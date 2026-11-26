// Vista 3D (three.js): orbita attorno alla casa o passeggiata in prima persona, selezione e
// trascinamento dei mobili sul pavimento, e render fotorealistico progressivo (path tracing).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildHouse } from './house3d.js';
import { GLASS } from './materials.js';

const M = 0.01;

export class View3D {
  /** app: { doc, sel, setSel, commit, changed, snapItem(it, p) , modelGeo(id) } */
  constructor(host, app) {
    this.host = host;
    this.app = app;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(r.domElement);
    r.domElement.className = 'v3d';
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    this.camera.position.set(8, 10, 12);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = true;
    // luci della vista di lavoro
    const pm = new THREE.PMREMGenerator(r);
    this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.35;
    this.hemi = new THREE.HemisphereLight(0xf2f6ff, 0x9c9282, 0.75);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    const gnd = new THREE.Mesh(new THREE.CircleGeometry(200, 64), new THREE.MeshStandardMaterial({ color: 0xcfd3c4, roughness: 1 }));
    gnd.rotation.x = -Math.PI / 2; gnd.position.y = -0.045; gnd.receiveShadow = true;
    gnd.userData.ground = true;
    this.ground = gnd;
    this.scene.add(gnd);
    this.scene.background = new THREE.Color(0xdfe6ec);
    this.houseGroup = null;
    this.mode = 'orbit';   // 'orbit' | 'walk'
    this.lowWalls = false;
    this.light = { mode: 'day', sunAz: 135, sunEl: 40, lamps: 1 };
    this.pt = null; this.tracing = false;
    this.renderExposure = 1.6;
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0;
    this._bind();
    this.visible = false;
    this.needsBuild = true;
    this.clock = new THREE.Timer();
    r.setAnimationLoop(() => this._frame());
  }

