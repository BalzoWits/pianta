// Miniature 3D degli arredi per il catalogo: ogni mobile reso una volta in vista tre quarti, poi in cache.
import * as THREE from 'three';
import { buildItem, newItem } from './furniture.js?v=mwz0jl1g';

let R = null, scene, cam;
const cache = new Map();
const W = 120, H = 96;

function setup() {
  const c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2;
  R = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
  R.setPixelRatio(1);
  R.setSize(W * 2, H * 2, false);
  R.outputColorSpace = THREE.SRGBColorSpace;
  R.toneMapping = THREE.ACESFilmicToneMapping;
  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9083, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(2, 4, 3); scene.add(sun);
  cam = new THREE.PerspectiveCamera(30, W / H, 0.01, 50);
}

/** dataURL della miniatura (null se WebGL non e' disponibile). */
export function itemThumb(kind) {
  if (cache.has(kind)) return cache.get(kind);
  try {
    if (!R) setup();
    const it = newItem(kind, 0, 0);
    it.elev = 0;
    const g = buildItem(it, (it.h || 100) + 45, null);
    g.position.set(0, 0, 0);
    g.traverse(o => { if (o.isLight) o.visible = false; if (o.isMesh && o.userData.bulb) o.material.emissiveIntensity = Math.min(1, o.userData.bulb); });
    scene.add(g);
    const b = new THREE.Box3().setFromObject(g);
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    const r = Math.max(0.05, 0.5 * Math.hypot(s.x, s.y, s.z));
    const dir = new THREE.Vector3(0.75, 0.6, 1).normalize();
    cam.position.copy(c).addScaledVector(dir, r / Math.sin(15 * Math.PI / 180) * 0.95);
    cam.lookAt(c);
    R.setClearColor(0x000000, 0);
    R.render(scene, cam);
    const url = R.domElement.toDataURL('image/png');
    scene.remove(g);
    g.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    cache.set(kind, url);
    return url;
  } catch (e) { cache.set(kind, null); return null; }
}
