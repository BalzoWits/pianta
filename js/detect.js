// Riconoscimento automatico dalla foto della planimetria:
// - inclinazione (per raddrizzare da sola una foto o una scansione un po' storta);
// - pareti orizzontali e verticali: muri disegnati con due linee sottili parallele (il caso piu'
//   comune nei disegni CAD) oppure campiti pieni; le linee delle quote, piu' chiare, sono scartate.
// Tutto lavora in pixel della foto; la conversione in centimetri la fa chi chiama.

/** Inclinazione del disegno in gradi (-6..6): l'angolo che rende piu' "nette" le proiezioni dei tratti scuri. */
export function skewAngle(map) {
  const { w, h, gray } = map;
  const xs = [], ys = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 400000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (gray[y * w + x] < 110) { xs.push(x); ys.push(y); }
  if (xs.length < 200) return 0;
  const n = xs.length, D = Math.ceil(Math.hypot(w, h)) + 4;
  const hist = new Float64Array(2 * D + 8);
  const score = deg => {
    const t = deg * Math.PI / 180, s = Math.sin(t), c = Math.cos(t);
    let tot = 0;
    for (const proj of [0, 1]) {
      hist.fill(0);
      for (let i = 0; i < n; i++) {
        const v = proj ? xs[i] * c + ys[i] * s : -xs[i] * s + ys[i] * c;
        hist[Math.round(v) + D]++;
      }
      for (let i = 0; i < hist.length; i++) tot += hist[i] * hist[i];
    }
    return tot;
  };
  let best = 0, bs = -1;
  for (let a = -6; a <= 6.001; a += 0.1) { const v = score(a); if (v > bs) { bs = v; best = a; } }
  const b0 = best;
  for (let a = b0 - 0.1; a <= b0 + 0.1001; a += 0.01) { const v = score(a); if (v > bs) { bs = v; best = a; } }
  return Math.round(best * 100) / 100;
}

/** Ruota l'immagine di deg (stesso verso di skewAngle) ingrandendo la tela; sfondo bianco. */
export async function rotateImage(src, deg, loadImage) {
  const img = await loadImage(src);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const t = -deg * Math.PI / 180;
  const W = Math.ceil(Math.abs(iw * Math.cos(t)) + Math.abs(ih * Math.sin(t)));
  const H = Math.ceil(Math.abs(iw * Math.sin(t)) + Math.abs(ih * Math.cos(t)));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2); ctx.rotate(t);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, -iw / 2, -ih / 2);
  return { src: c.toDataURL('image/jpeg', 0.9), w: W, h: H };
}

// ---------- pareti ----------

/** Tratti lunghi lungo righe (horiz) o colonne, uniti tra righe vicine. */
function segments(gray, w, h, T, horiz, MINLEN, GAP) {
  const L = horiz ? h : w, N = horiz ? w : h;
  const segs = [];
  let open = [];
  const runs = [];
  for (let r = 0; r < L; r++) {
    runs.length = 0;
    let a = -1, b = -1;
    for (let i = 0; i < N; i++) {
      const v = horiz ? gray[r * w + i] : gray[i * w + r];
      if (v < T) {
        if (a < 0) { a = b = i; } else if (i - b - 1 <= GAP) b = i; else { if (b - a + 1 >= MINLEN) runs.push([a, b]); a = b = i; }
      }
    }
    if (a >= 0 && b - a + 1 >= MINLEN) runs.push([a, b]);
    const next = [];
    for (const [ra, rb] of runs) {
      let hit = null;
      for (const s of open) {
        if (s.c1 === r - 1 && Math.min(rb, s.b) - Math.max(ra, s.a) >= 0.7 * Math.max(rb - ra, s.b - s.a)) { hit = s; break; } // tratti di lunghezza simile (non un pilastro accanto a una linea lunga)
      }
      if (hit) { hit.c1 = r; hit.a = Math.min(hit.a, ra); hit.b = Math.max(hit.b, rb); next.push(hit); }
      else { const s = { c0: r, c1: r, a: ra, b: rb, h: horiz }; segs.push(s); next.push(s); }
    }
    open = next;
  }
  // inchiostro per unita' di lunghezza (somma sulla sezione: le linee sfumate valgono come quelle nette),
  // posizione pesata e riempimento
  const col = [];
  for (const s of segs) {
    const r0 = Math.max(0, s.c0 - 1), r1 = Math.min(L - 1, s.c1 + 1);
    col.length = 0;
    let sw = 0, swr = 0, fill = 0, cnt = 0;
    for (let i = s.a; i <= s.b; i++) {
      let sum = 0;
      for (let r = r0; r <= r1; r++) {
        const v = 255 - (horiz ? gray[r * w + i] : gray[i * w + r]);
        sum += v; sw += v; swr += v * r;
        if (r >= s.c0 && r <= s.c1) { cnt++; if (255 - v < T) fill++; }
      }
      col.push(sum);
    }
    col.sort((p, q) => p - q);
    s.mass = col[col.length >> 1];
    s.c = sw ? swr / sw : (s.c0 + s.c1) / 2;
    s.len = s.b - s.a + 1;
    s.t = s.c1 - s.c0 + 1;
    s.fill = cnt ? fill / cnt : 0;
  }
  return segs;
}

