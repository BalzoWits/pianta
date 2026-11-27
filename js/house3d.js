// Costruisce la casa in 3D dal documento: pareti (con i fori di porte e finestre), pavimenti, soffitti,
// serramenti e mobili. Pianta in cm (x, y) -> three.js in metri (x, z), y verso l'alto.
import * as THREE from 'three';
import * as G from './geom.js';
import { solid, floorMaterial, GLASS, CHROME } from './materials.js';
import { buildItem } from './furniture.js';

const M = 0.01;

/** Prisma verticale da un poligono in pianta (cm) tra le quote z0 e z1 (cm). sideMat(nx, ny) -> indice materiale. */
function prism(poly, z0, z1, sideMat, capMat = 0) {
  const pts = poly.filter((p, i) => G.dist(p, poly[(i + 1) % poly.length]) > 0.01);
  if (pts.length < 3) return null;
  if (G.polyArea(pts) < 0) pts.reverse(); // area positiva = senso orario sullo schermo
  const pos = [], nor = [], groups = [];
  // triangolo con i vertici ordinati in modo che la faccia guardi verso n
  const T = (out, a, b, c, n) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) [b, c] = [c, b];
    out.push(a, b, c);
  };
  const push = (mat, verts, n) => { groups.push({ mat, start: pos.length / 3, count: verts.length }); for (const v of verts) { pos.push(v[0], v[1], v[2]); nor.push(n[0], n[1], n[2]); } };
  const tri = THREE.ShapeUtils.triangulateShape(pts.map(p => new THREE.Vector2(p.x, p.y)), []);
  const V = (p, z) => [p.x * M, z * M, p.y * M];
  const top = [], bot = [];
  for (const [a, b, c] of tri) {
    T(top, V(pts[a], z1), V(pts[b], z1), V(pts[c], z1), [0, 1, 0]);
    T(bot, V(pts[a], z0), V(pts[b], z0), V(pts[c], z0), [0, -1, 0]);
  }
  push(capMat, top, [0, 1, 0]); push(capMat, bot, [0, -1, 0]);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const d = G.norm(G.sub(q, p));
    const n = { x: d.y, y: -d.x }; // verso l'esterno con area positiva (y in basso)
    const N = [n.x, 0, n.y];
    const quad = [];
    T(quad, V(p, z0), V(q, z0), V(q, z1), N); T(quad, V(p, z0), V(q, z1), V(p, z1), N);
    push(sideMat(n.x, n.y), quad, N);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  // unisce i gruppi consecutivi con lo stesso materiale
  groups.sort((a, b) => a.start - b.start);
  let cur = null;
  for (const gr of groups) {
    if (cur && cur.mat === gr.mat && cur.start + cur.count === gr.start) cur.count += gr.count;
    else { if (cur) g.addGroup(cur.start, cur.count, cur.mat); cur = { ...gr }; }
  }
  if (cur) g.addGroup(cur.start, cur.count, cur.mat);
  return g;
}

/** Colore di ogni lato di parete in base alla stanza che guarda. */
function wallSideColors(doc, rooms) {
  const map = new Map();
  for (const r of rooms) {
    const col = r.label && r.label.wallColor;
    for (const e of r.edges) map.set(e.wall + e.side, col || '#f4f1ea');
  }
  return map;
}

/**
 * opts: { ceilings: bool, models: Map id->BufferGeometry, cutHeight: cm o null (pareti tagliate) }
 * Restituisce { group, bounds, rooms }
 */