  setVisible(v) {
    this.visible = v;
    if (v) { this.resize(); if (this.needsBuild) this.rebuild(); }
    else this.stopTrace();
  }
  invalidate() { this.needsBuild = true; if (this.visible) { clearTimeout(this._rb); this._rb = setTimeout(() => this.rebuild(), 60); } }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px'; this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.pt) { this.pt.updateCamera(); }
    if (this.gpu) this.gpu.resize();
  }

  rebuild() {
    this.needsBuild = false;
    const doc = this.app.doc;
    if (this.houseGroup) { this.scene.remove(this.houseGroup); disposeGroup(this.houseGroup); }
    const inside = this.mode === 'walk' || (this.tracing && !this.useGpu);
    const { group, bounds } = buildHouse(doc, {
      ceilings: inside,
      models: this.app.modelGeos(),
      cutHeight: !inside && this.lowWalls ? 110 : null,
    });
    this.houseGroup = group;
    this.scene.add(group);
    this.bounds = bounds;
    this._applyLights();
    this._highlight();
    if (!this._framed && !bounds.isEmpty()) { this.frame(); this._framed = true; }
    if (this.tracing) this._resetTrace(true);
  }

  frame() {
    const b = this.bounds && !this.bounds.isEmpty() ? this.bounds : new THREE.Box3(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 3, 3));
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    // distanza perche' tutta la casa stia nel campo visivo, vista da sud-est e dall'alto
    const radius = Math.max(3.2, 0.5 * Math.hypot(s.x, s.z));
    const fov = this.camera.fov * Math.PI / 180;
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const dist = radius / Math.sin(fit / 2) * 1.25;
    const dir = new THREE.Vector3(0.38, 0.95, 0.5).normalize();
    this.setMode('orbit');
    this.controls.target.set(c.x, 0.4, c.z);
    this.camera.position.set(c.x + dir.x * dist, dir.y * dist, c.z + dir.z * dist);
    this.controls.update();
  }

  setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    if (m === 'walk') {
      this.controls.enabled = false;
      const doc = this.app.doc;
      // si parte dentro la stanza selezionata (o la piu' grande), guardando verso il lato piu' profondo
      const st = this.app.walkStart && this.app.walkStart();
      if (st) {
        this.camera.position.set(st.x * M, (doc.settings.eye || 160) * M, st.y * M);
        this.yaw = st.yaw;
      } else {
        const c = this.bounds && !this.bounds.isEmpty() ? this.bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3();
        this.camera.position.set(c.x, (doc.settings.eye || 160) * M, c.z);
        this.yaw = 0;
      }
      this.pitch = -0.08;
      this._applyLook();
    } else {
      this.controls.enabled = true;
      const dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);
      this.controls.target.copy(this.camera.position).addScaledVector(dir, 3);
      if (this.controls.target.y < 0) this.controls.target.y = 0.5;
    }
    this.invalidate();
  }
  _applyLook() {
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  setLight(opts) { Object.assign(this.light, opts); this._applyLights(); if (this.tracing) this._resetTrace(true); }
  _applyLights() {
    const L = this.light, day = L.mode === 'day';
    const az = L.sunAz * Math.PI / 180, el = L.sunEl * Math.PI / 180;
    const c = this.bounds && !this.bounds.isEmpty() ? this.bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const R = 30;
    this.sun.position.set(c.x + Math.sin(az) * Math.cos(el) * R, Math.sin(el) * R, c.z - Math.cos(az) * Math.cos(el) * R);
    this.sun.target.position.copy(c);
    const s = this.bounds && !this.bounds.isEmpty() ? this.bounds.getSize(new THREE.Vector3()) : new THREE.Vector3(10, 3, 10);
    const ext = Math.max(s.x, s.z) * 0.75 + 2;
    Object.assign(this.sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 80 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.intensity = day ? 2.4 : 0;
    this.sun.visible = day;
    this.hemi.intensity = day ? 0.75 : 0.12;
    this.scene.environmentIntensity = day ? 0.35 : 0.06;
    this.scene.background = new THREE.Color(day ? 0xdfe6ec : 0x1c2230);
    if (this.houseGroup) this.houseGroup.traverse(o => {
      if (o.isPointLight && o.userData.lamp) { o.intensity = day ? 0 : 1.4 * L.lamps; o.castShadow = false; o.distance = 0; }
    });
  }

  // ---------- selezione ----------
  _highlight() {
    if (!this.houseGroup) return;
    const sel = this.app.sel;
    const id = sel && sel.type === 'item' ? sel.id : null;
    this.houseGroup.traverse(o => {
      if (!o.isMesh || !o.userData.item) return;
      if (o.userData._mat === undefined) o.userData._mat = o.material;
      if (o.userData.item === id) {
        const m = (Array.isArray(o.userData._mat) ? o.userData._mat[0] : o.userData._mat).clone();
        m.emissive = new THREE.Color(0x2f7bf6); m.emissiveIntensity = 0.35;
        o.material = m;
      } else if (o.material !== o.userData._mat) { o.material.dispose(); o.material = o.userData._mat; }
    });
  }
  selectionChanged() { this._highlight(); }

  _ray(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(v, this.camera);
    return rc;
  }
  _floorPoint(e, y = 0) {
    const rc = this._ray(e);
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? { x: p.x / M, y: p.z / M } : null;
  }

  _bind() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', e => {
      this.down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
      if (this.mode === 'walk') { el.setPointerCapture(e.pointerId); this.look = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; return; }
      if (e.button !== 0 || !this.houseGroup) return;
      // trascinamento di un mobile selezionato
      const sel = this.app.sel;
      if (sel && sel.type === 'item') {
        const hit = this._ray(e).intersectObjects(this.houseGroup.children, true).find(h => h.object.userData.item);
        if (hit && hit.object.userData.item === sel.id) {
          const it = this.app.doc.items.find(i => i.id === sel.id);
          const p = this._floorPoint(e);
          if (it && p) {
            this.controls.enabled = false;
            el.setPointerCapture(e.pointerId);
            this.dragItem = { it, off: { x: it.x - p.x, y: it.y - p.y }, rot0: it.rot, moved: false };
          }
        }
      }
    });
    el.addEventListener('pointermove', e => {
      if (this.look && this.mode === 'walk') {
        const k = 0.005;
        this.yaw = this.look.yaw - (e.clientX - this.look.x) * k;
        this.pitch = Math.max(-1.3, Math.min(1.3, this.look.pitch - (e.clientY - this.look.y) * k));
        this._applyLook();
        if (this.tracing) this._resetTrace();
        return;
      }
      if (this.dragItem) {
        const p = this._floorPoint(e);
        if (!p) return;
        const d = this.dragItem;
        d.moved = true;
        d.it.x = p.x + d.off.x; d.it.y = p.y + d.off.y;
        const s = !e.altKey && this.app.snapItem(d.it, { x: d.it.x, y: d.it.y });
        if (s) Object.assign(d.it, s); else d.it.rot = d.rot0;
        if (!e.altKey && this.app.snapItems) this.app.snapItems(d.it);
        this._moveItemMesh(d.it);
        this.app.changed(true, true);
      }
    });
    const up = e => {
      if (this.look) { this.look = null; }
      if (this.dragItem) {
        const d = this.dragItem; this.dragItem = null;
        this.controls.enabled = this.mode === 'orbit';
        if (d.moved) { this.app.commit('Sposta arredo'); return; }
      }
      if (!this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5;
      this.down = null;
      if (moved || !this.houseGroup) return;
      // clic: selezione
      const hit = this._ray(e).intersectObjects(this.houseGroup.children, true).find(h => h.object.visible && !h.object.userData.glass);
      if (!hit) { this.app.setSel(null); return; }
      const u = hit.object.userData;
      if (u.item) this.app.setSel({ type: 'item', id: u.item });
      else if (u.wall) this.app.setSel({ type: 'wall', id: u.wall });
      else if (u.floor && u.room) this.app.setSel({ type: 'room', id: u.room });
      else if (u.floor) { const p = { x: hit.point.x / M, y: hit.point.z / M }; this.app.selectRoomAt && this.app.selectRoomAt(p); }
      else this.app.setSel(null);
      if (this.mode === 'walk' && e.detail === 2) { /* doppio tocco: niente */ }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => { if (this.mode === 'walk') { e.preventDefault(); this.camera.fov = Math.max(25, Math.min(90, this.camera.fov + e.deltaY * 0.03)); this.camera.updateProjectionMatrix(); if (this.tracing) this._resetTrace(); } }, { passive: false });
    this.controls.addEventListener('change', () => { if (this.tracing) this._resetTrace(); });
    window.addEventListener('keydown', e => { if (this.visible && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) this.keys.add(e.code); });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }
  /** Pulsanti a schermo (iPad): avanti/indietro/destra/sinistra mentre sono premuti */
  hold(code, on) { if (on) this.keys.add(code); else this.keys.delete(code); }

  _moveItemMesh(it) {
    if (!this.houseGroup) return;
    const g = this.houseGroup.children.find(o => o.userData.item === it.id && o.isGroup);
    if (!g) return;
    g.position.x = it.x * M; g.position.z = it.y * M;
    g.rotation.y = -it.rot * Math.PI / 180;
  }

  _frame() {
    if (!this.visible) return;
    this.clock.update();
    const dt = Math.min(0.1, this.clock.getDelta());
    if (this.mode === 'walk' && this.keys.size) {
      const sp = (this.keys.has('ShiftLeft') ? 3 : 1.4) * dt;
      const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const v = new THREE.Vector3();
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) v.add(f);
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) v.sub(f);
      if (this.keys.has('KeyD')) v.add(r);
      if (this.keys.has('KeyA')) v.sub(r);
      if (this.keys.has('ArrowLeft')) { this.yaw += dt * 1.6; this._applyLook(); }
      if (this.keys.has('ArrowRight')) { this.yaw -= dt * 1.6; this._applyLook(); }
      if (v.lengthSq()) { this.camera.position.addScaledVector(v.normalize(), sp); }
      if (this.tracing) this._resetTrace();
    }
    if (this.mode === 'orbit') this.controls.update();
    if (this.tracing && this.useGpu) {
      // disegna la tela WebGPU (render-gpu.js)
    } else if (this.tracing && this.pt) {
      this.pt.renderSample();
      if (this.onProgress) this.onProgress({ stage: 'rendering', samples: Math.floor(this.pt.samples), max: 0 });
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  // ---------- render fotorealistico ----------
  async startTrace(opts = {}) {
    this.traceOpts = { bounces: 6, scale: 1, ...opts };
    this.tracing = true;
    if (this.gpuOk === undefined) {
      const { webgpuAvailable } = await import('./render-gpu.js');
      this.gpuOk = await webgpuAvailable();
    }
    if (this.gpuOk) {
      try {
        if (!this.gpu) {
          const { GpuTracer } = await import('./render-gpu.js');
          this.gpu = new GpuTracer(this.host, this);
          await this.gpu.init();
        }
        if (!this.tracing) return;
        this.useGpu = true;
        this.gpu.resize();
        await this.gpu.setDenoise(this.traceOpts.denoise !== false);
        this.gpu.setup(this.app.doc, this.light, this.traceOpts);
        this.gpu.start(this.onProgress);
        this.renderer.domElement.style.visibility = 'hidden';
        return;
      } catch (e) { console.warn('WebGPU non disponibile, uso WebGL', e); this.gpuOk = false; this.useGpu = false; }
    }
    if (this.onSlow) this.onSlow();
    const { WebGLPathTracer, GradientEquirectTexture } = await import('three-gpu-pathtracer');
    this.rebuild(); // con i soffitti
    if (!this.pt) {
      this.pt = new WebGLPathTracer(this.renderer);
      this.pt.tiles.set(2, 2);
      this.pt.minSamples = 1;
      this.pt.fadeDuration = 300;
      this.pt.renderDelay = 0;
      this.pt.dynamicLowRes = true;
      this.pt.lowResScale = 0.35;
      this.pt.filterGlossyFactor = 0.5;
      this.GradientEquirectTexture = GradientEquirectTexture;
    }
    this.pt.bounces = this.traceOpts.bounces;
    this.pt.renderScale = this.traceOpts.scale;
    this._resetTrace(true);
  }
  _resetTrace(full) {
    if (this.useGpu) { if (full && this.tracing) this.gpu.setup(this.app.doc, this.light, this.traceOpts); return; }
    if (!this.pt || !this.tracing) return;
    if (!full) { this.pt.updateCamera(); return; }
    // scena per il path tracer: vetri tolti (la luce passa dalle finestre), cielo come ambiente
    const day = this.light.mode === 'day';
    const sky = new this.GradientEquirectTexture();
    sky.topColor.set(day ? 0x8fb8ea : 0x0d1424);
    sky.bottomColor.set(day ? 0xf3efe6 : 0x1b2232);
    sky.exponent = 2.2;
    sky.update();
    if (this.skyTex) this.skyTex.dispose();
    this.skyTex = sky;
    if (!this._savedEnv) this._savedEnv = { env: this.envTex, bg: null, ei: 0.35 };
    this.scene.environment = sky;
    this.scene.background = sky;
    this.scene.environmentIntensity = day ? 1.0 : 0.15;
    this.scene.backgroundIntensity = 1;
    this.hemi.visible = false;
    const hidden = [];
    this.houseGroup.traverse(o => { if (o.isMesh && o.material === GLASS) { o.visible = false; hidden.push(o); } });
    this.ground.visible = true;
    this.houseGroup.traverse(o => { if (o.isPointLight && o.userData.lamp) { o.intensity = day ? (this.light.lampsDay ? 1.4 : 0) : 1.6 * this.light.lamps; } });
    this.pt.setScene(this.scene, this.camera);
  }
  stopTrace() {
    if (!this.tracing) return;
    this.tracing = false;
    if (this.useGpu) { this.gpu.stop(); this.useGpu = false; this.renderer.domElement.style.visibility = ''; }
    if (this._savedEnv) { this.scene.environment = this._savedEnv.env; this._savedEnv = null; }
    this.hemi.visible = true;
    this.rebuild();
  }
  snapshot() {
    if (this.useGpu) return this.gpu.snapshot();
    return this.renderer.domElement.toDataURL('image/png');
  }
}

function disposeGroup(g) {
  g.traverse(o => { if (o.isMesh) { o.geometry.dispose(); if (o.userData._mat && o.material !== o.userData._mat) o.material.dispose(); } });
}
