// Materiali condivisi tra la vista 3D e il render: colori e texture disegnate al volo (niente immagini da scaricare).
import * as THREE from 'three';

// Pavimenti: size = lato della texture in cm (per le coordinate UV)
export const FLOORS = {
  parquet:  { name: 'Parquet rovere', size: 120, draw: c => planks(c, ['#c9a274', '#bf9466', '#d2ad80', '#b98c5d', '#c69c6c'], 8) },
  parquet2: { name: 'Parquet noce', size: 120, draw: c => planks(c, ['#6e4a30', '#7a5436', '#5f3f28', '#83603f', '#6a462d'], 8) },
  sbiancato:{ name: 'Rovere sbiancato', size: 160, draw: c => planks(c, ['#ddd3c4', '#d3c7b6', '#e4dccf', '#cbbfae'], 6) },
  gres:     { name: 'Gres 60×60 chiaro', size: 120, draw: c => tiles(c, 2, '#dcd9d3', '#c9c5be', 0.015) },
  gres2:    { name: 'Gres 60×60 scuro', size: 120, draw: c => tiles(c, 2, '#6c6a67', '#57554f', 0.015) },
  cotto:    { name: 'Cotto 30×30', size: 60, draw: c => tiles(c, 2, '#b86a45', '#a65c3b', 0.03, 18) },
  marmo:    { name: 'Marmo bianco', size: 160, draw: c => marble(c, '#efede9', '#b9b6b0') },
  cemento:  { name: 'Resina / cemento', size: 300, draw: c => noisy(c, '#a9a7a2', 10) },
  mosaico:  { name: 'Mosaico bagno', size: 30, draw: c => tiles(c, 12, '#9cc3c9', '#7fa8b0', 0.08, 25) },
  moquette: { name: 'Moquette grigia', size: 100, draw: c => noisy(c, '#8c8f94', 18) },
};

export const WALL_COLORS = ['#f4f1ea', '#ffffff', '#e8e2d6', '#d9d4cb', '#c9d3d8', '#b9c7b4', '#e6cfc0', '#d6b98f', '#9aa7b3', '#6f7b70', '#a35d4a', '#3e4550'];
export const ITEM_COLORS = ['#f2efe9', '#d8d2c7', '#a89f91', '#6b6259', '#3b3733', '#1f1e1d', '#c9a274', '#8a5a3b', '#b9c7b4', '#5f7f8c', '#2f4858', '#b5473a', '#d9a441', '#7d6a99'];

// ---------- pavimenti dalle immagini dell'utente (doc.textures, chiave "img:<id>") ----------
const custom = new Map(); // id -> { tex, size, tint, src }
let onCustomReady = null;
export function onTextureLoaded(fn) { onCustomReady = fn; }
/** Allinea le texture dell'utente con quelle del documento. */
export function setCustomFloors(textures) {
  for (const [id, t] of Object.entries(textures || {})) {
    const cur = custom.get(id);
    if (cur && cur.src === t.src) { if (cur.size !== t.size) { cur.size = t.size; matCache.delete('floor:img:' + id); } continue; }
    const tex = new THREE.Texture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const e = { tex, size: t.size || 60, tint: '#eeeeee', src: t.src };
    custom.set(id, e);
    matCache.delete('floor:img:' + id);
    const img = new Image();
    img.onload = () => {
      tex.image = img; tex.needsUpdate = true;
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, 1, 1);
      const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
      // tinta chiara per la pianta 2D
      e.tint = `rgb(${Math.round(r + (255 - r) * 0.55)},${Math.round(g + (255 - g) * 0.55)},${Math.round(b + (255 - b) * 0.55)})`;
      if (onCustomReady) onCustomReady();
    };
    img.src = t.src;
  }
}
export const isCustomFloor = key => typeof key === 'string' && key.startsWith('img:');
export function floorTint(key) { const e = isCustomFloor(key) && custom.get(key.slice(4)); return e ? e.tint : null; }

const texCache = new Map();
export function floorTexture(key) {
  const def = FLOORS[key] || FLOORS.parquet;
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  def.draw(c);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  texCache.set(key, t);
  return t;
}
/** Piccola anteprima del pavimento (dataURL) per i bottoni del pannello. */
const thumbCache = new Map();
export function floorThumb(key) {
  if (isCustomFloor(key)) { const e = custom.get(key.slice(4)); return e ? e.src : ''; }
  if (thumbCache.has(key)) return thumbCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  (FLOORS[key] || FLOORS.parquet).draw(c);
  const s = document.createElement('canvas');
  s.width = s.height = 64;
  s.getContext('2d').drawImage(c, 0, 0, 64, 64);
  const u = s.toDataURL();
  thumbCache.set(key, u);
  return u;
}

