// Geometria della pianta. Tutte le misure sono in centimetri; x verso destra, y verso il basso
// (come sullo schermo). Il documento contiene nodi (estremi delle pareti, condivisi) e pareti tra
// due nodi; le stanze NON si disegnano: sono le zone chiuse dalle pareti, ricavate qui.

export const EPS = 1e-6;
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = a => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = a => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
export const perp = a => ({ x: -a.y, y: a.x });

export function newId(pfx = '') { return pfx + Math.random().toString(36).slice(2, 9); }

export function emptyDoc(name = 'Nuova casa') {
  return {
    v: 1, name,
    settings: { wallHeight: 270, wallThickness: 12, grid: 10, exteriorColor: '#e9e4da', showDims: true, showAreas: true },
    nodes: [], walls: [], openings: [], rooms: [], items: [], dims: [], models: {},
    background: null,
    view: null,
  };
}

export const nodeById = (doc, id) => doc.nodes.find(n => n.id === id);
export const wallById = (doc, id) => doc.walls.find(w => w.id === id);

/** Distanza punto-segmento: { d, t (0..1), p (punto proiettato) } */
export function projSeg(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  let t = l2 < EPS ? 0 : dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = add(a, mul(ab, t));
  return { d: dist(p, q), t, p: q };
}

/** Intersezione propria di due segmenti (non agli estremi): { t, u, p } o null */
export function segInter(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return null;
  const t = cross(sub(c, a), s) / den, u = cross(sub(c, a), r) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t, u, p: add(a, mul(r, t)) };
}

export function lineInter(p, u, q, v) {
  const den = cross(u, v);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(q, p), v) / den;
  return add(p, mul(u, t));
}

export function wallLength(doc, w) { return dist(nodeById(doc, w.a), nodeById(doc, w.b)); }

// ---------------- modifica del grafo delle pareti ----------------

export function findNode(doc, p, tol) {
  let best = null, bd = tol;
  for (const n of doc.nodes) { const d = dist(n, p); if (d <= bd) { bd = d; best = n; } }
  return best;
}

export function addNode(doc, p) {
  const n = { id: newId('n'), x: p.x, y: p.y };
  doc.nodes.push(n);
  return n;
}

/** Divide la parete nel punto p (proiettato): restituisce il nodo nuovo. Le aperture seguono il loro tratto. */
export function splitWall(doc, w, p) {
  const A = nodeById(doc, w.a), B = nodeById(doc, w.b);
  const pr = projSeg(p, A, B);
  if (dist(pr.p, A) < 0.5) return A;
  if (dist(pr.p, B) < 0.5) return B;
  const n = addNode(doc, pr.p);
  const w2 = { ...w, id: newId('w'), a: n.id, b: w.b };
  w.b = n.id;
  doc.walls.push(w2);
  const cut = dist(A, n);
  for (const o of doc.openings) if (o.wall === w.id && o.pos > cut) { o.wall = w2.id; o.pos -= cut; }
  return n;
}

/** Nodo in p: uno esistente vicino, o un punto su una parete (che viene divisa), o uno nuovo. */
export function nodeAt(doc, p, tol = 1) {
  const ex = findNode(doc, p, tol);
  if (ex) return ex;
  for (const w of doc.walls) {
    const pr = projSeg(p, nodeById(doc, w.a), nodeById(doc, w.b));
    if (pr.d <= tol && pr.t > 0 && pr.t < 1) return splitWall(doc, w, p);
  }
  return addNode(doc, p);
}

