// Catalogo dei mobili parametrici: ogni voce sa costruirsi in 3D (gruppo three.js in metri, origine al
// centro dell'ingombro a terra, fronte verso +z) e disegnarsi in pianta (coordinate locali in cm, fronte verso +y).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { solid, GLASS, MIRROR, CHROME, CERAMIC, finishBase } from './materials.js?v=mwz2r4zd';

const M = 0.01; // cm -> m

function box(g, w, h, d, x, y, z, mat, r = 0) {
  const geo = r > 0 ? new RoundedBoxGeometry(w * M, h * M, d * M, 3, Math.min(r, w / 2 - 0.1, h / 2 - 0.1, d / 2 - 0.1) * M) : new THREE.BoxGeometry(w * M, h * M, d * M);
  // finiture con texture (legno): coordinate in scala reale, una ripetizione ogni 60 cm su ogni faccia
  if (mat && mat.map && !r) {
    const uv = geo.getAttribute('uv'), dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f][0] / 60, uv.getY(i) * dims[f][1] / 60); }
  }
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x * M, (y + h / 2) * M, z * M);
  g.add(m);
  return m;
}
function cyl(g, r, h, x, y, z, mat, r2 = r, seg = 32) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r * M, r2 * M, h * M, seg), mat);
  m.position.set(x * M, (y + h / 2) * M, z * M);
  g.add(m);
  return m;
}
function sphere(g, r, x, y, z, mat, sy = 1) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r * M, 32, 16), mat);
  m.position.set(x * M, y * M, z * M);
  m.scale.y = sy;
  g.add(m);
  return m;
}
// paralume in tessuto: quando la lampada e' accesa lascia passare un po' di luce (emissivo tenue)
function glowShade(color) {
  return new THREE.MeshStandardMaterial({ color: finishBase(color), roughness: 0.85, side: THREE.DoubleSide, emissive: 0xffd9a8, emissiveIntensity: 0 });
}
// lampadina: materiale proprio (si accende e si spegne per oggetto), intensita' di base in userData.bulb
function bulb(g, r, x, y, z, base = 3) {
  const m = sphere(g, r, x, y, z, new THREE.MeshStandardMaterial({ color: 0xfff8e8, emissive: 0xffe2b0, emissiveIntensity: base, roughness: 0.4 }));
  m.userData.bulb = base;
  m.castShadow = false;
  return m;
}
function shade(g, rTop, rBot, h, x, y, z, color) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop * M, rBot * M, h * M, 32, 1, true), glowShade(color));
  m.position.set(x * M, (y + h / 2) * M, z * M);
  g.add(m);
  return m;
}
/** Blocco d'armadio da x0 a x1 (cm) e da y0 a y1, profondita' d (fronte a z = zf + d/2), con n ante e maniglie. */
function wardrobe(g, x0, x1, y0, y1, d, zf, n, m, color) {
  const w = x1 - x0, cx = (x0 + x1) / 2;
  box(g, w, y1 - y0, d, cx, y0, zf, m);
  const seam = solid(dark(color));
  for (let i = 1; i < n; i++) box(g, 0.4, y1 - y0 - 4, 0.4, x0 + w * i / n, y0 + 2, zf + d / 2, seam);
  const hh = Math.min(30, (y1 - y0) * 0.35);
  for (let i = 0; i < n; i++) {
    // maniglie vicine all'anta accanto (a coppie), oppure al centro se l'anta e' sola
    const f = n === 1 ? 0.9 : (i % 2 ? 0.1 : 0.9);
    box(g, 1.5, hh, 2, x0 + w * (i + f) / n, (y0 + y1) / 2 - hh / 2, zf + d / 2 + 1, CHROME);
  }
}
const legs4 = (g, w, d, h, inset, s, mat, round = false) => {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - inset), z = sz * (d / 2 - inset);
    const m = round ? cyl(g, s / 2, h, x, 0, z, mat, s / 2, 12) : box(g, s, h, s, x, 0, z, mat);
    m.userData.leg = true;
  }
};
const dark = c => { const k = new THREE.Color(finishBase(c)); k.multiplyScalar(0.6); return '#' + k.getHexString(); };
const WOOD_DARK = '#4a3a2c', METAL = '#2b2b2b';

// ---------- disegno 2D ----------
// ctx gia' trasformato: origine al centro, unita' in cm, fronte verso +y. s = cm per pixel (spessore linee)
function rect(ctx, x, y, w, h, fill) { ctx.beginPath(); ctx.rect(x, y, w, h); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.stroke(); }
function rrect(ctx, x, y, w, h, r, fill) { ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.stroke(); }
function circ(ctx, x, y, r, fill) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.stroke(); }
function ell(ctx, x, y, rx, ry, fill) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.stroke(); }
const box2d = (ctx, it, fill) => rect(ctx, -it.w / 2, -it.d / 2, it.w, it.d, fill);

