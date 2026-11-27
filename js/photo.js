// Foto della planimetria come sfondo: caricamento, raddrizzamento della prospettiva, taratura della
// scala (a mano con due punti, o in automatico leggendo le quote scritte sul disegno), aggancio al
// centro dei muri disegnati nella foto e spessore dei muri misurato sulla foto.
import * as G from './geom.js?v=mwz2r4zd';

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
  const here = dir === 'h' ? u : v;
  const atp = p => dir === 'h' ? at(p, v) : at(u, p);
  let start = null;
  for (let k = 0; k <= r && start == null; k++) {
    for (const s of k ? [-k, k] : [0]) {
      const x = dir === 'h' ? u + s : u, y = dir === 'h' ? v : v + s;
      if (at(x, y)) { start = dir === 'h' ? x : y; break; }
    }
  }
  if (start == null) {
    // cursore sul bianco dentro un muro a doppia linea: una linea sottile per parte, vicine fra loro
    const find = sg => { for (let p = here + sg; Math.abs(p - here) <= maxRun; p += sg) if (atp(p)) return p; return null; };
    const lo = find(-1), hi = find(1);
    if (lo == null || hi == null || hi - lo > maxRun) return null;
    let a2 = lo, b2 = hi;
    while (lo - a2 < 4 && atp(a2 - 1)) a2--;
    while (b2 - hi < 4 && atp(b2 + 1)) b2++;
    if (lo - a2 >= 4 || b2 - hi >= 4) return null; // non sono linee sottili
    return { a: a2, b: b2, len: b2 - a2 + 1, c: (a2 + b2) / 2, hollow: true };
  }
  let a = start, b = start;
  const lim = maxRun * 2;
  while (b - a < lim && (dir === 'h' ? at(a - 1, v) : at(u, a - 1))) a--;
  while (b - a < lim && (dir === 'h' ? at(b + 1, v) : at(u, b + 1))) b++;
  const len = b - a + 1;
  if (len > maxRun) return { long: true, a, b, len };
  if (len <= 4) {
    // linea sottile: muro a doppia linea? si cerca la linea parallela, prima dal lato del cursore
    const sides = here >= (a + b) / 2 ? [1, -1] : [-1, 1];
    for (const sg of sides) {
      const from = sg > 0 ? b : a;
      let p = from + 2 * sg, found = null;
      while (Math.abs(p - from) <= maxRun) { if (atp(p)) { found = p; break; } p += sg; }
      if (found == null || Math.abs(found - from) < 3) continue;
      let e = found;
      while (Math.abs(e - found) < 5 && atp(e + sg)) e += sg;
      if (Math.abs(e - found) > 4) continue; // non e' una linea sottile
      const A = Math.min(a, e), B = Math.max(b, e);
      // il cursore deve stare dentro la fascia (o quasi)
      if (here < A - r || here > B + r) continue;
      return { a: A, b: B, len: B - A + 1, c: (A + B) / 2, hollow: true };
    }
  }
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
export function lineForLabel(map, box, vertical, dbg) {
  const { w, h, gray } = map;
  if (!map.light) { map.light = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) map.light[i] = gray[i] < 205 ? 1 : 0; }
  const dark = map.light;
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && dark[y * w + x] === 1;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const th = vertical ? box.x1 - box.x0 : box.y1 - box.y0; // altezza del testo
  const tw = vertical ? box.y1 - box.y0 : box.x1 - box.x0;
  const cands = [], seen = new Set();
  const reach = Math.max(8, th * 2.2);
  for (let k = -reach; k <= reach; k++) {
    // anche le righe del testo: spesso la linea di quota passa in mezzo al numero
    const L = vertical ? Math.round(cx + k) : Math.round(cy + k);
    const c0 = vertical ? Math.round(cy) : Math.round(cx);
    // fascia di tre righe: le linee sottili sfumano su due righe o sono appena inclinate
    const get = s => vertical ? (at(L, s) || at(L - 1, s) || at(L + 1, s)) : (at(s, L) || at(s, L - 1) || at(s, L + 1));
    // il punto di partenza (vicino al centro del testo) deve essere sulla linea
    let s0 = null;
    for (let j = 0; j <= tw / 2 && s0 == null; j++) for (const sgn of [1, -1]) if (get(c0 + sgn * j)) { s0 = c0 + sgn * j; break; }
    if (s0 == null) continue;
    // si estende tollerando piccoli buchi
    // (il riquadro del numero si scavalca: la linea spesso passa in mezzo alle cifre)
    const tA = (vertical ? box.y0 : box.x0) - 2, tB = (vertical ? box.y1 : box.x1) + 2;
    const ext = dir => { let s = s0, gap = 0; while (gap <= 3) { const n = s + dir; if (n < 0 || n >= (vertical ? h : w)) break; if (get(n) || (n >= tA && n <= tB)) { s = n; gap = 0; } else { gap++; if (gap > 3) break; s = n; } } return s - dir * gap; };
    let a = ext(-1), b = ext(1);
    // una linea di quota e' molto piu' lunga del suo numero (la barretta di "80/210" no)
    const minLen = Math.max(tw * 1.8, th * 3);
    if (b - a < minLen) continue;
    // trattini (dritti o obliqui) e frecce: punti in cui la linea e' attraversata, cioe' ci sono pixel
    // scuri sia sopra sia sotto la linea entro pochi pixel (in una piccola finestra di colonne)
    // trattino di fine quota: barretta obliqua a 45° (o un segno corto) che attraversa la linea.
    // Le linee lunghe che la incrociano (richiami, muri, altre quote) non sono trattini.
    const tq = Math.max(4, Math.round(th * 0.4));
    const P = (s, q) => vertical ? at(L + q, s) : at(s, L + q); // q: distanza dalla linea (+/-)
    const near = (s, q) => P(s, q) || P(s - 1, q) || P(s + 1, q);
    const crosses = s => {
      for (const sg of [1, -1]) {
        let k = 0;
        for (let q = 2; q <= tq; q++) if (near(s + sg * q, -q) && near(s - sg * q, q)) k++;
        if (k >= tq - 2) return true;
      }
      // segno corto e dritto: c'e' vicino alla linea ma non continua oltre
      let shortMark = true;
      for (let q = 2; q <= 3; q++) if (!P(s, q) || !P(s, -q)) shortMark = false;
      if (shortMark && !P(s, Math.round(th * 1.2)) && !P(s, -Math.round(th * 1.2))) return true;
      return false;
    };
    const tw2 = 2;
    const t0 = vertical ? box.y0 : box.x0, t1 = vertical ? box.y1 : box.x1;
    const add = (A, B, strong) => {
      const len = B - A;
      if (len < minLen) return;
      // il numero di una quota sta circa a meta' della sua linea
      const mid = (t0 + t1) / 2;
      if (mid < A + 0.15 * len || mid > B - 0.15 * len) return;
      const key = Math.round(len) + (strong ? 's' : 'w');
      if (seen.has(key)) return;
      seen.add(key);
      cands.push({ len, a: A, b: B, L, strong });
    };
    // 1) fino alle linee perpendicolari (richiami o facce dei muri) piu' vicine al numero
    const e2 = Math.max(5, Math.round(th * 1.1)); // piu' alta delle cifre, che la linea puo' attraversare
    const crossing = s => { for (let q = -e2; q <= e2; q++) if (!near(s, q)) return false; return true; };
    let lc = null, rc = null;
    for (let s = Math.floor(t0) - 1; s >= a - 2; s--) if (crossing(s)) { lc = s; break; }
    for (let s = Math.ceil(t1) + 1; s <= b + 2; s++) if (crossing(s)) { rc = s; break; }
    if (dbg) dbg.push({ k, a, b, lc, rc, minLen });
    if (lc != null && rc != null) add(lc, rc, true);
    // 2) fino ai trattini che racchiudono il numero
    const ticks = [];
    for (let s = a; s <= b; s++) if ((s < t0 - 2 || s > t1 + 2) && crosses(s)) { if (!ticks.length || s - ticks[ticks.length - 1].e > 2) ticks.push({ s, e: s }); else ticks[ticks.length - 1].e = s; }
    const tk = ticks.filter(t => t.e - t.s <= tw2 * 4 + 2).map(t => (t.s + t.e) / 2);
    const left = tk.filter(t => t < c0 - 2).pop(), right = tk.find(t => t > c0 + 2);
    if (left != null && right != null) add(left, right, true);
    // 3) la linea intera (quote che attraversano muri interni: i richiami intermedi non contano)
    add(a, b, false);
  }
  if (!cands.length) return null;
  cands.sort((p, q) => (q.strong - p.strong) || (q.len - p.len));
  const seg = c => vertical ? { x0: c.L, y0: c.a, x1: c.L, y1: c.b } : { x0: c.a, y0: c.L, x1: c.b, y1: c.L };
  for (const c of cands) c.seg = seg(c);
  return { cands, len: cands[0].len, seg: cands[0].seg, ticks: cands[0].strong };
}