/** Aggiunge una parete tra p1 e p2 dividendo le pareti che incrocia. Restituisce le pareti create. */
export function addWall(doc, p1, p2, props = {}) {
  if (dist(p1, p2) < 1) return [];
  const n1 = nodeAt(doc, p1), n2 = nodeAt(doc, p2);
  if (n1 === n2) return [];
  // incroci con le pareti esistenti
  const cuts = [];
  for (const w of doc.walls.slice()) {
    if (w.a === n1.id || w.b === n1.id || w.a === n2.id || w.b === n2.id) continue;
    const A = nodeById(doc, w.a), B = nodeById(doc, w.b);
    const it = segInter(n1, n2, A, B);
    if (it && it.t > 0.001 && it.t < 0.999) {
      const n = (it.u > 0.001 && it.u < 0.999) ? splitWall(doc, w, it.p) : (it.u <= 0.001 ? A : B);
      cuts.push({ t: it.t, n });
    }
  }
  // nodi esistenti che cadono sulla parete nuova
  for (const n of doc.nodes) {
    if (n === n1 || n === n2 || cuts.some(c => c.n === n)) continue;
    const pr = projSeg(n, n1, n2);
    if (pr.d < 0.5 && pr.t > 0.001 && pr.t < 0.999) cuts.push({ t: pr.t, n });
  }
  cuts.sort((a, b) => a.t - b.t);
  const chain = [n1, ...cuts.map(c => c.n), n2];
  const made = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i], b = chain[i + 1];
    if (a === b) continue;
    if (doc.walls.some(w => (w.a === a.id && w.b === b.id) || (w.a === b.id && w.b === a.id))) continue;
    const w = { id: newId('w'), a: a.id, b: b.id, thickness: props.thickness ?? doc.settings.wallThickness, height: props.height ?? null };
    if (props.virtual) w.virtual = true; // divisore: separa le stanze ma non e' un muro
    doc.walls.push(w);
    made.push(w);
  }
  return made;
}

export function removeWall(doc, w) {
  doc.walls = doc.walls.filter(x => x !== w);
  doc.openings = doc.openings.filter(o => o.wall !== w.id);
  cleanup(doc);
}

export function degree(doc, nid) { return doc.walls.reduce((k, w) => k + (w.a === nid) + (w.b === nid), 0); }

/** Toglie i nodi isolati e unisce due pareti allineate che si incontrano in un nodo senza altre pareti. */
export function cleanup(doc) {
  let again = true;
  while (again) {
    again = false;
    for (const n of doc.nodes) {
      const inc = doc.walls.filter(w => w.a === n.id || w.b === n.id);
      if (inc.length !== 2) continue;
      const [w1, w2] = inc;
      if (Math.abs(w1.thickness - w2.thickness) > 0.01 || (w1.height || 0) !== (w2.height || 0) || !!w1.virtual !== !!w2.virtual) continue;
      const o1 = nodeById(doc, w1.a === n.id ? w1.b : w1.a), o2 = nodeById(doc, w2.a === n.id ? w2.b : w2.a);
      const d1 = norm(sub(n, o1)), d2 = norm(sub(o2, n));
      if (Math.abs(cross(d1, d2)) > 1e-4 || dot(d1, d2) < 0) continue;
      // w1 diventa o1 -> o2; le aperture sono riportate dall'estremo o1
      const len1 = dist(o1, n);
      const flip1 = w1.a !== o1.id; // w1 andava da n a o1?
      const L1 = dist(o1, n);
      for (const o of doc.openings) {
        if (o.wall === w1.id) { if (flip1) o.pos = L1 - o.pos; }
        else if (o.wall === w2.id) { const fromN = w2.a === n.id ? o.pos : dist(n, o2) - o.pos; o.wall = w1.id; o.pos = len1 + fromN; }
      }
      w1.a = o1.id; w1.b = o2.id;
      doc.walls = doc.walls.filter(w => w !== w2);
      again = true;
      break;
    }
  }
  const used = new Set();
  for (const w of doc.walls) { used.add(w.a); used.add(w.b); }
  doc.nodes = doc.nodes.filter(n => used.has(n.id));
}

/** Imposta la lunghezza di una parete spostando l'estremo indicato ('b' di default). */
export function setWallLength(doc, w, L, end = 'b') {
  const A = nodeById(doc, w.a), B = nodeById(doc, w.b);
  const fixed = end === 'b' ? A : B, moving = end === 'b' ? B : A;
  const d = norm(sub(moving, fixed));
  moving.x = fixed.x + d.x * L; moving.y = fixed.y + d.y * L;
}

