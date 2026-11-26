// Foto della planimetria come sfondo: caricamento, raddrizzamento della prospettiva, taratura della
// scala (a mano con due punti, o in automatico leggendo le quote scritte sul disegno), aggancio al
// centro dei muri disegnati nella foto e spessore dei muri misurato sulla foto.
import * as G from './geom.js';

const MAX_PX = 2400;

export function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Immagine non leggibile')); i.src = src; });
}
/** File (immagine o PDF non supportato) -> dataURL JPEG ridotto a MAX_PX */
export async function fileToDataURL(file) {
  if (!/^image\//.test(file.type)) throw new Error('Serve un\'immagine (JPG, PNG, …). Per un PDF fai prima uno screenshot della pagina.');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { src: c.toDataURL('image/jpeg', 0.88), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}

// ---------- prospettiva ----------
// omografia che porta i 4 punti src (in ordine: alto-sx, alto-dx, basso-dx, basso-sx) nei 4 punti dst
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // eliminazione di Gauss
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [...h, 1];
}
/** Raddrizza la foto: quad = 4 punti nell'immagine. Restituisce { src, w, h } */
export async function warpPerspective(src, quad) {
  const img = await loadImage(src);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const c0 = document.createElement('canvas'); c0.width = iw; c0.height = ih;
  const x0 = c0.getContext('2d'); x0.drawImage(img, 0, 0);
  const sd = x0.getImageData(0, 0, iw, ih).data;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(d(quad[0], quad[1]), d(quad[3], quad[2])), H = Math.max(d(quad[0], quad[3]), d(quad[1], quad[2]));
  const k = Math.min(1, MAX_PX / Math.max(W, H));
  W = Math.round(W * k); H = Math.round(H * k);
  // omografia inversa: dal rettangolo di uscita ai pixel della foto
  const h = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(W, H), od = out.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const den = h[6] * x + h[7] * y + h[8];
    const u = (h[0] * x + h[1] * y + h[2]) / den, v = (h[3] * x + h[4] * y + h[5]) / den;
    const o = (y * W + x) * 4;
    if (u < 0 || v < 0 || u >= iw - 1 || v >= ih - 1) { od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255; continue; }
    // bilineare
    const ui = u | 0, vi = v | 0, fu = u - ui, fv = v - vi;
    const i00 = (vi * iw + ui) * 4, i10 = i00 + 4, i01 = i00 + iw * 4, i11 = i01 + 4;
    for (let ch = 0; ch < 3; ch++) od[o + ch] = (sd[i00 + ch] * (1 - fu) + sd[i10 + ch] * fu) * (1 - fv) + (sd[i01 + ch] * (1 - fu) + sd[i11 + ch] * fu) * fv;
    od[o + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return { src: c.toDataURL('image/jpeg', 0.9), w: W, h: H };
}

// ---------- mappa dei pixel scuri ----------
export async function darkMap(src) {
  const img = await loadImage(src);
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0; i < w * h; i++) { const g = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0; gray[i] = g; hist[g]++; }
  // soglia di Otsu
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = w * h - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  thr = Math.min(thr, 170);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = gray[i] < thr ? 1 : 0;
  return { w, h, dark, gray, canvas: c };
}

/** Run scuro lungo una riga (dir 'h') o colonna ('v') che passa per (u,v), cercando entro r pixel. */
function runAt(map, u, v, dir, r, maxRun) {
  const { w, h, dark } = map;
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && dark[y * w + x] === 1;
  u = Math.round(u); v = Math.round(v);
  let start = null;
  for (let k = 0; k <= r && start == null; k++) {
    for (const s of k ? [-k, k] : [0]) {
      const x = dir === 'h' ? u + s : u, y = dir === 'h' ? v : v + s;
      if (at(x, y)) { start = dir === 'h' ? x : y; break; }
    }
  }
  if (start == null) return null;
  let a = start, b = start;
  const lim = maxRun * 2;
  while (b - a < lim && (dir === 'h' ? at(a - 1, v) : at(u, a - 1))) a--;
  while (b - a < lim && (dir === 'h' ? at(b + 1, v) : at(u, b + 1))) b++;
  const len = b - a + 1;
  if (len > maxRun) return { long: true, a, b, len };
  return { a, b, len, c: (a + b) / 2 };
}

/**
 * Fascia scura (spessore di un muro) attraversata lungo dir. Negli angoli e negli incroci il punto sta
 * dentro due muri e il tratto risulta lungo: si riprova spostandosi di lato, fuori dall'altro muro.
 */
function bandAt(map, u, v, dir, r, maxRun) {
  const R = runAt(map, u, v, dir, r, maxRun);
  if (R && !R.long && R.len >= 2) return R;
  if (!R || !R.long) return null;
  const here = dir === 'h' ? u : v;
  for (const d of [maxRun * 0.75, maxRun * 1.25, maxRun * 2]) for (const sg of [-1, 1]) {
    const R2 = dir === 'h' ? runAt(map, u, v + sg * d, 'h', r, maxRun) : runAt(map, u + sg * d, v, 'v', r, maxRun);
    if (R2 && !R2.long && R2.len >= 2 && Math.abs(R2.c - here) <= r + R2.len / 2) return R2;
  }
  return null;
}

/**
 * Aggancio al centro dei muri della foto. Muro verticale: la riga orizzontale che passa per il cursore lo
 * attraversa con un tratto scuro corto -> x al centro. Muro orizzontale: idem in verticale -> y.
 * Restituisce { u, v, thick } in pixel (u o v null se non agganciati).
 */
export function snapToWalls(map, u, v, rPx, maxRunPx) {
  const H = bandAt(map, u, v, 'h', rPx, maxRunPx);
  const V = bandAt(map, u, v, 'v', rPx, maxRunPx);
  const res = { u: null, v: null, thick: null };
  if (H && !H.long && H.len >= 2) { res.u = H.c; res.thick = H.len; }
  if (V && !V.long && V.len >= 2) { res.v = V.c; res.thick = res.thick ? Math.min(res.thick, V.len) : V.len; }
  // dentro un muro orizzontale il tratto orizzontale e' lungo: si aggancia solo la y (e viceversa)
  return res;
}

// ---------- lettura delle quote (OCR) ----------
let worker = null;
async function getWorker(onProgress) {
  if (worker) return worker;
  const T = (await import('../lib/tesseract/tesseract.esm.min.js')).default;
  worker = await T.createWorker('eng', 1, {
    workerPath: new URL('../lib/tesseract/worker.min.js', import.meta.url).href,
    logger: m => { if (onProgress && m.status) onProgress(m.status, m.progress || 0); },
  });
  await worker.setParameters({ tessedit_char_whitelist: '0123456789.,', tessedit_pageseg_mode: '11', preserve_interword_spaces: '0' });
  return worker;
}

/** Interpreta un numero di quota: "345" -> 345 cm, "3,45" / "3.45" -> 345 cm, "12" -> null (ambiguo) */
export function parseDim(text) {
  const t = text.replace(/[^0-9.,]/g, '');
  if (!t) return null;
  let m;
  if ((m = t.match(/^(\d{1,2})[.,](\d{1,2})$/))) { const v = parseFloat(m[1] + '.' + m[2]) * 100; return v >= 30 && v <= 3000 ? v : null; }
  if ((m = t.match(/^(\d{2,4})$/))) { const v = parseInt(m[1], 10); return v >= 40 && v <= 3000 ? v : null; }
  if ((m = t.match(/^(\d{2,4})[.,](\d)$/))) { const v = parseFloat(m[1] + '.' + m[2]); return v >= 40 && v <= 3000 ? v : null; }
  return null;
}

/**
 * Lunghezza in pixel della linea (quota o muro) a cui si riferisce un numero: si cerca sopra e sotto
 * il testo (o a destra e sinistra se il testo e' verticale) la linea scura piu' lunga parallela al
 * testo, e la si interrompe ai trattini/frecce che la attraversano.
 */
function lineForLabel(map, box, vertical) {
  const { w, h, dark } = map;
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && dark[y * w + x] === 1;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const th = vertical ? box.x1 - box.x0 : box.y1 - box.y0; // altezza del testo
  const tw = vertical ? box.y1 - box.y0 : box.x1 - box.x0;
  let best = null;
  const reach = Math.max(8, th * 2.2);
  for (let k = -reach; k <= reach; k++) {
    // si saltano le righe dentro il testo
    if (Math.abs(k) < th * 0.55) continue;
    const L = vertical ? Math.round(cx + k) : Math.round(cy + k);
    const c0 = vertical ? Math.round(cy) : Math.round(cx);
    const get = s => vertical ? at(L, s) : at(s, L);
    // il punto di partenza (vicino al centro del testo) deve essere sulla linea
    let s0 = null;
    for (let j = 0; j <= tw / 2 && s0 == null; j++) for (const sgn of [1, -1]) if (get(c0 + sgn * j)) { s0 = c0 + sgn * j; break; }
    if (s0 == null) continue;
    // si estende tollerando piccoli buchi
    const ext = dir => { let s = s0, gap = 0; while (gap <= 3) { const n = s + dir; if (n < 0 || n >= (vertical ? h : w)) break; if (get(n)) { s = n; gap = 0; } else { gap++; if (gap > 3) break; s = n; } } return s - dir * gap; };
    let a = ext(-1), b = ext(1);
    if (b - a < tw * 0.9) continue;
    // trattini (dritti o obliqui) e frecce: punti in cui la linea e' attraversata, cioe' ci sono pixel
    // scuri sia sopra sia sotto la linea entro pochi pixel (in una piccola finestra di colonne)
    const tq = Math.max(5, Math.round(th * 0.35)), tw2 = Math.max(3, Math.round(th * 0.3));
    const crosses = s => {
      let up = 0, dn = 0;
      for (let q = 3; q <= tq; q++) for (let j = -tw2; j <= tw2; j++) {
        if (vertical ? at(L - q, s + j) : at(s + j, L - q)) { up++; break; }
      }
      for (let q = 3; q <= tq; q++) for (let j = -tw2; j <= tw2; j++) {
        if (vertical ? at(L + q, s + j) : at(s + j, L + q)) { dn++; break; }
      }
      return up >= 2 && dn >= 2;
    };
    const ticks = [];
    for (let s = a; s <= b; s++) if (crosses(s)) { if (!ticks.length || s - ticks[ticks.length - 1].e > 2) ticks.push({ s, e: s }); else ticks[ticks.length - 1].e = s; }
    // un trattino e' stretto: i tratti larghi sono muri o testo, non segni di quota
    const tk = ticks.filter(t => t.e - t.s <= tw2 * 4 + 2).map(t => (t.s + t.e) / 2);
    // tratto tra i due trattini che racchiudono il centro del testo
    const left = tk.filter(t => t < c0 - 2).pop(), right = tk.find(t => t > c0 + 2);
    if (left != null) a = left; if (right != null) b = right;
    const len = b - a;
    if (len < tw * 0.9) continue;
    const score = len * (left != null && right != null ? 1.5 : 1) - Math.abs(k) * 0.5;
    if (!best || score > best.score) best = { len, a, b, L, score, ticks: left != null && right != null };
  }
  if (!best) return null;
  const seg = vertical ? { x0: best.L, y0: best.a, x1: best.L, y1: best.b } : { x0: best.a, y0: best.L, x1: best.b, y1: best.L };
  return { len: best.len, seg, ticks: best.ticks };
}

/**
 * Legge i numeri della planimetria e ne ricava la scala (cm per pixel). Restituisce
 * { k, used: [...], all: [...] } dove ogni voce ha { text, cm, box, seg, px, k, ok }.
 */
export async function ocrScale(src, map, onProgress) {
  const wk = await getWorker(onProgress);
  const found = [];
  const img = await loadImage(src);
  // due passate: testo orizzontale e testo verticale (immagine ruotata di 90°)
  for (const rot of [0, 1]) {
    const c = document.createElement('canvas');
    c.width = rot ? img.naturalHeight : img.naturalWidth; c.height = rot ? img.naturalWidth : img.naturalHeight;
    const ctx = c.getContext('2d');
    if (rot) { ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); }
    ctx.drawImage(img, 0, 0);
    if (onProgress) onProgress(rot ? 'quote verticali' : 'quote orizzontali', 0);
    const { data } = await wk.recognize(c);
    for (const wd of data.words || []) {
      const cm = parseDim(wd.text);
      if (cm == null || wd.confidence < 45) continue;
      let b = wd.bbox;
      // riporta il riquadro nelle coordinate dell'immagine originale (rotazione di 90° oraria)
      if (rot) b = { x0: b.y0, x1: b.y1, y0: img.naturalHeight - b.x1, y1: img.naturalHeight - b.x0 };
      found.push({ text: wd.text, cm, box: b, vertical: !!rot, conf: wd.confidence });
    }
  }
  for (const f of found) {
    const ln = lineForLabel(map, f.box, f.vertical);
    if (ln) { f.px = ln.len; f.seg = ln.seg; f.k = f.cm / ln.len; f.ticks = ln.ticks; }
  }
  const cand = found.filter(f => f.k);
  // la scala su cui concordano piu' quote (entro il 4%)
  let best = null;
  for (const f of cand) {
    const near = cand.filter(g => Math.abs(g.k / f.k - 1) < 0.04);
    const w = near.reduce((s, g) => s + (g.ticks ? 1.5 : 1), 0);
    if (!best || w > best.w) best = { w, near };
  }
  let k = null;
  if (best) {
    const ks = best.near.map(g => g.k).sort((a, b) => a - b);
    k = ks[ks.length >> 1];
    for (const g of best.near) g.ok = true;
  }
  return { k, used: best ? best.near : [], all: found };
}