/** Soglia d'inchiostro: esclude le linee chiare (quote, richiami), relativa ai tratti piu' marcati. */
function wallMass(segs) {
  const thin = segs.filter(s => s.t <= 3 && s.len >= 40).map(s => s.mass).sort((p, q) => p - q);
  if (!thin.length) return 0;
  return 0.55 * thin[Math.floor(thin.length * 0.9)];
}

/** Scarta le serie di linee parallele equidistanti (scale, tratteggi): 5 o piu' linee. */
function markCombs(segs, maxT) {
  const S = segs.slice().sort((p, q) => p.c - q.c);
  for (let i = 0; i < S.length; i++) {
    const A = S[i];
    for (let j = i + 1; j < S.length; j++) {
      const B = S[j];
      const sp = B.c - A.c;
      if (sp < 5) continue;
      if (sp > maxT) break;
      if (Math.min(A.b, B.b) - Math.max(A.a, B.a) < 0.6 * Math.max(A.len, B.len)) continue;
      // si segue la catena con lo stesso passo
      const chain = [A, B];
      let last = B;
      for (let k = j + 1; k < S.length; k++) {
        const C = S[k];
        const d = C.c - last.c;
        if (d > sp + 2) break;
        if (Math.abs(d - sp) <= 2 && Math.min(last.b, C.b) - Math.max(last.a, C.a) >= 0.6 * Math.max(last.len, C.len)) { chain.push(C); last = C; }
      }
      if (chain.length >= 5) for (const s of chain) s.comb = true;
    }
  }
}

function pairsOf(segs, ink, w, h, MAXT, MINLEN, MASS) {
  const walls = [];
  const S = segs.filter(s => s.mass >= MASS && !s.comb).sort((p, q) => p.c - q.c);
  for (let i = 0; i < S.length; i++) {
    const A = S[i];
    if (A.t >= 5 && A.fill >= 0.85) { walls.push({ h: A.h, c: A.c, a: A.a, b: A.b, t: A.t }); continue; } // muro pieno
    for (let j = i + 1; j < S.length; j++) {
      const B = S[j];
      const dd = B.c - A.c;
      if (dd < 3) continue;
      if (dd > MAXT) break;
      // le due linee di un muro hanno lo stesso tratto
      if (A.t <= 3 && B.t <= 3 && (A.mass / B.mass > 1.6 || B.mass / A.mass > 1.6)) continue;
      const lo = Math.max(A.a, B.a), hi = Math.min(A.b, B.b);
      if (hi - lo < MINLEN) continue;
      // tra le due linee dev'esserci (quasi) vuoto per almeno meta' della lunghezza
      const c0 = Math.floor(A.c) + 2, c1 = Math.ceil(B.c) - 1;
      if (c1 > c0) {
        let emptyCols = 0;
        for (let i2 = lo; i2 <= hi; i2++) {
          let k = 0;
          for (let r = c0; r < c1; r++) if (A.h ? ink[r * w + i2] : ink[i2 * w + r]) k++;
          if (k < 0.34 * (c1 - c0)) emptyCols++;
        }
        if (emptyCols < 0.5 * (hi - lo + 1)) continue;
      }
      walls.push({ h: A.h, c: (A.c + B.c) / 2, a: lo, b: hi, t: dd + 1 });
    }
  }
  return walls;
}

/** Unisce pezzi allineati dello stesso spessore (anche sovrapposti) separati da buchi <= maxGap. */
function merge(walls, maxGap) {
  const W = walls.slice().sort((p, q) => (p.h === q.h ? 0 : p.h ? -1 : 1) || p.c - q.c || p.a - q.a);
  const out = [];
  for (const w of W) {
    let m = null;
    for (const o of out) {
      if (!(o.h === w.h && Math.abs(o.c - w.c) <= 2.5 && Math.abs(o.t - w.t) <= Math.max(3, 0.25 * o.t) && w.a - o.b <= maxGap && o.a - w.b <= maxGap)) continue;
      // un buco si scavalca solo tra due tratti veri di muro, non per un frammento
      const gap = Math.max(w.a - o.b, o.a - w.b);
      const minPiece = Math.max(2 * w.t, 22);
      if (gap > 3 && (w.b - w.a < minPiece || o.b - o.a < minPiece)) continue;
      m = o; break;
    }
    if (m) {
      const L1 = m.b - m.a, L2 = w.b - w.a;
      m.c = (m.c * L1 + w.c * L2) / Math.max(1, L1 + L2);
      m.t = (m.t * L1 + w.t * L2) / Math.max(1, L1 + L2);
      if (w.a > m.b) m.gaps.push([m.b, w.a]); else if (m.a > w.b) m.gaps.push([w.b, m.a]);
      for (const g of w.gaps || []) m.gaps.push(g);
      m.a = Math.min(m.a, w.a); m.b = Math.max(m.b, w.b);
    } else out.push({ ...w, gaps: (w.gaps || []).slice() });
  }
  // i buchi coperti da altri pezzi non sono buchi
  for (const o of out) o.gaps = o.gaps.filter(([g0, g1]) => g1 - g0 > 2);
  return out;
}