// ---------------- spigoli delle pareti (giunzioni a 45°) ----------------

/**
 * Per ogni parete calcola i 4 spigoli: L e R sono il lato sinistro/destro guardando da a verso b
 * (sinistra = perp(d) = (-dy, dx)). Restituisce Map wallId -> { aL, aR, bL, bR, d, n, A, B }.
 */
export function wallCorners(doc) {
  const res = new Map();
  const byNode = new Map();
  for (const w of doc.walls) {
    const A = nodeById(doc, w.a), B = nodeById(doc, w.b);
    const d = norm(sub(B, A));
    res.set(w.id, { A, B, d, n: perp(d), h: w.thickness / 2, aL: null, aR: null, bL: null, bR: null });
    for (const [nid, end, u] of [[w.a, 'a', d], [w.b, 'b', mul(d, -1)]]) {
      if (!byNode.has(nid)) byNode.set(nid, []);
      byNode.get(nid).push({ w, end, u, ang: Math.atan2(u.y, u.x) });
    }
  }
  for (const [nid, list] of byNode) {
    const N = nodeById(doc, nid);
    list.sort((p, q) => p.ang - q.ang);
    const k = list.length;
    for (let i = 0; i < k; i++) {
      const cur = list[i], nxt = list[(i + 1) % k];
      const hc = cur.w.thickness / 2, hn = nxt.w.thickness / 2;
      // lato "sinistro" di cur (rispetto alla sua uscita u) e lato "destro" di nxt
      const nc = perp(cur.u), nn = perp(nxt.u);
      let p;
      if (k === 1) p = null;
      else {
        p = lineInter(add(N, mul(nc, hc)), cur.u, add(N, mul(nn, -hn)), nxt.u);
        if (p && dist(p, N) > 4 * Math.max(hc, hn)) p = null; // angolo troppo acuto: niente punta
      }
      const left = p || add(N, mul(nc, hc));
      const right = p || add(N, mul(nn, -hn));
      setCorner(res.get(cur.w.id), cur.end, 'left', left);
      setCorner(res.get(nxt.w.id), nxt.end, 'right', right);
    }
    if (k === 1) {
      const c = list[0];
      setCorner(res.get(c.w.id), c.end, 'right', add(N, mul(perp(c.u), -c.w.thickness / 2)));
    }
  }
  return res;
}
// "left/right" rispetto all'uscita dal nodo; all'estremo b l'uscita e' opposta a d, quindi si invertono
function setCorner(c, end, side, p) {
  if (end === 'a') { if (side === 'left') c.aL = p; else c.aR = p; }
  else { if (side === 'left') c.bR = p; else c.bL = p; }
}

/** Poligono pieno della parete, compresi i nodi (riempie il centro delle giunzioni). */
export function wallPolygon(c) { return [c.aL, c.bL, c.B, c.bR, c.aR, c.A]; }

/** Coordinate locali della parete: s lungo la parete da A, o verso sinistra. */
export const toLocal = (c, p) => ({ s: dot(sub(p, c.A), c.d), o: dot(sub(p, c.A), c.n) });
export const toWorld = (c, s, o) => ({ x: c.A.x + c.d.x * s + c.n.x * o, y: c.A.y + c.d.y * s + c.n.y * o });

/** Taglia un poligono (punti {s,o}) alla fascia s0 <= s <= s1. */
export function clipSlab(poly, s0, s1) {
  const clip = (pts, keep, inter) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const kp = keep(p), kq = keep(q);
      if (kp) out.push(p);
      if (kp !== kq) out.push(inter(p, q));
    }
    return out;
  };
  const at = s => (p, q) => { const t = (s - p.s) / (q.s - p.s); return { s, o: p.o + (q.o - p.o) * t }; };
  let r = clip(poly, p => p.s >= s0 - 1e-9, at(s0));
  r = clip(r, p => p.s <= s1 + 1e-9, at(s1));
  return r;
}