// ---------- catalogo ----------
export const CATALOG = {
  // Soggiorno
  divano3: {
    name: 'Divano 3 posti', cat: 'Soggiorno', w: 220, d: 92, h: 82, color: '#8d8a84', legH: 4, bases: ['legs', 'floor'],
    build(g, it) {
      const f = solid(it.color, { rough: 0.95 }), a = it.w, d = it.d;
      const arm = Math.min(18, a * 0.1), seats = Math.max(1, Math.round((a - 2 * arm) / 65));
      box(g, a, 18, d, 0, 4, 0, f, 3);
      box(g, a - 2 * arm, 20, 22, 0, 18, -d / 2 + 11, f, 6);
      box(g, a - 2 * arm, it.h - 18, 20, 0, 18, -d / 2 + 10, f, 8);
      const sw = (a - 2 * arm) / seats;
      for (let i = 0; i < seats; i++) box(g, sw - 1, 16, d - 22, -a / 2 + arm + sw * (i + 0.5), 20, 11, f, 7);
      for (const s of [-1, 1]) box(g, arm, 62, d, s * (a / 2 - arm / 2), 4, 0, f, 7);
      legs4(g, a, d, 4, 8, 4, solid(METAL), true);
    },
    draw(ctx, it, s) {
      const arm = Math.min(18, it.w * 0.1), seats = Math.max(1, Math.round((it.w - 2 * arm) / 65));
      rrect(ctx, -it.w / 2, -it.d / 2, it.w, it.d, 6, '#fff');
      rect(ctx, -it.w / 2 + arm, -it.d / 2, it.w - 2 * arm, 20);
      const sw = (it.w - 2 * arm) / seats;
      for (let i = 1; i < seats; i++) { ctx.beginPath(); ctx.moveTo(-it.w / 2 + arm + sw * i, -it.d / 2 + 20); ctx.lineTo(-it.w / 2 + arm + sw * i, it.d / 2); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(-it.w / 2 + arm, -it.d / 2); ctx.lineTo(-it.w / 2 + arm, it.d / 2); ctx.moveTo(it.w / 2 - arm, -it.d / 2); ctx.lineTo(it.w / 2 - arm, it.d / 2); ctx.stroke();
    },
  },
  divano2: { like: 'divano3', name: 'Divano 2 posti', w: 160 },
  mobileBasso: { like: 'mobileTV', name: 'Mobile TV senza televisore', noTv: true },
  poltrona: { like: 'divano3', name: 'Poltrona', w: 90, d: 88, color: '#6b7f8c' },
  tavolino: {
    name: 'Tavolino', cat: 'Soggiorno', w: 110, d: 60, h: 40, color: '#c9a274',
    build(g, it) { const m = solid(it.color, { rough: 0.5 }); box(g, it.w, 4, it.d, 0, it.h - 4, 0, m, 1); box(g, it.w - 8, 2, it.d - 8, 0, 8, 0, m); legs4(g, it.w, it.d, it.h - 4, 4, 4, solid(METAL)); },
    draw(ctx, it) { rrect(ctx, -it.w / 2, -it.d / 2, it.w, it.d, 3, '#fff'); },
  },
  mobileTV: {
    name: 'Mobile TV', cat: 'Soggiorno', w: 180, d: 45, h: 50, color: '#f2efe9', legH: 10, bases: ['legs', 'floor', 'wall'], wallElev: 35,
    build(g, it) {
      const m = solid(it.color, { rough: 0.6 });
      box(g, it.w, it.h - 10, it.d, 0, 10, 0, m, 1);
      legs4(g, it.w, it.d, 10, 6, 3, solid(METAL));
      for (let i = 1; i < 3; i++) box(g, 0.6, it.h - 16, 0.5, -it.w / 2 + it.w * i / 3, 13, it.d / 2, solid(dark(it.color)));
      if (it.tv !== false) {
        const tvw = Math.min(140, it.w - 20);
        box(g, tvw, tvw * 0.56, 3, 0, it.h + 8, -it.d / 2 + 12, solid('#111', { rough: 0.2 }));
        box(g, 24, 8, 16, 0, it.h, -it.d / 2 + 12, solid('#222'));
      }
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); if (it.tv !== false) { const tvw = Math.min(140, it.w - 20); rect(ctx, -tvw / 2, -it.d / 2 + 9, tvw, 4, '#333'); } },
  },
  libreria: {
    name: 'Libreria', cat: 'Soggiorno', w: 100, d: 35, h: 200, color: '#f2efe9',
    build(g, it) {
      const m = solid(it.color, { rough: 0.6 }), t = 2;
      for (const s of [-1, 1]) box(g, t, it.h, it.d, s * (it.w / 2 - t / 2), 0, 0, m);
      box(g, it.w, t, it.d, 0, it.h - t, 0, m); box(g, it.w - 2 * t, 1, it.d, 0, 0, -0.5, m);
      box(g, it.w, it.h, 1, 0, 0, -it.d / 2 + 0.5, m);
      const shelves = Math.max(2, Math.round(it.h / 38));
      const cols = ['#7d4a3a', '#2f4858', '#d9a441', '#5f7f8c', '#b5473a', '#ddd6c8', '#3b3733'];
      let k = 0;
      for (let i = 1; i <= shelves; i++) {
        const y = (it.h - t) * i / (shelves + 0) - 0;
        if (i < shelves) box(g, it.w - 2 * t, t, it.d - 1, 0, y - t, 0.5, m);
        const y0 = (it.h - t) * (i - 1) / shelves + (i === 1 ? 1 : 0);
        let x = -it.w / 2 + t + 2;
        while (x < it.w / 2 - 12 && (i + k) % 4 !== 3) {
          const bw = 2 + ((k * 7) % 4), bh = 20 + ((k * 13) % 9);
          box(g, bw, bh, it.d * 0.7, x + bw / 2, y0, -it.d * 0.1, solid(cols[k % cols.length], { rough: 0.7 }));
          x += bw + 0.3; k++;
        }
        k++;
      }
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); ctx.beginPath(); ctx.moveTo(-it.w / 2, -it.d / 2 + 2); ctx.lineTo(it.w / 2, -it.d / 2 + 2); ctx.stroke(); },
  },
  tappeto: {
    name: 'Tappeto', cat: 'Soggiorno', w: 200, d: 140, h: 1, color: '#b9b0a2',
    build(g, it) { box(g, it.w, 1, it.d, 0, 0, 0, solid(it.color, { rough: 1 })); box(g, it.w - 20, 1.05, it.d - 20, 0, 0, 0, solid(dark(it.color), { rough: 1 })); },
    draw(ctx, it) { ctx.setLineDash([6, 4]); box2d(ctx, it); ctx.setLineDash([]); },
  },
  // Pranzo
  tavolo: {
    name: 'Tavolo', cat: 'Pranzo', w: 160, d: 90, h: 75, color: '#c9a274',
    build(g, it) { const m = solid(it.color, { rough: 0.45 }); box(g, it.w, 4, it.d, 0, it.h - 4, 0, m, 1); legs4(g, it.w, it.d, it.h - 4, 6, 6, m); },
    draw(ctx, it) { box2d(ctx, it, '#fff'); },
  },
  tavoloTondo: {
    name: 'Tavolo rotondo', cat: 'Pranzo', w: 110, d: 110, h: 75, color: '#f2efe9', round: true,
    build(g, it) { const m = solid(it.color, { rough: 0.4 }); const r = it.w / 2; const top = cyl(g, r, 4, 0, it.h - 4, 0, m, r, 48); top.scale.z = it.d / it.w; cyl(g, 4, it.h - 4, 0, 0, 0, solid(METAL)); cyl(g, 25, 2, 0, 0, 0, solid(METAL)); },
    draw(ctx, it) { ell(ctx, 0, 0, it.w / 2, it.d / 2, '#fff'); },
  },
  sedia: {
    name: 'Sedia', cat: 'Pranzo', w: 45, d: 50, h: 88, color: '#3b3733',
    build(g, it) {
      const m = solid(it.color, { rough: 0.6 }); const sh = 45;
      box(g, it.w, 4, it.d, 0, sh - 4, 0, m, 1);
      legs4(g, it.w, it.d, sh - 4, 2.5, 3, m);
      box(g, it.w, it.h - sh, 3, 0, sh, -it.d / 2 + 1.5, m, 1);
    },
    draw(ctx, it) { rrect(ctx, -it.w / 2, -it.d / 2, it.w, it.d, 4, '#fff'); rect(ctx, -it.w / 2, -it.d / 2, it.w, 4); },
  },
  // Cucina
  baseCucina: {
    name: 'Base cucina', cat: 'Cucina', w: 60, d: 60, h: 90, color: '#f2efe9', color2: '#3b3733',
    build(g, it) {
      const f = solid(it.color, { rough: 0.4 }), top = solid(it.color2, { rough: 0.3 });
      box(g, it.w, 10, it.d - 6, 0, 0, -3, solid('#222'));
      box(g, it.w - 0.4, it.h - 14, it.d - 4, 0, 10, -2, f);
      box(g, it.w, 4, it.d, 0, it.h - 4, 0, top);
      const doors = Math.max(1, Math.round(it.w / 60));
      for (let i = 1; i < doors; i++) box(g, 0.4, it.h - 14, 0.4, -it.w / 2 + it.w * i / doors, 10, it.d / 2 - 2, solid(dark(it.color)));
      box(g, it.w - 4, 1.2, 1.5, 0, it.h - 9, it.d / 2 - 1.5, CHROME);
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); ctx.beginPath(); ctx.moveTo(-it.w / 2, it.d / 2 - 3); ctx.lineTo(it.w / 2, it.d / 2 - 3); ctx.stroke(); },
  },
  lavello: {
    like: 'baseCucina', name: 'Base con lavello', w: 90,
    extra(g, it) {
      const sw = Math.min(50, it.w - 20);
      box(g, sw, 0.5, 40, 0, it.h + 0.05, 0, CHROME);
      box(g, sw - 4, 0.6, 36, 0, it.h + 0.1, 0, solid('#9a9a9a', { metal: 1, rough: 0.3 }));
      cyl(g, 1.5, 25, 0, it.h, -it.d / 2 + 8, CHROME);
      box(g, 3, 3, 18, 0, it.h + 22, -it.d / 2 + 16, CHROME);
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); const sw = Math.min(50, it.w - 20); rrect(ctx, -sw / 2, -20, sw, 40, 5); circ(ctx, 0, 0, 2.5); },
  },
  fornelli: {
    like: 'baseCucina', name: 'Base con piano cottura', w: 60,
    extra(g, it) {
      box(g, Math.min(58, it.w - 2), 0.6, 50, 0, it.h, 0, solid('#111', { rough: 0.1 }));
      for (const [x, z] of [[-14, -12], [14, -12], [-14, 12], [14, 12]]) cyl(g, 8, 0.3, x, it.h + 0.6, z, solid('#444', { rough: 0.5 }), 8, 24);
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); for (const [x, y] of [[-14, -12], [14, -12], [-14, 12], [14, 12]]) circ(ctx, x, y, 8); },
  },
  pensile: {
    name: 'Pensile', cat: 'Cucina', w: 60, d: 35, h: 70, elev: 145, color: '#f2efe9',
    build(g, it) { box(g, it.w - 0.4, it.h, it.d, 0, 0, 0, solid(it.color, { rough: 0.4 })); box(g, it.w - 4, 1.2, 1.5, 0, 3, it.d / 2 + 0.7, CHROME); },
    draw(ctx, it) { ctx.setLineDash([4, 3]); box2d(ctx, it); ctx.beginPath(); ctx.moveTo(-it.w / 2, -it.d / 2); ctx.lineTo(it.w / 2, it.d / 2); ctx.stroke(); ctx.setLineDash([]); },
  },
  frigo: {
    name: 'Frigorifero', cat: 'Cucina', w: 60, d: 65, h: 200, color: '#d8d8d8',
    build(g, it) { box(g, it.w, it.h, it.d, 0, 0, 0, solid(it.color, { rough: 0.25, metal: 0.3 }), 2); box(g, it.w, 0.6, 0.4, 0, it.h * 0.62, it.d / 2, solid('#555')); box(g, 2, 40, 3, it.w / 2 - 6, it.h * 0.62 - 50, it.d / 2 + 1.5, CHROME); box(g, 2, 30, 3, it.w / 2 - 6, it.h * 0.62 + 10, it.d / 2 + 1.5, CHROME); },
    draw(ctx, it) { box2d(ctx, it, '#fff'); ctx.beginPath(); ctx.moveTo(-it.w / 2, -it.d / 2); ctx.lineTo(it.w / 2, it.d / 2); ctx.moveTo(it.w / 2, -it.d / 2); ctx.lineTo(-it.w / 2, it.d / 2); ctx.stroke(); },
  },
  colonna: {
    name: 'Colonna forno', cat: 'Cucina', w: 60, d: 60, h: 215, color: '#f2efe9',
    build(g, it) { box(g, it.w - 0.4, it.h, it.d, 0, 0, 0, solid(it.color, { rough: 0.4 })); box(g, it.w - 6, 58, 1, 0, 85, it.d / 2, solid('#111', { rough: 0.1 })); box(g, it.w - 10, 1.5, 2, 0, 140, it.d / 2 + 1, CHROME); },
    draw(ctx, it) { box2d(ctx, it, '#fff'); rect(ctx, -it.w / 2 + 3, it.d / 2 - 4, it.w - 6, 4); },
  },
  // Camera
  letto2: {
    name: 'Letto matrimoniale', cat: 'Camera', w: 170, d: 210, h: 100, color: '#f2efe9', color2: '#8a7a6a', legH: 4, bases: ['legs', 'floor'],
    build(g, it) {
      const fr = solid(it.color2, { rough: 0.8 }), sheet = solid(it.color, { rough: 1 });
      box(g, it.w, 28, it.d, 0, 4, 0, fr, 2);
      box(g, it.w - 6, 20, it.d - 6, 0, 30, 1, sheet, 6);
      box(g, it.w, it.h, 8, 0, 4, -it.d / 2 + 4, fr, 3);
      const np = it.w > 120 ? 2 : 1, pw = (it.w - 20) / np;
      for (let i = 0; i < np; i++) box(g, pw - 6, 12, 40, -it.w / 2 + 10 + pw * (i + 0.5), 48, -it.d / 2 + 34, sheet, 6);
      box(g, it.w - 4, 4, it.d * 0.55, 0, 49, it.d * 0.2, solid(dark(it.color)), 2);
      legs4(g, it.w, it.d, 4, 8, 5, solid(METAL));
    },
    draw(ctx, it) {
      box2d(ctx, it, '#fff'); rect(ctx, -it.w / 2, -it.d / 2, it.w, 8);
      const np = it.w > 120 ? 2 : 1, pw = (it.w - 20) / np;
      for (let i = 0; i < np; i++) rrect(ctx, -it.w / 2 + 10 + pw * i + 3, -it.d / 2 + 14, pw - 6, 40, 6);
      ctx.beginPath(); ctx.moveTo(-it.w / 2, -it.d / 2 + 70); ctx.lineTo(it.w / 2, -it.d / 2 + 70); ctx.stroke();
    },
  },
  letto1: { like: 'letto2', name: 'Letto singolo', w: 90 },
  comodino: {
    name: 'Comodino', cat: 'Camera', w: 45, d: 40, h: 50, color: '#c9a274', legH: 10, bases: ['legs', 'floor', 'wall'], wallElev: 30,
    build(g, it) { const m = solid(it.color, { rough: 0.5 }); box(g, it.w, it.h - 10, it.d, 0, 10, 0, m, 1); legs4(g, it.w, it.d, 10, 3, 3, m); box(g, it.w - 4, 0.6, 0.4, 0, it.h - 18, it.d / 2, solid(dark(it.color))); },
    draw(ctx, it) { box2d(ctx, it, '#fff'); },
  },
  armadio: {
    name: 'Armadio', cat: 'Camera', w: 200, d: 60, h: 240, color: '#f2efe9',
    params: [{ key: 'doors', label: 'Numero di ante', def: 4, min: 1, max: 10, unit: '' }],
    build(g, it) {
      const m = solid(it.color, { rough: 0.45 });
      wardrobe(g, -it.w / 2, it.w / 2, 0, it.h, it.d, 0, Math.max(1, Math.round(it.doors || it.w / 50)), m, it.color);
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); ctx.beginPath(); ctx.moveTo(-it.w / 2 + 4, 0); ctx.lineTo(it.w / 2 - 4, 0); ctx.stroke(); for (let x = -it.w / 2 + 15; x < it.w / 2 - 5; x += 15) { ctx.beginPath(); ctx.moveTo(x, -6); ctx.lineTo(x - 6, 6); ctx.stroke(); } },
  },
  cassettiera: {
    name: 'Cassettiera', cat: 'Camera', w: 100, d: 50, h: 80, color: '#f2efe9', legH: 8, bases: ['legs', 'floor', 'wall'], wallElev: 30,
    build(g, it) { const m = solid(it.color, { rough: 0.45 }); box(g, it.w, it.h - 8, it.d, 0, 8, 0, m, 1); legs4(g, it.w, it.d, 8, 4, 3, solid(METAL)); const n = 3; for (let i = 1; i < n; i++) box(g, it.w - 2, 0.5, 0.4, 0, 8 + (it.h - 8) * i / n, it.d / 2, solid(dark(it.color))); },
    draw(ctx, it) { box2d(ctx, it, '#fff'); },
  },
  scrivania: {
    name: 'Scrivania', cat: 'Camera', w: 120, d: 60, h: 75, color: '#f2efe9',
    build(g, it) { const m = solid(it.color, { rough: 0.45 }); box(g, it.w, 3, it.d, 0, it.h - 3, 0, m); for (const s of [-1, 1]) box(g, 3, it.h - 3, it.d - 4, s * (it.w / 2 - 3), 0, 0, solid(METAL)); box(g, 50, 30, 2, 0, it.h + 10, -it.d / 2 + 10, solid('#111', { rough: 0.2 })); box(g, 4, 10, 4, 0, it.h, -it.d / 2 + 10, solid('#222')); },
    draw(ctx, it) { box2d(ctx, it, '#fff'); rect(ctx, -25, -it.d / 2 + 9, 50, 2, '#333'); },
  },
  // Bagno
  wc: {
    name: 'WC', cat: 'Bagno', w: 38, d: 55, h: 40, color: '#f7f7f5', bases: ['floor', 'hung'],
    build(g, it) {
      const m = CERAMIC;
      if (it.base === 'hung') {
        // sospeso: cassetta nel muro (si vede la placca), vaso staccato da terra
        box(g, it.w * 0.75, it.h - 20, 12, 0, 20, -it.d / 2 + 6, m, 4);
        const b = cyl(g, it.w / 2, it.h - 22, 0, 20, 5, m, it.w / 2.6, 32); b.scale.z = (it.d - 12) / it.w;
        box(g, 22, 14, 1.2, 0, 92, -it.d / 2 + 0.6, CHROME, 0.5);
      } else {
        box(g, it.w, 35, 16, 0, 0, -it.d / 2 + 8, m, 4);
        const b = cyl(g, it.w / 2, it.h - 2, 0, 0, 5, m, it.w / 2.4, 32); b.scale.z = (it.d - 16) / it.w;
      }
      box(g, it.w - 2, 3, it.d - 8, 0, it.h - 2, 3, solid('#ffffff', { rough: 0.3 }), 1.4);
    },
    draw(ctx, it) { rect(ctx, -it.w / 2, -it.d / 2, it.w, 16, '#fff'); ell(ctx, 0, 5, it.w / 2 - 1, (it.d - 16) / 2 + 1, '#fff'); },
  },
  bidet: {
    name: 'Bidet', cat: 'Bagno', w: 38, d: 55, h: 40, color: '#f7f7f5', bases: ['floor', 'hung'],
    build(g, it) {
      const y0 = it.base === 'hung' ? 20 : 0;
      if (it.base === 'hung') box(g, it.w * 0.75, it.h - 20, 10, 0, 20, -it.d / 2 + 5, CERAMIC, 4);
      const b = cyl(g, it.w / 2, it.h - y0, 0, y0, 2, CERAMIC, it.w / 2.4, 32); b.scale.z = (it.d - 4) / it.w;
      cyl(g, 1.5, 8, 0, it.h, -it.d / 2 + 8, CHROME);
    },
    draw(ctx, it) { ell(ctx, 0, 2, it.w / 2, it.d / 2 - 2, '#fff'); circ(ctx, 0, -it.d / 2 + 8, 2); },
  },
  lavabo: {
    name: 'Lavabo con mobile', cat: 'Bagno', w: 80, d: 48, h: 85, color: '#c9a274', bases: ['hungcab', 'floorcab', 'hung'],
    build(g, it) {
      const base = it.base || 'hungcab';
      if (base === 'hungcab') box(g, it.w, it.h - 30, it.d - 2, 0, 20, -1, solid(it.color, { rough: 0.5 }));
      else if (base === 'floorcab') { box(g, it.w, it.h - 18, it.d - 2, 0, 8, -1, solid(it.color, { rough: 0.5 })); box(g, it.w - 4, 8, it.d - 8, 0, 0, -4, solid('#2b2b2b')); }
      else { cyl(g, 2, it.h - 40, 0, 30, -it.d / 2 + 10, CHROME); }
      box(g, it.w, 10, it.d, 0, it.h - 10, 0, CERAMIC, 2);
      box(g, it.w - 20, 1, it.d - 18, 0, it.h - 0.5, 3, solid('#e5e5e2', { rough: 0.2 }), 0);
      cyl(g, 1.5, 20, 0, it.h, -it.d / 2 + 6, CHROME); box(g, 3, 3, 12, 0, it.h + 18, -it.d / 2 + 11, CHROME);
      box(g, Math.min(it.w, 90), 70, 2, 0, it.h + 30, -it.d / 2 - 1, MIRROR);
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); rrect(ctx, -it.w / 2 + 10, -it.d / 2 + 12, it.w - 20, it.d - 18, 8); circ(ctx, 0, -it.d / 2 + 6, 2); },
  },
  doccia: {
    name: 'Doccia', cat: 'Bagno', w: 90, d: 90, h: 200, color: '#f7f7f5',
    build(g, it) {
      box(g, it.w, 5, it.d, 0, 0, 0, CERAMIC);
      box(g, 1, it.h - 5, it.d, it.w / 2 - 0.5, 5, 0, GLASS); box(g, it.w, it.h - 5, 1, 0, 5, it.d / 2 - 0.5, GLASS);
      cyl(g, 1, 100, -it.w / 2 + 6, 100, -it.d / 2 + 6, CHROME);
      cyl(g, 10, 1, -it.w / 2 + 16, it.h - 5, -it.d / 2 + 16, CHROME);
      box(g, 2, 2, 12, -it.w / 2 + 6, it.h - 5, -it.d / 2 + 11, CHROME);
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); ctx.beginPath(); ctx.moveTo(-it.w / 2, -it.d / 2); ctx.lineTo(it.w / 2, it.d / 2); ctx.moveTo(it.w / 2, -it.d / 2); ctx.lineTo(-it.w / 2, it.d / 2); ctx.stroke(); circ(ctx, 0, 0, 3); },
  },
  vasca: {
    name: 'Vasca', cat: 'Bagno', w: 170, d: 75, h: 55, color: '#f7f7f5',
    build(g, it) { box(g, it.w, it.h, it.d, 0, 0, 0, CERAMIC, 3); box(g, it.w - 14, 2, it.d - 14, 0, it.h - 1.5, 0, solid('#e9eef0', { rough: 0.1 }), 0); cyl(g, 1.5, 12, -it.w / 2 + 6, it.h, 0, CHROME); },
    draw(ctx, it) { box2d(ctx, it, '#fff'); rrect(ctx, -it.w / 2 + 7, -it.d / 2 + 7, it.w - 14, it.d - 14, 25); circ(ctx, -it.w / 2 + 25, 0, 3); },
  },
  // Luci
  lampadario: {
    name: 'Lampada a soffitto', cat: 'Luci', w: 40, d: 40, h: 25, elev: null, color: '#f2efe9', light: 'ceiling',
    build(g, it) {
      const r = it.w / 2;
      cyl(g, 0.4, 40, 0, it.h, 0, solid('#222'));
      const sh = cyl(g, r * 0.5, it.h * 0.8, 0, 0, 0, glowShade(it.color), r, 32);
      sh.geometry = new THREE.CylinderGeometry(r * 0.45 * M, r * M, it.h * 0.8 * M, 32, 1, true);
      sh.userData.bulb = 0.25;
      bulb(g, 5, 0, 6, 0);
    },
    draw(ctx, it) { circ(ctx, 0, 0, it.w / 2); ctx.beginPath(); ctx.moveTo(-it.w / 2, 0); ctx.lineTo(it.w / 2, 0); ctx.moveTo(0, -it.w / 2); ctx.lineTo(0, it.w / 2); ctx.stroke(); },
  },
  faretto: {
    name: 'Faretto a incasso', cat: 'Luci', w: 10, d: 10, h: 2, color: '#f2efe9', light: 'flush', round: true,
    build(g, it) {
      const r = it.w / 2;
      cyl(g, r, 1.5, 0, 0.5, 0, solid(it.color, { rough: 0.5 }), r, 24);
      const disk = cyl(g, r * 0.7, 0.6, 0, 0, 0, new THREE.MeshStandardMaterial({ color: 0xfff8e8, emissive: 0xffe2b0, emissiveIntensity: 3 }), r * 0.7, 24);
      disk.userData.bulb = 3; disk.castShadow = false;
    },
    draw(ctx, it) { circ(ctx, 0, 0, it.w / 2); circ(ctx, 0, 0, it.w / 4); },
  },
  applique: {
    name: 'Applique (da parete)', cat: 'Luci', w: 30, d: 16, h: 24, elev: 180, color: '#f2efe9', light: 'wall',
    build(g, it) {
      box(g, 10, it.h * 0.6, 2, 0, it.h * 0.2, -it.d / 2 + 1, solid('#2b2b2b'));
      box(g, 2, 2, it.d * 0.5, 0, it.h * 0.45, -it.d / 4, solid('#2b2b2b'));
      shade(g, it.w * 0.32, it.w * 0.45, it.h * 0.7, 0, it.h * 0.15, it.d * 0.1, it.color).userData.bulb = 0.25;
      bulb(g, 3.5, 0, it.h * 0.45, it.d * 0.1);
    },
    draw(ctx, it) { rect(ctx, -it.w / 2, -it.d / 2, it.w, 3); ell(ctx, 0, it.d * 0.1, it.w * 0.45, it.d * 0.4); },
  },
  lampadaTavolo: {
    name: 'Lampada da tavolo', cat: 'Luci', w: 28, d: 28, h: 48, elev: 50, color: '#f2efe9', light: 'table', round: true,
    build(g, it) {
      cyl(g, it.w * 0.3, 2, 0, 0, 0, solid('#c9a274', { rough: 0.5 }));
      cyl(g, 1, it.h * 0.55, 0, 2, 0, solid('#2b2b2b'));
      shade(g, it.w * 0.32, it.w / 2, it.h * 0.42, 0, it.h * 0.55, 0, it.color).userData.bulb = 0.25;
      bulb(g, 3.5, 0, it.h * 0.68, 0);
    },
    draw(ctx, it) { circ(ctx, 0, 0, it.w / 2); circ(ctx, 0, 0, it.w * 0.3); },
  },
  lampadaTerra: {
    name: 'Lampada da terra', cat: 'Luci', w: 40, d: 40, h: 170, color: '#f2efe9', light: 'floor',
    build(g, it) {
      cyl(g, 14, 2, 0, 0, 0, solid(METAL)); cyl(g, 1, it.h - 30, 0, 2, 0, solid(METAL));
      const sh = new THREE.Mesh(new THREE.CylinderGeometry(it.w / 2 * 0.7 * M, it.w / 2 * M, 30 * M, 32, 1, true), glowShade(it.color));
      sh.position.y = (it.h - 15) * M; g.add(sh);
      sh.userData.bulb = 0.25;
      bulb(g, 5, 0, it.h - 18, 0);
    },
    draw(ctx, it) { circ(ctx, 0, 0, it.w / 2); circ(ctx, 0, 0, 3); },
  },
  // ---------- altri arredi ----------
  divanoAngolare: {
    name: 'Divano angolare', cat: 'Soggiorno', w: 260, d: 180, h: 82, color: '#8d8a84',
    build(g, it) {
      const f = solid(it.color, { rough: 0.95 }), W = it.w, D = it.d, dp = 92, arm = 18;
      box(g, W, 18, dp, 0, 4, -D / 2 + dp / 2, f, 3);
      box(g, dp, 18, D - dp, W / 2 - dp / 2, 4, dp / 2, f, 3);
      box(g, W - arm, it.h - 18, 20, arm / 2, 18, -D / 2 + 10, f, 8);
      box(g, arm, 62, dp, -W / 2 + arm / 2, 4, -D / 2 + dp / 2, f, 7);
      const seats = Math.max(2, Math.round((W - arm - dp) / 65)), sw = (W - arm - dp) / seats;
      for (let i = 0; i < seats; i++) box(g, sw - 1, 16, dp - 22, -W / 2 + arm + sw * (i + 0.5), 20, -D / 2 + 11 + dp / 2, f, 7);
      box(g, dp - 6, 16, D - 24, W / 2 - dp / 2 - 3, 20, 10, f, 7);
    },
    draw(ctx, it) {
      const W = it.w, D = it.d, dp = 92;
      ctx.beginPath(); ctx.moveTo(-W / 2, -D / 2); ctx.lineTo(W / 2, -D / 2); ctx.lineTo(W / 2, D / 2); ctx.lineTo(W / 2 - dp, D / 2); ctx.lineTo(W / 2 - dp, -D / 2 + dp); ctx.lineTo(-W / 2, -D / 2 + dp); ctx.closePath(); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
      rect(ctx, -W / 2 + 18, -D / 2, W - 18, 20);
    },
  },
  pouf: {
    name: 'Pouf', cat: 'Soggiorno', w: 50, d: 50, h: 42, color: '#b5473a', round: true,
    build(g, it) { const c = cyl(g, it.w / 2, it.h, 0, 0, 0, solid(it.color, { rough: 1 }), it.w / 2, 32); c.scale.z = it.d / it.w; },
    draw(ctx, it) { ell(ctx, 0, 0, it.w / 2, it.d / 2, '#fff'); ell(ctx, 0, 0, it.w / 4, it.d / 4); },
  },
  credenza: {
    name: 'Madia / credenza', cat: 'Soggiorno', w: 160, d: 45, h: 85, color: '#c9a274', legH: 15, bases: ['legs', 'floor', 'wall'], wallElev: 30,
    build(g, it) {
      const m = solid(it.color, { rough: 0.5 });
      box(g, it.w, it.h - 15, it.d, 0, 15, 0, m, 1);
      legs4(g, it.w, it.d, 15, 6, 3, solid(METAL));
      const n = Math.max(2, Math.round(it.w / 45));
      for (let i = 1; i < n; i++) box(g, 0.5, it.h - 21, 0.4, -it.w / 2 + it.w * i / n, 18, it.d / 2, solid(dark(it.color)));
      for (let i = 0; i < n; i++) box(g, 1.2, 12, 2, -it.w / 2 + it.w * (i + 0.85) / n, it.h / 2, it.d / 2 + 1, CHROME);
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); },
  },
  mensola: {
    name: 'Mensola', cat: 'Soggiorno', w: 80, d: 22, h: 30, elev: 150, color: '#c9a274',
    build(g, it) {
      box(g, it.w, 3, it.d, 0, 0, 0, solid(it.color, { rough: 0.5 }));
      const cols = ['#7d4a3a', '#2f4858', '#d9a441', '#5f7f8c', '#ddd6c8'];
      for (let i = 0; i < 6; i++) box(g, 3, 20 + (i * 7) % 8, it.d * 0.7, -it.w / 2 + 6 + i * 3.4, 3, 0, solid(cols[i % cols.length]));
      cyl(g, 7, 16, it.w / 4, 3, 0, solid('#e9e4da', { rough: 0.6 }), 6);
    },
    draw(ctx, it) { ctx.setLineDash([4, 3]); box2d(ctx, it); ctx.setLineDash([]); },
  },
  quadro: {
    name: 'Quadro', cat: 'Soggiorno', w: 80, d: 3, h: 60, elev: 130, color: '#2b2b2b', color2: '#5f7f8c',
    build(g, it) {
      box(g, it.w, it.h, it.d, 0, 0, 0, solid(it.color, { rough: 0.5 }));
      box(g, it.w - 8, it.h - 8, 0.5, 0, 4, it.d / 2, solid(it.color2 || '#5f7f8c', { rough: 0.9 }));
      box(g, (it.w - 8) * 0.4, (it.h - 8) * 0.5, 0.6, -(it.w - 8) * 0.15, 4 + (it.h - 8) * 0.2, it.d / 2, solid('#d9a441', { rough: 0.9 }));
    },
    draw(ctx, it) { rect(ctx, -it.w / 2, -it.d / 2, it.w, it.d, '#333'); },
  },
  tvParete: {
    name: 'TV a parete', cat: 'Soggiorno', w: 125, d: 5, h: 72, elev: 110, color: '#111111',
    build(g, it) { box(g, it.w, it.h, it.d, 0, 0, 0, solid('#151515', { rough: 0.3 })); box(g, it.w - 3, it.h - 3, 0.3, 0, 1.5, it.d / 2, solid('#0b0d12', { rough: 0.05 })); },
    draw(ctx, it) { rect(ctx, -it.w / 2, -it.d / 2, it.w, it.d, '#333'); },
  },
  sgabello: {
    name: 'Sgabello alto', cat: 'Pranzo', w: 38, d: 38, h: 75, color: '#3b3733', round: true,
    build(g, it) {
      cyl(g, it.w / 2, 4, 0, it.h - 4, 0, solid(it.color, { rough: 0.6 }));
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4, r = it.w * 0.38; cyl(g, 1.2, it.h - 4, Math.cos(a) * r, 0, Math.sin(a) * r, solid(METAL)); }
      cyl(g, it.w * 0.4, 1, 0, 25, 0, solid(METAL), it.w * 0.4, 24);
    },
    draw(ctx, it) { circ(ctx, 0, 0, it.w / 2, '#fff'); },
  },
  panca: {
    name: 'Panca', cat: 'Pranzo', w: 120, d: 38, h: 45, color: '#c9a274',
    build(g, it) { const m = solid(it.color, { rough: 0.5 }); box(g, it.w, 4, it.d, 0, it.h - 4, 0, m, 1); for (const s of [-1, 1]) box(g, 4, it.h - 4, it.d - 6, s * (it.w / 2 - 8), 0, 0, m); },
    draw(ctx, it) { box2d(ctx, it, '#fff'); },
  },
  vetrina: {
    name: 'Vetrina', cat: 'Pranzo', w: 90, d: 40, h: 190, color: '#f2efe9',
    build(g, it) {
      const m = solid(it.color, { rough: 0.5 });
      box(g, it.w, 80, it.d, 0, 0, 0, m);
      for (const s of [-1, 1]) box(g, 2, it.h - 80, it.d, s * (it.w / 2 - 1), 80, 0, m);
      box(g, it.w, 2, it.d, 0, it.h - 2, 0, m); box(g, it.w, it.h - 80, 1, 0, 80, -it.d / 2 + 0.5, m);
      for (let i = 1; i < 4; i++) box(g, it.w - 4, 1, it.d - 3, 0, 80 + (it.h - 82) * i / 4, 0, GLASS);
      box(g, it.w - 4, it.h - 84, 0.6, 0, 81, it.d / 2 - 0.5, GLASS);
      for (let i = 0; i < 3; i++) cyl(g, 3, 12, -it.w / 4 + i * it.w / 4, 80 + (it.h - 82) / 4 + 1, 0, solid('#e9eef0', { rough: 0.1 }), 3.5, 16);
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); ctx.beginPath(); ctx.moveTo(-it.w / 2, it.d / 2 - 3); ctx.lineTo(it.w / 2, it.d / 2 - 3); ctx.stroke(); },
  },
  lavastoviglie: {
    like: 'baseCucina', name: 'Lavastoviglie', w: 60,
    extra(g, it) { box(g, it.w - 2, it.h - 18, 0.6, 0, 12, it.d / 2 - 0.2, solid('#c8c8c8', { metal: 0.6, rough: 0.3 })); box(g, it.w - 8, 3, 1, 0, it.h - 12, it.d / 2 + 0.3, solid('#222')); },
    draw(ctx, it) { box2d(ctx, it, '#fff'); rect(ctx, -it.w / 2 + 4, it.d / 2 - 4, it.w - 8, 3, '#bbb'); },
  },
  cappa: {
    name: 'Cappa', cat: 'Cucina', w: 60, d: 50, h: 60, elev: 155, color: '#c8c8c8',
    build(g, it) {
      const m = solid(it.color, { metal: 0.7, rough: 0.3 });
      box(g, it.w, 8, it.d, 0, 0, 0, m);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * it.w / 60 * 1.2, it.w / 2 * M * 1.05, 18 * M, 4, 1), m);
      c.rotation.y = Math.PI / 4; c.position.y = 17 * M; g.add(c);
      box(g, 24, it.h - 26, 20, 0, 26, -it.d / 2 + 12, m);
    },
    draw(ctx, it) { ctx.setLineDash([4, 3]); box2d(ctx, it); ctx.setLineDash([]); rect(ctx, -12, -it.d / 2 + 2, 24, 20); },
  },
  isola: {
    name: 'Isola cucina', cat: 'Cucina', w: 180, d: 90, h: 92, color: '#f2efe9', color2: '#3b3733',
    build(g, it) {
      const f = solid(it.color, { rough: 0.4 }), top = solid(it.color2 || '#3b3733', { rough: 0.3 });
      box(g, it.w - 30, 10, it.d - 36, 0, 0, -12, solid('#222'));
      box(g, it.w - 30, it.h - 14, it.d - 30, 0, 10, -12, f);
      box(g, it.w, 4, it.d, 0, it.h - 4, 0, top);
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); rect(ctx, -it.w / 2 + 15, -it.d / 2 + 3, it.w - 30, it.d - 30); },
  },
  letto120: { like: 'letto2', name: 'Letto da una piazza e mezza', w: 120 },
  armadioPonte: {
    name: 'Armadio a ponte', cat: 'Camera', w: 320, d: 60, h: 260, color: '#f2efe9',
    params: [
      { key: 'gapLeft', label: 'Vano: distanza da sinistra', def: 70, min: 0, max: 1000 },
      { key: 'gapW', label: 'Vano: larghezza', def: 180, min: 40, max: 1000 },
      { key: 'gapH', label: 'Vano: altezza', def: 200, min: 40, max: 400 },
      { key: 'bridgeD', label: 'Profondità del ponte', def: 40, min: 15, max: 100 },
    ],
    build(g, it) {
      const m = solid(it.color, { rough: 0.45 });
      const W = it.w, x0 = -W / 2;
      const gl = Math.max(0, Math.min(W - 10, it.gapLeft ?? 70));
      const gw = Math.max(10, Math.min(W - gl, it.gapW ?? 180));
      const gh = Math.max(10, Math.min(it.h - 10, it.gapH ?? 200));
      const bd = Math.max(10, Math.min(it.d, it.bridgeD ?? 40));
      const doorsFor = w => Math.max(1, Math.round(w / 50));
      if (gl > 5) wardrobe(g, x0, x0 + gl, 0, it.h, it.d, 0, doorsFor(gl), m, it.color);
      if (W - gl - gw > 5) wardrobe(g, x0 + gl + gw, W / 2, 0, it.h, it.d, 0, doorsFor(W - gl - gw), m, it.color);
      // ponte: appoggiato al muro (dietro), meno profondo delle colonne
      wardrobe(g, x0 + gl, x0 + gl + gw, gh, it.h, bd, -it.d / 2 + bd / 2, doorsFor(gw), m, it.color);
    },
    draw(ctx, it) {
      const W = it.w, x0 = -W / 2;
      const gl = Math.max(0, Math.min(W - 10, it.gapLeft ?? 70)), gw = Math.max(10, Math.min(W - gl, it.gapW ?? 180));
      const bd = Math.max(10, Math.min(it.d, it.bridgeD ?? 40));
      if (gl > 5) rect(ctx, x0, -it.d / 2, gl, it.d, '#fff');
      if (W - gl - gw > 5) rect(ctx, x0 + gl + gw, -it.d / 2, W - gl - gw, it.d, '#fff');
      ctx.setLineDash([5, 4]); rect(ctx, x0 + gl, -it.d / 2, gw, bd); ctx.setLineDash([]);
    },
  },
  specchioTerra: {
    name: 'Specchio da terra', cat: 'Camera', w: 60, d: 30, h: 170, color: '#c9a274',
    build(g, it) {
      const m = solid(it.color, { rough: 0.5 });
      const p = new THREE.Group(); p.position.z = -it.d / 2 * M + 0.03; p.rotation.x = -0.12; g.add(p);
      box(p, it.w, it.h, 3, 0, 0, 0, m); box(p, it.w - 8, it.h - 8, 0.5, 0, 4, 1.6, MIRROR);
    },
    draw(ctx, it) { rect(ctx, -it.w / 2, -it.d / 2, it.w, 6, '#ddd'); },
  },
  sediaUfficio: {
    name: 'Sedia da ufficio', cat: 'Camera', w: 60, d: 60, h: 110, color: '#2b2b2b', round: true,
    build(g, it) {
      const m = solid(it.color, { rough: 0.7 });
      for (let i = 0; i < 5; i++) { const a = i * Math.PI * 2 / 5; const leg = box(g, 2.5, 2.5, it.w / 2 - 4, Math.cos(a) * it.w / 4, 5, Math.sin(a) * it.w / 4, solid(METAL)); leg.rotation.y = -a + Math.PI / 2; sphere(g, 2.5, Math.cos(a) * (it.w / 2 - 3), 2.5, Math.sin(a) * (it.w / 2 - 3), solid('#111')); }
      cyl(g, 2.5, 38, 0, 7, 0, solid(METAL));
      box(g, 48, 8, 46, 0, 45, 2, m, 3);
      const back = box(g, 46, 55, 6, 0, 52, -it.d / 2 + 10, m, 3); back.rotation.x = -0.12;
    },
    draw(ctx, it) { circ(ctx, 0, 0, it.w / 2); rrect(ctx, -24, -21, 48, 46, 6, '#fff'); rect(ctx, -23, -it.d / 2 + 7, 46, 6); },
  },
  lavatrice: {
    name: 'Lavatrice', cat: 'Bagno', w: 60, d: 60, h: 85, color: '#f7f7f5',
    build(g, it) {
      box(g, it.w, it.h, it.d, 0, 0, 0, solid(it.color, { rough: 0.3 }), 2);
      const door = cyl(g, 16, 2, 0, 0, 0, solid('#9aa4ad', { metal: 0.6, rough: 0.2 }), 16, 32); door.rotation.x = Math.PI / 2; door.position.set(0, (it.h * 0.45) * M, (it.d / 2 + 1) * M);
      const gl = cyl(g, 12, 2.2, 0, 0, 0, solid('#2a3540', { rough: 0.05 }), 12, 32); gl.rotation.x = Math.PI / 2; gl.position.set(0, (it.h * 0.45) * M, (it.d / 2 + 1.2) * M);
      box(g, it.w - 6, 8, 1, 0, it.h - 12, it.d / 2, solid('#e2e2e0'));
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); circ(ctx, 0, it.d / 2 - 2, 14); },
  },
  termoarredo: {
    name: 'Termoarredo', cat: 'Bagno', w: 50, d: 8, h: 120, elev: 15, color: '#f2efe9',
    build(g, it) {
      const m = solid(it.color, { rough: 0.4, metal: 0.2 });
      for (const s of [-1, 1]) cyl(g, 1.8, it.h, s * (it.w / 2 - 2), 0, 0, m, 1.8, 12);
      const n = Math.round(it.h / 8);
      for (let i = 0; i < n; i++) { const b = cyl(g, 1.1, it.w - 4, 0, 0, 0, m, 1.1, 10); b.rotation.z = Math.PI / 2; b.position.set(0, (4 + i * (it.h - 8) / (n - 1)) * M, 0); }
    },
    draw(ctx, it) { rect(ctx, -it.w / 2, -it.d / 2, it.w, it.d, '#ddd'); },
  },
  specchio: {
    name: 'Specchio a parete', cat: 'Bagno', w: 60, d: 3, h: 80, elev: 110, color: '#c8c8c8',
    build(g, it) { box(g, it.w, it.h, it.d, 0, 0, 0, solid(it.color, { metal: 0.5, rough: 0.3 }), 1); box(g, it.w - 4, it.h - 4, 0.4, 0, 2, it.d / 2, MIRROR); },
    draw(ctx, it) { rect(ctx, -it.w / 2, -it.d / 2, it.w, it.d, '#bbb'); },
  },
  radiatore: {
    name: 'Radiatore', cat: 'Varie', w: 80, d: 10, h: 60, elev: 12, color: '#f2efe9',
    build(g, it) {
      const m = solid(it.color, { rough: 0.5 });
      const n = Math.max(3, Math.round(it.w / 8));
      for (let i = 0; i < n; i++) box(g, it.w / n - 1.5, it.h, it.d, -it.w / 2 + (i + 0.5) * it.w / n, 0, 0, m, 1);
    },
    draw(ctx, it) { rect(ctx, -it.w / 2, -it.d / 2, it.w, it.d, '#ddd'); },
  },
  tenda: {
    name: 'Tenda', cat: 'Varie', w: 140, d: 12, h: 250, color: '#e9e4da',
    build(g, it) {
      const n = Math.max(6, Math.round(it.w / 12)), m = solid(it.color, { rough: 1, side: THREE.DoubleSide });
      const pos = [];
      for (let i = 0; i <= n * 4; i++) { const x = -it.w / 2 + it.w * i / (n * 4); pos.push(x * M, Math.sin(i / 4 * Math.PI * 2) * it.d * 0.4 * M); }
      const shape = new THREE.Shape(); shape.moveTo(pos[0], pos[1]);
      for (let i = 2; i < pos.length; i += 2) shape.lineTo(pos[i], pos[i + 1]);
      for (let i = pos.length - 2; i >= 0; i -= 2) shape.lineTo(pos[i], pos[i + 1] + 0.006);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: (it.h - 6) * M, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const c = new THREE.Mesh(geo, m); c.position.y = 2 * M; g.add(c);
      const rod = cyl(g, 1, it.w + 10, 0, 0, 0, solid('#888', { metal: 0.6, rough: 0.3 })); rod.rotation.z = Math.PI / 2; rod.position.y = (it.h - 2) * M;
    },
    draw(ctx, it) { ctx.beginPath(); for (let x = -it.w / 2; x <= it.w / 2; x += 3) { const y = Math.sin((x + it.w / 2) / 12 * Math.PI * 2) * it.d * 0.4; if (x === -it.w / 2) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke(); },
  },
  pianoforte: {
    name: 'Pianoforte verticale', cat: 'Varie', w: 150, d: 60, h: 125, color: '#1a1a1a',
    build(g, it) {
      const m = solid(it.color, { rough: 0.15 });
      box(g, it.w, it.h, 30, 0, 0, -it.d / 2 + 15, m, 1);
      box(g, it.w, 6, it.d - 30, 0, 70, it.d / 2 - (it.d - 30) / 2, m);
      box(g, it.w - 12, 2, 14, 0, 76, -it.d / 2 + 37, solid('#f4f1e8', { rough: 0.3 }));
      for (let i = 0; i < 36; i++) if ([1, 2, 4, 5, 6].includes(i % 7)) box(g, 1.2, 1.5, 8, -it.w / 2 + 6 + (i + 0.5) * (it.w - 12) / 36 - 1.6, 78, -it.d / 2 + 34, solid('#111'));
      for (const s of [-1, 1]) box(g, 4, 70, it.d - 30, s * (it.w / 2 - 2), 0, it.d / 2 - (it.d - 30) / 2, m);
    },
    draw(ctx, it) { box2d(ctx, it, '#fff'); rect(ctx, -it.w / 2, -it.d / 2, it.w, 30, '#ddd'); },
  },
  // Varie
  pianta: {
    name: 'Pianta', cat: 'Varie', w: 45, d: 45, h: 120, color: '#5d7a4a',
    build(g, it) {
      cyl(g, it.w * 0.3, 35, 0, 0, 0, solid('#d8d2c7', { rough: 0.7 }), it.w * 0.24);
      const leaf = solid(it.color, { rough: 0.7 });
      for (let i = 0; i < 9; i++) {
        const a = i * 2.4, r = it.w * 0.22 * (0.3 + (i % 3) * 0.35);
        sphere(g, it.w * 0.22, Math.cos(a) * r, 35 + (it.h - 35) * (0.35 + 0.08 * (i % 5)), Math.sin(a) * r, leaf, 1.3);
      }
    },
    draw(ctx, it) { circ(ctx, 0, 0, it.w * 0.3); for (let i = 0; i < 7; i++) { const a = i * Math.PI * 2 / 7; ell(ctx, Math.cos(a) * it.w * 0.28, Math.sin(a) * it.w * 0.28, it.w * 0.2, it.w * 0.2); } },
  },
  scatola: {
    name: 'Blocco generico', cat: 'Varie', w: 60, d: 60, h: 60, color: '#d8d2c7',
    build(g, it) { box(g, it.w, it.h, it.d, 0, 0, 0, solid(it.color, { rough: 0.7 })); },
    draw(ctx, it) { box2d(ctx, it, '#fff'); },
  },
  cilindro: {
    name: 'Colonna / cilindro', cat: 'Varie', w: 40, d: 40, h: 270, color: '#f2efe9', round: true,
    build(g, it) { const c = cyl(g, it.w / 2, it.h, 0, 0, 0, solid(it.color, { rough: 0.7 }), it.w / 2, 48); c.scale.z = it.d / it.w; },
    draw(ctx, it) { ell(ctx, 0, 0, it.w / 2, it.d / 2, '#fff'); },
  },
  modello: {
    name: 'Modello importato', cat: 'Importati', w: 100, d: 100, h: 100, color: '#d8d2c7', hidden: true,
    build() { /* costruito da models.js */ },
    draw(ctx, it) { box2d(ctx, it, '#fff'); ctx.beginPath(); ctx.moveTo(-it.w / 2, -it.d / 2); ctx.lineTo(it.w / 2, it.d / 2); ctx.stroke(); },
  },
};

