// Render fotorealistico su WebGPU (three-gpu-pathtracer, versione WebGPU). Su Windows compila in pochi
// secondi, mentre la versione WebGL con Direct3D impiega minuti. Disegna su una tela sopra la vista 3D
// e copia a ogni fotogramma la camera della vista (orbita o passeggiata), cosi' si puo' muovere la vista.
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { WebGPUPathTracer, OIDNDenoiser } from 'pathtracer-webgpu';
import { buildRenderScene } from './lighting.js?v=mwytbqcp';

const M = 0.01;

/** WebGPU utilizzabile? Restituisce { ok, why } (il motivo serve per spiegarlo all'utente). */
export async function webgpuAvailable() {
  if (!navigator.gpu) return { ok: false, why: 'questo browser non ha WebGPU (su iPhone e iPad serve iOS/iPadOS 26 o successivo)' };
  try { const a = await navigator.gpu.requestAdapter(); return a ? { ok: true } : { ok: false, why: 'la scheda grafica non è disponibile per WebGPU' }; }
  catch (e) { return { ok: false, why: 'WebGPU non si è avviato (' + e.message + ')' }; }
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

  /** (Ri)costruisce la scena (lighting.js: la stessa del render WebGL). */
  setup(doc, light, opts) {
    if (this.scene) this.scene.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    if (this.sky) this.sky.dispose();
    const { scene, sky, R } = buildRenderScene(doc, this.view.camera, light, this.view.app.modelGeos());
    this.scene = scene; this.sky = sky; this.R = R;
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
      this.renderer.toneMappingExposure = (this.R ? this.R.exposure : 1.4) * (this.view.renderExposure / 1.6);
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
