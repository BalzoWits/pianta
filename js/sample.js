// Appartamento di esempio (circa 80 m²): soggiorno con cucina, camera, studio, bagno e disimpegno, arredati.
import * as G from './geom.js';
import { newItem } from './furniture.js';
import { OPENING_TYPES } from './plan2d.js';

/** Apertura nel punto p (sulla linea d'asse di una parete). */
export function addOpeningAt(doc, p, type, extra = {}) {
  const def = OPENING_TYPES[type];
  let best = null;
  for (const w of doc.walls) {
    const A = G.nodeById(doc, w.a), B = G.nodeById(doc, w.b);
    const pr = G.projSeg(p, A, B);
    if (pr.d < 1 && (!best || pr.d < best.pr.d)) best = { w, pr, A };
  }
  if (!best) return null;
  const o = { id: G.newId('o'), wall: best.w.id, pos: G.dist(best.A, best.pr.p), type, width: def.width, height: def.height, sill: def.sill, hinge: 'a', swing: 'L', open: 90, ...extra };
  doc.openings.push(o);
  return o;
}

export function sampleDoc() {
  const d = G.emptyDoc('Appartamento di esempio');
  const P = (x, y) => ({ x, y });
  const ext = { thickness: 30 }, int = { thickness: 10 };
  const outer = [P(0, 0), P(1000, 0), P(1000, 800), P(0, 800)];
  for (let i = 0; i < 4; i++) G.addWall(d, outer[i], outer[(i + 1) % 4], ext);
  G.addWall(d, P(600, 0), P(600, 800), int);
  G.addWall(d, P(0, 550), P(600, 550), int);
  G.addWall(d, P(600, 450), P(1000, 450), int);
  G.addWall(d, P(750, 450), P(750, 800), int);
  // porte
  addOpeningAt(d, P(600, 500), 'door', { width: 80 });
  addOpeningAt(d, P(600, 690), 'door', { width: 80 });
  addOpeningAt(d, P(675, 450), 'door', { width: 80 });
  addOpeningAt(d, P(750, 630), 'door', { width: 70 });
  addOpeningAt(d, P(675, 800), 'door', { width: 90, color: '#7a5a3f' });
  // finestre
  addOpeningAt(d, P(160, 0), 'window', { width: 140 });
  addOpeningAt(d, P(420, 0), 'french', { width: 140 });
  addOpeningAt(d, P(800, 0), 'window', { width: 120 });
  addOpeningAt(d, P(1000, 225), 'window', { width: 120 });
  addOpeningAt(d, P(0, 675), 'window', { width: 120 });
  addOpeningAt(d, P(1000, 625), 'window', { width: 80, sill: 110, height: 110 });
  addOpeningAt(d, P(0, 260), 'window', { width: 120 });
  // il verso delle porte: verso le stanze, non nel disimpegno
  fixDoorSwings(d);
  // stanze
  const room = (x, y, name, floor, wallColor) => d.rooms.push({ id: G.newId('r'), x, y, name, floor, wallColor });
  room(230, 120, 'Soggiorno', 'parquet', '#f4f1ea');
  room(150, 640, 'Studio', 'parquet', '#c9d3d8');
  room(800, 330, 'Camera', 'parquet', '#e6cfc0');
  room(675, 560, 'Disimpegno', 'parquet', '#f4f1ea');
  room(870, 580, 'Bagno', 'gres', '#ffffff');
  // arredi
  const add = (kind, x, y, rot, extra = {}) => { const it = newItem(kind, x, y); it.rot = rot; Object.assign(it, extra); d.items.push(it); return it; };
  // soggiorno
  add('tappeto', 190, 260, 90, { w: 220, d: 170 });
  add('mobileTV', 37.5, 260, 270);
  add('divano3', 300, 260, 90);
  add('tavolino', 175, 260, 90);
  add('pianta', 45, 120, 0);
  add('lampadaTerra', 335, 130, 0);
  // cucina lungo la parete
  add('frigo', 562.5, 47.5, 90, { d: 65 });
  add('lavello', 565, 125, 90);
  add('baseCucina', 565, 200, 90);
  add('fornelli', 565, 260, 90);
  add('baseCucina', 565, 320, 90);
  add('pensile', 577.5, 200, 90, { w: 60 });
  add('pensile', 577.5, 320, 90, { w: 60 });
  add('tavolo', 450, 430, 0, { w: 140, d: 80 });
  for (const x of [415, 485]) { add('sedia', x, 370, 0); add('sedia', x, 490, 180); }
  // camera
  add('letto2', 880, 225, 90);
  add('comodino', 965, 115, 90);
  add('comodino', 965, 335, 90);
  add('armadio', 635, 225, 270, { w: 220 });
  add('tappeto', 760, 225, 90, { w: 160, d: 80, color: '#cbbfae' });
  // studio
  add('scrivania', 45, 675, 270, { w: 130 });
  add('sedia', 100, 675, 90, { color: '#2f4858' });
  add('letto1', 430, 680, 180);
  add('libreria', 200, 572.5, 0, { w: 120 });
  // bagno
  add('doccia', 805, 505, 0);
  add('wc', 957.5, 700, 90);
  add('bidet', 957.5, 755, 90);
  add('lavabo', 860, 761, 180);
  // luci
  for (const [x, y] of [[230, 260], [450, 430], [800, 225], [300, 675], [870, 640], [675, 620]]) add('lampadario', x, y, 0);
  return d;
}

/** Porte del disimpegno: si aprono verso la stanza piu' grande (non verso il corridoio). */
function fixDoorSwings(d) {
  const corners = G.wallCorners(d);
  const rooms = G.findRooms(d, corners);
  for (const o of d.openings) {
    if (o.type !== 'door') continue;
    const sides = { L: 0, R: 0 };
    for (const r of rooms) for (const e of r.edges) if (e.wall === o.wall) sides[e.side] = r.area;
    if (sides.L || sides.R) o.swing = sides.L >= sides.R ? 'L' : 'R';
  }
}