export function buildHouse(doc, opts = {}) {
  const S = doc.settings;
  const H = S.wallHeight;
  const group = new THREE.Group();
  const corners = G.wallCorners(doc);
  const rooms = G.matchRooms(doc, G.findRooms(doc, corners));
  const sideCol = wallSideColors(doc, rooms);
  const ext = S.exteriorColor || '#e9e4da';
  const topMat = solid('#9a958c', { rough: 0.9 });

  // ---- pareti ----
  for (const w of doc.walls) {
    if (w.virtual) continue; // divisore: solo nella pianta
    const c = corners.get(w.id);
    const wh = w.height || H;
    const hTop = opts.cutHeight ? Math.min(wh, opts.cutHeight) : wh;
    const L = G.dist(c.A, c.B);
    const mats = [topMat, solid(sideCol.get(w.id + 'L') || ext, { rough: 0.9 }), solid(sideCol.get(w.id + 'R') || ext, { rough: 0.9 })];
    const sideMat = (nx, ny) => { const k = nx * c.n.x + ny * c.n.y; return k > 0.7 ? 1 : k < -0.7 ? 2 : 0; };
    const loc = G.wallPolygon(c).map(p => G.toLocal(c, p));
    const ops = G.wallOpenings(doc, w);
    // fasce piene e fasce con apertura lungo la parete
    const cuts = [];
    let s = -1e6;
    for (const o of ops) { if (o.s0 > s) cuts.push({ s0: s, s1: o.s0, op: null }); cuts.push({ s0: o.s0, s1: o.s1, op: o.o }); s = Math.max(s, o.s1); }
    cuts.push({ s0: s, s1: 1e6, op: null });
    const wallGroup = new THREE.Group();
    wallGroup.userData.wall = w.id;
    for (const k of cuts) {
      if (k.s1 - k.s0 < 0.01) continue;
      const poly = G.clipSlab(loc, k.s0, k.s1).map(p => G.toWorld(c, p.s, p.o));
      const spans = k.op ? [[0, Math.min(k.op.sill || 0, hTop)], [Math.min((k.op.sill || 0) + k.op.height, hTop), hTop]] : [[0, hTop]];
      for (const [z0, z1] of spans) {
        if (z1 - z0 < 0.1) continue;
        const geo = prism(poly, z0, z1, sideMat);
        if (!geo) continue;
        const mesh = new THREE.Mesh(geo, mats);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.wall = w.id;
        wallGroup.add(mesh);
      }
    }
    group.add(wallGroup);
    // serramenti
    for (const o of ops) {
      const op = o.o;
      if ((op.sill || 0) >= hTop) continue;
      group.add(buildOpening(op, c, w, Math.min(op.height, hTop - (op.sill || 0))));
    }
  }

  // ---- pavimenti e soffitti ----
  for (const r of rooms) {
    const key = (r.label && r.label.floor) || 'parquet';
    const fm = floorMaterial(key);
    const floor = prism(r.poly, -4, 0, () => 1, 0);
    if (floor) {
      uvPlanar(floor, fm.userData);
      const m = new THREE.Mesh(floor, [fm, solid('#bbb')]);
      m.receiveShadow = true;
      m.userData.room = r.label ? r.label.id : null;
      m.userData.floor = true;
      group.add(m);
    }
    if (opts.ceilings) {
      const ce = prism(r.poly, H, H + 6, () => 0, 0);
      if (ce) { const m = new THREE.Mesh(ce, solid((r.label && r.label.ceilColor) || '#f7f5f0', { rough: 0.95 })); m.receiveShadow = true; m.castShadow = true; m.userData.ceiling = true; group.add(m); }
    }
  }

  // ---- mobili ----
  for (const it of doc.items) {
    const g = buildItem(it, H, opts.models && it.model ? opts.models.get(it.model) : null);
    group.add(g);
  }
  const bounds = new THREE.Box3().setFromObject(group);
  return { group, bounds, rooms };
}