// "like": eredita da un'altra voce cambiando solo alcuni valori
for (const [k, v] of Object.entries(CATALOG)) {
  if (!v.like) continue;
  const base = CATALOG[v.like];
  const own = { ...v };
  const extra = own.extra;
  CATALOG[k] = { ...base, ...own };
  if (extra) CATALOG[k].build = (g, it) => { base.build(g, it); extra(g, it); };
  if (!own.draw) CATALOG[k].draw = base.draw;
}

export const CATEGORIES = ['Soggiorno', 'Pranzo', 'Cucina', 'Camera', 'Bagno', 'Luci', 'Varie'];

export function newItem(kind, x, y) {
  const c = CATALOG[kind];
  const it = { id: 'i' + Math.random().toString(36).slice(2, 9), kind, x, y, rot: 0, w: c.w, d: c.d, h: c.h, elev: c.elev ?? 0, color: c.color, color2: c.color2 || null };
  if (c.light) Object.assign(it, { on: true, power: 1, lightColor: '#ffd9a8' });
  if (c.noTv) it.tv = false;
  if (c.bases) it.base = c.bases[0];
  for (const p of c.params || []) it[p.key] = p.def;
  return it;
}
/** L'oggetto fa luce? (lampade del catalogo o modelli importati segnati come luminosi) */
export const isLamp = it => !!((CATALOG[it.kind] && CATALOG[it.kind].light) || it.glow);