/** Aperture della parete ordinate, con gli intervalli [s0,s1] ristretti alla parete. */
export function wallOpenings(doc, w) {
  const L = wallLength(doc, w);
  return doc.openings.filter(o => o.wall === w.id).map(o => ({
    o, s0: Math.max(0, o.pos - o.width / 2), s1: Math.min(L, o.pos + o.width / 2),
  })).sort((a, b) => a.s0 - b.s0);
}

// ---------------- stanze (facce del grafo planare) ----------------

export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}
export function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function polyCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < EPS) return { ...poly[0] };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}
/** Un punto sicuramente interno (per l'etichetta): il centroide se e' dentro, altrimenti il centro della fascia orizzontale piu' larga. */
export function interiorPoint(poly) {
  const c = polyCentroid(poly);
  if (pointInPoly(c, poly)) return c;
  let best = c, bw = -1;
  const ys = poly.map(p => p.y).sort((a, b) => a - b);
  for (let i = 0; i < ys.length - 1; i++) {
    const y = (ys[i] + ys[i + 1]) / 2;
    const xs = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > bw) { bw = xs[k + 1] - xs[k]; best = { x: (xs[k] + xs[k + 1]) / 2, y }; }
  }
  return best;
}

/**
 * Facce chiuse dal grafo delle pareti. Ogni faccia: { edges: [{ wall, side:'L'|'R' }], poly (linee
 * d'asse), inner (filo interno dei muri), area (m², filo interno) }. La faccia esterna viene scartata.
 */
export function findRooms(doc, corners = wallCorners(doc)) {
  const out = new Map(); // nodeId -> semi-lati uscenti ordinati per angolo
  const half = [];
  for (const w of doc.walls) {
    const A = nodeById(doc, w.a), B = nodeById(doc, w.b);
    const h1 = { w, from: A, to: B, fwd: true }, h2 = { w, from: B, to: A, fwd: false };
    h1.twin = h2; h2.twin = h1;
    half.push(h1, h2);
  }
  for (const h of half) {
    h.ang = Math.atan2(h.to.y - h.from.y, h.to.x - h.from.x);
    if (!out.has(h.from.id)) out.set(h.from.id, []);
    out.get(h.from.id).push(h);
  }
  for (const list of out.values()) { list.sort((a, b) => a.ang - b.ang); list.forEach((h, i) => { h.idx = i; }); }
  const seen = new Set();
  const faces = [];
  for (const h0 of half) {
    if (seen.has(h0)) continue;
    const edges = [];
    let h = h0, guard = 0;
    while (!seen.has(h) && guard++ < 10000) {
      seen.add(h);
      edges.push(h);
      const list = out.get(h.to.id);
      const t = h.twin;
      h = list[(t.idx - 1 + list.length) % list.length];
    }
    const poly = edges.map(e => ({ x: e.from.x, y: e.from.y }));
    const a = polyArea(poly);
    // con y verso il basso e questo giro, le stanze hanno area positiva; la faccia esterna negativa
    if (a < 1) continue;
    // la stanza sta dal lato perp(direzione del semi-lato): lato L della parete se il semi-lato va da a a b
    const inner = edges.map(e => {
      const c = corners.get(e.w.id);
      return e.fwd ? c.bL : c.aR;
    });
    faces.push({
      edges: edges.map(e => ({ wall: e.w.id, side: e.fwd ? 'L' : 'R' })),
      poly, inner, area: Math.abs(polyArea(inner)) / 10000,
    });
  }
  return faces;
}

/** Associa ogni stanza trovata alla sua etichetta (doc.rooms, un punto ciascuna). */
export function matchRooms(doc, faces) {
  const res = faces.map(f => ({ ...f, label: null }));
  for (const r of doc.rooms) {
    const f = res.filter(f => pointInPoly(r, f.poly)).sort((a, b) => a.area - b.area)[0];
    if (f && !f.label) f.label = r;
  }
  return res;
}
