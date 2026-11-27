// Editor della pianta in 2D su canvas: disegno delle pareti con agganci e quote, porte e finestre,
// mobili, stanze, quote libere e foto di sfondo. Funziona con mouse, tastiera e touch (iPad).
import * as G from './geom.js';
import { CATALOG } from './furniture.js';
import { FLOORS, floorTint } from './materials.js';

const COL = {
  bg: '#f6f5f2', grid: '#e6e3dc', grid2: '#d6d2c9', wall: '#2f343b', wallSel: '#2f7bf6', node: '#2f7bf6',
  dim: '#5b6470', dimExt: '#2f343b', room: '#ffffff', text: '#2a2e35', snap: '#e8590c', guide: 'rgba(232,89,12,0.55)',
  item: '#5d636b', sel: '#2f7bf6', open: '#ffffff',
};
const FLOOR_TINT = { parquet: '#efe4d4', parquet2: '#e4d8cc', sbiancato: '#f2eee7', gres: '#eeeeec', gres2: '#e2e2e0', cotto: '#f1ddd2', marmo: '#f7f7f6', cemento: '#ebebea', mosaico: '#e2eef0', moquette: '#ebecee' };

const NOSNAP = new Set(['tappeto', 'lampadario', 'lampadaTerra', 'tavolo', 'tavoloTondo', 'tavolino', 'sedia', 'pianta', 'cilindro', 'pouf', 'sgabello', 'isola', 'sediaUfficio', 'faretto']);

export const OPENING_TYPES = {
  door: { name: 'Porta', width: 80, height: 210, sill: 0 },
  door2: { name: 'Porta a due ante', width: 120, height: 210, sill: 0 },
  slide: { name: 'Scorrevole esterna', width: 80, height: 210, sill: 0 },
  pocket: { name: 'Scorrevole a scomparsa', width: 80, height: 210, sill: 0 },
  window: { name: 'Finestra', width: 120, height: 140, sill: 90 },
  french: { name: 'Portafinestra', width: 120, height: 230, sill: 0 },
  opening: { name: 'Vano aperto', width: 90, height: 210, sill: 0 },
};

export const fmtCm = v => { const r = Math.round(v * 10) / 10; return (Number.isInteger(r) ? r : r.toFixed(1).replace('.', ',')); };
export const fmtM2 = v => v.toFixed(v < 10 ? 2 : 1).replace('.', ',') + ' m²';