/**
 * Allunga o accorcia gli estremi fino alla linea d'asse della parete perpendicolare vicina.
 * Con doorPx: un muro che finisce poco prima di una parete (varco da porta vicino all'angolo) si
 * prolunga fino a lei e il varco resta segnato come buco (diventera' una porta).
 */
function joinCorners(walls, tolPx, doorPx = 0) {
  for (const w of walls) {
    for (const end of ['a', 'b']) {
      const e = w[end];
      const out = end === 'a' ? -1 : 1; // verso l'esterno del muro
      let best = null, bd = Infinity, gap = 0;
      for (const p of walls) {
        if (p.h === w.h) continue;
        // la perpendicolare deve attraversare la linea di w (con un po' di tolleranza)
        if (w.c < p.a - tolPx - p.t / 2 || w.c > p.b + tolPx + p.t / 2) continue;
        const d = Math.abs(p.c - e);
        const lim = p.t / 2 + w.t / 2 + tolPx;
        if (d <= lim && d < bd) { bd = d; best = p; gap = 0; continue; }
        // varco da porta: la parete sta oltre l'estremo, a 55-130 cm dalla sua faccia
        const free = (p.c - e) * out - p.t / 2;
        if (doorPx && free > lim - p.t / 2 && free <= doorPx && d < bd) {
          // non si attraversano altre pareti per arrivarci
          const blocked = walls.some(q => q !== p && q.h !== w.h && (q.c - e) * out > 0 && (q.c - e) * out < (p.c - e) * out &&
            w.c >= q.a - q.t / 2 && w.c <= q.b + q.t / 2);
          if (!blocked) { bd = d; best = p; gap = free; }
        }
      }
      if (best) {
        if (gap > 0) {
          const face = best.c - out * best.t / 2;
          w.gaps.push(out > 0 ? [e, face] : [face, e]);
        }
        w[end] = best.c;
        // e la perpendicolare arriva fino a w, se le manca poco
        if (best.a > w.c && best.a - w.c <= w.t / 2 + tolPx) best.a = w.c;
        if (best.b < w.c && w.c - best.b <= w.t / 2 + tolPx) best.b = w.c;
      }
    }
  }
  return walls;
}

/**
 * Pareti della foto. map = { w, h, gray } (pixel), k = cm per pixel.
 * Restituisce { walls: [{ x0, y0, x1, y1, t }], doors: [{ x, y, width }] } in pixel.
 */
export function detectWalls(map, k, dbg) {
  const { w, h, gray } = map;
  const T = 185;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = gray[i] < T ? 1 : 0;
  const MINLEN = 14, GAP = 2;
  const MAXT = Math.max(8, Math.round(75 / k));      // muri fino a 75 cm
  const hs = segments(gray, w, h, T, true, MINLEN, GAP);
  const vs = segments(gray, w, h, T, false, MINLEN, GAP);
  const MASS = wallMass(hs.concat(vs));
  if (dbg) { dbg.MASS = MASS; dbg.vs = vs; dbg.hs = hs; }
  markCombs(hs.filter(s => s.mass >= MASS), MAXT);
  markCombs(vs.filter(s => s.mass >= MASS), MAXT);
  const raw = pairsOf(hs, ink, w, h, MAXT, MINLEN, MASS).concat(pairsOf(vs, ink, w, h, MAXT, MINLEN, MASS));
  const gapPx = 135 / k;
  let walls = merge(merge(raw, gapPx), gapPx);
  walls = walls.filter(x => x.b - x.a >= Math.max(2.2 * x.t, 40 / k));
  // coppie di linee dentro un muro piu' spesso (vetri delle finestre, doppie linee dell'intonaco): via
  walls = walls.filter(x => !walls.some(y => y !== x && y.h === x.h && y.t > x.t + 2 && Math.abs(x.c - y.c) < y.t / 2 &&
    Math.min(x.b, y.b) - Math.max(x.a, y.a) >= 0.7 * (x.b - x.a)));
  // prima si uniscono i doppioni, poi si chiudono gli angoli (cosi' le linee d'asse non si spostano piu')
  walls = joinCorners(joinCorners(merge(walls, 4), 30 / k), 30 / k, 130 / k);
  // porte: varchi tra 55 e 130 cm nelle pareti sottili (interne)
  const doors = [];
  for (const x of walls) {
    if (x.t * k > 25) continue;
    for (const [g0, g1] of x.gaps) {
      const cm = (g1 - g0) * k;
      if (cm >= 55 && cm <= 130) doors.push(x.h ? { x: (g0 + g1) / 2, y: x.c, width: Math.round(cm / 5) * 5 } : { x: x.c, y: (g0 + g1) / 2, width: Math.round(cm / 5) * 5 });
    }
  }
  return {
    walls: walls.map(x => x.h ? { x0: x.a, y0: x.c, x1: x.b, y1: x.c, t: x.t } : { x0: x.c, y0: x.a, x1: x.c, y1: x.b, t: x.t }),
    doors,
  };
}