// ---------- disegno delle texture ----------
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = v => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
function grain(ctx, x, y, w, h, base, lines = 14) {
  ctx.fillStyle = base; ctx.fillRect(x, y, w, h);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  for (let i = 0; i < lines; i++) {
    ctx.strokeStyle = `rgba(60,35,15,${0.04 + rnd() * 0.07})`;
    ctx.lineWidth = 0.5 + rnd() * 1.5;
    const yy = y + rnd() * h;
    ctx.beginPath(); ctx.moveTo(x, yy);
    for (let k = 1; k <= 8; k++) ctx.lineTo(x + w * k / 8, yy + (rnd() - 0.5) * h * 0.08);
    ctx.stroke();
  }
  ctx.restore();
}
function planks(c, cols, rows) {
  seed = 7;
  const ctx = c.getContext('2d'), S = c.width, h = S / rows;
  for (let r = 0; r < rows; r++) {
    let x = -rnd() * S * 0.6;
    while (x < S) {
      const w = S * (0.45 + rnd() * 0.5);
      const col = cols[Math.floor(rnd() * cols.length)];
      grain(ctx, x, r * h, w, h, col);
      if (x + w > S) grain(ctx, x - S, r * h, w, h, col); // ripetizione senza cuciture
      ctx.fillStyle = 'rgba(40,25,10,0.35)';
      ctx.fillRect(x, r * h, 1.5, h);
      x += w;
    }
    ctx.fillStyle = 'rgba(40,25,10,0.35)';
    ctx.fillRect(0, r * h, S, 1.5);
  }
}
function tiles(c, n, a, b, grout = 0.02, vary = 8) {
  seed = 11;
  const ctx = c.getContext('2d'), S = c.width, t = S / n;
  ctx.fillStyle = '#bdb8ae'; ctx.fillRect(0, 0, S, S);
  const g = Math.max(1, t * grout);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    ctx.fillStyle = (i + j) % 2 && n > 4 ? b : a;
    ctx.fillRect(i * t + g / 2, j * t + g / 2, t - g, t - g);
    ctx.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${rnd() * vary / 255})`;
    ctx.fillRect(i * t + g / 2, j * t + g / 2, t - g, t - g);
  }
  ctx.fillStyle = shade(b, 0.9);
  ctx.globalAlpha = 0.5;
  for (let i = 0; i <= n; i++) { ctx.fillRect(i * t - g / 2, 0, g, S); ctx.fillRect(0, i * t - g / 2, S, g); }
  ctx.globalAlpha = 1;
}
function noisy(c, base, amt) {
  seed = 5;
  const ctx = c.getContext('2d'), S = c.width;
  ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
  const img = ctx.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const v = (rnd() - 0.5) * amt; d[i] += v; d[i + 1] += v; d[i + 2] += v; }
  ctx.putImageData(img, 0, 0);
  for (let k = 0; k < 40; k++) {
    ctx.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},0.025)`;
    const r = 20 + rnd() * 80, x = rnd() * S, y = rnd() * S;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) { ctx.beginPath(); ctx.arc(x + dx, y + dy, r, 0, 7); ctx.fill(); }
  }
}
function marble(c, base, vein) {
  seed = 9;
  const ctx = c.getContext('2d'), S = c.width;
  ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
  for (let k = 0; k < 14; k++) {
    ctx.strokeStyle = vein; ctx.globalAlpha = 0.08 + rnd() * 0.25; ctx.lineWidth = 0.5 + rnd() * 2.5;
    let x = rnd() * S, y = 0;
    ctx.beginPath(); ctx.moveTo(x, y);
    while (y < S) { x += (rnd() - 0.4) * 40; y += 10 + rnd() * 30; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(150,150,150,0.5)';
  ctx.fillRect(0, 0, S, 1); ctx.fillRect(0, 0, 1, S); ctx.fillRect(0, S / 2, S, 1); ctx.fillRect(S / 2, 0, 1, S);
}

// ---------- materiali ----------
const matCache = new Map();
export function solid(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.8, metalness: opts.metal ?? 0, emissive: opts.emissive || 0x000000, emissiveIntensity: opts.ei ?? 1, side: opts.side ?? THREE.FrontSide });
  matCache.set(key, m);
  return m;
}
export const GLASS = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.02, metalness: 0, transmission: 1, ior: 1.5, thickness: 0.01, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
export const MIRROR = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.02, metalness: 1 });
export const CHROME = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.15, metalness: 1 });
export const CERAMIC = new THREE.MeshStandardMaterial({ color: 0xf7f7f5, roughness: 0.15 });

export function floorMaterial(key) {
  const k = 'floor:' + key;
  if (matCache.has(k)) return matCache.get(k);
  if (isCustomFloor(key) && custom.has(key.slice(4))) {
    const e = custom.get(key.slice(4));
    const m = new THREE.MeshStandardMaterial({ map: e.tex, roughness: 0.6 });
    m.userData.texSize = e.size;
    matCache.set(k, m);
    return m;
  }
  const def = FLOORS[key] || FLOORS.parquet;
  const rough = /marmo|gres|mosaico/.test(key) ? 0.25 : /moquette/.test(key) ? 1 : 0.55;
  const m = new THREE.MeshStandardMaterial({ map: floorTexture(key), roughness: rough });
  m.userData.texSize = def.size;
  matCache.set(k, m);
  return m;
}