function uvPlanar(geo, ud) {
  const p = geo.getAttribute('position');
  const uv = new Float32Array(p.count * 2);
  const W = (ud.texSize || 100) * M, H = (ud.texH || ud.texSize || 100) * M;
  const a = (ud.texRot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    uv[i * 2] = (x * ca + z * sa) / W; uv[i * 2 + 1] = (-x * sa + z * ca) / H;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Telaio, anta e vetro di un'apertura. */
function buildOpening(op, c, w, h) {
  const g = new THREE.Group();
  const t = w.thickness;
  const W = op.width;
  const frameMat = solid(op.frameColor || (op.type === 'window' || op.type === 'french' ? '#f4f4f2' : '#e9e5dd'), { rough: 0.5 });
  // sistema locale: x lungo la parete, z = normale (lato L positivo), y su
  const P = G.toWorld(c, op.pos, 0);
  g.position.set(P.x * M, (op.sill || 0) * M, P.y * M);
  g.rotation.y = -Math.atan2(c.d.y, c.d.x);
  // con questa rotazione l'asse x locale va lungo d e l'asse z locale lungo n (perp in pianta, y verso il basso)
  const B = (bw, bh, bd, x, y, z, m) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw * M, bh * M, bd * M), m); mesh.position.set(x * M, (y + bh / 2) * M, z * M); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh; };
  if (op.type === 'opening') return g;
  const f = 5; // profilo del telaio
  if (op.type === 'door' || op.type === 'door2' || op.type === 'slide' || op.type === 'pocket') {
    const fd = t + 2;
    B(f, h, fd, -W / 2 + f / 2, 0, 0, frameMat); B(f, h, fd, W / 2 - f / 2, 0, 0, frameMat); B(W, f, fd, 0, h - f, 0, frameMat);
    const leafMat = solid(op.color || '#efebe3', { rough: 0.45 });
    const lw = W - 2 * f, lh = h - f;
    const side = op.swing === 'R' ? -1 : 1; // verso che lato si apre
    const ang = (op.open ?? 90) * Math.PI / 180;
    const leaves = op.type === 'door2' ? [[-1, lw / 2], [1, lw / 2]] : [[op.hinge === 'b' ? 1 : -1, lw]];
    if (op.type === 'slide' || op.type === 'pocket') {
      // scorrevole esterna: anta fuori dal muro; a scomparsa: anta dentro il muro (si vede solo la parte nel vano)
      const dir = op.hinge === 'b' ? 1 : -1;
      const sh = lw * (op.slide ?? (op.type === 'pocket' ? 0.85 : 0.6)) * dir;
      const leaf = B(lw, lh, op.type === 'pocket' ? 3 : 3.5, sh, 0, op.type === 'pocket' ? 0 : side * (t / 2 + 3), leafMat);
      const kn = new THREE.Mesh(new THREE.BoxGeometry(2 * M, 14 * M, 4 * M), CHROME);
      kn.position.set((sh - dir * (lw / 2 - 5)) * M, 100 * M, (op.type === 'pocket' ? 0 : side * (t / 2 + 3)) * M);
      g.add(kn);
      void leaf;
    } else for (const [hs, w2] of leaves) {
      const pivot = new THREE.Group();
      pivot.position.set(hs * (lw / 2) * M, 0, side * (t / 2 - 2) * M);
      pivot.rotation.y = hs * side * ang;
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(w2 * M, lh * M, 4 * M), leafMat);
      leaf.position.set(-hs * w2 / 2 * M, lh / 2 * M, 0);
      leaf.castShadow = leaf.receiveShadow = true;
      pivot.add(leaf);
      const knob = new THREE.Mesh(new THREE.BoxGeometry(12 * M, 2 * M, 2 * M), CHROME);
      knob.position.set(-hs * (w2 - 8) * M, 105 * M, side * 3.5 * M);
      pivot.add(knob);
      g.add(pivot);
    }
  } else {
    // finestra o portafinestra: telaio al centro del muro, una o due ante a vetro
    const fd = 7;
    B(f, h, fd, -W / 2 + f / 2, 0, 0, frameMat); B(f, h, fd, W / 2 - f / 2, 0, 0, frameMat);
    B(W, f, fd, 0, 0, 0, frameMat); B(W, f, fd, 0, h - f, 0, frameMat);
    const panes = W > 90 ? 2 : 1;
    const pw = (W - 2 * f) / panes;
    for (let i = 0; i < panes; i++) {
      const x0 = -W / 2 + f + pw * i;
      B(4, h - 2 * f, 5, x0 + 2, f, 0, frameMat); B(4, h - 2 * f, 5, x0 + pw - 2, f, 0, frameMat);
      B(pw, 4, 5, x0 + pw / 2, f, 0, frameMat); B(pw, 4, 5, x0 + pw / 2, h - f - 4, 0, frameMat);
      const gl = B(pw - 8, h - 2 * f - 8, 0.6, x0 + pw / 2, f + 4, 0, GLASS);
      gl.castShadow = false;
      gl.userData.glass = true;
    }
    if (op.type === 'window' && (op.sill || 0) > 0) B(W + 6, 3, t + 6, 0, -3, 0, solid('#dedad3', { rough: 0.4 }));
  }
  return g;
}
