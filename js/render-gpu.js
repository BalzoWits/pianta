// Render fotorealistico su WebGPU (three-gpu-pathtracer, versione WebGPU). Su Windows compila in pochi
// secondi, mentre la versione WebGL con Direct3D impiega minuti. Disegna su una tela sopra la vista 3D
// e copia a ogni fotogramma la camera della vista (orbita o passeggiata), cosi' si puo' muovere la vista.
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { WebGPUPathTracer, OIDNDenoiser } from 'pathtracer-webgpu';
import { buildHouse } from './house3d.js';
import { GLASS } from './materials.js';

const M = 0.01;

export async function webgpuAvailable() {
  try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) { return false; }
}

/** Cielo a gradiente (equirettangolare, float): zenit, orizzonte e terreno. */
export function skyTexture(day) {
  const W = 256, H = 128;
  const data = new Float32Array(W * H * 4);
  const top = day ? [0.32, 0.52, 0.95] : [0.01, 0.015, 0.035];
  const hor = day ? [1.0, 0.98, 0.94] : [0.05, 0.06, 0.09];
  const gnd = day ? [0.42, 0.40, 0.36] : [0.02, 0.02, 0.025];
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H; // 1 = zenit
    const el = (v - 0.5) * Math.PI; // elevazione
    let c;
    if (el >= 0) { const t = Math.pow(Math.sin(el), 0.55); c = hor.map((h, i) => h + (top[i] - h) * t); }
    else { const t = Math.min(1, -el * 6); c = hor.map((h, i) => h + (gnd[i] - h) * t); }
    for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 1; }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class GpuTracer {
  constructor(host, view) {
    this.host = host;
    this.view = view;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'v3d trace';
    this.canvas.style.pointerEvents = 'none';
    host.appendChild(this.canvas);
    this.running = false;
  }
  async init() {
    this.renderer = new WebGPURenderer({ canvas: this.canvas, antialias: false, trackTimestamp: true });
    await this.renderer.init();
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.pt = new WebGPUPathTracer(this.renderer);
    this.pt.renderDelay = 0;
    this.pt.fadeDuration = 200;
    this.pt.filterGlossyFactor = 0.5;
    this.pt.clampIndirect = 6;
    this.cam = new THREE.PerspectiveCamera();
    // avanzamento: compilazione, passaggi, pulizia del rumore
    this.state = { stage: 'building', samples: 0, max: 0, progress: null, done: false };
    this.pt.addEventListener('progress', e => {
      this.state.stage = e.stage; this.state.progress = e.progress; this.state.done = false;
      if (e.samples) this.state.samples = Math.floor(e.samples.avg);
      this._emit();
    });
    this.pt.addEventListener('complete', () => { this.state.done = true; this.state.stage = 'done'; this._emit(); });
  }
  _emit() { if (this.onProgress) this.onProgress({ ...this.state, max: this.pt.maxSamples }); }

  /** Denoiser OIDN (pesi "small", 640 KB, caricati la prima volta). */
  async setDenoise(on) {
    if (on && !this.denoiser) {
      try {
        const { initUNetFromURL } = await import('../lib/oidn-webgpu.js');
        this.denoiser = new OIDNDenoiser({ initUNetFromURL, auxWeightsUrl: new URL('../lib/oidn/rt_hdr_alb_nrm_small.tza', import.meta.url).href });
        this.denoiser.addEventListener('error', e => console.warn('denoiser', e));
      } catch (e) { console.warn('Denoiser non disponibile', e); this.denoiser = null; return; }
    }
    this.pt.setDenoiser(on ? this.denoiser : null);
  }
  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h || !this.renderer) return;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
  }

  /** (Ri)costruisce la scena: casa con soffitti, senza vetri, cielo, sole e lampade. */
  setup(doc, light, opts) {
    const day = light.mode === 'day';
    if (this.scene) this.scene.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    const scene = new THREE.Scene();
    const { group, bounds } = buildHouse(doc, { ceilings: true, models: this.view.app.modelGeos() });
    const glass = [];
    group.traverse(o => { if (o.isMesh && o.material === GLASS) glass.push(o); });
    for (const g of glass) g.parent.remove(g);
    group.traverse(o => { if (o.isPointLight && o.userData.lamp) { o.intensity = day ? (light.lampsDay ? 1.4 : 0) : 1.6 * light.lamps; o.visible = o.intensity > 0; } });
    scene.add(group);
    const gnd = new THREE.Mesh(new THREE.CircleGeometry(200, 48), new THREE.MeshStandardMaterial({ color: day ? 0xb7bda8 : 0x30332c, roughness: 1 }));
    gnd.rotation.x = -Math.PI / 2; gnd.position.y = -0.045;
    scene.add(gnd);
    if (day) {
      const c = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
      const az = light.sunAz * Math.PI / 180, el = light.sunEl * Math.PI / 180;
      const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
      sun.position.set(c.x + Math.sin(az) * Math.cos(el) * 30, Math.sin(el) * 30, c.z - Math.cos(az) * Math.cos(el) * 30);
      sun.target.position.copy(c);
      scene.add(sun, sun.target);
    }
    if (this.sky) this.sky.dispose();
    this.sky = skyTexture(day);
    scene.environment = this.sky;
    scene.background = this.sky;
    scene.environmentIntensity = day ? 2.2 : 0.6;
    this.scene = scene;
    this.pt.maxBounces = opts.bounces;
    this.pt.renderScale = opts.scale;
    this.pt.maxSamples = opts.samples || 0;
    this.state.samples = 0; this.state.done = false;
    this._syncCam(true);
    this.pt.setScene(scene, this.cam);
  }

  _syncCam(force) {
    const v = this.view.camera;
    v.updateMatrixWorld();
    const key = v.matrixWorld.elements.join(',') + v.fov + v.aspect;
    if (!force && key === this._camKey) return false;
    this._camKey = key;
    this.cam.position.copy(v.position); this.cam.quaternion.copy(v.quaternion);
    this.cam.fov = v.fov; this.cam.aspect = v.aspect; this.cam.near = v.near; this.cam.far = v.far;
    this.cam.updateProjectionMatrix(); this.cam.updateMatrixWorld();
    return true;
  }

  start(onProgress) {
    this.running = true;
    this.canvas.hidden = false;
    this.onProgress = onProgress;
    const loop = () => {
      if (!this.running) return;
      if (this._syncCam(false)) this.pt.updateCamera();
      this.renderer.toneMappingExposure = this.view.renderExposure;
      this.pt.renderSample();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
    this.canvas.hidden = true;
  }
  /** Immagine attuale (si rende un passaggio e si legge subito la tela, nello stesso giro). */
  snapshot() {
    this.pt.renderSample();
    return this.canvas.toDataURL('image/png');
  }
}
