// Modelli 3D importati come arredi: lettura (OBJ, STL, GLB/GLTF), colori dei materiali, semplificazione
// automatica e normalizzazione nel cubo [-1,1]. Nel documento finiscono in base64 (doc.models), cosi'
// viaggiano con il progetto e il salvataggio online.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

export const MAX_TRIS = 15000;

/** File -> { tris: Float32Array (9 per triangolo), cols: Uint8Array (3 per triangolo) } */
export async function readModelFile(file) {
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  let root;
  if (name.endsWith('.stl')) root = new THREE.Mesh(new STLLoader().parse(buf), new THREE.MeshStandardMaterial({ color: 0xd8d2c7 }));
  else if (name.endsWith('.obj')) root = new OBJLoader().parse(new TextDecoder().decode(buf));
  else if (name.endsWith('.glb') || name.endsWith('.gltf')) root = (await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej))).scene;
  else throw new Error('Formato non riconosciuto: usa OBJ, STL, GLB o GLTF');
  root.updateMatrixWorld(true);
  const T = [], C = [];
  const v = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry, p = g.getAttribute('position');
    if (!p) return;
    const idx = g.getIndex();
    const n = idx ? idx.count : p.count;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }];
    for (const gr of groups) {
      const m = mats[gr.materialIndex || 0] || mats[0];
      const col = m && m.color ? m.color.clone().convertLinearToSRGB() : new THREE.Color(0.85, 0.82, 0.78);
      const cr = Math.round(col.r * 255), cg = Math.round(col.g * 255), cb = Math.round(col.b * 255);
      for (let i = gr.start; i + 2 < gr.start + gr.count && i + 2 < n; i += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx.getX(i + k) : i + k;
          v.fromBufferAttribute(p, vi).applyMatrix4(o.matrixWorld);
          T.push(v.x, v.y, v.z);
        }
        C.push(cr, cg, cb);
      }
    }
  });
  if (!T.length) throw new Error('Nel file non ho trovato triangoli');
  return { tris: new Float32Array(T), cols: new Uint8Array(C) };
}

/** Porta il modello nel cubo [-1,1] e restituisce le misure originali (in unita' del file). */
export function normalize(tris) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let a = 0; a < 3; a++) { const x = tris[i + a]; if (x < mn[a]) mn[a] = x; if (x > mx[a]) mx[a] = x; }
  const c = [0, 1, 2].map(a => (mn[a] + mx[a]) / 2);
  const h = [0, 1, 2].map(a => Math.max((mx[a] - mn[a]) / 2, 1e-6));
  const hmax = Math.max(...h);
  const hs = h.map(x => Math.max(x, hmax * 0.01));
  for (let i = 0; i < tris.length; i += 3) for (let a = 0; a < 3; a++) tris[i + a] = (tris[i + a] - c[a]) / hs[a];
  return { size: h.map(x => x * 2) };
}

/** Ruota il modello di 90° attorno a un asse ('x' | 'y' | 'z') per raddrizzarlo (es. STL con Z in alto). */
export function rotate90(tris, axis) {
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (axis === 'x') { tris[i + 1] = -z; tris[i + 2] = y; }
    else if (axis === 'y') { tris[i] = z; tris[i + 2] = -x; }
    else { tris[i] = -y; tris[i + 1] = x; }
  }
  return tris;
}

// semplificazione per raggruppamento dei vertici (come in Orizzonte), con il colore del triangolo
function clusterOnce(tris, cols, G) {
  const nT = tris.length / 9;
  const cellOf = new Int32Array(nT * 3);
  const map = new Map(), sums = [];
  for (let i = 0; i < nT * 3; i++) {
    const x = tris[i * 3], y = tris[i * 3 + 1], z = tris[i * 3 + 2];
    const cx = Math.min(G - 1, Math.floor((x + 1) * 0.5 * G)), cy = Math.min(G - 1, Math.floor((y + 1) * 0.5 * G)), cz = Math.min(G - 1, Math.floor((z + 1) * 0.5 * G));
    const key = (cx * G + cy) * G + cz;
    let id = map.get(key);
    if (id === undefined) { id = sums.length / 4; map.set(key, id); sums.push(0, 0, 0, 0); }
    sums[id * 4] += x; sums[id * 4 + 1] += y; sums[id * 4 + 2] += z; sums[id * 4 + 3]++;
    cellOf[i] = id;
  }
  const seen = new Set(), out = [], oc = [];
  for (let t = 0; t < nT; t++) {
    const a = cellOf[t * 3], b = cellOf[t * 3 + 1], c = cellOf[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    const s = [a, b, c].sort((p, q) => p - q).join(',');
    if (seen.has(s)) continue;
    seen.add(s);
    for (const id of [a, b, c]) { const w = sums[id * 4 + 3]; out.push(sums[id * 4] / w, sums[id * 4 + 1] / w, sums[id * 4 + 2] / w); }
    oc.push(cols[t * 3], cols[t * 3 + 1], cols[t * 3 + 2]);
  }
  return { tris: new Float32Array(out), cols: new Uint8Array(oc) };
}
export function simplify(tris, cols, maxTris = MAX_TRIS) {
  if (tris.length / 9 <= maxTris) return { tris, cols };
  let lo = 8, hi = 1024, best = null;
  for (let it = 0; it < 10; it++) {
    const G = Math.round((lo + hi) / 2);
    const r = clusterOnce(tris, cols, G);
    if (r.tris.length / 9 <= maxTris) { best = r; lo = G + 1; } else hi = G - 1;
    if (hi < lo) break;
  }
  return best || clusterOnce(tris, cols, 8);
}

/** Record del documento -> BufferGeometry (normali con spigoli vivi oltre 35°) */
export function geometryFromRecord(rec) {
  const tris = b64ToF32(rec.pos);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  if (rec.col) {
    const tc = b64ToU8(rec.col);
    const vc = new Float32Array(tris.length);
    const lin = v => Math.pow(v / 255, 2.2);
    for (let t = 0; t < tc.length / 3; t++) for (let k = 0; k < 3; k++) { vc[t * 9 + k * 3] = lin(tc[t * 3]); vc[t * 9 + k * 3 + 1] = lin(tc[t * 3 + 1]); vc[t * 9 + k * 3 + 2] = lin(tc[t * 3 + 2]); }
    g.setAttribute('color', new THREE.BufferAttribute(vc, 3));
  }
  const out = toCreasedNormals(g, 35 * Math.PI / 180);
  g.dispose();
  return out;
}

/** True se tutti i triangoli hanno lo stesso colore (allora il colore si sceglie dal pannello). */
export function singleColor(cols) {
  for (let i = 3; i < cols.length; i += 3) if (cols[i] !== cols[0] || cols[i + 1] !== cols[1] || cols[i + 2] !== cols[2]) return false;
  return true;
}

export function f32ToB64(a) { return u8ToB64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
export function u8ToB64(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
export function b64ToU8(b) { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
export function b64ToF32(b) { const u = b64ToU8(b); return new Float32Array(u.buffer); }
