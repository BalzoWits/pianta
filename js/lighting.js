// Illuminazione condivisa da vista 3D e render (WebGPU e WebGL): preset, cielo, sole, lampade e luce di
// riempimento automatica nella stanza in cui si trova la camera. Cosi' tutti i motori danno la stessa immagine.
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import * as G from './geom.js?v=mwyu6iif';
import { buildHouse } from './house3d.js?v=mwyu6iif';
import { GLASS } from './materials.js?v=mwyu6iif';

const M = 0.01;
let rectLibReady = false;
export function initRectLights() { if (!rectLibReady) { RectAreaLightUniformsLib.init(); rectLibReady = true; } }

// sun: intensita' del sole; env: intensita' del cielo; fill: luce di riempimento della stanza;
// lamps: lampade accese; exposure: esposizione del render
export const LIGHT_PRESETS = {
  auto: { name: 'Automatica', hint: 'Sole all’ora scelta più una luce diffusa nella stanza: interni sempre ben illuminati', sun: 3.2, env: 2.2, fill: 1, fillColor: '#fff6ea', lamps: false, exposure: 1.4 },
  mattina: { name: 'Mattina', hint: 'Sole basso da est, luce fresca', time: 8.5, sun: 3.2, env: 2.0, fill: 0.5, fillColor: '#fff8f0', lamps: false, exposure: 1.5 },
  mezzogiorno: { name: 'Mezzogiorno', hint: 'Sole alto da sud, luce piena', time: 13, sun: 3.2, env: 2.2, fill: 0.4, fillColor: '#ffffff', lamps: false, exposure: 1.45 },
  pomeriggio: { name: 'Pomeriggio', hint: 'Sole da ovest, luce calda e ombre lunghe', time: 16.5, sun: 3.2, env: 2.0, fill: 0.5, fillColor: '#fff4e6', lamps: false, exposure: 1.5 },
  tramonto: { name: 'Tramonto', hint: 'Sole all’orizzonte, luce arancione, lampade accese', time: 'tramonto', sun: 3.6, env: 0.8, fill: 0.35, fillColor: '#ffd8b0', lamps: true, exposure: 1.6 },
  sera: { name: 'Sera', hint: 'Buio fuori, luce solo dalle lampade (più una leggera luce diffusa)', night: true, sun: 0, env: 0.5, fill: 0.2, fillColor: '#ffd9a8', lamps: true, exposure: 1.5 },
  giorno: { name: 'Solo finestre', hint: 'Sole all’ora scelta e cielo, senza aiuti: come nella realtà', sun: 3.2, env: 2.2, fill: 0, fillColor: '#ffffff', lamps: false, exposure: 1.6 },
  studio: { name: 'Studio', hint: 'Luce bianca uniforme, senza ombre nette: per vedere bene arredi e colori', noSun: true, sun: 0, env: 3, fill: 1.6, fillColor: '#ffffff', lamps: false, exposure: 1.3 },
};

const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function declination(month) { const n = Math.round((month - 0.5) * 30.4); return 23.44 * Math.sin(2 * Math.PI * (284 + n) / 365); }
/** Posizione del sole (ora solare, mese 1-12, latitudine): { el, az } in gradi, az da nord in senso orario. */
export function sunPosition(time, month, lat) {
  const d = rad(declination(month)), f = rad(lat), H = rad(15 * (time - 12));
  const el = Math.asin(Math.sin(f) * Math.sin(d) + Math.cos(f) * Math.cos(d) * Math.cos(H));
  const az = Math.atan2(-Math.cos(d) * Math.sin(H), Math.sin(d) * Math.cos(f) - Math.cos(d) * Math.cos(H) * Math.sin(f));
  return { el: deg(el), az: (deg(az) + 360) % 360 };
}
/** Ora del tramonto (solare) per mese e latitudine. */
export function sunsetTime(month, lat) {
  const c = -Math.tan(rad(lat)) * Math.tan(rad(declination(month)));
  return 12 + deg(Math.acos(Math.max(-1, Math.min(1, c)))) / 15;
}
export const fmtTime = t => { const hh = Math.floor(t), mm = Math.round((t - hh) * 60); return hh + ':' + String(mm === 60 ? 0 : mm).padStart(2, '0'); };

/** Stato della luce (preset, ora, mese, nord della casa) -> valori da usare. */
export function resolveLight(L) {
  const P = LIGHT_PRESETS[L.preset] || LIGHT_PRESETS.auto;
  const month = L.month || 6, lat = L.lat ?? 45, north = L.north || 0;
  const time = P.time === 'tramonto' ? sunsetTime(month, lat) - 0.35 : (L.time ?? 11);
  const sp = sunPosition(time, month, lat);
  // notte: preset Sera o sole sotto l'orizzonte
  const day = !P.night && sp.el > -1;
  const el = Math.max(2, sp.el);
  // colore e forza del sole secondo l'altezza: arancione all'alba e al tramonto
  const t = Math.min(1, Math.max(0, (el - 2) / 28));
  const warm = new THREE.Color('#ff9a50').lerp(new THREE.Color('#fff0d8'), t);
  const skyK = Math.min(1, 0.35 + Math.sin(rad(el)) * 1.6);
  return {
    ...P,
    day,
    time, month,
    sunAz: (sp.az + north) % 360, // in pianta: da "su" in senso orario
    sunEl: el,
    sun: day && !P.noSun ? P.sun * (0.75 + 0.25 * t) : 0,
    sunColor: '#' + warm.getHexString(),
    warmSky: day && el < 12,
    env: day ? P.env * (P.noSun ? 1 : skyK) : (P.night ? P.env : 0.45),
    lampsOn: P.lamps || !!L.lampsDay || !day,
    lampScale: L.lamps ?? 1,
    fill: P.fill * (L.fillScale ?? 1),
    exposure: P.exposure * (L.expScale ?? 1),
  };
}