/**
 * Prepara l'immagine per la lettura del testo: bianco e nero netto e senza le linee lunghe (muri,
 * quote, richiami), che altrimenti si attaccano alle cifre e il lettore non le riconosce.
 */
function cleanForOcr(ctx, W, H, up) {
  const id = ctx.getImageData(0, 0, W, H), d = id.data;
  const blk = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) blk[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) < 190 ? 1 : 0;
  const keep = blk.slice();
  const LR = Math.round(13 * up); // tratti piu' lunghi di cosi' non sono cifre
  for (let y = 0; y < H; y++) {
    let a = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && blk[y * W + x];
      if (on && a < 0) a = x;
      if (!on && a >= 0) { if (x - a > LR) for (let k = a; k < x; k++) keep[y * W + k] = 0; a = -1; }
    }
  }
  for (let x = 0; x < W; x++) {
    let a = -1;
    for (let y = 0; y <= H; y++) {
      const on = y < H && blk[y * W + x];
      if (on && a < 0) a = y;
      if (!on && a >= 0) { if (y - a > LR) for (let k = a; k < y; k++) keep[k * W + x] = 0; a = -1; }
    }
  }
  for (let i = 0; i < W * H; i++) { const v = keep[i] ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  ctx.putImageData(id, 0, 0);
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
  // il testo delle planimetrie e' piccolo: si legge su una copia ingrandita
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const up = Math.min(3.5, Math.max(1, 4000 / Math.max(iw, ih)));
  for (const rot of [0, 1]) {
    const c = document.createElement('canvas');
    c.width = Math.round((rot ? ih : iw) * up); c.height = Math.round((rot ? iw : ih) * up);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    if (rot) { ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); }
    ctx.scale(up, up);
    ctx.drawImage(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    cleanForOcr(ctx, c.width, c.height, up);
    if (globalThis.__ocrDebug) globalThis.__ocrDebug.push(c.toDataURL('image/png'));
    if (onProgress) onProgress(rot ? 'quote verticali' : 'quote orizzontali', 0);
    const { data } = await wk.recognize(c);
    if (globalThis.__ocrWords) globalThis.__ocrWords.push(...(data.words || []).map(x => x.text + '@' + Math.round(x.confidence) + '(' + Math.round(x.bbox.x0 / up) + ',' + Math.round(x.bbox.y0 / up) + ')'));
    const words = [];
    for (const wd of data.words || []) {
      const cm = parseDim(wd.text);
      if (cm == null) continue; // la confidenza non serve: con le sole cifre ammesse spesso vale 0 anche quando e' giusto
      const bb = { x0: wd.bbox.x0 / up, x1: wd.bbox.x1 / up, y0: wd.bbox.y0 / up, y1: wd.bbox.y1 / up };
      words.push({ text: wd.text, cm, bb, conf: wd.confidence });
    }
    // sigle di porte e finestre: due numeri uno sopra l'altro (larghezza/altezza), come "80/210"
    for (const a of words) for (const b of words) {
      if (a === b) continue;
      const hgt = Math.max(a.bb.y1 - a.bb.y0, b.bb.y1 - b.bb.y0);
      const wd = Math.max(a.bb.x1 - a.bb.x0, b.bb.x1 - b.bb.x0);
      const dx = Math.abs((a.bb.x0 + a.bb.x1) / 2 - (b.bb.x0 + b.bb.x1) / 2);
      const gap = b.bb.y0 - a.bb.y1;
      if (dx < wd * 0.6 && gap > -hgt * 0.2 && gap < hgt * 1.1) { a.frac = b.frac = true; }
    }
    for (const wd of words) {
      let b = wd.bb;
      // riporta il riquadro nelle coordinate dell'immagine originale (rotazione di 90° oraria)
      if (rot) b = { x0: b.y0, x1: b.y1, y0: ih - b.x1, y1: ih - b.x0 };
      found.push({ text: wd.text, cm: wd.cm, box: b, vertical: !!rot, conf: wd.conf, frac: !!wd.frac });
    }
  }
  for (const f of found) {
    if (f.frac) continue;
    const ln = lineForLabel(map, f.box, f.vertical);
    if (ln) { f.cands = ln.cands.map(c => ({ ...c, kk: f.cm / c.len })); f.px = ln.len; f.seg = ln.seg; f.k = f.cm / ln.len; f.ticks = ln.ticks; }
  }
  // la scala su cui concordano piu' numeri, ognuno con la sua misura piu' vicina (entro il 6%)
  const cand = found.filter(f => f.cands && f.cands.length);
  let best = null;
  for (const f of cand) for (const c of f.cands) {
    const K = c.kk;
    let score = 0;
    const votes = [];
    for (const g of cand) {
      let bm = null;
      for (const d of g.cands) { const e = Math.abs(d.kk / K - 1); if (e < 0.05 && (!bm || (d.strong && !bm.strong) || (d.strong === bm.strong && e < Math.abs(bm.kk / K - 1)))) bm = d; }
      if (bm) { score += bm.strong ? 1 : 0.5; votes.push([g, bm]); }
    }
    if (votes.length >= 2 && (!best || score > best.score)) best = { score, votes };
  }
  let k = null;
  const used = [];
  if (best) {
    const ks = best.votes.map(v => v[1].kk).sort((a, b) => a - b);
    k = ks[ks.length >> 1];
    for (const [g, c] of best.votes) { g.ok = true; g.k = c.kk; g.px = c.len; g.seg = c.seg; g.ticks = c.strong; used.push(g); }
  }
  return { k, used, all: found };
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