/** Gruppo 3D di un mobile, gia' posizionato. models: mappa id -> geometria per i modelli importati. */
export function buildItem(it, wallHeight, modelGeo) {
  const c = CATALOG[it.kind] || CATALOG.scatola;
  const g = new THREE.Group();
  if (it.kind === 'modello' && modelGeo) {
    // colori del file oppure una tinta unica scelta dall'utente; se e' una lampada, luminoso
    const vc = modelGeo.hasAttribute('color') && !it.paint;
    const mat = it.glow ? new THREE.MeshStandardMaterial({ vertexColors: vc, color: vc ? 0xffffff : finishBase(it.color), roughness: 0.6, emissive: 0xffe2b0, emissiveIntensity: 1 })
      : vc ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }) : solid(it.color, { rough: 0.7 });
    const m = new THREE.Mesh(modelGeo, mat);
    m.scale.set(it.w * M / 2, it.h * M / 2, it.d * M / 2);
    m.position.y = it.h * M / 2;
    if (it.glow) { m.userData.bulb = 0.8; m.castShadow = false; }
    g.add(m);
  } else c.build(g, it);
  if (c.legH && (it.base === 'floor' || it.base === 'wall')) {
    const legs = [];
    g.traverse(o => { if (o.userData.leg) legs.push(o); });
    for (const l of legs) l.parent.remove(l);
    for (const ch of g.children) ch.position.y -= c.legH * M;
  }
  const elev = c.light === 'ceiling' ? wallHeight - it.h - 40 : c.light === 'flush' ? wallHeight - it.h : (it.elev || 0);
  g.position.set(it.x * M, elev * M, it.y * M);
  g.rotation.y = -it.rot * Math.PI / 180;
  g.userData.item = it.id;
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.item = it.id; } });
  if (c.light || it.glow) {
    const L = new THREE.PointLight(0xffd9a8, 0, 0, 2);
    const pos = { ceiling: [6, 0], flush: [-4, 0], floor: [it.h - 18, 0], wall: [it.h * 0.45, it.d * 0.25], table: [it.h * 0.68, 0] }[c.light] || [it.h * 0.6, 0];
    L.position.set(0, pos[0] * M, pos[1] * M);
    L.userData.lamp = true;
    L.userData.base = c.light === 'flush' ? 1 : 1.4;
    g.add(L);
  }
  // riferimento all'oggetto per accendere e spegnere (lighting.js)
  if (c.light || it.glow) g.traverse(o => { if (o.isLight || o.userData.bulb) o.userData.lampItem = it; });
  return g;
}