// ---------- strumento foto per l'editor 2D ----------
export class PhotoTool {
  constructor(app) {
    this.app = app;
    this.img = null;
    this.map = null;
    this.mode = null;       // 'move' | 'calib' | 'persp'
    this.calib = [];
    this.quad = null;
    this.ocr = null;
  }
  get bg() { return this.app.doc.background; }
  visible() { return !!(this.bg && this.bg.visible && this.img); }
  snapOn() { return !!(this.bg && this.bg.snap && this.bg.visible && this.map); }

  async refresh() {
    const bg = this.bg;
    if (!bg) { this.img = null; this.map = null; this._src = null; return; }
    if (this._src === bg.src) return;
    this._src = bg.src;
    this.img = await loadImage(bg.src);
    this.map = null;
    darkMap(bg.src).then(m => { if (this._src === bg.src) { this.map = m; this.app.plan.redraw(); } });
    this.app.plan.redraw();
  }

  // pixel della foto <-> pianta (cm)
  toPlan(u, v) {
    const bg = this.bg, a = bg.rot * Math.PI / 180;
    const x = (u - bg.w / 2) * bg.k, y = (v - bg.h / 2) * bg.k;
    return { x: bg.cx + x * Math.cos(a) - y * Math.sin(a), y: bg.cy + x * Math.sin(a) + y * Math.cos(a) };
  }
  toPx(p) {
    const bg = this.bg, a = bg.rot * Math.PI / 180;
    const dx = p.x - bg.cx, dy = p.y - bg.cy;
    const x = dx * Math.cos(a) + dy * Math.sin(a), y = -dx * Math.sin(a) + dy * Math.cos(a);
    return { u: x / bg.k + bg.w / 2, v: y / bg.k + bg.h / 2 };
  }
  corners() { if (!this.bg || !this.bg.visible) return null; const b = this.bg; return [this.toPlan(0, 0), this.toPlan(b.w, 0), this.toPlan(b.w, b.h), this.toPlan(0, b.h)]; }