/** Cielo a gradiente (equirettangolare, mezza precisione: filtrabile su ogni GPU, anche iPad). */
export function skyTexture(day, warm = false) {
  const W = 256, H = 128;
  const data = new Uint16Array(W * H * 4);
  const top = day ? (warm ? [0.35, 0.42, 0.75] : [0.32, 0.52, 0.95]) : [0.01, 0.015, 0.035];
  const hor = day ? (warm ? [1.0, 0.72, 0.45] : [1.0, 0.98, 0.94]) : [0.05, 0.06, 0.09];
  const gnd = day ? [0.42, 0.40, 0.36] : [0.02, 0.02, 0.025];
  const f = THREE.DataUtils.toHalfFloat;
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H;
    const el = (v - 0.5) * Math.PI;
    let c;
    if (el >= 0) { const t = Math.pow(Math.sin(el), 0.55); c = hor.map((h, i) => h + (top[i] - h) * t); }
    else { const t = Math.min(1, -el * 6); c = hor.map((h, i) => h + (gnd[i] - h) * t); }
    for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; data[o] = f(c[0]); data[o + 1] = f(c[1]); data[o + 2] = f(c[2]); data[o + 3] = f(1); }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Intensita' di lampade e lampadine (per oggetto: accesa, potenza, colore). k = scala del motore. */
export function applyLamps(group, R, k = 1) {
  group.traverse(o => {
    const it = o.userData.lampItem;
    if (!it) return;
    const on = R.lampsOn && it.on !== false;
    const p = (it.power ?? 1) * R.lampScale;
    const col = new THREE.Color(it.lightColor || '#ffd9a8');
    if (o.isLight) { o.intensity = on ? o.userData.base * p * k : 0; o.color.copy(col); o.visible = on; o.castShadow = false; }
    else if (o.isMesh && o.userData.bulb) {
      // i paralumi (bulb basso) prendono un po' del loro colore, le lampadine il colore della luce
      if (o.userData.bulb < 0.5) o.material.emissive.copy(col).lerp(o.material.color, 0.3); else o.material.emissive.copy(col);
      o.material.emissiveIntensity = on ? o.userData.bulb * Math.min(2, p) : 0;
    }
  });
}

/** Stanza che contiene il punto (cm), o null. */
export function roomAt(doc, p) {
  const rooms = G.findRooms(doc);
  return rooms.filter(r => G.pointInPoly(p, r.poly)).sort((a, b) => a.area - b.area)[0] || null;
}

/**
 * Luce di riempimento: un pannello luminoso sotto il soffitto della stanza in cui sta la camera (o di
 * tutte, piu' deboli, se la camera e' fuori). Morbida e senza ombre nette: schiarisce gli interni.
 */
export function addFill(target, doc, camPos, R, k = 1) {
  if (!(R.fill > 0)) return [];
  initRectLights();
  const H = doc.settings.wallHeight;
  const here = roomAt(doc, { x: camPos.x / M, y: camPos.z / M });
  const rooms = here ? [here] : G.findRooms(doc);
  const lights = [];
  for (const r of rooms) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of r.inner) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const c = G.interiorPoint(r.inner);
    const w = Math.max(40, (x1 - x0) * 0.55), d = Math.max(40, (y1 - y0) * 0.55);
    const L = new THREE.RectAreaLight(new THREE.Color(R.fillColor), 4.5 * R.fill * k * (here ? 1 : 0.6), w * M, d * M);
    L.position.set(c.x * M, (H - 2) * M, c.y * M);
    L.rotation.x = -Math.PI / 2;
    L.userData.fill = true;
    target.add(L);
    lights.push(L);
  }
  return lights;
}

/** Scena completa per il path tracer (uguale per WebGPU e WebGL). */
export function buildRenderScene(doc, camera, L, models) {
  const R = resolveLight({ ...L, north: doc.settings.north || 0, lat: doc.settings.lat ?? 45 });
  const scene = new THREE.Scene();
  const inside = camera.position.y * 100 < doc.settings.wallHeight;
  const { group, bounds } = buildHouse(doc, { ceilings: inside, models });
  const glass = [];
  group.traverse(o => { if (o.isMesh && o.material === GLASS) glass.push(o); });
  for (const g of glass) g.parent.remove(g);
  applyLamps(group, R, 4);
  scene.add(group);
  const gnd = new THREE.Mesh(new THREE.CircleGeometry(200, 48), new THREE.MeshStandardMaterial({ color: R.day ? 0xb7bda8 : 0x30332c, roughness: 1 }));
  gnd.rotation.x = -Math.PI / 2; gnd.position.y = -0.045;
  scene.add(gnd);
  if (R.day && R.sun > 0) {
    const c = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
    const az = R.sunAz * Math.PI / 180, el = R.sunEl * Math.PI / 180;
    const sun = new THREE.DirectionalLight(new THREE.Color(R.sunColor), R.sun);
    sun.position.set(c.x + Math.sin(az) * Math.cos(el) * 30, Math.sin(el) * 30, c.z - Math.cos(az) * Math.cos(el) * 30);
    sun.target.position.copy(c);
    scene.add(sun, sun.target);
  }
  addFill(scene, doc, camera.position, R);
  const sky = skyTexture(R.day, R.warmSky);
  scene.environment = sky;
  scene.background = sky;
  scene.environmentIntensity = R.env;
  return { scene, sky, R };
}