export class Plan2D {
  /** app: { doc, sel, setSel(sel), commit(label), changed(), toolDone(), onTyped(), photo } */
  constructor(canvas, app) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.snapPrefs = { angle: true, align: true, grid: true };
    this.view = { ox: 0, oy: 0, s: 1 }; // pixel per cm
    this.tool = 'select';
    this.toolOpt = {};
    this.draft = null;     // disegno in corso
    this.hover = null;     // punto agganciato sotto il cursore
    this.drag = null;
    this.pointers = new Map();
    this.typed = '';
    this.labelBoxes = [];
    this.photoOverlay = null; // { boxes: [...] } dall'OCR
    this.dirty = true;
    this._bind();
    const loop = () => { if (this.dirty && this.visible) { this.dirty = false; this.draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    this.visible = true;
  }
  get doc() { return this.app.doc; }
  redraw() { this.dirty = true; }

  // ---------- coordinate ----------
  toScreen(p) { return { x: p.x * this.view.s + this.view.ox, y: p.y * this.view.s + this.view.oy }; }
  toPlan(x, y) { return { x: (x - this.view.ox) / this.view.s, y: (y - this.view.oy) / this.view.s }; }
  px(n) { return n / this.view.s; } // n pixel in cm
  /** Passo di aggancio: la griglia del progetto, piu' fine quando si ingrandisce. */
  gridStep() {
    const g = this.doc.settings.grid;
    if (!g) return 0;
    for (const c of [g, 5, 2, 1]) if (c <= g && c * this.view.s <= 12) return c;
    return 0.5;
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.W = r.width; this.H = r.height;
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.redraw();
  }

  fit() {
    const d = this.doc;
    const pts = [...d.nodes, ...d.items.map(i => ({ x: i.x, y: i.y }))];
    const bg = this.app.photo && this.app.photo.corners();
    if (bg) pts.push(...bg);
    if (!pts.length) { this.view.s = Math.min(this.W, this.H) / 1200; this.view.ox = this.W / 2; this.view.oy = this.H / 2; this.redraw(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const w = Math.max(200, x1 - x0), h = Math.max(200, y1 - y0);
    this.view.s = Math.min((this.W - 120) / w, (this.H - 120) / h);
    this.view.ox = this.W / 2 - (x0 + x1) / 2 * this.view.s;
    this.view.oy = this.H / 2 - (y0 + y1) / 2 * this.view.s;
    this.redraw();
  }
  zoomAt(x, y, f) {
    const s2 = Math.max(0.02, Math.min(20, this.view.s * f));
    const p = this.toPlan(x, y);
    this.view.s = s2;
    this.view.ox = x - p.x * s2; this.view.oy = y - p.y * s2;
    this.redraw();
  }

  setTool(t, opt = {}) {
    this.tool = t; this.toolOpt = opt; this.draft = null; this.typed = ''; this.hover = null;
    this.cv.style.cursor = t === 'select' ? 'default' : t === 'pan' ? 'grab' : 'crosshair';
    this.app.onTyped && this.app.onTyped('');
    this.redraw();
  }

  // ---------- agganci ----------
  snap(p, opts = {}) {
    const d = this.doc, tolN = this.px(12), tolW = this.px(9), tolA = this.px(8);
    const res = { p: { ...p }, kind: null, guides: [] };
    const excl = opts.exclude || new Set();
    // nodi
    let best = null, bd = tolN;
    for (const n of d.nodes) { if (excl.has(n.id)) continue; const dd = G.dist(n, p); if (dd < bd) { bd = dd; best = n; } }
    if (best) { res.p = { x: best.x, y: best.y }; res.kind = 'node'; res.node = best; return res; }
    // foto di sfondo: centro dei muri disegnati
    let photoSnap = null;
    if (this.app.photo && this.app.photo.snapOn()) photoSnap = this.app.photo.snapPoint(p, this.px(10));
    if (photoSnap) {
      // l'aggancio non deve far saltare il punto: oltre 14 pixel sullo schermo si ignora (per asse)
      const lim = this.px(14);
      if (photoSnap.x != null && Math.abs(photoSnap.x - p.x) > lim) photoSnap.x = null;
      if (photoSnap.y != null && Math.abs(photoSnap.y - p.y) > lim) photoSnap.y = null;
      if (photoSnap.x == null && photoSnap.y == null) photoSnap = null;
    }
    const SP = this.snapPrefs || {};
    // angoli rispetto al punto di partenza
    let q = { ...p };
    let angLocked = false;
    if (photoSnap && (photoSnap.x != null || photoSnap.y != null)) {
      if (photoSnap.x != null) q.x = photoSnap.x;
      if (photoSnap.y != null) q.y = photoSnap.y;
      res.kind = 'photo'; res.thick = photoSnap.thick;
    }
    if (opts.from && !opts.free && SP.angle !== false) {
      const v = G.sub(q, opts.from), L = G.len(v);
      if (L > this.px(10)) {
        const a = Math.atan2(v.y, v.x);
        const step = Math.PI / 12; // 15°
        const a2 = Math.round(a / step) * step;
        const tol = (Math.abs(Math.round(a2 / (Math.PI / 2)) * (Math.PI / 2) - a2) < 1e-6) ? 0.07 : 0.035;
        if (Math.abs(a - a2) < tol) {
          const dir = { x: Math.cos(a2), y: Math.sin(a2) };
          const L2 = G.dot(v, dir);
          q = G.add(opts.from, G.mul(dir, L2));
          angLocked = dir;
          res.guides.push({ a: opts.from, b: q, kind: 'angle' });
        }
      }
    }
    // allineamento con altri nodi (orizzontale/verticale)
    let ax = null, ay = null;
    for (const n of (SP.align === false ? [] : d.nodes)) {
      if (excl.has(n.id)) continue;
      if (Math.abs(n.x - q.x) < tolA && (ax == null || Math.abs(n.x - q.x) < Math.abs(ax.x - q.x))) ax = n;
      if (Math.abs(n.y - q.y) < tolA && (ay == null || Math.abs(n.y - q.y) < Math.abs(ay.y - q.y))) ay = n;
    }
    if (angLocked) {
      // lungo una direzione bloccata: ci si allinea solo se la direzione non e' parallela alla guida
      if (ax && Math.abs(angLocked.x) > 0.2) { const t = (ax.x - opts.from.x) / angLocked.x; q = G.add(opts.from, G.mul(angLocked, t)); res.guides.push({ a: ax, b: q, kind: 'align' }); }
      else if (ay && Math.abs(angLocked.y) > 0.2) { const t = (ay.y - opts.from.y) / angLocked.y; q = G.add(opts.from, G.mul(angLocked, t)); res.guides.push({ a: ay, b: q, kind: 'align' }); }
    } else {
      if (ax) { q.x = ax.x; res.guides.push({ a: ax, b: { x: q.x, y: q.y }, kind: 'align' }); }
      if (ay) { q.y = ay.y; res.guides.push({ a: ay, b: { x: q.x, y: q.y }, kind: 'align' }); }
    }
    // corpo di una parete (per i collegamenti a T)
    if (!ax && !ay && !photoSnap) {
      for (const w of d.walls) {
        if (excl.has(w.a) || excl.has(w.b)) continue;
        const A = G.nodeById(d, w.a), B = G.nodeById(d, w.b);
        const pr = G.projSeg(q, A, B);
        if (pr.d < tolW + w.thickness / 2 && pr.t > 0 && pr.t < 1) {
          if (angLocked) { const it = G.lineInter(opts.from, angLocked, A, G.sub(B, A)); if (it && G.dist(it, q) < tolW * 2) { q = it; res.kind = 'wall'; } }
          else { q = pr.p; res.kind = 'wall'; }
          break;
        }
      }
    }
    // griglia
    if (!res.kind && !ax && !ay && !angLocked && d.settings.grid && !opts.noGrid && SP.grid !== false) {
      const g = this.gridStep();
      q = { x: Math.round(q.x / g) * g, y: Math.round(q.y / g) * g };
    } else if (!res.kind && angLocked && d.settings.grid && opts.from && !ax && !ay && SP.grid !== false) {
      // lunghezza arrotondata alla griglia lungo la direzione bloccata
      const g = this.gridStep();
      const L = Math.round(G.dist(opts.from, q) / g) * g;
      q = G.add(opts.from, G.mul(angLocked, L));
    }
    res.p = q;
    if (!res.kind) res.kind = angLocked ? 'angle' : (ax || ay) ? 'align' : 'free';
    return res;
  }

  // ---------- ricerca di cosa c'e' sotto il cursore ----------
  hit(p) {
    const d = this.doc, tol = this.px(7);
    const sel = this.app.sel;
    // maniglie del mobile selezionato
    if (sel && sel.type === 'item') {
      const it = d.items.find(i => i.id === sel.id);
      if (it) {
        const h = this.itemHandles(it);
        if (G.dist(p, h.rot) < this.px(12)) return { type: 'item-rot', id: it.id };
        if (G.dist(p, h.size) < this.px(12)) return { type: 'item-size', id: it.id };
        for (const k of ['E', 'W', 'S', 'N']) if (G.dist(p, h[k]) < this.px(13)) return { type: 'item-side', id: it.id, side: k };
      }
    }
    if (sel && sel.type === 'dim') {
      const dm = d.dims.find(x => x.id === sel.id);
      if (dm) { const g = this.dimGeom(dm); if (G.dist(p, g.a2) < this.px(10)) return { type: 'dim-a', id: dm.id }; if (G.dist(p, g.b2) < this.px(10)) return { type: 'dim-b', id: dm.id }; }
    }
    // nodi (sempre afferrabili, sopra le pareti)
    { let bn = null, bd = this.px(13); for (const n of d.nodes) { const dd = G.dist(n, p); if (dd < bd) { bd = dd; bn = n; } } if (bn) return { type: 'node', id: bn.id }; }
    // aperture
    const corners = this.corners || G.wallCorners(d);
    for (const o of d.openings) {
      const w = G.wallById(d, o.wall); if (!w) continue;
      const c = corners.get(w.id); if (!c) continue;
      const l = G.toLocal(c, p);
      if (Math.abs(l.s - o.pos) < o.width / 2 && Math.abs(l.o) < w.thickness / 2 + tol) return { type: 'opening', id: o.id };
    }
    // mobili (dall'ultimo, che e' disegnato sopra)
    for (let i = d.items.length - 1; i >= 0; i--) {
      const it = d.items[i];
      const l = this.itemLocal(it, p);
      if (Math.abs(l.x) <= it.w / 2 + tol && Math.abs(l.y) <= it.d / 2 + tol) return { type: 'item', id: it.id };
    }
    // quote libere
    for (const dm of d.dims) {
      const g = this.dimGeom(dm);
      if (G.projSeg(p, g.a2, g.b2).d < tol) return { type: 'dim', id: dm.id };
    }
    // pareti
    for (const w of d.walls) {
      const c = corners.get(w.id);
      if (G.pointInPoly(p, G.wallPolygon(c))) return { type: 'wall', id: w.id };
      if (G.projSeg(p, c.A, c.B).d < w.thickness / 2 + tol) return { type: 'wall', id: w.id };
    }
    // etichette delle stanze
    for (const r of d.rooms) if (G.dist(r, p) < this.px(20)) return { type: 'room', id: r.id };
    // interno di una stanza
    const rooms = this.rooms || [];
    const f = rooms.filter(r => G.pointInPoly(p, r.poly)).sort((a, b) => a.area - b.area)[0];
    if (f) return { type: 'roomface', face: f };
    return null;
  }

  itemLocal(it, p) {
    const a = it.rot * Math.PI / 180, dx = p.x - it.x, dy = p.y - it.y;
    return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
  }
  itemWorld(it, x, y) {
    const a = it.rot * Math.PI / 180;
    return { x: it.x + x * Math.cos(a) - y * Math.sin(a), y: it.y + x * Math.sin(a) + y * Math.cos(a) };
  }
  itemHandles(it) {
    const o = this.px(14);
    return {
      rot: this.itemWorld(it, 0, -it.d / 2 - this.px(30)), size: this.itemWorld(it, it.w / 2, it.d / 2),
      // freccette: destra, sinistra, davanti, dietro (fuori dal mobile)
      E: this.itemWorld(it, it.w / 2 + o, 0), W: this.itemWorld(it, -it.w / 2 - o, 0),
      S: this.itemWorld(it, 0, it.d / 2 + o), N: this.itemWorld(it, it.w * 0.3, -it.d / 2 - o),
    };
  }
  /** Avvicina il mobile al filo del muro piu' vicino girandogli la schiena verso il muro. */
  snapItemToWall(it, p) {
    if (NOSNAP.has(it.kind)) return null;
    const d = this.doc, corners = this.visible && this.corners ? this.corners : G.wallCorners(d);
    const reach = Math.max(it.d / 2 + this.px(16), it.d / 2 + 12);
    let best = null;
    for (const w of d.walls) {
      if (w.virtual) continue;
      const c = corners.get(w.id);
      const l = G.toLocal(c, p);
      const L = G.dist(c.A, c.B);
      if (l.s < -it.w / 2 || l.s > L + it.w / 2) continue;
      const side = l.o >= 0 ? 1 : -1;
      const face = side * c.h;
      const gap = Math.abs(l.o - face) - it.d / 2;
      if (Math.abs(l.o) < c.h) continue;
      if (gap < reach - it.d / 2 && (!best || gap < best.gap)) best = { c, l, side, face, gap, w };
    }
    if (!best) return null;
    const { c, l, side, face } = best;
    // schiena verso il muro: il fronte del mobile (+y locale) guarda lontano dal muro (verso side*n)
    const nrm = G.mul(c.n, side);
    const rot = Math.atan2(-nrm.x, nrm.y) * 180 / Math.PI;
    const pos = G.toWorld(c, l.s, face + side * it.d / 2);
    return { x: pos.x, y: pos.y, rot: Math.round(rot * 100) / 100 };
  }

  /**
   * Magnetismo fra mobili con la stessa rotazione (o ruotati di 90°): si accostano lato contro lato
   * e si allineano al filo del vicino. tol in cm (di default 10 pixel dello schermo).
   */
  snapItemToItems(it, tol = this.px(10)) {
    if (it.kind === 'tappeto' || it.kind === 'lampadario') return false;
    let bx = null, by = null;
    for (const o of this.doc.items) {
      if (o === it || o.kind === 'tappeto' || o.kind === 'lampadario') continue;
      const dr = (((o.rot - it.rot) % 90) + 90) % 90;
      if (dr > 1 && dr < 89) continue;
      const q = (((o.rot - it.rot) % 180) + 180) % 180;
      const swap = Math.abs(q - 90) < 1;
      const ow = swap ? o.d : o.w, od = swap ? o.w : o.d;
      const l = this.itemLocal(it, o);
      const near = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > -tol;
      const xs = [[it.w / 2, l.x - ow / 2], [-it.w / 2, l.x + ow / 2], [-it.w / 2, l.x - ow / 2], [it.w / 2, l.x + ow / 2]];
      const ys = [[it.d / 2, l.y - od / 2], [-it.d / 2, l.y + od / 2], [-it.d / 2, l.y - od / 2], [it.d / 2, l.y + od / 2]];
      const rowY = near(-it.d / 2, it.d / 2, l.y - od / 2, l.y + od / 2), rowX = near(-it.w / 2, it.w / 2, l.x - ow / 2, l.x + ow / 2);
      if (rowY) for (const [m, e] of xs) { const c = e - m; if (Math.abs(c) < tol && (bx === null || Math.abs(c) < Math.abs(bx))) bx = c; }
      if (rowX) for (const [m, e] of ys) { const c = e - m; if (Math.abs(c) < tol && (by === null || Math.abs(c) < Math.abs(by))) by = c; }
    }
    if (bx === null && by === null) return false;
    const c = this.itemWorld(it, bx || 0, by || 0);
    it.x = c.x; it.y = c.y;
    return true;
  }

  dimGeom(dm) {
    const d = G.norm(G.sub(dm.b, dm.a)), n = G.perp(d);
    const off = dm.off || 0;
    return { a2: G.add(dm.a, G.mul(n, off)), b2: G.add(dm.b, G.mul(n, off)), d, n, L: G.dist(dm.a, dm.b) };
  }

  // ---------- eventi ----------
  _bind() {
    const cv = this.cv;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      if (e.ctrlKey || !e.shiftKey && Math.abs(e.deltaX) < 1 && e.deltaMode === 0 && Math.abs(e.deltaY) >= 50 || e.deltaMode !== 0) {
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      } else {
        this.view.ox -= e.deltaX; this.view.oy -= e.deltaY; this.redraw();
      }
    }, { passive: false });
    cv.addEventListener('pointerdown', e => this._down(e));
    cv.addEventListener('pointermove', e => this._move(e));
    cv.addEventListener('pointerup', e => this._up(e));
    cv.addEventListener('pointercancel', e => this._up(e, true));
    cv.addEventListener('pointerleave', () => { if (!this.pointers.size) { this.hover = null; this.redraw(); } });
    cv.addEventListener('dblclick', e => this._dbl(e));
    this.spaceDown = false;
    window.addEventListener('keydown', e => { if (e.code === 'Space' && !isTyping(e)) { this.spaceDown = true; } });
    window.addEventListener('keyup', e => { if (e.code === 'Space') this.spaceDown = false; });
  }
  _pt(e) { const r = this.cv.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }

  _down(e) {
    this.cv.setPointerCapture(e.pointerId);
    const { sx, sy } = this._pt(e);
    this.pointers.set(e.pointerId, { sx, sy });
    if (this.pointers.size === 2) {
      // due dita: si annulla l'operazione singola e si passa a sposta/zoom
      if (this.drag && this.drag.moved && this.drag.undo) this.drag.undo();
      this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.sx - b.sx, a.sy - b.sy), cx: (a.sx + b.sx) / 2, cy: (a.sy + b.sy) / 2 };
      return;
    }
    if (this.pointers.size > 2) return;
    const p = this.toPlan(sx, sy);
    const cc = this._compassCenter();
    if (this.northMode) { this._setNorth(sx, sy); this._endNorth(); return; }
    if (Math.hypot(sx - cc.x, sy - cc.y) < 36) { this.startNorth(); this.northMode.press = { sx, sy }; return; }
    if (e.button === 1 || e.button === 2 || this.spaceDown || this.tool === 'pan') {
      this.drag = { type: 'pan', sx, sy, ox: this.view.ox, oy: this.view.oy };
      this.cv.style.cursor = 'grabbing';
      return;
    }
    this.downAt = { sx, sy, t: performance.now(), touch: e.pointerType === 'touch' };
    const T = this.tool;
    if (T === 'select') return this._selectDown(p, sx, sy, e);
    if (T === 'wall') return this._wallDown(p, e);
    if (T === 'rect') { const s = this.snap(p); this.draft = { type: 'rect', a: s.p, b: s.p }; return; }
    if (T === 'opening') return this._openingDown(p);
    if (T === 'dim') return this._dimDown(p);
    if (T === 'place') return this._placeDown(p);
    if (T === 'photo') return this.app.photo.down(p, this);
  }

  _move(e) {
    const { sx, sy } = this._pt(e);
    if (this.northMode) { this.mouse = this.toPlan(sx, sy); this._setNorth(sx, sy); this.redraw(); return; }
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { sx, sy });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.sx - b.sx, a.sy - b.sy), cx = (a.sx + b.sx) / 2, cy = (a.sy + b.sy) / 2;
      this.view.ox += cx - this.pinch.cx; this.view.oy += cy - this.pinch.cy;
      this.zoomAt(cx, cy, d / this.pinch.d);
      this.pinch = { d, cx, cy };
      return;
    }
    const p = this.toPlan(sx, sy);
    this.mouse = p;
    const dr = this.drag;
    if (dr && dr.type === 'pan') { if (Math.hypot(sx - dr.sx, sy - dr.sy) > 4) dr.moved = true; this.view.ox = dr.ox + sx - dr.sx; this.view.oy = dr.oy + sy - dr.sy; this.redraw(); return; }
    if (dr) {
      if (!dr.moved && Math.hypot(sx - this.downAt.sx, sy - this.downAt.sy) < (this.downAt.touch ? 8 : 3)) return;
      dr.moved = true;
      this._dragMove(dr, p, e);
      this.redraw();
      return;
    }
    const T = this.tool;
    if (T === 'wall' || T === 'dim') {
      const from = this.draft ? (this.draft.from || this.draft.a) : null;
      this.hover = this.snap(p, { from, free: e.altKey });
      if (this.draft && this.draft.type === 'dim2') { const g = this.draft; const n = G.perp(G.norm(G.sub(g.b, g.a))); g.off = G.dot(G.sub(p, g.a), n); }
    } else if (T === 'rect') {
      if (this.draft && this.pointers.size) this.draft.b = this.snap(p, { from: this.draft.a }).p;
      else this.hover = this.snap(p);
    } else if (T === 'opening') {
      this.hover = this._openingAt(p);
    } else if (T === 'place') {
      this.hover = { p };
    } else if (T === 'photo') {
      this.app.photo.move(p, this, !!this.pointers.size);
    } else if (T === 'select') {
      const h = this.hit(p);
      this.hoverHit = h && h.type !== 'roomface' ? h : null;
      this.cv.style.cursor = !h ? 'default' : h.type === 'item-rot' ? 'alias' : h.type === 'item-size' ? 'nwse-resize' : h.type === 'item-side' ? 'ew-resize' : h.type === 'roomface' ? 'default' : 'move';
    }
    this.redraw();
  }

  _up(e, cancel) {
    if (this.northMode && this.northMode.press) {
      const { sx, sy } = this._pt(e);
      this.pointers.delete(e.pointerId);
      // trascinato l'ago: si fissa al rilascio; solo cliccato: si aspetta il clic sulla mappa
      if (Math.hypot(sx - this.northMode.press.sx, sy - this.northMode.press.sy) > 12) this._endNorth();
      else this.northMode.press = null;
      return;
    }
    const wasPinch = this.pinch;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (wasPinch) { if (!this.pointers.size) this.drag = null; return; }
    const dr = this.drag;
    this.drag = null;
    if (dr && dr.type === 'pan') { this.cv.style.cursor = this.tool === 'pan' ? 'grab' : this.tool === 'select' ? 'default' : 'crosshair'; if (!dr.moved && dr.click && !cancel) dr.click(); return; }
    if (cancel) { if (dr && dr.moved && dr.undo) dr.undo(); return; }
    const { sx, sy } = this._pt(e);
    const p = this.toPlan(sx, sy);
    if (dr) {
      if (dr.moved) { if (dr.end) dr.end(p); this.app.commit(dr.label || 'Sposta'); }
      else if (dr.click) dr.click(p);
      this.redraw();
      return;
    }
    if (this.tool === 'rect' && this.draft) {
      const { a, b } = this.draft;
      this.draft = null;
      if (Math.abs(a.x - b.x) > 20 && Math.abs(a.y - b.y) > 20) {
        const P = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
        for (let i = 0; i < 4; i++) G.addWall(this.doc, P[i], P[(i + 1) % 4]);
        this.app.commit('Stanza rettangolare');
      }
      this.redraw();
    }
    if (this.tool === 'photo') this.app.photo.up(p, this);
  }

  _dbl(e) {
    const { sx, sy } = this._pt(e);
    const p = this.toPlan(sx, sy);
    if (this.tool === 'wall') { this.finishWall(); return; }
    // doppio clic su una quota: si scrive la misura
    for (const b of this.labelBoxes) {
      if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) { this.app.editLength(b); return; }
    }
    const h = this.hit(p);
    if (h && h.type === 'wall' && !G.wallById(this.doc, h.id).virtual) this.app.editLength({ wall: h.id, kind: 'center' });
    if (h && (h.type === 'room' || h.type === 'roomface')) {
      if (h.type === 'roomface') this.app.selectRoomFace(h.face); else this.app.setSel({ type: 'room', id: h.id });
      setTimeout(() => { const i = document.getElementById('roomName'); if (i) { i.focus(); i.select(); } }, 30);
    }
  }

  // ---------- selezione e trascinamento ----------
  _selectDown(p, sx, sy, e) {
    const d = this.doc;
    const h = this.hit(p);
    if (!h) { this.app.setSel(null); this.drag = { type: 'pan', sx, sy, ox: this.view.ox, oy: this.view.oy }; return; }
    if (h.type === 'roomface') {
      // clic dentro una stanza: si seleziona (l'etichetta si crea al primo bisogno)
      this.drag = { type: 'pan', sx, sy, ox: this.view.ox, oy: this.view.oy, click: () => this.app.selectRoomFace(h.face) };
      return;
    }
    if (!h.type.startsWith('item-') && !h.type.startsWith('dim-')) this.app.setSel({ type: h.type, id: h.id });
    const snap = JSON.stringify(d);
    const undo = () => { const o = JSON.parse(snap); Object.assign(d, o); this.app.changed(); };
    if (h.type === 'node') {
      const n = G.nodeById(d, h.id);
      this.drag = { type: 'node', n, off: { x: n.x - p.x, y: n.y - p.y }, undo, label: 'Sposta angolo', end: () => this._mergeNode(n) };
    } else if (h.type === 'wall') {
      const w = G.wallById(d, h.id);
      const A = G.nodeById(d, w.a), B = G.nodeById(d, w.b);
      this.drag = { type: 'wall', w, A, B, A0: { ...A }, B0: { ...B }, p0: p, undo, label: 'Sposta parete', free: e.shiftKey };
    } else if (h.type === 'opening') {
      this.drag = { type: 'opening', o: d.openings.find(o => o.id === h.id), undo, label: 'Sposta apertura' };
    } else if (h.type === 'item') {
      const it = d.items.find(i => i.id === h.id);
      this.drag = { type: 'item', it, off: { x: it.x - p.x, y: it.y - p.y }, rot0: it.rot, undo, label: 'Sposta arredo', free: e.shiftKey };
    } else if (h.type === 'item-rot') {
      this.drag = { type: 'item-rot', it: d.items.find(i => i.id === h.id), undo, label: 'Ruota arredo' };
    } else if (h.type === 'item-size') {
      this.drag = { type: 'item-size', it: d.items.find(i => i.id === h.id), undo, label: 'Ridimensiona arredo' };
    } else if (h.type === 'item-side') {
      this.drag = { type: 'item-side', side: h.side, it: d.items.find(i => i.id === h.id), undo, label: 'Ridimensiona arredo' };
    } else if (h.type === 'room') {
      const r = d.rooms.find(x => x.id === h.id);
      this.drag = { type: 'room', r, off: { x: r.x - p.x, y: r.y - p.y }, undo, label: 'Sposta etichetta' };
    } else if (h.type === 'dim') {
      this.drag = { type: 'dim', dm: d.dims.find(x => x.id === h.id), undo, label: 'Sposta quota' };
    } else if (h.type === 'dim-a' || h.type === 'dim-b') {
      this.drag = { type: 'dim-end', dm: d.dims.find(x => x.id === h.id), end: null, which: h.type === 'dim-a' ? 'a' : 'b', undo, label: 'Modifica quota' };
    }
  }

  _dragMove(dr, p, e) {
    const d = this.doc;
    if (dr.type === 'node') {
      // si muove come il cursore (senza saltare sotto di lui) e senza la griglia assoluta: le pareti
      // ricalcate dalla foto non stanno sulla griglia e salterebbero appena toccate
      p = { x: p.x + dr.off.x, y: p.y + dr.off.y };
      const s = this.snap(p, { exclude: new Set([dr.n.id]), free: e.altKey, noGrid: true });
      // aggancio angolare rispetto agli altri estremi delle pareti collegate
      dr.n.x = s.p.x; dr.n.y = s.p.y;
      if (s.kind === 'free' || s.kind === 'photo') {
        for (const w of d.walls) {
          if (w.a !== dr.n.id && w.b !== dr.n.id) continue;
          const o = G.nodeById(d, w.a === dr.n.id ? w.b : w.a);
          const s2 = this.snap(p, { exclude: new Set([dr.n.id]), from: o, free: e.altKey, noGrid: true });
          if (s2.kind === 'angle' || s2.kind === 'align') { dr.n.x = s2.p.x; dr.n.y = s2.p.y; this.hover = s2; break; }
        }
      } else this.hover = s;
      this.app.changed(true);
    } else if (dr.type === 'wall') {
      let v = G.sub(p, dr.p0);
      if (!dr.free) { const n = G.perp(G.norm(G.sub(dr.B0, dr.A0))); v = G.mul(n, G.dot(v, n)); }
      const g = this.gridStep();
      if (g && !e.altKey) { const L = G.len(v); if (L > 0) v = G.mul(G.norm(v), Math.round(L / g) * g); }
      dr.A.x = dr.A0.x + v.x; dr.A.y = dr.A0.y + v.y; dr.B.x = dr.B0.x + v.x; dr.B.y = dr.B0.y + v.y;
      this.app.changed(true);
    } else if (dr.type === 'opening') {
      const at = this._openingAt(p, dr.o);
      if (at) { dr.o.wall = at.wall.id; dr.o.pos = at.pos; }
      this.app.changed(true);
    } else if (dr.type === 'item') {
      let q = { x: p.x + dr.off.x, y: p.y + dr.off.y };
      const g = d.settings.grid;
      if (g && !e.altKey) q = { x: Math.round(q.x / (g / 2)) * (g / 2), y: Math.round(q.y / (g / 2)) * (g / 2) };
      dr.it.x = q.x; dr.it.y = q.y;
      if (!dr.free && !e.altKey) {
        const s = this.snapItemToWall(dr.it, q);
        if (s) { dr.it.x = s.x; dr.it.y = s.y; dr.it.rot = s.rot; } else dr.it.rot = dr.rot0;
        this.snapItemToItems(dr.it);
      }
      this.app.changed(true);
    } else if (dr.type === 'item-rot') {
      let a = Math.atan2(p.y - dr.it.y, p.x - dr.it.x) * 180 / Math.PI + 90;
      if (!e.altKey) a = Math.round(a / 15) * 15;
      dr.it.rot = ((a % 360) + 360) % 360;
      this.app.changed(true);
    } else if (dr.type === 'item-size') {
      const l = this.itemLocal(dr.it, p);
      const g = e.altKey ? 1 : 5;
      // il lato opposto resta fermo
      const nw = Math.max(5, Math.round((l.x + dr.it.w / 2) / g) * g), nd = Math.max(5, Math.round((l.y + dr.it.d / 2) / g) * g);
      const c = this.itemWorld(dr.it, (nw - dr.it.w) / 2, (nd - dr.it.d) / 2);
      dr.it.x = c.x; dr.it.y = c.y; dr.it.w = nw; dr.it.d = nd;
      this.app.changed(true);
    } else if (dr.type === 'item-side') {
      // una sola misura; il lato opposto resta fermo
      const it = dr.it, l = this.itemLocal(it, p), g = e.altKey ? 1 : Math.max(1, this.gridStep() / 2 || 1);
      const o = this.px(14);
      let dx = 0, dy = 0, f = 1;
      if (dr.side === 'E' || dr.side === 'W') {
        const sg = dr.side === 'E' ? 1 : -1;
        const nw = Math.max(5, Math.round((sg * l.x - o + it.w / 2) / g) * g);
        dx = sg * (nw - it.w) / 2; f = nw / it.w; it.w = nw;
        if (it.lock) { it.d *= f; it.h *= f; }
      } else {
        const sg = dr.side === 'S' ? 1 : -1;
        const nd = Math.max(5, Math.round((sg * l.y - o + it.d / 2) / g) * g);
        dy = sg * (nd - it.d) / 2; f = nd / it.d; it.d = nd;
        if (it.lock) { it.w *= f; it.h *= f; }
      }
      const c = this.itemWorld(it, dx, dy);
      it.x = c.x; it.y = c.y;
      this.app.changed(true);
    } else if (dr.type === 'room') {
      dr.r.x = p.x + dr.off.x; dr.r.y = p.y + dr.off.y;
      this.app.changed(true);
    } else if (dr.type === 'dim') {
      const g = this.dimGeom(dr.dm);
      dr.dm.off = G.dot(G.sub(p, dr.dm.a), g.n);
      this.app.changed(true);
    } else if (dr.type === 'dim-end') {
      const s = this.snap(p, { from: dr.which === 'a' ? dr.dm.b : dr.dm.a });
      dr.dm[dr.which] = s.p;
      this.hover = s;
      this.app.changed(true);
    }
  }

  /** Nodo lasciato sopra un altro nodo o su una parete: si uniscono. */
  _mergeNode(n) {
    const d = this.doc;
    const other = d.nodes.find(m => m !== n && G.dist(m, n) < 1);
    if (other) {
      for (const w of d.walls) { if (w.a === n.id) w.a = other.id; if (w.b === n.id) w.b = other.id; }
      d.walls = d.walls.filter(w => w.a !== w.b);
      // pareti doppie
      const seen = new Set();
      d.walls = d.walls.filter(w => { const k = [w.a, w.b].sort().join(); if (seen.has(k)) return false; seen.add(k); return true; });
      d.nodes = d.nodes.filter(m => m !== n);
    } else {
      for (const w of d.walls.slice()) {
        if (w.a === n.id || w.b === n.id) continue;
        const pr = G.projSeg(n, G.nodeById(d, w.a), G.nodeById(d, w.b));
        if (pr.d < 1 && pr.t > 0 && pr.t < 1) {
          const m = G.splitWall(d, w, n);
          for (const w2 of d.walls) { if (w2.a === n.id) w2.a = m.id; if (w2.b === n.id) w2.b = m.id; }
          d.nodes = d.nodes.filter(x => x !== n);
          break;
        }
      }
    }
    G.cleanup(d);
  }

  // ---------- pareti ----------
  _wallDown(p, e) {
    const s = this.snap(p, { from: this.draft && this.draft.from, free: e.altKey });
    if (!this.draft) { this.draft = { type: 'wall', from: s.p, start: s.p, thick: s.thick }; return; }
    this.addWallTo(s.p, s.thick);
  }
  addWallTo(q, thick) {
    const dr = this.draft;
    if (!dr || G.dist(dr.from, q) < 1) return;
    const t = this.toolOpt.thickness || this.doc.settings.wallThickness;
    const useThick = this.toolOpt.photoThick && thick ? thick : (dr.thick && this.toolOpt.photoThick ? dr.thick : t);
    G.addWall(this.doc, dr.from, q, this.toolOpt.virtual ? { thickness: 2, virtual: true } : { thickness: Math.round(useThick) });
    this.app.commit('Parete');
    const closed = G.dist(q, dr.start) < 0.5;
    dr.lastDir = G.norm(G.sub(q, dr.from));
    dr.from = q; dr.thick = thick; this.typed = ''; this.app.onTyped && this.app.onTyped('');
    if (closed) this.finishWall();
  }
  finishWall() { this.draft = null; this.typed = ''; this.app.onTyped && this.app.onTyped(''); this.redraw(); }
  /** Lunghezza scritta (tastiera o pannello) mentre si disegna: parete in quella direzione. */
  applyTypedLength(L, forced) {
    const dr = this.draft;
    if (!dr || !(L > 0)) return false;
    let dir = forced;
    const h = this.hover && this.hover.p;
    if (!dir) dir = h && G.dist(h, dr.from) > 0.5 ? G.norm(G.sub(h, dr.from)) : (dr.lastDir || { x: 1, y: 0 });
    this.addWallTo(G.add(dr.from, G.mul(dir, L)));
    return true;
  }
  /** Tasti mentre si disegna: numeri per la lunghezza, Invio, Esc, Backspace. Restituisce true se gestito. */
  key(e) {
    if (this.tool === 'wall' && this.draft) {
      if (/^[0-9.,]$/.test(e.key)) { this.typed += e.key; this.app.onTyped && this.app.onTyped(this.typed); this.redraw(); return true; }
      if (e.key === 'Backspace' && this.typed) { this.typed = this.typed.slice(0, -1); this.app.onTyped && this.app.onTyped(this.typed); this.redraw(); return true; }
      if (e.key === 'Enter') { if (this.typed) this.applyTypedLength(parseFloat(this.typed.replace(',', '.'))); else this.finishWall(); return true; }
      if (e.key === 'Escape') { this.finishWall(); return true; }
    }
    if (e.key === 'Escape' && this.northMode) { this.cancelNorth(); return true; }
    if (e.key === 'Escape' && (this.draft || this.tool !== 'select')) { this.draft = null; this.app.toolDone(); return true; }
    return false;
  }

  // ---------- aperture ----------
  _openingAt(p, existing) {
    const d = this.doc, corners = this.corners || G.wallCorners(d);
    let best = null;
    for (const w of d.walls) {
      if (w.virtual) continue;
      const c = corners.get(w.id);
      const l = G.toLocal(c, p);
      const L = G.dist(c.A, c.B);
      if (l.s < 0 || l.s > L) continue;
      const dd = Math.abs(l.o) - w.thickness / 2;
      if (dd < this.px(24) && (!best || dd < best.dd)) best = { w, c, l, L, dd };
    }
    if (!best) return null;
    const type = existing ? existing.type : this.toolOpt.type || 'door';
    const width = existing ? existing.width : (OPENING_TYPES[type] || OPENING_TYPES.door).width;
    const margin = 0;
    let pos = Math.max(width / 2 + margin, Math.min(best.L - width / 2 - margin, best.l.s));
    const g = this.doc.settings.grid ? 5 : 0;
    if (g) pos = Math.round(pos / g) * g;
    if (best.L < width) pos = best.L / 2;
    return { wall: best.w, pos, side: best.l.o >= 0 ? 'L' : 'R', c: best.c, width, type };
  }
  _openingDown(p) {
    const at = this._openingAt(p);
    if (!at) return;
    const def = OPENING_TYPES[at.type] || OPENING_TYPES.door;
    const o = { id: G.newId('o'), wall: at.wall.id, pos: at.pos, type: at.type, width: def.width, height: Math.min(def.height, this.doc.settings.wallHeight - def.sill - 5), sill: def.sill, hinge: 'a', swing: at.side, open: 90 };
    this.doc.openings.push(o);
    this.app.commit(def.name);
    this.app.setSel({ type: 'opening', id: o.id });
  }

  // ---------- quote libere ----------
  _dimDown(p) {
    const dr = this.draft;
    if (!dr) { const s = this.snap(p, { noGrid: false }); this.draft = { type: 'dim1', a: s.p }; return; }
    if (dr.type === 'dim1') { const s = this.snap(p, { from: dr.a }); if (G.dist(s.p, dr.a) < 1) return; this.draft = { type: 'dim2', a: dr.a, b: s.p, off: 0 }; return; }
    if (dr.type === 'dim2') {
      this.doc.dims.push({ id: G.newId('d'), a: dr.a, b: dr.b, off: dr.off });
      this.draft = null;
      this.app.commit('Quota');
    }
  }

  // ---------- inserimento arredi ----------
  _placeDown(p) {
    const it = this.app.placeItemAt(p);
    if (!it) return;
    const s = this.snapItemToWall(it, p);
    if (s) Object.assign(it, s);
    this.app.commit('Aggiungi ' + (CATALOG[it.kind] ? CATALOG[it.kind].name.toLowerCase() : 'arredo'));
    this.app.setSel({ type: 'item', id: it.id });
    this.app.toolDone();
  }

  // ---------- disegno ----------
  draw() {
    const ctx = this.ctx, dpr = this.dpr || 1, d = this.doc;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, this.W, this.H);
    this.labelBoxes = [];
    this.corners = G.wallCorners(d);
    this.rooms = G.matchRooms(d, G.findRooms(d, this.corners));
    this._grid();
    const V = this.view;
    ctx.setTransform(dpr * V.s, 0, 0, dpr * V.s, dpr * V.ox, dpr * V.oy);
    if (this.app.photo) this.app.photo.drawImage(ctx, this);
    const lw = this.px(1);
    const sel = this.app.sel;
    // stanze
    for (const r of this.rooms) {
      ctx.beginPath(); r.inner.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
      const key = r.label && r.label.floor || 'parquet';
      const selected = sel && sel.type === 'room' && r.label && sel.id === r.label.id;
      ctx.fillStyle = selected ? '#dce9fd' : (FLOOR_TINT[key] || floorTint(key) || '#fff');
      ctx.globalAlpha = this.app.photo && this.app.photo.visible() ? 0.55 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // mobili sotto le pareti (le pareti coprono le sovrapposizioni)
    for (const it of d.items) this._drawItem(it, sel && sel.type === 'item' && sel.id === it.id);
    // pareti
    for (const w of d.walls) {
      const c = this.corners.get(w.id);
      if (w.virtual) {
        ctx.strokeStyle = sel && sel.type === 'wall' && sel.id === w.id ? COL.wallSel : '#8a929c';
        ctx.lineWidth = this.px(2); ctx.setLineDash([this.px(7), this.px(5)]);
        ctx.beginPath(); ctx.moveTo(c.A.x, c.A.y); ctx.lineTo(c.B.x, c.B.y); ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      const poly = G.wallPolygon(c);
      ctx.beginPath(); poly.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
      ctx.fillStyle = sel && sel.type === 'wall' && sel.id === w.id ? COL.wallSel : (w.height && w.height < d.settings.wallHeight ? '#7c838d' : COL.wall);
      ctx.globalAlpha = this.app.photo && this.app.photo.visible() ? 0.85 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // aperture
    for (const o of d.openings) this._drawOpening(o, sel && sel.type === 'opening' && sel.id === o.id);
    // quote automatiche
    if (d.settings.showDims) this._autoDims();
    // quote libere
    for (const dm of d.dims) this._drawDim(dm, sel && sel.type === 'dim' && sel.id === dm.id);
    // nomi e superfici delle stanze
    for (const r of this.rooms) this._roomLabel(r);
    // con «Seleziona»: angoli sempre visibili (punti da trascinare) ed evidenza di cosa c'e' sotto il cursore
    if (this.tool === 'select') {
      const hh = !this.drag ? this.hoverHit : null;
      if (hh && hh.type === 'wall') {
        const c = this.corners.get(hh.id);
        if (c) { const poly = G.wallPolygon(c); ctx.beginPath(); poly.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.closePath(); ctx.strokeStyle = COL.sel; ctx.lineWidth = lw * 2.5; ctx.stroke(); }
      }
      for (const n of d.nodes) {
        const hot = hh && hh.type === 'node' && hh.id === n.id;
        ctx.beginPath(); ctx.arc(n.x, n.y, this.px(hot ? 7 : 3.5), 0, 7);
        ctx.fillStyle = hot ? COL.sel : 'rgba(255,255,255,0.9)'; ctx.fill();
        ctx.lineWidth = lw * 1.5; ctx.strokeStyle = COL.node; ctx.stroke();
      }
      if (hh && (hh.type === 'item' || hh.type === 'opening')) this.cv.title = hh.type === 'item' ? 'Arredo' : 'Porta o finestra';
    }
    // nodi della parete selezionata
    if (sel && (sel.type === 'wall' || sel.type === 'node')) {
      const ids = sel.type === 'node' ? [sel.id] : (() => { const w = G.wallById(d, sel.id); return w ? [w.a, w.b] : []; })();
      for (const id of ids) { const n = G.nodeById(d, id); if (n) { ctx.beginPath(); ctx.arc(n.x, n.y, this.px(5), 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = lw * 2; ctx.strokeStyle = COL.node; ctx.stroke(); } }
    }
    this._drawDraft();
    if (this.app.photo) this.app.photo.drawOverlay(ctx, this);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._scaleBar();
    this._compass();
  }
  _compassCenter() { return { x: this.W - 46, y: 46 }; }
  /** Scelta del nord: l'ago segue il puntatore, un clic lo fissa. Esc annulla. */
  _endNorth() { this.northMode = null; this.app.commit('Nord'); this.app.northDone && this.app.northDone(); this.redraw(); }
  startNorth() { this.northMode = { old: this.doc.settings.north || 0 }; this.app.northStart && this.app.northStart(); this.redraw(); }
  cancelNorth() { if (!this.northMode) return; this.doc.settings.north = this.northMode.old; this.northMode = null; this.app.northDone && this.app.northDone(); this.redraw(); }
  _setNorth(sx, sy) {
    const c = this._compassCenter();
    if (Math.hypot(sx - c.x, sy - c.y) < 4) return;
    let a = Math.atan2(sx - c.x, -(sy - c.y)) * 180 / Math.PI;
    a = Math.round((a + 360) % 360);
    this.doc.settings.north = a;
  }
  _compass() {
    const ctx = this.ctx, a = (this.doc.settings.north || 0) * Math.PI / 180, { x: cx, y: cy } = this._compassCenter();
    const active = !!this.northMode;
    if (active && this.mouse) {
      // linea verso il puntatore
      const m = this.toScreen(this.mouse);
      ctx.save(); ctx.strokeStyle = '#c92a2a'; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(m.x, m.y); ctx.stroke(); ctx.restore();
    }
    const R = 34; // raggio della rosa
    ctx.save(); ctx.translate(cx, cy);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fillStyle = active ? '#fff1f1' : 'rgba(255,255,255,0.92)'; ctx.fill();
    ctx.strokeStyle = active ? '#c92a2a' : '#c9c5bc'; ctx.lineWidth = active ? 2 : 1; ctx.stroke();
    // tacche ogni 45° e lettere dei punti cardinali (sempre dritte)
    const P = [['N', 0, '#c92a2a'], ['E', 90, '#2a2e35'], ['S', 180, '#2a2e35'], ['O', 270, '#2a2e35']];
    ctx.strokeStyle = '#b8b3a9'; ctx.lineWidth = 1;
    for (let k = 0; k < 8; k++) { const t = a + k * Math.PI / 4, r1 = k % 2 ? R - 5 : R - 8; ctx.beginPath(); ctx.moveTo(Math.sin(t) * r1, -Math.cos(t) * r1); ctx.lineTo(Math.sin(t) * (R - 2), -Math.cos(t) * (R - 2)); ctx.stroke(); }
    ctx.font = '700 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [l, d0, col] of P) { const t = a + d0 * Math.PI / 180; ctx.fillStyle = col; ctx.fillText(l, Math.sin(t) * (R - 15), -Math.cos(t) * (R - 15)); }
    // ago: rosso verso nord, grigio verso sud
    ctx.rotate(a);
    const n = R - 24;
    ctx.beginPath(); ctx.moveTo(0, -n); ctx.lineTo(4.5, 0); ctx.lineTo(-4.5, 0); ctx.closePath(); ctx.fillStyle = '#c92a2a'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, n); ctx.lineTo(4.5, 0); ctx.lineTo(-4.5, 0); ctx.closePath(); ctx.fillStyle = '#9aa0a8'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.restore();
  }

  _grid() {
    const ctx = this.ctx, V = this.view;
    const step = [10, 50, 100, 500, 1000].find(g => g * V.s >= 14) || 1000;
    const major = step * (step === 50 ? 2 : step >= 100 ? 5 : 10);
    const p0 = this.toPlan(0, 0), p1 = this.toPlan(this.W, this.H);
    ctx.lineWidth = 1;
    for (const [g, col] of [[step, COL.grid], [major, COL.grid2]]) {
      ctx.strokeStyle = col; ctx.beginPath();
      for (let x = Math.floor(p0.x / g) * g; x <= p1.x; x += g) { const sx = Math.round(x * V.s + V.ox) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, this.H); }
      for (let y = Math.floor(p0.y / g) * g; y <= p1.y; y += g) { const sy = Math.round(y * V.s + V.oy) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(this.W, sy); }
      ctx.stroke();
    }
  }
  _scaleBar() {
    const ctx = this.ctx;
    const L = [10, 20, 50, 100, 200, 500, 1000, 2000].find(v => v * this.view.s >= 70) || 2000;
    const w = L * this.view.s, x = 16, y = this.H - 18;
    ctx.strokeStyle = COL.text; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y - 5); ctx.stroke();
    ctx.fillStyle = COL.text; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(L >= 100 ? (L / 100) + ' m' : L + ' cm', x + w + 6, y + 1);
  }

  _text(x, y, str, opts = {}) {
    // testo a dimensione fissa sullo schermo, con eventuale rotazione lungo una direzione
    const ctx = this.ctx, s = this.toScreen({ x, y }), dpr = this.dpr || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(s.x, s.y);
    let a = opts.angle || 0;
    if (a > Math.PI / 2 + 0.01) a -= Math.PI; if (a < -Math.PI / 2 + 0.01) a += Math.PI;
    ctx.rotate(a);
    ctx.font = (opts.bold ? '600 ' : '') + (opts.size || 11) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const m = ctx.measureText(str), w = m.width + 6, h = (opts.size || 11) + 4;
    if (opts.bg) { ctx.fillStyle = opts.bg; ctx.fillRect(-w / 2, -h / 2, w, h); }
    ctx.fillStyle = opts.color || COL.text;
    ctx.fillText(str, 0, 0.5);
    ctx.restore();
    // riquadro cliccabile (approssimato sull'asse)
    const r = Math.max(w, h) / 2;
    return { x0: s.x - r, x1: s.x + r, y0: s.y - h / 2 - (Math.abs(Math.sin(a)) * w / 2), y1: s.y + h / 2 + (Math.abs(Math.sin(a)) * w / 2) };
  }

  _roomLabel(r) {
    const d = this.doc;
    const at = r.label ? { x: r.label.x, y: r.label.y } : G.interiorPoint(r.inner);
    const name = r.label && r.label.name;
    if (name) this._text(at.x, at.y - this.px(8), name, { bold: true, size: 12 });
    if (d.settings.showAreas) this._text(at.x, at.y + (name ? this.px(7) : 0), fmtM2(r.area), { size: 11, color: '#6a717b' });
  }

  _autoDims() {
    const d = this.doc, ctx = this.ctx;
    const roomSide = new Set();
    for (const r of this.rooms) for (const e of r.edges) roomSide.add(e.wall + e.side);
    for (const w of d.walls) {
      if (w.virtual) continue;
      const c = this.corners.get(w.id);
      for (const side of ['L', 'R']) {
        const p = side === 'L' ? c.aL : c.aR, q = side === 'L' ? c.bL : c.bR;
        const sp = G.toLocal(c, p).s, sq = G.toLocal(c, q).s;
        const L = Math.abs(sq - sp);
        if (L * this.view.s < 34) continue;
        const sgn = side === 'L' ? 1 : -1;
        const ang = Math.atan2(c.d.y, c.d.x);
        if (roomSide.has(w.id + side)) {
          // lato interno: solo il numero, appena dentro la stanza
          const m = G.toWorld(c, (sp + sq) / 2, sgn * (c.h + this.px(9)));
          const box = this._text(m.x, m.y, fmtCm(L), { angle: ang, size: 10, color: COL.dim });
          this.labelBoxes.push({ ...box, wall: w.id, side, kind: 'inner', L });
        } else {
          // lato esterno: linea di quota con trattini
          const off = sgn * (c.h + this.px(22));
          const a = G.toWorld(c, sp, off), b = G.toWorld(c, sq, off);
          ctx.strokeStyle = COL.dimExt; ctx.lineWidth = this.px(0.8);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          const tk = this.px(4);
          for (const e of [a, b]) { ctx.moveTo(e.x - (c.d.x + c.n.x) * tk, e.y - (c.d.y + c.n.y) * tk); ctx.lineTo(e.x + (c.d.x + c.n.x) * tk, e.y + (c.d.y + c.n.y) * tk); }
          const e1 = G.toWorld(c, sp, sgn * (c.h + this.px(4))), e2 = G.toWorld(c, sq, sgn * (c.h + this.px(4)));
          ctx.moveTo(e1.x, e1.y); ctx.lineTo(G.toWorld(c, sp, off + sgn * this.px(4)).x, G.toWorld(c, sp, off + sgn * this.px(4)).y);
          ctx.moveTo(e2.x, e2.y); ctx.lineTo(G.toWorld(c, sq, off + sgn * this.px(4)).x, G.toWorld(c, sq, off + sgn * this.px(4)).y);
          ctx.stroke();
          const m = G.toWorld(c, (sp + sq) / 2, off);
          const box = this._text(m.x, m.y, fmtCm(L), { angle: ang, size: 11, bg: COL.bg, color: COL.dimExt });
          this.labelBoxes.push({ ...box, wall: w.id, side, kind: 'outer', L });
        }
      }
    }
  }

  _drawDim(dm, selected) {
    const ctx = this.ctx, g = this.dimGeom(dm);
    ctx.strokeStyle = selected ? COL.sel : '#b4442c'; ctx.lineWidth = this.px(selected ? 1.6 : 1);
    ctx.beginPath();
    ctx.moveTo(dm.a.x, dm.a.y); ctx.lineTo(g.a2.x + g.n.x * this.px(4) * Math.sign(dm.off || 1), g.a2.y + g.n.y * this.px(4) * Math.sign(dm.off || 1));
    ctx.moveTo(dm.b.x, dm.b.y); ctx.lineTo(g.b2.x + g.n.x * this.px(4) * Math.sign(dm.off || 1), g.b2.y + g.n.y * this.px(4) * Math.sign(dm.off || 1));
    ctx.moveTo(g.a2.x, g.a2.y); ctx.lineTo(g.b2.x, g.b2.y);
    const tk = this.px(5);
    for (const e of [g.a2, g.b2]) { ctx.moveTo(e.x - (g.d.x + g.n.x) * tk, e.y - (g.d.y + g.n.y) * tk); ctx.lineTo(e.x + (g.d.x + g.n.x) * tk, e.y + (g.d.y + g.n.y) * tk); }
    ctx.stroke();
    const m = G.mul(G.add(g.a2, g.b2), 0.5);
    const box = this._text(m.x, m.y, fmtCm(g.L), { angle: Math.atan2(g.d.y, g.d.x), size: 11, bg: COL.bg, color: '#b4442c' });
    this.labelBoxes.push({ ...box, dim: dm.id, kind: 'dim', L: g.L });
    if (selected) for (const e of [g.a2, g.b2]) { ctx.beginPath(); ctx.arc(e.x, e.y, this.px(5), 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); }
  }

  _drawItem(it, selected) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate(it.rot * Math.PI / 180);
    ctx.lineWidth = this.px(selected ? 1.8 : 1);
    ctx.strokeStyle = selected ? COL.sel : COL.item;
    ctx.fillStyle = '#fff';
    ctx.lineJoin = 'round';
    const c = CATALOG[it.kind] || CATALOG.scatola;
    try { c.draw(ctx, it, this.view.s); } catch (e) { ctx.strokeRect(-it.w / 2, -it.d / 2, it.w, it.d); }
    ctx.restore();
    if (selected) {
      const h = this.itemHandles(it);
      const top = this.itemWorld(it, 0, -it.d / 2);
      ctx.strokeStyle = COL.sel; ctx.lineWidth = this.px(1);
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(h.rot.x, h.rot.y); ctx.stroke();
      for (const [p, shape] of [[h.rot, 'c'], [h.size, 's']]) {
        ctx.beginPath();
        if (shape === 'c') ctx.arc(p.x, p.y, this.px(7), 0, 7); else ctx.rect(p.x - this.px(6), p.y - this.px(6), this.px(12), this.px(12));
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = this.px(2); ctx.stroke();
      }
      // freccette doppie sui lati
      const a = it.rot * Math.PI / 180;
      for (const [k, ang] of [['E', 0], ['W', 0], ['S', Math.PI / 2], ['N', Math.PI / 2]]) {
        const q = h[k];
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(a + ang);
        const L = this.px(9), W = this.px(4.5);
        ctx.beginPath(); ctx.arc(0, 0, this.px(11), 0, 7); ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-L, 0); ctx.lineTo(-L + W, -W); ctx.lineTo(-L + W, W); ctx.closePath();
        ctx.moveTo(L, 0); ctx.lineTo(L - W, -W); ctx.lineTo(L - W, W); ctx.closePath();
        ctx.fillStyle = COL.sel; ctx.fill();
        ctx.fillRect(-L + W, -this.px(1), 2 * (L - W), this.px(2));
        ctx.restore();
      }
      // misure mentre si ridimensiona
      if (this.drag && (this.drag.type === 'item-side' || this.drag.type === 'item-size')) {
        const m = this.itemWorld(it, 0, 0);
        this._text(m.x, m.y, `${fmtCm(it.w)} × ${fmtCm(it.d)}`, { bg: '#fff', color: COL.sel, size: 12, bold: true });
      }
    }
  }

  _drawOpening(o, selected) {
    const d = this.doc, ctx = this.ctx;
    const w = G.wallById(d, o.wall); if (!w) return;
    const c = this.corners.get(w.id);
    const t = w.thickness, h = t / 2;
    const s0 = o.pos - o.width / 2, s1 = o.pos + o.width / 2;
    const W = (s, off) => G.toWorld(c, s, off);
    const poly = pts => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); };
    // vano nel muro
    poly([W(s0, h + 0.3), W(s1, h + 0.3), W(s1, -h - 0.3), W(s0, -h - 0.3)]);
    ctx.fillStyle = selected ? '#dce9fd' : COL.open; ctx.fill();
    ctx.strokeStyle = selected ? COL.sel : COL.wall; ctx.lineWidth = this.px(selected ? 1.6 : 1);
    ctx.beginPath();
    for (const s of [s0, s1]) { const a = W(s, h), b = W(s, -h); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.stroke();
    const sw = o.swing === 'R' ? -1 : 1;
    if (o.type === 'window' || o.type === 'french') {
      ctx.beginPath();
      for (const off of [h * 0.35, -h * 0.35]) { const a = W(s0, off), b = W(s1, off); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      ctx.stroke();
      if (o.type === 'french') {
        const panes = o.width > 90 ? 2 : 1;
        const lw = o.width / panes;
        ctx.setLineDash([this.px(4), this.px(3)]);
        for (let i = 0; i < panes; i++) {
          const hingeS = i === 0 ? s0 : s1, dir = i === 0 ? 1 : -1;
          const hp = W(hingeS, sw * h);
          const tip = W(hingeS, sw * (h + lw));
          ctx.beginPath(); ctx.moveTo(hp.x, hp.y); ctx.lineTo(tip.x, tip.y);
          const a0 = Math.atan2(tip.y - hp.y, tip.x - hp.x), end = W(hingeS + dir * lw, sw * h), a1 = Math.atan2(end.y - hp.y, end.x - hp.x);
          ctx.arc(hp.x, hp.y, lw, a0, a1, crossSign(c, sw, dir));
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    } else if (o.type === 'door' || o.type === 'door2') {
      const leaves = o.type === 'door2' ? [[s0, 1, o.width / 2], [s1, -1, o.width / 2]] : [[o.hinge === 'b' ? s1 : s0, o.hinge === 'b' ? -1 : 1, o.width]];
      for (const [hs, dir, lw] of leaves) {
        const hp = W(hs, sw * h);
        const tip = W(hs, sw * (h + lw));
        ctx.lineWidth = this.px(selected ? 2 : 1.5);
        ctx.beginPath(); ctx.moveTo(hp.x, hp.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
        ctx.lineWidth = this.px(0.8);
        const end = W(hs + dir * lw, sw * h);
        const a0 = Math.atan2(tip.y - hp.y, tip.x - hp.x), a1 = Math.atan2(end.y - hp.y, end.x - hp.x);
        ctx.beginPath(); ctx.arc(hp.x, hp.y, lw, a0, a1, crossSign(c, sw, dir)); ctx.stroke();
      }
    } else if (o.type === 'slide' || o.type === 'pocket') {
      const dir = o.hinge === 'b' ? 1 : -1; // verso cui scorre l'anta
      const sh = o.width * (o.slide ?? (o.type === 'pocket' ? 0.85 : 0.6)) * dir;
      if (o.type === 'pocket') {
        // cassonetto nel muro (tratteggiato) e anta dentro
        const c0 = dir < 0 ? s0 - o.width : s1, c1 = dir < 0 ? s0 : s1 + o.width;
        ctx.setLineDash([this.px(4), this.px(3)]); ctx.lineWidth = this.px(0.8);
        ctx.beginPath(); for (const off of [h * 0.45, -h * 0.45]) { const a = W(c0, off), b = W(c1, off); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); } ctx.stroke();
        ctx.setLineDash([]);
        const a = W(s0 + sh, 0), b = W(s1 + sh, 0);
        ctx.strokeStyle = selected ? COL.sel : '#e8590c'; ctx.lineWidth = this.px(2.5);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      } else {
        const off = sw * (h + this.px(3));
        const a = W(s0 + sh, off), b = W(s1 + sh, off);
        ctx.lineWidth = this.px(2.5);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.lineWidth = this.px(1);
    } else if (o.type === 'opening') {
      ctx.setLineDash([this.px(3), this.px(3)]);
      ctx.beginPath(); const a = W(s0, 0), b = W(s1, 0); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    // larghezza dell'apertura quando e' selezionata
    if (selected) {
      const m = W(o.pos, 0);
      this._text(m.x, m.y, fmtCm(o.width), { angle: Math.atan2(c.d.y, c.d.x), size: 10, bg: '#dce9fd', color: COL.sel });
    }
  }

  _drawDraft() {
    const ctx = this.ctx, dr = this.draft, hv = this.hover;
    const lw = this.px(1);
    if (hv && hv.guides) {
      ctx.strokeStyle = COL.guide; ctx.lineWidth = lw; ctx.setLineDash([this.px(4), this.px(4)]);
      for (const g of hv.guides) { if (g.kind === 'align') { ctx.beginPath(); ctx.moveTo(g.a.x, g.a.y); ctx.lineTo(g.b.x, g.b.y); ctx.stroke(); } }
      ctx.setLineDash([]);
    }
    if (this.tool === 'wall') {
      if (dr && hv) {
        const t = this.toolOpt.virtual ? 2 : this.toolOpt.photoThick && hv.thick ? hv.thick : (this.toolOpt.thickness || this.doc.settings.wallThickness);
        const a = dr.from, b = hv.p;
        const v = G.sub(b, a), L = G.len(v);
        if (L > 0.5) {
          const n = G.perp(G.norm(v));
          ctx.beginPath();
          const P = [G.add(a, G.mul(n, t / 2)), G.add(b, G.mul(n, t / 2)), G.add(b, G.mul(n, -t / 2)), G.add(a, G.mul(n, -t / 2))];
          P.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
          ctx.fillStyle = 'rgba(47,123,246,0.35)'; ctx.fill();
          ctx.strokeStyle = COL.sel; ctx.lineWidth = lw; ctx.stroke();
          const m = G.add(G.mul(G.add(a, b), 0.5), G.mul(n, -(t / 2 + this.px(14))));
          const ang = Math.atan2(v.y, v.x);
          let deg = Math.round(-ang * 180 / Math.PI); if (deg < 0) deg += 360;
          this._text(m.x, m.y, (this.typed ? this.typed + '▌' : fmtCm(L) + ' cm') + '  ' + deg + '°', { angle: ang, size: 12, bg: this.typed ? '#fff3bf' : '#fff', color: COL.sel, bold: !!this.typed });
        }
      }
      if (hv) this._snapMark(hv);
    } else if (this.tool === 'rect') {
      if (dr) {
        const { a, b } = dr;
        ctx.fillStyle = 'rgba(47,123,246,0.12)'; ctx.strokeStyle = COL.sel; ctx.lineWidth = this.px(2);
        ctx.beginPath(); ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.fill(); ctx.stroke();
        this._text((a.x + b.x) / 2, Math.min(a.y, b.y) - this.px(14), fmtCm(Math.abs(b.x - a.x)), { bg: '#fff', color: COL.sel, size: 12 });
        this._text(Math.max(a.x, b.x) + this.px(24), (a.y + b.y) / 2, fmtCm(Math.abs(b.y - a.y)), { bg: '#fff', color: COL.sel, size: 12 });
      } else if (hv) this._snapMark(hv);
    } else if (this.tool === 'opening' && hv) {
      const c = hv.c, t = hv.wall.thickness;
      const s0 = hv.pos - hv.width / 2, s1 = hv.pos + hv.width / 2;
      const P = [G.toWorld(c, s0, t / 2 + 2), G.toWorld(c, s1, t / 2 + 2), G.toWorld(c, s1, -t / 2 - 2), G.toWorld(c, s0, -t / 2 - 2)];
      ctx.beginPath(); P.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
      ctx.fillStyle = 'rgba(47,123,246,0.4)'; ctx.fill();
      const sw = hv.side === 'L' ? 1 : -1;
      const a = G.toWorld(c, hv.pos, sw * (t / 2 + 8)), b = G.toWorld(c, hv.pos, sw * (t / 2 + 30));
      ctx.strokeStyle = COL.sel; ctx.lineWidth = this.px(2); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (this.tool === 'dim') {
      if (dr && dr.type === 'dim1' && hv) { ctx.strokeStyle = '#b4442c'; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(dr.a.x, dr.a.y); ctx.lineTo(hv.p.x, hv.p.y); ctx.stroke(); this._text((dr.a.x + hv.p.x) / 2, (dr.a.y + hv.p.y) / 2, fmtCm(G.dist(dr.a, hv.p)), { bg: '#fff', color: '#b4442c' }); }
      if (dr && dr.type === 'dim2') this._drawDim(dr, true);
      if (hv) this._snapMark(hv);
    } else if (this.tool === 'place' && hv) {
      const it = this.app.previewItem && this.app.previewItem(hv.p);
      if (it) {
        const s = this.snapItemToWall(it, hv.p);
        if (s) Object.assign(it, s);
        ctx.globalAlpha = 0.7; this._drawItem(it, true); ctx.globalAlpha = 1;
      }
    }
  }
  _snapMark(hv) {
    const ctx = this.ctx, p = hv.p, r = this.px(6);
    ctx.strokeStyle = COL.snap; ctx.lineWidth = this.px(1.5);
    ctx.beginPath();
    if (hv.kind === 'node') ctx.rect(p.x - r, p.y - r, 2 * r, 2 * r);
    else if (hv.kind === 'wall') { ctx.moveTo(p.x - r, p.y - r); ctx.lineTo(p.x + r, p.y + r); ctx.moveTo(p.x + r, p.y - r); ctx.lineTo(p.x - r, p.y + r); }
    else if (hv.kind === 'photo') { ctx.arc(p.x, p.y, r, 0, 7); ctx.moveTo(p.x - r * 1.6, p.y); ctx.lineTo(p.x + r * 1.6, p.y); ctx.moveTo(p.x, p.y - r * 1.6); ctx.lineTo(p.x, p.y + r * 1.6); }
    else { ctx.moveTo(p.x - r, p.y); ctx.lineTo(p.x + r, p.y); ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x, p.y + r); }
    ctx.stroke();
  }
}

// verso dell'arco della porta (true = antiorario sul canvas)
function crossSign(c, sw, dir) {
  // l'anta parte perpendicolare al muro (verso sw*n) e si chiude verso dir*d
  const z = (sw * c.n.x) * (dir * c.d.y) - (sw * c.n.y) * (dir * c.d.x);
  return z < 0;
}
function isTyping(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
export { isTyping };