  snapPoint(p, tolCm) {
    const bg = this.bg, px = this.toPx(p);
    const r = Math.max(2, tolCm / bg.k), maxRun = Math.max(3, 70 / bg.k);
    const s = snapToWalls(this.map, px.u, px.v, Math.round(r), Math.round(maxRun));
    if (s.u == null && s.v == null) return null;
    // si torna in pianta tenendo la componente non agganciata
    const q = this.toPlan(s.u ?? px.u, s.v ?? px.v);
    const rot = Math.abs(bg.rot % 90) > 0.01;
    return { x: (s.u != null || rot) ? q.x : null, y: (s.v != null || rot) ? q.y : null, thick: s.thick ? Math.round(s.thick * bg.k) : null };
  }

  drawImage(ctx, plan) {
    if (!this.visible()) return;
    const bg = this.bg;
    ctx.save();
    ctx.translate(bg.cx, bg.cy);
    ctx.rotate(bg.rot * Math.PI / 180);
    ctx.scale(bg.k, bg.k);
    ctx.globalAlpha = bg.opacity;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.img, -bg.w / 2, -bg.h / 2, bg.w, bg.h);
    ctx.restore();
  }

  drawOverlay(ctx, plan) {
    if (!this.bg || !this.img) return;
    const lw = plan.px(1.5);
    if (this.mode === 'calib') {
      ctx.strokeStyle = '#e8590c'; ctx.fillStyle = '#e8590c'; ctx.lineWidth = lw;
      const pts = [...this.calib]; if (pts.length === 1 && this.hover) pts.push(this.hover);
      if (pts.length === 2) { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke(); }
      for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, plan.px(5), 0, 7); ctx.fill(); }
    }
    if (this.mode === 'persp' && this.quad) {
      const P = this.quad.map(([u, v]) => this.toPlan(u, v));
      ctx.strokeStyle = '#e8590c'; ctx.lineWidth = lw; ctx.fillStyle = 'rgba(232,89,12,0.08)';
      ctx.beginPath(); P.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.fill(); ctx.stroke();
      for (const p of P) { ctx.beginPath(); ctx.arc(p.x, p.y, plan.px(9), 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); }
    }
    if (this.ocr && this.mode === 'ocr') {
      ctx.lineWidth = lw;
      for (const f of this.ocr.all) {
        const b = f.box, P = [this.toPlan(b.x0, b.y0), this.toPlan(b.x1, b.y0), this.toPlan(b.x1, b.y1), this.toPlan(b.x0, b.y1)];
        ctx.strokeStyle = f.ok ? '#2b8a3e' : '#c92a2a';
        ctx.beginPath(); P.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.stroke();
        if (f.seg && f.ok) { const a = this.toPlan(f.seg.x0, f.seg.y0), c = this.toPlan(f.seg.x1, f.seg.y1); ctx.lineWidth = plan.px(3); ctx.strokeStyle = 'rgba(43,138,62,0.7)'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke(); ctx.lineWidth = lw; }
      }
    }
  }

  setMode(m) {
    this.mode = m; this.calib = []; this.hover = null;
    if (m === 'persp') { const b = this.bg; const i = Math.min(b.w, b.h) * 0.08; this.quad = [[i, i], [b.w - i, i], [b.w - i, b.h - i], [i, b.h - i]]; }
    this.app.plan.redraw();
  }

  down(p, plan) {
    if (!this.bg) return;
    if (this.mode === 'move') { this.dragFrom = { p, cx: this.bg.cx, cy: this.bg.cy, snap: JSON.stringify(this.bg) }; }
    else if (this.mode === 'persp') {
      const P = this.quad.map(([u, v]) => this.toPlan(u, v));
      const i = P.findIndex(q => G.dist(q, p) < plan.px(22));
      this.dragCorner = i >= 0 ? i : null;
    } else if (this.mode === 'calib') {
      // aggancio al centro dei muri anche durante la taratura
      this.calib.push(this._calibPoint(p, plan));
      if (this.calib.length === 2) this.app.askCalibration(this.calib[0], this.calib[1]);
      plan.redraw();
    }
  }
  _calibPoint(p, plan) {
    if (!this.map) return p;
    const s = this.snapPoint(p, plan.px(10));
    return s ? { x: s.x ?? p.x, y: s.y ?? p.y } : p;
  }
  move(p, plan, pressed) {
    if (this.mode === 'move' && pressed && this.dragFrom) { this.bg.cx = this.dragFrom.cx + p.x - this.dragFrom.p.x; this.bg.cy = this.dragFrom.cy + p.y - this.dragFrom.p.y; plan.redraw(); }
    else if (this.mode === 'persp' && pressed && this.dragCorner != null) { const q = this.toPx(p); this.quad[this.dragCorner] = [Math.max(0, Math.min(this.bg.w, q.u)), Math.max(0, Math.min(this.bg.h, q.v))]; plan.redraw(); }
    else if (this.mode === 'calib') { this.hover = this._calibPoint(p, plan); plan.redraw(); }
  }
  up() {
    if (this.mode === 'move' && this.dragFrom) { this.dragFrom = null; this.app.commit('Sposta foto'); }
    this.dragCorner = null;
  }

  /** Imposta la scala: la distanza tra a e b (in pianta) vale cm. Il punto a resta fermo. */
  applyScale(a, b, cm) {
    const bg = this.bg;
    const pa = this.toPx(a), pb = this.toPx(b);
    const dpx = Math.hypot(pa.u - pb.u, pa.v - pb.v);
    if (dpx < 1) return;
    this.setScale(cm / dpx, a);
  }
  setScale(k, keep) {
    const bg = this.bg;
    const px = keep ? this.toPx(keep) : { u: bg.w / 2, v: bg.h / 2 };
    bg.k = k;
    if (keep) { const q = this.toPlan(px.u, px.v); bg.cx += keep.x - q.x; bg.cy += keep.y - q.y; }
  }
}
