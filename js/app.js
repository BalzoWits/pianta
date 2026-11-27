// Pianta: collega editor 2D, vista 3D, render, pannelli, progetti e salvataggio.
import * as G from './geom.js?v=mwz0jl1g';
import { Plan2D, OPENING_TYPES, fmtCm, fmtM2, isTyping } from './plan2d.js?v=mwz0jl1g';
import { View3D } from './view3d.js?v=mwz0jl1g';
import { buildHouse } from './house3d.js?v=mwz0jl1g';
import { CATALOG, CATEGORIES, newItem, isLamp } from './furniture.js?v=mwz0jl1g';
import { LIGHT_PRESETS, resolveLight, fmtTime } from './lighting.js?v=mwz0jl1g';
import { itemThumb } from './thumbs.js?v=mwz0jl1g';
import { FLOORS, WALL_COLORS, ITEM_COLORS, floorThumb, setCustomFloors, onTextureLoaded, isCustomFloor, LAYOUTS, FINISHES, finishCss } from './materials.js?v=mwz0jl1g';
import { PhotoTool, fileToDataURL, warpPerspective, ocrScale, darkMap, loadImage } from './photo.js?v=mwz0jl1g';
import { skewAngle, rotateImage, detectWalls } from './detect.js?v=mwz0jl1g';
import * as MD from './models.js?v=mwz0jl1g';
import * as store from './store.js?v=mwz0jl1g';
import { Sync } from './cloud.js?v=mwz0jl1g';
import { sampleDoc, addOpeningAt } from './sample.js?v=mwz0jl1g';

const $ = s => document.querySelector(s);
const QP = new URLSearchParams(location.search);

// ---------- stato ----------
const app = {
  doc: G.emptyDoc(),
  sel: null,
  view: '2d',
  setSel, commit, changed, toolDone, onTyped, editLength, selectRoomFace, placeItemAt, previewItem,
  northStart: () => { $('#hint').textContent = 'Trascina l’ago verso il nord e rilascia, oppure clicca sulla mappa dove sta il nord · Esc per annullare'; },
  northDone: () => { setHint(); renderPanel(); view.setLight({}); },
  askCalibration, modelGeos, snapItem: (it, p) => plan.snapItemToWall(it, p), snapItems: it => plan.snapItemToItems(it, 8), selectRoomAt, selectedRoomCenter, walkStart,
};
let project = null; // { id, name, rev }
const photo = app.photo = new PhotoTool(app);
const plan = app.plan = new Plan2D($('#plan'), app);
const view = new View3D($('#v3d'), app);
app.view3d = view;

// ---------- annulla / ripeti ----------
const bgSources = new Map();
function snapshot() {
  const d = app.doc;
  const bg = d.background ? { ...d.background, src: undefined } : null;
  if (d.background) bgSources.set(d.background.sid, d.background.src);
  return JSON.stringify({ ...d, models: undefined, background: bg });
}
function restore(json) {
  const o = JSON.parse(json);
  o.models = app.doc.models;
  if (o.background) o.background.src = bgSources.get(o.background.sid);
  app.doc = o;
  setCustomFloors(o.textures);
  photo.refresh();
}
let history = [], hIdx = -1;
function resetHistory() { history = [snapshot()]; hIdx = 0; updateUndo(); }
function commit(label) {
  const s = snapshot();
  if (history[hIdx] === s) { refresh(); return; }
  history = history.slice(0, hIdx + 1);
  history.push(s);
  if (history.length > 120) history.shift();
  hIdx = history.length - 1;
  updateUndo();
  refresh();
  scheduleSave();
}
function undo() { if (hIdx <= 0) return; hIdx--; restore(history[hIdx]); fixSel(); refresh(); scheduleSave(); updateUndo(); }
function redo() { if (hIdx >= history.length - 1) return; hIdx++; restore(history[hIdx]); fixSel(); refresh(); scheduleSave(); updateUndo(); }
function updateUndo() { $('#btnUndo').disabled = hIdx <= 0; $('#btnRedo').disabled = hIdx >= history.length - 1; }
function fixSel() { if (app.sel && !findSel(app.sel)) app.sel = null; }

/** Ridisegna tutto dopo una modifica confermata. */
function refresh() { plan.redraw(); view.invalidate(); renderPanel(); }
/** Modifica in corso (trascinamento): solo il disegno. */
function changed(live, from3d) { plan.redraw(); if (!from3d) view.invalidate(); if (!live) renderPanel(); }

// ---------- selezione ----------
function findSel(s) {
  const d = app.doc;
  if (!s) return null;
  if (s.type === 'wall') return G.wallById(d, s.id);
  if (s.type === 'node') return G.nodeById(d, s.id);
  if (s.type === 'opening') return d.openings.find(o => o.id === s.id);
  if (s.type === 'item') return d.items.find(o => o.id === s.id);
  if (s.type === 'room') return d.rooms.find(o => o.id === s.id);
  if (s.type === 'dim') return d.dims.find(o => o.id === s.id);
  return null;
}
function setSel(s) {
  if (JSON.stringify(s) === JSON.stringify(app.sel)) return;
  app.sel = s;
  plan.redraw();
  view.selectionChanged();
  renderPanel();
}
function selectRoomFace(face) {
  if (face.label) { setSel({ type: 'room', id: face.label.id }); return; }
  const p = G.interiorPoint(face.inner);
  const r = { id: G.newId('r'), x: p.x, y: p.y, name: '', floor: 'parquet', wallColor: '#f4f1ea' };
  app.doc.rooms.push(r);
  commit('Stanza');
  setSel({ type: 'room', id: r.id });
}
function selectRoomAt(p) {
  const rooms = G.matchRooms(app.doc, G.findRooms(app.doc));
  const f = rooms.filter(r => G.pointInPoly(p, r.poly)).sort((a, b) => a.area - b.area)[0];
  if (f) selectRoomFace(f); else setSel(null);
}
function selectedRoomCenter() {
  const s = app.sel;
  if (!s) return null;
  if (s.type === 'room') { const r = findSel(s); return r ? { x: r.x, y: r.y } : null; }
  return null;
}
/** Punto di partenza della passeggiata: nella stanza selezionata o nella piu' grande, arretrato
 * verso un muro e girato verso il lato opposto (cosi' si vede quasi tutta la stanza). */
function walkStart() {
  const rooms = roomsInfo();
  if (!rooms.length) return null;
  const s = app.sel;
  let r = s && s.type === 'room' ? rooms.find(f => f.label && f.label.id === s.id) : null;
  if (!r) r = rooms.slice().sort((a, b) => b.area - a.area)[0];
  const p = r.label && G.pointInPoly(r.label, r.poly) ? { x: r.label.x, y: r.label.y } : G.interiorPoint(r.inner);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of r.inner) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  // direzione con piu' spazio davanti; ci si mette a 40 cm dal muro opposto
  const opts = [[1, 0, x1 - x0, { x: x0 + 40, y: (y0 + y1) / 2 }], [-1, 0, x1 - x0, { x: x1 - 40, y: (y0 + y1) / 2 }], [0, 1, y1 - y0, { x: (x0 + x1) / 2, y: y0 + 40 }], [0, -1, y1 - y0, { x: (x0 + x1) / 2, y: y1 - 40 }]];
  const cand = opts.filter(o => G.pointInPoly(o[3], r.inner)).sort((a, b) => b[2] - a[2]);
  const o = cand[0];
  const at = o ? o[3] : p;
  const [dx, dy] = o ? o : [0, -1];
  // nella vista 3D: avanti = (-sin yaw, -cos yaw) in (x, z), con z = y della pianta
  return { x: at.x, y: at.y, yaw: Math.atan2(-dx, -dy) };
}
function deleteSel() {
  const d = app.doc, s = app.sel;
  if (!s) return;
  if (s.type === 'wall') { const w = findSel(s); if (w) G.removeWall(d, w); }
  else if (s.type === 'node') { d.walls.filter(w => w.a === s.id || w.b === s.id).forEach(w => { d.openings = d.openings.filter(o => o.wall !== w.id); }); d.walls = d.walls.filter(w => w.a !== s.id && w.b !== s.id); G.cleanup(d); }
  else if (s.type === 'opening') d.openings = d.openings.filter(o => o.id !== s.id);
  else if (s.type === 'item') d.items = d.items.filter(o => o.id !== s.id);
  else if (s.type === 'room') d.rooms = d.rooms.filter(o => o.id !== s.id);
  else if (s.type === 'dim') d.dims = d.dims.filter(o => o.id !== s.id);
  app.sel = null;
  purgeModels();
  commit('Elimina');
}
function duplicateSel() {
  const s = app.sel;
  if (!s || s.type !== 'item') return;
  const it = findSel(s);
  const c = { ...it, id: G.newId('i'), x: it.x + 20, y: it.y + 20 };
  app.doc.items.push(c);
  commit('Duplica');
  setSel({ type: 'item', id: c.id });
}

// ---------- strumenti ----------
const ICONS = {
  select: '<path d="M5 3l14 8-6 1.5L10 19z"/>',
  wall: '<path d="M3 17L17 3l4 4L7 21H3z"/><path d="M14 6l4 4"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M4 5l3 3M20 19l-3-3"/>',
  door: '<path d="M4 20h16M6 20V4h7v16"/><path d="M13 4a9 9 0 0 1 7 9"/>',
  window: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16M4 12h16"/>',
  dim: '<path d="M3 12h18M3 8v8M21 8v8M7 10l-4 2 4 2M17 10l4 2-4 2"/>',
  divider: '<path d="M3 21V3h18v18z" opacity=".35"/><path d="M12 3v18" stroke-dasharray="3 2.5"/>',
  furniture: '<path d="M4 18v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6M4 15h16M6 18v2M18 18v2M7 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  house: '<path d="M3 11l9-7 9 7v9H3z"/><path d="M9 20v-6h6v6"/>',
  orbit: '<circle cx="12" cy="12" r="3"/><path d="M3 12a9 4 0 0 0 18 0a9 4 0 0 0-18 0"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="M9 21l2-6 3 3v5M7 12l3-4 4 1 2 4M11 15l-1-6"/>',
  low: '<path d="M3 20h18M5 20v-6h14v6M5 14l3-3h8l3 3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  moon: '<path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z"/>',
};
const icon = k => `<svg viewBox="0 0 24 24">${ICONS[k]}</svg>`;
const TOOLS_2D = [
  ['select', 'Seleziona', 'V'], ['wall', 'Pareti', 'W'], ['rect', 'Stanza', 'R'], ['divider', 'Divisore', 'L'], ['door', 'Porte', 'D'], ['window', 'Finestre', 'F'],
  ['dim', 'Quota', 'Q'], ['furniture', 'Arredi', 'M'], ['photo', 'Da foto', 'P'], '-', ['fit', 'Inquadra', 'Home'],
];
let curTool = 'select';
let placeKind = null;
let openingType = 'door';

function renderTools() {
  const t = $('#tools');
  t.innerHTML = '';
  if (app.view === '2d') {
    for (const x of TOOLS_2D) {
      if (x === '-') { t.appendChild(Object.assign(document.createElement('i'), { className: 'sep' })); continue; }
      const [k, name, key] = x;
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = icon(k) + `<span>${name}</span>`;
      b.title = `${name} (${key})`;
      const active = k === curTool || (k === 'door' && curTool === 'opening' && openingType !== 'window' && openingType !== 'french') || (k === 'window' && curTool === 'opening' && (openingType === 'window' || openingType === 'french')) || (k === 'furniture' && curTool === 'place');
      if (active) b.classList.add('on');
      b.addEventListener('click', () => pickTool(k));
      t.appendChild(b);
    }
  } else {
    const B = (k, name, title, on, fn) => { const b = document.createElement('button'); b.type = 'button'; b.innerHTML = icon(k) + `<span>${name}</span>`; b.title = title; if (on) b.classList.add('on'); b.addEventListener('click', fn); t.appendChild(b); };
    B('orbit', 'Orbita', 'Gira attorno alla casa', view.mode === 'orbit', () => { view.setMode('orbit'); renderTools(); updateWalkpad(); setHint(); });
    B('walk', 'Cammina', 'Vista dagli occhi: WASD o frecce, trascina per guardarti attorno', view.mode === 'walk', () => { view.setMode('walk'); renderTools(); updateWalkpad(); setHint(); });
    B('fit', 'Inquadra', 'Inquadra tutta la casa', false, () => { view.frame(); renderTools(); updateWalkpad(); });
    t.appendChild(Object.assign(document.createElement('i'), { className: 'sep' }));
    B('low', 'Pareti basse', 'Pareti tagliate a 110 cm per vedere dentro', view.lowWalls, () => { view.lowWalls = !view.lowWalls; view.invalidate(); renderTools(); });
    const night = view.light.preset === 'sera';
    B(night ? 'moon' : 'sun', night ? 'Sera' : 'Giorno', 'Luce del giorno o sera con le lampade (altre luci nel pannello)', false, () => { view.light.preset = night ? 'auto' : 'sera'; view.setLight({}); renderTools(); renderPanel(); });
    t.appendChild(Object.assign(document.createElement('i'), { className: 'sep' }));
    B('furniture', 'Arredi', 'Aggiungi un arredo', false, () => { setSel(null); panelMode = 'catalog'; renderPanel(); });
  }
}
let panelMode = null; // 'catalog' in 3D
function pickTool(k) {
  if (k === 'fit') { plan.fit(); return; }
  if (k === 'door') { curTool = 'opening'; if (openingType === 'window' || openingType === 'french') openingType = 'door'; plan.setTool('opening', { type: openingType }); }
  else if (k === 'window') { curTool = 'opening'; if (!(openingType === 'window' || openingType === 'french')) openingType = 'window'; plan.setTool('opening', { type: openingType }); }
  else if (k === 'furniture') { curTool = 'place'; plan.setTool('select'); placeKind = null; }
  else if (k === 'photo') { curTool = 'photo'; plan.setTool('photo'); photo.setMode(app.doc.background ? 'move' : null); }
  else if (k === 'divider') { curTool = 'divider'; plan.setTool('wall', { virtual: true }); }
  else { curTool = k; plan.setTool(k, k === 'wall' ? { thickness: wallTool.thickness, photoThick: wallTool.photoThick } : {}); }
  if (k !== 'photo' && photo.mode) photo.setMode(null);
  if (k !== 'select') setSel(null);
  renderTools(); renderPanel(); setHint();
}
function toolDone() {
  if (curTool === 'place') { placeKind = null; plan.setTool('select'); renderPanel(); setHint(); return; }
  curTool = 'select'; plan.setTool('select'); photo.setMode(null); renderTools(); renderPanel(); setHint();
}
const wallTool = { thickness: null, photoThick: true };

function setHint() {
  const H = {
    select: 'Clic per selezionare · trascina per spostare · doppio clic su una misura per cambiarla · clic in una stanza per nome e pavimento',
    wall: 'Clic per iniziare e a ogni angolo · scrivi la lunghezza e premi Invio · doppio clic o Esc per finire · Alt = senza agganci',
    rect: 'Trascina da un angolo all’altro per creare una stanza rettangolare',
    divider: 'Disegna una linea che divide un ambiente in due stanze (es. zona cucina): si aggancia alle pareti · doppio clic o Esc per finire',
    opening: 'Clic su una parete per inserire · il lato del cursore decide verso dove si apre',
    dim: 'Clic sul primo punto, clic sul secondo, poi sposta e clicca per la distanza della quota',
    place: placeKind ? 'Clic per posare · vicino a un muro si appoggia da solo · Esc per annullare' : 'Scegli un arredo dal pannello',
    photo: photo.mode === 'calib' ? 'Clic su due punti di cui conosci la distanza (ad esempio gli estremi di una quota)' : photo.mode === 'persp' ? 'Trascina i 4 angoli sui bordi della pianta nella foto, poi «Applica»' : photo.mode === 'move' ? 'Trascina per spostare la foto' : '',
  };
  let h = '';
  if (app.view === '2d') h = H[curTool] || '';
  else if (app.view === '3d') h = view.mode === 'walk' ? 'WASD o frecce per muoverti · tieni premuto e trascina per guardarti attorno · Q/E per girare · Maiusc per correre' : 'Trascina per girare · tasto destro o due dita per spostare · clic su un arredo per selezionarlo, poi trascinalo';
  else h = 'Il render migliora a ogni passaggio · muovi la vista o cammina e riparte da capo';
  if (window.matchMedia('(pointer: coarse)').matches && app.view !== '2d' && view.mode === 'walk') h = 'Trascina il dito per guardarti attorno · usa le frecce in basso per muoverti';
  $('#hint').textContent = (window.matchMedia('(pointer: coarse)').matches ? h.replace(/ · Alt = senza agganci| · Maiusc per correre/g, '') : h);
}

// ---------- viste ----------
function setView(v) {
  if (app.view === v) return;
  const prev = app.view;
  app.view = v;
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $('#plan').hidden = v !== '2d';
  $('#v3d').hidden = v === '2d';
  plan.visible = v === '2d';
  panelMode = null;
  if (prev === 'render' && v !== 'render') renderStopped();
  if (v === '2d') { view.setVisible(false); plan.resize(); }
  else {
    view.setVisible(true);
    if (v === 'render') { view.startTrace(renderOpts).catch(e => { toast('Render non disponibile: ' + e.message); console.error(e); }); }
    else if (prev === 'render') view.stopTrace();
  }
  $('#renderbar').hidden = v !== 'render';
  updateWalkpad();
  renderTools(); renderPanel(); setHint();
}
// filtro del rumore spento su questo dispositivo se in passato il sistema ha chiuso la pagina durante il filtro
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* pieno o vietato */ } };
const renderOpts = { style: 'pt', bounces: 6, scale: 1, samples: 96, denoise: lsGet('pianta.noDenoise') !== '1' };
function updateWalkpad() { $('#walkpad').hidden = !(app.view !== '2d' && view.mode === 'walk'); }
document.querySelectorAll('#viewSeg button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
// stato del render in corso, ricordato nel browser: se il sistema chiude la pagina (memoria) alla
// riapertura si sa in che fase era e si recupera l'immagine salvata prima del filtro
let lastStage = null;
function trackRender(st) {
  if (st.stage === lastStage) return;
  lastStage = st.stage;
  if (st.stage === 'rendering' || st.stage === 'denoising') lsSet('pianta.renderRun', JSON.stringify({ stage: st.stage, t: Date.now() }));
  if (st.stage === 'denoising') {
    // immagine gia' calcolata, prima del filtro: se il filtro fa chiudere la pagina non si perde
    try { const c = document.createElement('canvas'); const img = new Image(); img.onload = () => { c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); lsSet('pianta.renderShot', c.toDataURL('image/jpeg', 0.9)); }; img.src = view.snapshot(); } catch (e) { /* niente */ }
  }
  if (st.stage === 'done' || st.stage === 'instant') { lsSet('pianta.renderRun', null); lsSet('pianta.renderShot', null); }
}
function renderStopped() { lastStage = null; lsSet('pianta.renderRun', null); }
view.onProgress = st => {
  trackRender(st);
  const n = st.samples || 0;
  let t;
  if (st.stage === 'instant') t = 'Pronto';
  else if (st.stage === 'building' || st.stage === 'compiling' || (!n && st.stage !== 'done')) t = 'Preparo il render…';
  else if (st.stage === 'denoising') t = 'Tolgo il rumore…' + (st.progress != null ? ' ' + Math.round(st.progress * 100) + '%' : '');
  else if (st.stage === 'done') t = 'Pronto · ' + n + ' passaggi';
  else t = n + (st.max ? ' / ' + st.max : '') + (n === 1 ? ' passaggio' : ' passaggi');
  $('#rSamples').textContent = t;
};
view.onSlow = () => { $('#rSamples').textContent = 'Preparo il render…'; toast('Render in modalità compatibile (WebGL): ' + (view.gpuWhy || 'WebGPU non disponibile') + '. Il primo render può richiedere qualche minuto.'); if (app.view === 'render') renderPanel(); };
$('#rSave').addEventListener('click', async () => {
  const url = view.snapshot();
  const name = (project ? project.name : 'pianta') + ' - render.png';
  const touch = window.matchMedia('(pointer: coarse)').matches;
  // su iPhone e iPad (anche aperta come app dalla Home) il download non funziona o finisce in File:
  // si usa il foglio di condivisione, da cui «Salva immagine» la mette in Foto
  if (touch && navigator.canShare) {
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  if (touch) {
    // ultima strada: l'immagine a tutto schermo, da tenere premuta per salvarla
    modal(`<h2>Immagine pronta</h2><p class="note">Tieni premuto sull’immagine e scegli «Salva in Foto» (o «Aggiungi a Foto»).</p><img src="${url}" alt="" style="width:100%;border-radius:8px"><footer><button class="primary" data-close>Chiudi</button></footer>`);
    return;
  }
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  toast('Immagine salvata nella cartella Download');
});
for (const b of document.querySelectorAll('#walkpad button')) {
  const k = b.dataset.k;
  const on = e => { e.preventDefault(); view.hold(k, true); };
  const off = () => view.hold(k, false);
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
}

// ---------- pannello ----------
const panel = $('#panel');
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
function numField(label, value, onSet, { unit = 'cm', min = 0, max = 100000, step = 1 } = {}) {
  const inp = h('input', { type: 'number', value: Math.round(value * 10) / 10, min, max, step, inputmode: 'decimal' });
  inp.addEventListener('change', () => { let v = parseFloat(String(inp.value).replace(',', '.')); if (!isFinite(v)) return; v = Math.max(min, Math.min(max, v)); onSet(v); });
  return h('label', { class: 'field' }, h('span', {}, label), h('span', {}, inp, ' ', h('span', { class: 'unit' }, unit)));
}
function checkField(label, value, onSet) {
  const inp = h('input', { type: 'checkbox' });
  inp.checked = !!value;
  inp.addEventListener('change', () => onSet(inp.checked));
  return h('label', { class: 'field' }, h('span', {}, label), inp);
}
function rangeField(label, value, min, max, step, onSet, fmt = v => v) {
  const out = h('span', { class: 'unit', style: 'width:auto;margin:0' }, fmt(value));
  const inp = h('input', { type: 'range', min, max, step, value });
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); out.textContent = fmt(v); onSet(v, false); });
  inp.addEventListener('change', () => onSet(parseFloat(inp.value), true));
  return h('label', { class: 'field' }, h('span', {}, label, ' ', out), inp);
}
// ---------- colori: tinte pronte, rotella e codice esadecimale ----------
let swIdx = 0, wheelOpen = null;
/** Colori + finiture (metalli ed effetti legno) per i mobili. */
function finishes(cur, onPick) {
  const wrap = h('div', {});
  wrap.append(swatches(ITEM_COLORS, cur, onPick));
  const box = h('div', { class: 'sw finishes' });
  for (const [k, f] of Object.entries(FINISHES)) box.append(h('button', { type: 'button', class: k === cur ? 'on' : '', title: f.name, style: `background:${finishCss(k)}`, onclick: () => onPick(k) }));
  wrap.append(h('p', { class: 'swlabel' }, cur && FINISHES[cur] ? 'Finitura: ' + FINISHES[cur].name : 'Legni e metalli:'), box);
  return wrap;
}
function swatches(colors, cur, onPick) {
  const key = swIdx++;
  const wrap = h('div', { class: 'swwrap' });
  const box = h('div', { class: 'sw' });
  for (const c of colors) box.append(h('button', { type: 'button', class: c.toLowerCase() === (cur || '').toLowerCase() ? 'on' : '', style: `background:${c}`, title: c, onclick: () => onPick(c) }));
  const open = wheelOpen === key;
  box.append(h('button', { type: 'button', class: 'wheelbtn' + (open ? ' on' : ''), title: 'Altro colore: rotella e codice', onclick: () => { wheelOpen = open ? null : key; renderPanel(); } }));
  wrap.append(box);
  if (open) wrap.append(colorWheel(cur || '#ffffff', onPick));
  return wrap;
}
const hex2rgb = hx => { const n = parseInt(hx.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgb2hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
function hsv2rgb(hh, s, v) {
  const f = n => { const k = (n + hh / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hh * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
/** Rotella (tinta = angolo, saturazione = distanza dal centro) + luminosita' + esadecimale. */
function colorWheel(cur, onPick) {
  const N = 180, R = N / 2;
  let [hh, s, v] = rgb2hsv(...hex2rgb(/^#[0-9a-f]{6}$/i.test(cur) ? cur : '#ffffff'));
  const box = h('div', { class: 'wheel' });
  const cv = h('canvas', { width: N, height: N });
  const ctx = cv.getContext('2d');
  const disc = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - R + 0.5, dy = y - R + 0.5, r = Math.hypot(dx, dy) / R, o = (y * N + x) * 4;
    if (r > 1) { disc.data[o + 3] = 0; continue; }
    const [cr, cg, cb] = hsv2rgb((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, r, 1);
    disc.data[o] = cr; disc.data[o + 1] = cg; disc.data[o + 2] = cb; disc.data[o + 3] = 255;
  }
  const chip = h('span', { class: 'chip' });
  const hexIn = h('input', { type: 'text', maxlength: 7, spellcheck: 'false', class: 'hex' });
  const val = h('input', { type: 'range', min: 0, max: 100, step: 1 });
  const cur3 = () => rgb2hex(...hsv2rgb(hh, s, v));
  const draw = () => {
    ctx.clearRect(0, 0, N, N);
    ctx.putImageData(disc, 0, 0);
    // la luminosita' scurisce tutta la rotella
    ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = `rgba(0,0,0,${1 - v})`; ctx.fillRect(0, 0, N, N); ctx.globalCompositeOperation = 'source-over';
    const a = hh * Math.PI / 180, mx = R + Math.cos(a) * s * R, my = R + Math.sin(a) * s * R;
    ctx.beginPath(); ctx.arc(mx, my, 7, 0, 7); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#000'; ctx.stroke();
    const c = cur3();
    chip.style.background = c;
    if (document.activeElement !== hexIn) hexIn.value = c;
    val.value = Math.round(v * 100);
    val.style.background = `linear-gradient(to right, #000, ${rgb2hex(...hsv2rgb(hh, s, 1))})`;
  };
  const fromXY = e => {
    const r = cv.getBoundingClientRect();
    const dx = (e.clientX - r.left) * N / r.width - R, dy = (e.clientY - r.top) * N / r.height - R;
    hh = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; s = Math.min(1, Math.hypot(dx, dy) / R);
    if (v < 0.05) v = 1; // da nero, scegliendo una tinta si torna alla luce
    draw();
  };
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); fromXY(e); });
  cv.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch' && cv.hasPointerCapture(e.pointerId)) fromXY(e); });
  cv.addEventListener('pointerup', () => onPick(cur3()));
  val.addEventListener('input', () => { v = val.value / 100; draw(); });
  val.addEventListener('change', () => onPick(cur3()));
  const applyHex = () => {
    let t = hexIn.value.trim();
    if (!t.startsWith('#')) t = '#' + t;
    if (/^#[0-9a-f]{3}$/i.test(t)) t = '#' + t.slice(1).split('').map(ch => ch + ch).join('');
    if (!/^#[0-9a-f]{6}$/i.test(t)) { toast('Codice non valido: usa #rrggbb'); draw(); return; }
    [hh, s, v] = rgb2hsv(...hex2rgb(t));
    draw();
    onPick(t.toLowerCase());
  };
  hexIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyHex(); } });
  hexIn.addEventListener('change', applyHex);
  draw();
  box.append(cv, h('div', { class: 'wheelside' }, h('label', { class: 'lum' }, 'Luminosità', val), h('div', { class: 'hexrow' }, chip, hexIn)));
  return box;
}
function btn(label, fn, cls = '') { return h('button', { type: 'button', class: 'btn ' + cls, onclick: fn }, label); }
function setVal(fn, label) { return v => { fn(v); commit(label); }; }

function renderPanel() {
  panel.innerHTML = '';
  swIdx = 0;
  const s = app.sel, obj = findSel(s);
  if (obj && app.view === 'render') panel.append(h('button', { type: 'button', class: 'btn ghost back', onclick: () => setSel(null) }, '← Impostazioni del render'));
  if (obj) {
    if (s.type === 'wall') return panelWall(obj);
    if (s.type === 'node') return panelNode(obj);
    if (s.type === 'opening') return panelOpening(obj);
    if (s.type === 'item') return panelItem(obj);
    if (s.type === 'room') return panelRoom(obj);
    if (s.type === 'dim') return panelDim(obj);
  }
  if (app.view === 'render') return panelRender();
  if (app.view === '3d') return panelMode === 'catalog' ? panelCatalog() : panel3D();
  if (curTool === 'divider') return panelDividerTool();
  if (curTool === 'wall' || curTool === 'rect') return panelWallTool();
  if (curTool === 'opening') return panelOpeningTool();
  if (curTool === 'place') return panelCatalog();
  if (curTool === 'photo') return panelPhoto();
  return panelHouse();
}

/** Riquadri dei pavimenti (quelli pronti, le immagini dell'utente e «+ Tua immagine»). */
function floorPicker(cur, onPick) {
  const fl = h('div', { class: 'floors' });
  const tile = (k, name, src) => fl.append(h('button', { type: 'button', class: cur === k ? 'on' : '', title: name, onclick: () => onPick(k) }, h('img', { src, alt: '' }), h('span', {}, name)));
  for (const [k, v] of Object.entries(FLOORS)) tile(k, v.name, floorThumb(k));
  for (const [id, t] of Object.entries(app.doc.textures || {})) tile('img:' + id, t.name, t.src);
  fl.append(h('button', { type: 'button', class: 'addimg', title: 'Usa una tua immagine (foto di piastrelle, parquet…)', onclick: () => pickFloorImage(onPick) }, h('span', { class: 'plus' }, '+'), h('span', {}, 'Tua immagine')));
  return fl;
}
let floorImageCb = null;
function pickFloorImage(cb) { floorImageCb = cb; $('#fileFloor').click(); }
const fileFloor = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', id: 'fileFloor', hidden: true });
document.body.appendChild(fileFloor);
fileFloor.addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const url = URL.createObjectURL(f);
    const img = await loadImage(url);
    URL.revokeObjectURL(url);
    // intera (anche rettangolare: listoni, piastrelle 30×60), al massimo 1024 px di lato
    const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const id = G.newId('t');
    const v = await promptText('Quanto è larga nella realtà l’immagine (lato orizzontale)?', '60', 'Usa', 'cm, es. 60 per una piastrella 60×60');
    const size = parseLen(v) || 60;
    app.doc.textures[id] = { name: f.name.replace(/\.[^.]+$/, '').slice(0, 24), src: c.toDataURL('image/jpeg', 0.85), size, layout: 'dritta', rot: 0 };
    setCustomFloors(app.doc.textures);
    if (floorImageCb) floorImageCb('img:' + id);
  } catch (err) { toast('Immagine non leggibile: ' + err.message); }
});
onTextureLoaded(() => { plan.redraw(); view.invalidate(); });

function roomsInfo() { return G.matchRooms(app.doc, G.findRooms(app.doc)); }

function panelHouse() {
  const d = app.doc, S = d.settings;
  panel.append(h('h2', {}, 'Casa'));
  const rooms = roomsInfo();
  if (!d.walls.length) {
    panel.append(h('p', {}, 'Comincia disegnando le pareti (strumento «Pareti» o «Stanza»), oppure carica la foto di una planimetria con «Da foto» e ricalcala.'));
    panel.append(h('div', { class: 'row' }, btn('Disegna pareti', () => pickTool('wall')), btn('Da foto', () => pickTool('photo'))));
    panel.append(h('div', { class: 'row' }, btn('Apri l’esempio', async () => { await newProject(sampleDoc(), 'Appartamento di esempio'); })));
  }
  if (rooms.length) {
    panel.append(h('h3', {}, 'Stanze'));
    panel.append(h('p', {}, 'Clicca una stanza (nella pianta o qui sotto) per nome, pavimento e colori. Solo le stanze chiuse da pareti collegate si possono scegliere.'));
    const list = h('div', { class: 'list' });
    let tot = 0;
    for (const r of rooms) {
      tot += r.area;
      list.append(h('div', { class: 'it', onclick: () => selectRoomFace(r) }, h('span', {}, (r.label && r.label.name) || 'Senza nome'), h('span', {}, fmtM2(r.area))));
    }
    list.append(h('div', { class: 'it tot' }, h('span', {}, 'Superficie netta'), h('span', {}, fmtM2(tot))));
    panel.append(list);
    panel.append(h('h3', {}, 'Pavimento in tutte le stanze'));
    panel.append(floorPicker(null, k => {
      // le stanze senza etichetta la ricevono, cosi' il pavimento resta legato a loro
      for (const r of rooms) {
        if (r.label) r.label.floor = k;
        else { const p = G.interiorPoint(r.inner); d.rooms.push({ id: G.newId('r'), x: p.x, y: p.y, name: '', floor: k, wallColor: '#f4f1ea' }); }
      }
      commit('Pavimento ovunque');
    }));
  }
  panel.append(h('h3', {}, 'Misure di base'));
  panel.append(numField('Altezza pareti', S.wallHeight, setVal(v => { S.wallHeight = v; }, 'Altezza pareti'), { min: 150, max: 600 }));
  panel.append(numField('Spessore nuove pareti', S.wallThickness, setVal(v => { S.wallThickness = v; }, 'Spessore'), { min: 3, max: 80 }));
  panel.append(numField('Griglia di aggancio', S.grid, setVal(v => { S.grid = v; }, 'Griglia'), { min: 0, max: 100 }));
  panel.append(checkField('Mostra le quote', S.showDims, setVal(v => { S.showDims = v; }, 'Quote')));
  panel.append(checkField('Mostra le superfici', S.showAreas, setVal(v => { S.showAreas = v; }, 'Superfici')));
  panel.append(h('h3', {}, 'Orientamento'));
  panel.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => { if (app.view !== '2d') setView('2d'); plan.startNorth(); } }, h('span', { class: 'compassico', style: `transform: rotate(${S.north || 0}deg)` }, '➤'), ' Indica il nord sulla mappa')));
  panel.append(rangeField('Direzione del nord', S.north || 0, 0, 359, 1, (v, fin) => { S.north = v; plan.redraw(); if (fin) { commit('Nord'); view.setLight({}); } }, v => v + '°'));
  panel.append(h('p', {}, 'Puoi anche cliccare la rosa dei venti in alto a destra nella pianta: l’ago segue il mouse, clicchi dove sta il nord. Serve per la posizione del sole nel render.'));
  const lat = h('select', {}, ...[['46.5', 'Nord Italia (Alpi)'], ['45.5', 'Nord Italia'], ['43.8', 'Centro Italia'], ['41.5', 'Lazio, Campania'], ['39', 'Sud Italia'], ['37.5', 'Sicilia']].map(([v, n]) => h('option', { value: v }, n)));
  lat.value = String([46.5, 45.5, 43.8, 41.5, 39, 37.5].reduce((a, b) => Math.abs(b - (S.lat ?? 45)) < Math.abs(a - (S.lat ?? 45)) ? b : a));
  lat.addEventListener('change', () => { S.lat = +lat.value; commit('Latitudine'); view.setLight({}); });
  panel.append(h('label', { class: 'field' }, h('span', {}, 'Zona'), lat));
  panel.append(h('h3', {}, 'Facciata esterna'));
  panel.append(swatches(['#e9e4da', '#f4f1ea', '#d9c8a9', '#c98c6c', '#b5b0a5', '#8a8f94'], S.exteriorColor, setVal(c => { S.exteriorColor = c; }, 'Colore esterno')));
  panel.append(h('h3', {}, 'Scorciatoie'));
  panel.append(h('p', { html: '<span class="kbd">V</span> seleziona · <span class="kbd">W</span> pareti · <span class="kbd">R</span> stanza · <span class="kbd">D</span> porte · <span class="kbd">F</span> finestre · <span class="kbd">Q</span> quota · <span class="kbd">M</span> arredi · <span class="kbd">Canc</span> elimina · <span class="kbd">Ctrl+Z</span> annulla · <span class="kbd">E</span> ruota arredo · <span class="kbd">Ctrl+D</span> duplica · rotellina o due dita per zoom · spazio o tasto destro per spostare la vista' }));
}

function panelWallTool() {
  const d = app.doc;
  panel.append(h('h2', {}, curTool === 'rect' ? 'Stanza rettangolare' : 'Pareti'));
  panel.append(numField('Spessore', wallTool.thickness || d.settings.wallThickness, v => { wallTool.thickness = v; plan.toolOpt.thickness = v; }, { min: 3, max: 80 }));
  const quick = h('div', { class: 'row' });
  for (const t of [8, 10, 12, 30]) quick.append(btn(t + ' cm', () => { wallTool.thickness = t; plan.toolOpt.thickness = t; renderPanel(); }, (wallTool.thickness || d.settings.wallThickness) === t ? 'on' : ''));
  panel.append(quick);
  if (curTool === 'wall') {
    panel.append(h('h3', {}, 'Lunghezza'));
    const inp = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'es. 345 o 3,45 m', id: 'lenIn', class: 'wide' });
    const apply = () => { const v = parseLen(inp.value); if (v && plan.applyTypedLength(v)) { inp.value = ''; } else if (!plan.draft) toast('Prima clicca il punto di partenza'); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    panel.append(h('div', { class: 'row' }, inp, btn('Aggiungi', apply)));
    const dirBtn = (label, dir) => btn(label, () => { const v = parseLen(inp.value); if (!v) { toast('Scrivi prima la lunghezza'); return; } if (plan.applyTypedLength(v, dir)) inp.value = ''; else toast('Prima clicca il punto di partenza'); });
    panel.append(h('div', { class: 'row' }, dirBtn('→', { x: 1, y: 0 }), dirBtn('↓', { x: 0, y: 1 }), dirBtn('←', { x: -1, y: 0 }), dirBtn('↑', { x: 0, y: -1 })));
    panel.append(h('p', {}, 'Mentre disegni puoi anche scrivere la misura direttamente: compare in alto e con Invio la parete prende quella lunghezza nella direzione del cursore.'));
    panel.append(h('div', { class: 'row' }, btn('Fine (Esc)', () => plan.finishWall())));
    panel.append(h('h3', {}, 'Agganci'));
    const SP = plan.snapPrefs;
    panel.append(checkField('Angoli a 15°', SP.angle !== false, v => { SP.angle = v; }));
    panel.append(checkField('Allineamento con gli altri angoli', SP.align !== false, v => { SP.align = v; }));
    panel.append(checkField('Griglia', SP.grid !== false, v => { SP.grid = v; }));
    if (d.background) {
      panel.append(checkField('Muri della foto', d.background.snap, setVal(v => { d.background.snap = v; }, 'Aggancio foto')));
      panel.append(checkField('Spessore misurato sulla foto', wallTool.photoThick, v => { wallTool.photoThick = v; plan.toolOpt.photoThick = v; }));
    }
    panel.append(h('p', {}, 'Il segno arancione mostra a cosa si aggancia il punto: quadrato = angolo esistente, × = parete, cerchio = muro della foto, croce = libero. Tenendo premuto Alt non si aggancia a niente.'));
  }
}

/** Rivestimento: materiale (piastrelle, marmo, immagine), altezza e partenza da terra. */
function cladEditor(cl, apply, wallH) {
  const on = !!(cl && cl.mat);
  panel.append(checkField('Rivestimento', on, v => apply(v ? { mat: (cl && cl.mat) || 'gres', h: (cl && cl.h) || 120, from: (cl && cl.from) || 0 } : null)));
  if (!on) return;
  panel.append(numField('Fino all’altezza di', cl.h || 120, v => apply({ ...cl, h: v }), { min: 5, max: 800 }));
  panel.append(h('div', { class: 'row' }, ...[[60, '60'], [120, '120'], [220, '220'], [wallH, 'Fino al soffitto']].map(([v, n]) => btn(n, () => apply({ ...cl, h: v }), (cl.h || 120) === v ? 'on' : ''))));
  panel.append(numField('Da terra', cl.from || 0, v => apply({ ...cl, from: v }), { min: 0, max: 400 }));
  panel.append(floorPicker(cl.mat, k => apply({ ...cl, mat: k })));
}

function panelDividerTool() {
  panel.append(h('h2', {}, 'Divisore di stanza'));
  panel.append(h('p', {}, 'Una linea tratteggiata che divide un ambiente senza muro: per esempio la zona cucina del soggiorno, un ingresso aperto o la zona notte di un open space. Ogni parte diventa una stanza a sé, con il suo nome, il suo pavimento e la sua superficie. In 3D non si vede.'));
  panel.append(h('p', {}, 'Clicca su una parete, poi sull’altra parete di fronte: la linea si aggancia da sola. Doppio clic o Esc per finire.'));
  panel.append(h('div', { class: 'row' }, btn('Fine (Esc)', () => plan.finishWall())));
}

function panelOpeningTool() {
  panel.append(h('h2', {}, 'Porte e finestre'));
  panel.append(h('p', {}, 'Scegli il tipo e clicca su una parete.'));
  const box = h('div', { class: 'types' });
  for (const [k, v] of Object.entries(OPENING_TYPES)) {
    box.append(h('button', { type: 'button', class: k === openingType ? 'on' : '', onclick: () => { openingType = k; plan.setTool('opening', { type: k }); renderTools(); renderPanel(); } }, openingIcon(k), v.name));
  }
  panel.append(box);
}
function openingIcon(type) {
  const c = document.createElement('canvas'); c.width = 108; c.height = 80;
  const x = c.getContext('2d'); x.scale(2, 2);
  x.fillStyle = '#2f343b'; x.fillRect(2, 22, 12, 6); x.fillRect(42, 22, 12, 6);
  x.strokeStyle = '#2f343b'; x.lineWidth = 1.4;
  x.beginPath();
  if (type === 'door') { x.moveTo(14, 25); x.lineTo(14, 3); x.arc(14, 25, 22, -Math.PI / 2, 0); }
  else if (type === 'door2') { x.moveTo(14, 25); x.lineTo(14, 11); x.arc(14, 25, 14, -Math.PI / 2, 0); x.moveTo(42, 25); x.lineTo(42, 11); x.arc(42, 25, 14, -Math.PI / 2, Math.PI, true); }
  else if (type === 'slide') { x.lineWidth = 3; x.moveTo(4, 18); x.lineTo(30, 18); }
  else if (type === 'pocket') { x.stroke(); x.beginPath(); x.strokeStyle = '#e8590c'; x.lineWidth = 3; x.moveTo(4, 25); x.lineTo(24, 25); }
  else if (type === 'window' || type === 'french') { x.rect(14, 22, 28, 6); x.moveTo(14, 25); x.lineTo(42, 25); if (type === 'french') { x.moveTo(14, 22); x.arc(14, 22, 14, -Math.PI / 2, 0); } }
  else { x.setLineDash([3, 2]); x.moveTo(14, 25); x.lineTo(42, 25); }
  x.stroke();
  return c;
}

function panelWall(w) {
  const d = app.doc;
  const L = G.wallLength(d, w);
  if (w.virtual) {
    panel.append(h('h2', {}, 'Divisore di stanza'));
    panel.append(h('p', {}, 'Divide il pavimento in due stanze senza muro. Lunghezza ' + fmtCm(L) + ' cm.'));
    panel.append(h('div', { class: 'row' }, btn('Trasformalo in parete', () => { delete w.virtual; w.thickness = d.settings.wallThickness; commit('Parete'); }), btn('Elimina', deleteSel, 'danger')));
    return;
  }
  panel.append(h('h2', {}, 'Parete'));
  panel.append(numField('Lunghezza (asse)', L, setVal(v => stretchWall(w, v - L), 'Lunghezza parete'), { min: 5 }));
  const mode = h('select', {}, h('option', { value: 'stretch' }, 'sposta tutto ciò che c’è oltre'), h('option', { value: 'end' }, 'sposta solo l’estremo'), h('option', { value: 'scale' }, 'riscala tutta la pianta'));
  mode.value = stretchMode;
  mode.addEventListener('change', () => { stretchMode = mode.value; });
  panel.append(h('label', { class: 'field' }, h('span', {}, 'Allungando'), mode));
  panel.append(numField('Spessore', w.thickness, setVal(v => { w.thickness = v; }, 'Spessore'), { min: 2, max: 100 }));
  panel.append(numField('Altezza', w.height || d.settings.wallHeight, setVal(v => { w.height = v === d.settings.wallHeight ? null : v; }, 'Altezza parete'), { min: 10, max: 800 }));
  panel.append(h('p', {}, 'Un’altezza più bassa del resto fa un muretto (es. 100 cm per un parapetto o una penisola).'));
  const c = G.wallCorners(d).get(w.id);
  const rooms = roomsInfo();
  const sideName = side => { const r = rooms.find(f => f.edges.some(e => e.wall === w.id && e.side === side)); return r ? (r.label && r.label.name ? 'verso ' + r.label.name : 'verso la stanza (' + fmtM2(r.area) + ')') : 'esterno'; };
  for (const side of ['L', 'R']) {
    const len = side === 'L' ? G.dist(c.aL, c.bL) : G.dist(c.aR, c.bR);
    panel.append(h('h3', {}, `Lato ${sideName(side)} · ${fmtCm(len)} cm`));
    cladEditor(w.clad && w.clad[side], v => { w.clad = { ...(w.clad || {}), [side]: v }; commit('Rivestimento'); }, d.settings.wallHeight);
  }
  panel.append(h('div', { class: 'row' },
    btn('Dividi a metà', () => { const A = G.nodeById(d, w.a), B = G.nodeById(d, w.b); G.splitWall(d, w, G.mul(G.add(A, B), 0.5)); commit('Dividi parete'); }),
    btn('Rendi divisore', () => { w.virtual = true; w.thickness = 2; d.openings = d.openings.filter(o => o.wall !== w.id); commit('Divisore'); }),
    btn('Elimina', deleteSel, 'danger')));
}
let stretchMode = 'stretch';
/** Allunga (o accorcia) una parete di delta cm. In modalita' "stira" sposta tutto cio' che sta oltre l'estremo b. */
function stretchWall(w, delta, end = 'b') {
  const d = app.doc;
  if (stretchMode === 'scale') { const L0 = G.wallLength(d, w); scalePlan((L0 + delta) / L0); return; }
  const A = G.nodeById(d, end === 'b' ? w.a : w.b), B = G.nodeById(d, end === 'b' ? w.b : w.a);
  const dir = G.norm(G.sub(B, A));
  if (stretchMode === 'end') { B.x += dir.x * delta; B.y += dir.y * delta; return; }
  const sB = G.dot(G.sub(B, A), dir) - 0.5;
  const mv = p => { if (G.dot(G.sub(p, A), dir) >= sB) { p.x += dir.x * delta; p.y += dir.y * delta; } };
  for (const n of d.nodes) mv(n);
  for (const it of d.items) mv(it);
  for (const r of d.rooms) mv(r);
  for (const dm of d.dims) { mv(dm.a); mv(dm.b); }
}
function panelNode(n) {
  panel.append(h('h2', {}, 'Angolo'));
  panel.append(h('p', {}, 'Trascinalo per spostare le pareti collegate. Lasciandolo su un altro angolo o su una parete si uniscono.'));
  panel.append(h('div', { class: 'row' }, btn('Elimina con le sue pareti', deleteSel, 'danger')));
}

function panelOpening(o) {
  const d = app.doc, w = G.wallById(d, o.wall);
  const L = G.wallLength(d, w);
  panel.append(h('h2', {}, OPENING_TYPES[o.type].name));
  const sel = h('select', {});
  for (const [k, v] of Object.entries(OPENING_TYPES)) sel.append(h('option', { value: k }, v.name));
  sel.value = o.type;
  sel.addEventListener('change', () => { const def = OPENING_TYPES[sel.value]; o.type = sel.value; o.sill = def.sill; o.height = Math.min(def.height, d.settings.wallHeight - def.sill - 5); commit('Tipo apertura'); });
  panel.append(h('label', { class: 'field' }, h('span', {}, 'Tipo'), sel));
  panel.append(numField('Larghezza', o.width, setVal(v => { o.width = Math.min(v, L); o.pos = Math.max(o.width / 2, Math.min(L - o.width / 2, o.pos)); }, 'Larghezza'), { min: 20, max: 1000 }));
  panel.append(numField('Altezza', o.height, setVal(v => { o.height = v; }, 'Altezza'), { min: 20, max: 600 }));
  panel.append(numField('Da terra', o.sill || 0, setVal(v => { o.sill = v; }, 'Davanzale'), { min: 0, max: 400 }));
  // distanza dagli estremi del muro (filo interno)
  const c = G.wallCorners(d).get(w.id);
  const sa = Math.max(G.toLocal(c, c.aL).s, G.toLocal(c, c.aR).s), sb = Math.min(G.toLocal(c, c.bL).s, G.toLocal(c, c.bR).s);
  panel.append(numField('Dall’angolo a sinistra', o.pos - o.width / 2 - sa, setVal(v => { o.pos = sa + v + o.width / 2; }, 'Posizione'), { min: 0, max: L }));
  panel.append(numField('Dall’angolo a destra', sb - (o.pos + o.width / 2), setVal(v => { o.pos = sb - v - o.width / 2; }, 'Posizione'), { min: 0, max: L }));
  if (o.type === 'slide' || o.type === 'pocket') {
    panel.append(h('div', { class: 'row' },
      btn('Scorre dall’altra parte', () => { o.hinge = o.hinge === 'b' ? 'a' : 'b'; commit('Verso'); }),
      o.type === 'slide' ? btn('Anta sull’altro lato del muro', () => { o.swing = o.swing === 'R' ? 'L' : 'R'; commit('Lato anta'); }) : null));
    panel.append(rangeField('Quanto è aperta', Math.round((o.slide ?? (o.type === 'pocket' ? 0.85 : 0.6)) * 100), 0, 100, 5, (v, fin) => { o.slide = v / 100; plan.redraw(); if (fin) commit('Apertura'); }, v => v + '%'));
    if (o.type === 'pocket') {
      // nel muro serve spazio per l'anta, dal lato verso cui scorre
      const c2 = G.wallCorners(d).get(w.id);
      const room = o.hinge === 'b' ? Math.min(G.toLocal(c2, c2.bL).s, G.toLocal(c2, c2.bR).s) - (o.pos + o.width / 2) : (o.pos - o.width / 2) - Math.max(G.toLocal(c2, c2.aL).s, G.toLocal(c2, c2.aR).s);
      if (room < o.width) panel.append(h('div', { class: 'callout' }, `Da quel lato nel muro ci sono solo ${fmtCm(Math.max(0, room))} cm: per far sparire l’anta ne servono ${fmtCm(o.width)}. Fai scorrere dall’altra parte o sposta la porta.`));
    }
  }
  if (o.type === 'door' || o.type === 'door2' || o.type === 'french') {
    panel.append(h('div', { class: 'row' },
      btn('Apri dall’altro lato', () => { o.swing = o.swing === 'R' ? 'L' : 'R'; commit('Verso'); }),
      o.type === 'door' ? btn('Cerniera opposta', () => { o.hinge = o.hinge === 'b' ? 'a' : 'b'; commit('Cerniera'); }) : null));
  }
  if (o.type === 'door' || o.type === 'door2' || o.type === 'slide' || o.type === 'pocket' || o.type === 'french') {
    if (o.type === 'door' || o.type === 'door2') panel.append(rangeField('Apertura in 3D', o.open ?? 90, 0, 120, 5, (v, fin) => { o.open = v; if (fin) commit('Apertura'); }, v => v + '°'));
    panel.append(h('h3', {}, 'Colore'));
    panel.append(swatches(['#efebe3', '#ffffff', '#c9a274', '#7a5a3f', '#4a3a2c', '#3e4550', '#9aa7b3'], o.color || '#efebe3', setVal(c => { o.color = c; }, 'Colore porta')));
  } else if (o.type === 'window') {
    panel.append(h('h3', {}, 'Telaio'));
    panel.append(swatches(['#f4f4f2', '#c9a274', '#7a5a3f', '#3e4550', '#2b2b2b'], o.frameColor || '#f4f4f2', setVal(c => { o.frameColor = c; }, 'Colore telaio')));
  }
  panel.append(h('div', { class: 'row' }, btn('Elimina', deleteSel, 'danger')));
}

function itemPreviewCanvas(kind, wpx = 112, hpx = 88) {
  const c = document.createElement('canvas'); c.width = wpx; c.height = hpx;
  const x = c.getContext('2d');
  const cat = CATALOG[kind];
  const it = { kind, w: cat.w, d: cat.d, h: cat.h, color: cat.color, rot: 0 };
  const s = Math.min((wpx - 12) / it.w, (hpx - 12) / it.d);
  x.translate(wpx / 2, hpx / 2); x.scale(s, s);
  x.lineWidth = 1.6 / s; x.strokeStyle = '#4b5159'; x.fillStyle = '#fff'; x.lineJoin = 'round';
  try { cat.draw(x, it, s); } catch (e) { x.strokeRect(-it.w / 2, -it.d / 2, it.w, it.d); }
  return c;
}
function panelCatalog() {
  panel.append(h('h2', {}, 'Arredi'));
  panel.append(h('p', {}, app.view === '2d' ? 'Scegli un arredo e clicca nella pianta per posarlo. Vicino a un muro si gira e si appoggia da solo.' : 'Scegli un arredo: compare al centro della vista, poi trascinalo dove vuoi.'));
  for (const cat of CATEGORIES) {
    panel.append(h('h3', {}, cat));
    const g = h('div', { class: 'catalog' });
    for (const [k, v] of Object.entries(CATALOG)) {
      if (v.cat !== cat || v.hidden) continue;
      const th = itemThumb(k);
      g.append(h('button', { type: 'button', class: placeKind === k ? 'on' : '', onclick: () => chooseItem(k) }, th ? h('img', { src: th, alt: '', class: 'thumb' }) : itemPreviewCanvas(k), v.name));
    }
    panel.append(g);
  }
  panel.append(h('h3', {}, 'Modelli 3D'));
  panel.append(h('p', {}, 'Importa un mobile da un file OBJ, STL, GLB o GLTF (ad esempio scaricato da un catalogo online): viene semplificato e puoi ridimensionarlo.'));
  panel.append(h('div', { class: 'row' }, btn('Importa modello 3D…', () => $('#fileModel').click())));
  const ids = Object.keys(app.doc.models || {});
  if (ids.length) {
    const g = h('div', { class: 'list' });
    for (const id of ids) g.append(h('div', { class: 'it', onclick: () => chooseItem('modello', id) }, h('span', {}, app.doc.models[id].name), h('span', {}, '+')));
    panel.append(g);
  }
}
let placeModel = null;
function chooseItem(kind, modelId = null) {
  placeKind = kind; placeModel = modelId;
  if (app.view === '2d') { curTool = 'place'; plan.setTool('place'); renderTools(); renderPanel(); setHint(); return; }
  // 3D: al centro della vista, sul pavimento
  const t = view.mode === 'orbit' ? view.controls.target : view.camera.position.clone().add(view.camera.getWorldDirection(new view.camera.position.constructor()).multiplyScalar(2));
  const it = placeItemAt({ x: t.x * 100, y: t.z * 100 });
  const s = plan.snapItemToWall(it, { x: it.x, y: it.y });
  if (s) Object.assign(it, s);
  placeKind = null;
  panelMode = null;
  commit('Aggiungi arredo');
  setSel({ type: 'item', id: it.id });
}
function previewItem(p) {
  if (!placeKind) return null;
  const it = newItem(placeKind, p.x, p.y);
  if (placeKind === 'modello') applyModelSize(it, placeModel);
  return it;
}
function placeItemAt(p) {
  if (!placeKind) return null;
  const it = previewItem(p);
  if (placeKind === 'modello') it.model = placeModel;
  app.doc.items.push(it);
  return it;
}
function applyModelSize(it, id) {
  const m = app.doc.models[id];
  if (!m) return;
  it.w = m.size[0]; it.h = m.size[1]; it.d = m.size[2]; it.lock = true;
  if (m.single) it.color = m.single;
}

function backToCatalog() {
  app.sel = null; view.selectionChanged(); plan.redraw();
  if (app.view === '2d') { curTool = 'place'; placeKind = null; plan.setTool('select'); renderTools(); setHint(); }
  else panelMode = 'catalog';
  renderPanel();
}
function panelItem(it) {
  const cat = CATALOG[it.kind] || CATALOG.scatola;
  const model = it.kind === 'modello' ? app.doc.models[it.model] : null;
  if (app.view !== 'render') panel.append(h('button', { type: 'button', class: 'btn ghost back', onclick: backToCatalog }, '← Arredi'));
  panel.append(h('h2', {}, model ? model.name : cat.name));
  const lock = !!it.lock;
  const setDim = (k) => setVal(v => {
    if (lock && it[k] > 0) { const f = v / it[k]; it.w *= f; it.d *= f; it.h *= f; it[k] = v; } else it[k] = v;
  }, 'Misure');
  const nums = h('div', { class: 'nums' });
  for (const [k, lab] of [['w', 'Larghezza'], ['d', 'Profondità'], ['h', 'Altezza']]) {
    const inp = h('input', { type: 'number', value: Math.round(it[k] * 10) / 10, min: 1, step: 1, inputmode: 'decimal' });
    inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (v > 0) setDim(k)(v); });
    nums.append(h('label', {}, lab, inp));
  }
  panel.append(nums);
  panel.append(checkField('Mantieni le proporzioni', lock, setVal(v => { it.lock = v; }, 'Proporzioni')));
  if (cat.bases) {
    const NAMES = { legs: 'Con piedini', floor: 'A terra', wall: 'Sospeso', hung: 'Sospeso', hungcab: 'Mobile sospeso', floorcab: 'Mobile a terra' };
    if (it.kind === 'lavabo') NAMES.hung = 'Solo lavabo sospeso';
    panel.append(h('h3', {}, 'Base'));
    panel.append(h('div', { class: 'row' }, ...cat.bases.map(b => btn(NAMES[b], () => {
      const was = it.base;
      it.base = b;
      if (b === 'wall' && !(it.elev > 0)) it.elev = cat.wallElev || 30;
      if (was === 'wall' && b !== 'wall') it.elev = 0;
      commit('Base');
    }, (it.base || cat.bases[0]) === b ? 'on' : ''))));
  }
  if (cat.params) {
    panel.append(h('h3', {}, it.kind === 'armadioPonte' ? 'Vano del ponte' : 'Ante'));
    for (const pdef of cat.params) panel.append(numField(pdef.label, it[pdef.key] ?? pdef.def, setVal(v => { it[pdef.key] = Math.round(v); }, pdef.label), { unit: pdef.unit ?? 'cm', min: pdef.min, max: pdef.max }));
    if (it.kind === 'armadioPonte') panel.append(h('p', {}, 'Le colonne ai lati sono alte e profonde come l’armadio; il ponte sopra il vano resta appoggiato al muro. Metti il letto nel vano.'));
  }
  if (it.kind === 'mobileTV' || it.kind === 'mobileBasso') panel.append(checkField('Con televisore', it.tv !== false, setVal(v => { it.tv = v; }, 'Televisore')));
  if (cat.light !== 'ceiling') panel.append(numField(it.base === 'wall' ? 'Da terra (sospeso)' : 'Da terra', it.elev || 0, setVal(v => { it.elev = v; }, 'Altezza da terra'), { min: 0, max: 400 }));
  panel.append(numField('Rotazione', it.rot, setVal(v => { it.rot = ((v % 360) + 360) % 360; }, 'Ruota'), { unit: '°', min: -360, max: 720 }));
  panel.append(h('div', { class: 'row' }, btn('↺ 90°', () => { it.rot = (it.rot + 270) % 360; commit('Ruota'); }), btn('↻ 90°', () => { it.rot = (it.rot + 90) % 360; commit('Ruota'); })));
  if (model && model.col && !model.single) {
    panel.append(h('h3', {}, 'Colore'));
    panel.append(h('div', { class: 'row' }, btn('Colori del file', () => { it.paint = false; commit('Colore modello'); }, !it.paint ? 'on' : ''), btn('Tinta unica', () => { it.paint = true; commit('Colore modello'); }, it.paint ? 'on' : '')));
    if (it.paint) panel.append(finishes(it.color, setVal(c => { it.color = c; }, 'Colore')));
  }
  if (model) panel.append(checkField('È una lampada (fa luce)', !!it.glow, setVal(v => { it.glow = v; if (v && it.on === undefined) Object.assign(it, { on: true, power: 1, lightColor: '#ffd9a8' }); }, 'Lampada')));
  if (isLamp(it)) {
    panel.append(h('h3', {}, 'Luce'));
    panel.append(checkField('Accesa', it.on !== false, setVal(v => { it.on = v; }, 'Accendi')));
    panel.append(rangeField('Intensità', it.power ?? 1, 0.1, 5, 0.1, (v, fin) => { it.power = v; if (fin) commit('Intensità luce'); }, v => v.toFixed(1).replace('.', ',') + '×'));
    panel.append(h('p', {}, 'Colore della luce'));
    panel.append(swatches(['#ffc88a', '#ffd9a8', '#fff1dc', '#ffffff', '#dfeaff', '#b8d4ff'], it.lightColor || '#ffd9a8', setVal(c => { it.lightColor = c; }, 'Colore luce')));
    panel.append(h('p', {}, 'Le lampade si vedono accese con l’illuminazione «Sera» o «Tramonto», oppure con «Lampade accese» nel pannello del render.'));
  }
  if (!model || model.single || !model.col) {
    panel.append(h('h3', {}, 'Colore e finitura'));
    panel.append(finishes(it.color, setVal(c => { it.color = c; }, 'Colore')));
  }
  if (it.color2 != null) {
    panel.append(h('h3', {}, it.kind.startsWith('letto') ? 'Struttura' : it.kind === 'quadro' ? 'Dipinto' : 'Piano'));
    panel.append(finishes(it.color2, setVal(c => { it.color2 = c; }, 'Colore')));
  }
  if (model) {
    panel.append(h('h3', {}, 'Raddrizza il modello'));
    panel.append(h('div', { class: 'row' }, ...['x', 'y', 'z'].map(a => btn('Gira su ' + a.toUpperCase(), () => rotateModel(it, a)))));
  }
  panel.append(h('div', { class: 'row' }, btn('Duplica', duplicateSel), btn('Elimina', deleteSel, 'danger')));
}

function panelRoom(r) {
  const info = roomsInfo().find(f => f.label === r || (f.label && f.label.id === r.id));
  panel.append(h('h2', {}, 'Stanza'));
  const name = h('input', { type: 'text', value: r.name || '', list: 'roomNames', placeholder: 'Nome della stanza (es. Cucina)', class: 'wide', id: 'roomName' });
  name.addEventListener('change', () => { r.name = name.value.trim(); commit('Nome stanza'); });
  const dl = h('datalist', { id: 'roomNames' }, ...['Soggiorno', 'Cucina', 'Soggiorno con cucina', 'Sala da pranzo', 'Camera', 'Camera matrimoniale', 'Cameretta', 'Studio', 'Bagno', 'Lavanderia', 'Ingresso', 'Disimpegno', 'Corridoio', 'Ripostiglio', 'Cabina armadio', 'Balcone', 'Terrazzo', 'Garage', 'Cantina'].map(n => h('option', { value: n })));
  panel.append(h('div', { class: 'row' }, name, dl));
  if (info) {
    let per = 0; for (let i = 0; i < info.inner.length; i++) per += G.dist(info.inner[i], info.inner[(i + 1) % info.inner.length]);
    panel.append(h('p', {}, `Superficie ${fmtM2(info.area)} · perimetro ${fmtCm(per / 100)} m · volume ${(info.area * app.doc.settings.wallHeight / 100).toFixed(1).replace('.', ',')} m³`));
  } else panel.append(h('div', { class: 'callout' }, 'Questa etichetta non è dentro una stanza chiusa: trascinala dentro una stanza o chiudi le pareti.'));
  panel.append(h('h3', {}, 'Pavimento'));
  panel.append(floorPicker(r.floor || 'parquet', k => { r.floor = k; commit('Pavimento'); }));
  if (isCustomFloor(r.floor)) {
    const t = app.doc.textures[r.floor.slice(4)];
    if (t) {
      panel.append(numField('Larghezza dell’immagine', t.size, setVal(v => { t.size = v; setCustomFloors(app.doc.textures); }, 'Scala pavimento'), { min: 5, max: 1000 }));
      const lay = h('select', {}, ...Object.entries(LAYOUTS).map(([k, n]) => h('option', { value: k }, n)));
      lay.value = t.layout || 'dritta';
      lay.addEventListener('change', () => { t.layout = lay.value; setCustomFloors(app.doc.textures); commit('Posa pavimento'); });
      panel.append(h('label', { class: 'field' }, h('span', {}, 'Posa'), lay));
      const rot = h('select', {}, ...[0, 45, 90, 135].map(a => h('option', { value: a }, a + '°')));
      rot.value = String(t.rot || 0);
      rot.addEventListener('change', () => { t.rot = +rot.value; setCustomFloors(app.doc.textures); commit('Rotazione pavimento'); });
      panel.append(h('label', { class: 'field' }, h('span', {}, 'Rotazione'), rot));
      panel.append(h('p', {}, 'Posa e misure valgono per questa immagine in tutte le stanze dove la usi.'));
    }
  }
  panel.append(h('h3', {}, 'Pareti'));
  panel.append(swatches(WALL_COLORS, r.wallColor || '#f4f1ea', setVal(c => { r.wallColor = c; }, 'Colore pareti')));
  if (info) {
    panel.append(h('h3', {}, 'Rivestimento di tutte le pareti'));
    const edges = info.edges.filter(e => { const w2 = G.wallById(app.doc, e.wall); return w2 && !w2.virtual; });
    const first = edges.map(e => { const w2 = G.wallById(app.doc, e.wall); return w2.clad && w2.clad[e.side]; })[0];
    cladEditor(first, v => { for (const e of edges) { const w2 = G.wallById(app.doc, e.wall); w2.clad = { ...(w2.clad || {}), [e.side]: v }; } commit('Rivestimento stanza'); }, app.doc.settings.wallHeight);
    panel.append(h('p', {}, 'Per una sola parete: selezionala e imposta il rivestimento del lato che guarda questa stanza.'));
  }
  panel.append(h('h3', {}, 'Soffitto'));
  panel.append(swatches(['#f7f5f0', '#ffffff', '#e8e2d6', '#c9d3d8', '#3e4550'], r.ceilColor || '#f7f5f0', setVal(c => { r.ceilColor = c; }, 'Colore soffitto')));
  panel.append(h('div', { class: 'row' },
    btn('Guardala in 3D', () => { setView('3d'); view.setMode('walk'); renderTools(); updateWalkpad(); setHint(); }),
    btn('Togli etichetta', deleteSel, 'danger')));
}

function panelDim(dm) {
  const L = G.dist(dm.a, dm.b);
  panel.append(h('h2', {}, 'Quota'));
  panel.append(numField('Lunghezza', L, setVal(v => { const dir = G.norm(G.sub(dm.b, dm.a)); dm.b = G.add(dm.a, G.mul(dir, v)); }, 'Quota'), { min: 1 }));
  panel.append(h('p', {}, 'Cambiare questo numero sposta solo la quota, non le pareti. Per cambiare una parete fai doppio clic sulla sua misura.'));
  panel.append(h('div', { class: 'row' }, btn('Elimina', deleteSel, 'danger')));
}

/** Sezione «Illuminazione»: preset, sole, lampade, luce diffusa ed esposizione (vista 3D e render). */
function lightSection(live) {
  const L = view.light, Rl = resolveLight({ ...L, north: app.doc.settings.north || 0, lat: app.doc.settings.lat ?? 45 });
  const set = (o, fin) => { Object.assign(L, o); if (fin !== false || live) view.setLight({}); };
  panel.append(h('h3', {}, 'Illuminazione'));
  const pr = h('div', { class: 'presets' });
  for (const [k, P] of Object.entries(LIGHT_PRESETS)) pr.append(h('button', { type: 'button', class: 'btn' + (L.preset === k ? ' on' : ''), title: P.hint, onclick: () => { L.preset = k; if (typeof P.time === 'number') L.time = P.time; if (P.night) L.time = 21.5; L.fillScale = 1; L.expScale = 1; view.setLight({}); renderTools(); renderPanel(); } }, P.name));
  panel.append(pr);
  panel.append(h('p', {}, (LIGHT_PRESETS[L.preset] || LIGHT_PRESETS.auto).hint + '.'));
  if (!(LIGHT_PRESETS[L.preset] || {}).noSun && L.preset !== 'tramonto' && L.preset !== 'sera') {
    panel.append(rangeField('Ora del giorno', L.time ?? 11, 5, 22, 0.25, (v, fin) => set({ time: v }, fin), fmtTime));
  }
  const mo = h('select', {}, ...['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'].map((n, i) => h('option', { value: i + 1 }, n)));
  mo.value = String(L.month || 6);
  mo.addEventListener('change', () => { set({ month: +mo.value }); renderPanel(); });
  panel.append(h('label', { class: 'field' }, h('span', {}, 'Mese'), mo));
  if (Rl.day && Rl.sun > 0) panel.append(h('p', {}, `Sole a ${Math.round(Rl.sunEl)}° sull’orizzonte, da ${['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ovest', 'ovest', 'nord-ovest'][Math.round(((Rl.sunAz - (app.doc.settings.north || 0) + 360) % 360) / 45) % 8]}. Il nord della casa si imposta nel pannello «Casa» della pianta.`));
  else if (!Rl.day) panel.append(h('p', {}, 'A quest’ora il sole è tramontato: la luce viene dalle lampade.'));
  panel.append(rangeField('Luce diffusa nella stanza', L.fillScale ?? 1, 0, 3, 0.1, (v, fin) => set({ fillScale: v }, fin), v => v.toFixed(1).replace('.', ',') + '×'));
  panel.append(checkField('Lampade accese', Rl.lampsOn, v => { set({ lampsDay: v && !(LIGHT_PRESETS[L.preset] || {}).lamps }); if (!v && (LIGHT_PRESETS[L.preset] || {}).lamps) toast('Con questo preset le lampade sono accese: puoi spegnerle una per una nel pannello della lampada'); renderPanel(); }));
  if (Rl.lampsOn) panel.append(rangeField('Potenza di tutte le lampade', L.lamps ?? 1, 0.2, 4, 0.1, (v, fin) => set({ lamps: v }, fin), v => v.toFixed(1).replace('.', ',') + '×'));
  panel.append(rangeField('Esposizione', L.expScale ?? 1, 0.3, 3, 0.05, (v, fin) => set({ expScale: v }, fin), v => v.toFixed(2).replace('.', ',') + '×'));
}

function panel3D() {
  panel.append(h('h2', {}, 'Vista 3D'));
  panel.append(h('p', {}, 'Clicca un arredo per selezionarlo e trascinalo sul pavimento; una parete o un pavimento per cambiarne i colori. Con «Cammina» guardi la casa dall’altezza degli occhi.'));
  lightSection(true);
  panel.append(numField('Altezza occhi', app.doc.settings.eye || 160, setVal(v => { app.doc.settings.eye = v; if (view.mode === 'walk') view.camera.position.y = v / 100; }, 'Altezza occhi'), { min: 50, max: 250 }));
  panel.append(h('h3', {}, 'Render'));
  panel.append(h('p', {}, 'Metti la vista dove ti piace (ad esempio con «Cammina» dentro una stanza) e passa a «Render» per l’immagine fotorealistica.'));
  panel.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => setView('render') }, 'Render da questa vista')));
}

function panelRender() {
  panel.append(h('h2', {}, 'Render'));
  const R = renderOpts;
  const restart = () => view.startTrace(R);
  // stile: fotorealistico (path tracing) oppure istantanei
  const styles = [['pt', 'Fotorealistico'], ['raster', 'Veloce'], ['sketch', 'Schizzo']];
  panel.append(h('div', { class: 'row' }, ...styles.map(([k, n]) => btn(n, () => { R.style = k; restart(); renderPanel(); }, R.style === k ? 'on' : ''))));
  panel.append(h('p', {}, R.style === 'pt' ? 'Luce vera, riflessi e ombre morbide: l’immagine si pulisce a ogni passaggio e alla fine un filtro toglie il rumore. Puoi ancora girare la vista: il calcolo riparte.'
    : R.style === 'raster' ? 'Immagine immediata con ombre del sole e luce d’ambiente: meno realistica, ma pronta subito anche mentre ti muovi.'
      : 'Disegno a contorni su modello bianco, pronto subito: utile per presentare gli spazi.'));
  if (R.style === 'pt') {
    panel.append(h('h3', {}, 'Velocità e qualità'));
    const P = { rapida: [16, 3, 0.5], bozza: [32, 4, 0.75], buona: [96, 6, 1], alta: [300, 8, 1], continua: [0, 8, 1] };
    const names = { rapida: 'Rapida', bozza: 'Bozza', buona: 'Buona', alta: 'Alta', continua: 'Senza fine' };
    panel.append(h('div', { class: 'row' }, ...Object.keys(P).map(k => btn(names[k], () => { [R.samples, R.bounces, R.scale] = P[k]; restart(); renderPanel(); }, P[k][0] === R.samples && P[k][1] === R.bounces && P[k][2] === R.scale ? 'on' : ''))));
    panel.append(numField('Passaggi', R.samples, v => { R.samples = Math.round(v); restart(); renderPanel(); }, { unit: '', min: 0, max: 5000 }));
    panel.append(rangeField('Rimbalzi della luce', R.bounces, 1, 12, 1, (v, fin) => { if (fin) { R.bounces = v; restart(); } }, v => v));
    const rs = h('select', {}, ...[['0.25', '25%'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100%']].map(([v, n]) => h('option', { value: v }, n)));
    rs.value = String(R.scale);
    rs.addEventListener('change', () => { R.scale = +rs.value; restart(); });
    panel.append(h('label', { class: 'field' }, h('span', {}, 'Risoluzione'), rs));
    if (view.gpuOk !== false) panel.append(checkField('Togli il rumore alla fine', R.denoise, v => { R.denoise = v; lsSet('pianta.noDenoise', v ? null : '1'); restart(); }));
    panel.append(h('p', {}, 'Più veloce: meno passaggi, meno rimbalzi (2–3 bastano per una bozza), risoluzione più bassa. «Passaggi» a 0 = continua finché non cambi vista.'));
    panel.append(h('p', { class: 'engine' }, view.useGpu ? 'Motore: WebGPU (veloce).' : view.gpuOk === false ? 'Motore: WebGL compatibile, più lento — ' + (view.gpuWhy || 'WebGPU non disponibile') + '.' : ''));
  }
  if (R.style !== 'sketch') lightSection(R.style !== 'pt');
  panel.append(h('div', { class: 'row' }, btn('Cammina', () => { view.setMode('walk'); updateWalkpad(); renderTools(); }), btn('Orbita', () => { view.setMode('orbit'); updateWalkpad(); renderTools(); })));
}

// ---------- foto della planimetria ----------
let ocrResult = null;
function panelPhoto() {
  const d = app.doc, bg = d.background;
  panel.append(h('h2', {}, 'Planimetria da foto'));
  if (!bg) {
    panel.append(h('p', {}, 'Carica una foto o uno screenshot della planimetria. Se la fotografi, tienila più dritta possibile: poi puoi raddrizzarla qui.'));
    panel.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => $('#fileImg').click() }, 'Carica foto…')));
    panel.append(h('p', {}, 'Dopo il caricamento: 1) raddrizzala se serve, 2) leggi le quote o fai la taratura con una misura nota, 3) ricalca i muri con lo strumento Pareti, che si aggancia da solo al centro dei muri disegnati.'));
    return;
  }
  const modeBtn = (m, label) => btn(label, () => { photo.setMode(photo.mode === m ? 'move' : m); renderPanel(); setHint(); }, photo.mode === m ? 'on' : '');
  panel.append(h('h3', {}, '1 · Raddrizza'));
  if (photo.mode === 'persp') {
    panel.append(h('p', {}, 'Trascina i 4 cerchi sugli angoli della pianta (o di un rettangolo che nella realtà è dritto).'));
    panel.append(h('div', { class: 'row' }, btn('Annulla', () => { photo.setMode('move'); renderPanel(); setHint(); }), h('button', { type: 'button', class: 'primary', onclick: applyPerspective }, 'Applica')));
  } else panel.append(h('div', { class: 'row' }, btn('Raddrizza da sola', () => straightenPhoto(true)), modeBtn('persp', 'Raddrizza prospettiva')));
  panel.append(h('div', { class: 'row' },
    btn('↺ 90°', () => { bg.rot = (bg.rot + 270) % 360; commit('Ruota foto'); }),
    btn('↻ 90°', () => { bg.rot = (bg.rot + 90) % 360; commit('Ruota foto'); })));
  panel.append(rangeField('Rotazione fine', ((bg.rot + 180) % 360) - 180, -15, 15, 0.1, (v, fin) => { bg.rot = (Math.round(bg.rot / 90) * 90 + v + 360) % 360; plan.redraw(); if (fin) commit('Ruota foto'); }, v => v.toFixed(1).replace('.', ',') + '°'));

  panel.append(h('h3', {}, '2 · Scala'));
  panel.append(h('p', {}, `Ora 1 pixel della foto = ${bg.k.toFixed(3).replace('.', ',')} cm${bg.calibrated ? '' : ' (non ancora tarata)'}.`));
  panel.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: runOCR }, 'Leggi le quote dalla foto'), modeBtn('calib', 'Taratura a mano')));
  if (ocrResult) {
    const box = h('div', { class: 'ocr' });
    if (ocrResult.k) {
      box.append(h('div', { class: 'callout' }, `Scala trovata con ${ocrResult.used.length} ${ocrResult.used.length === 1 ? 'quota' : 'quote coerenti'}: 1 px = ${ocrResult.k.toFixed(3).replace('.', ',')} cm. Le quote usate sono in verde sulla foto.`));
      box.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => { photo.setScale(ocrResult.k, plan.toPlan(plan.W / 2, plan.H / 2)); bg.calibrated = true; ocrResult = null; photo.setMode('move'); commit('Scala dalle quote'); plan.fit(); toast('Foto in scala: ora ricalca i muri con «Pareti»'); } }, 'Usa questa scala'), btn('Ignora', () => { ocrResult = null; photo.setMode('move'); renderPanel(); })));
    } else box.append(h('div', { class: 'callout' }, 'Non ho trovato quote leggibili abbinate a una linea. Usa la taratura a mano: clicca gli estremi di una quota e scrivi la misura.'));
    for (const f of ocrResult.all) box.append(h('div', { class: 'it' }, h('span', {}, `«${f.text}» → ${fmtCm(f.cm)} cm`), h('span', { class: f.ok ? 'ok' : 'no' }, f.ok ? '✓ usata' : f.frac ? 'porta/finestra' : f.k ? 'scartata' : 'senza linea')));
    panel.append(box);
  }
  panel.append(h('h3', {}, '3 · Pareti'));
  panel.append(h('p', {}, 'Trova da sola le pareti orizzontali e verticali (disegnate con due linee o piene) e le porte nei muri interni. Poi controlla: cancella o correggi quelle sbagliate e completa le altre con «Pareti».'));
  panel.append(h('div', { class: 'row' }, h('button', { type: 'button', class: bg.calibrated ? 'primary' : 'btn', onclick: runDetect }, 'Rileva le pareti'), btn('Disegna a mano', () => pickTool('wall'))));
  panel.append(checkField('Aggancia ai muri della foto', bg.snap, setVal(v => { bg.snap = v; }, 'Aggancio foto')));
  panel.append(h('h3', {}, 'Foto'));
  panel.append(rangeField('Trasparenza', bg.opacity, 0.1, 1, 0.05, (v, fin) => { bg.opacity = v; plan.redraw(); if (fin) commit('Trasparenza'); }, v => Math.round(v * 100) + '%'));
  panel.append(checkField('Mostra la foto', bg.visible, setVal(v => { bg.visible = v; }, 'Mostra foto')));
  panel.append(h('div', { class: 'row' }, modeBtn('move', 'Sposta foto'), btn('Cambia foto…', () => $('#fileImg').click()), btn('Togli', () => { app.doc.background = null; photo.setMode(null); photo.refresh(); commit('Togli foto'); }, 'danger')));
}
$('#fileImg').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    busy('Carico la foto…');
    const r = await fileToDataURL(f);
    const c = plan.toPlan(plan.W / 2, plan.H / 2);
    const prev = app.doc.background;
    app.doc.background = { sid: G.newId('b'), src: r.src, w: r.w, h: r.h, cx: c.x, cy: c.y, k: prev ? prev.k : 1200 / Math.max(r.w, r.h), rot: 0, opacity: 0.6, visible: true, snap: true, calibrated: false };
    ocrResult = null;
    busy('Raddrizzo la foto…');
    await straightenPhoto(false);
    await photo.refresh();
    photo.setMode('move');
    commit('Foto');
    plan.fit();
  } catch (err) { toast(err.message); } finally { busy(null); }
});
/** Raddrizza la foto se il disegno e' un po' storto (fino a 6°). */
async function straightenPhoto(manual) {
  const bg = app.doc.background;
  if (!bg) return;
  try {
    if (manual) busy('Misuro l’inclinazione…');
    const map = await darkMap(bg.src);
    const ang = skewAngle(map);
    if (Math.abs(ang) < 0.1) { if (manual) toast('La foto è già dritta'); return; }
    const r = await rotateImage(bg.src, ang, loadImage);
    Object.assign(bg, { sid: G.newId('b'), src: r.src, w: r.w, h: r.h });
    if (manual) { await photo.refresh(); commit('Raddrizza foto'); }
    toast(`Foto raddrizzata di ${Math.abs(ang).toFixed(1).replace('.', ',')}°`);
  } catch (e) { console.warn(e); if (manual) toast('Non riuscito: ' + e.message); } finally { if (manual) busy(null); }
}

function choose(title, text, options) {
  return new Promise(resolve => {
    let done = false;
    modal(`<h2>${esc(title)}</h2><p class="note">${esc(text)}</p><div class="conflict">${options.map(([k, l, s]) => `<button class="btn" data-c="${k}"><b>${esc(l)}</b><small>${esc(s)}</small></button>`).join('')}</div>`, (el, close) => {
      el.addEventListener('click', e => { const b = e.target.closest('[data-c]'); if (b) { done = true; close(); resolve(b.dataset.c); } });
    });
    onModalClosed(() => { if (!done) resolve(null); });
  });
}

/** Collega gli estremi liberi al muro o all'estremo piu' vicino (entro meta' spessore + 8 cm). */
function weldLooseEnds(d) {
  for (let pass = 0; pass < 2; pass++) {
    for (const n of d.nodes.slice()) {
      if (!d.nodes.includes(n) || G.degree(d, n.id) !== 1) continue;
      const own = d.walls.find(w => w.a === n.id || w.b === n.id);
      let best = null;
      for (const m of d.nodes) {
        if (m === n) continue;
        const dd = G.dist(m, n);
        if (dd <= own.thickness / 2 + 15 && (!best || dd < best.d) && !d.walls.some(w => (w.a === n.id && w.b === m.id) || (w.b === n.id && w.a === m.id))) best = { d: dd, p: { x: m.x, y: m.y } };
      }
      for (const w of d.walls) {
        if (w === own || w.a === n.id || w.b === n.id) continue;
        const pr = G.projSeg(n, G.nodeById(d, w.a), G.nodeById(d, w.b));
        if (pr.d <= w.thickness / 2 + 8 && (!best || pr.d < best.d - 2)) best = { d: pr.d, p: pr.p };
      }
      if (!best) continue;
      n.x = best.p.x; n.y = best.p.y;
      plan._mergeNode(n);
    }
  }
}

/** Pareti (e porte) riconosciute nella foto, aggiunte come un'unica modifica annullabile. */
async function runDetect() {
  const d = app.doc, bg = d.background;
  if (!bg) return;
  if (!bg.calibrated) {
    const c = await choose('La foto non è ancora in scala', 'Le pareti prenderebbero misure sbagliate. Prima leggi le quote o fai la taratura a mano.', [['no', 'Prima metto in scala', 'torno al passo 2'], ['si', 'Rileva lo stesso', 'le misure andranno corrette']]);
    if (c !== 'si') return;
  }
  let mode = 'add';
  if (d.walls.length) {
    mode = await choose('Ci sono già delle pareti', 'Cosa faccio con quelle disegnate finora?', [['replace', 'Sostituiscile', 'tolgo pareti, porte e finestre attuali'], ['add', 'Aggiungi le nuove', 'tengo quelle che ci sono']]);
    if (!mode) return;
  }
  try {
    busy('Cerco le pareti…');
    await new Promise(r => setTimeout(r, 30));
    if (!photo.map) photo.map = await darkMap(bg.src);
    const res = detectWalls(photo.map, bg.k);
    if (!res.walls.length) { toast('Non ho trovato pareti: prova a disegnarle con «Pareti»'); return; }
    if (mode === 'replace') { d.walls = []; d.nodes = []; d.openings = []; }
    for (const w of res.walls) {
      const a = photo.toPlan(w.x0, w.y0), b = photo.toPlan(w.x1, w.y1);
      G.addWall(d, a, b, { thickness: Math.max(5, Math.round(w.t * bg.k)) });
    }
    weldLooseEnds(d);
    G.cleanup(d);
    let nd = 0;
    for (const o of res.doors) {
      const p = photo.toPlan(o.x, o.y);
      if (addOpeningAt(d, p, 'door', { width: Math.max(60, Math.min(120, o.width)) })) nd++;
    }
    curTool = 'select'; plan.setTool('select'); photo.setMode(null);
    commit('Pareti dalla foto');
    renderTools(); setHint();
    toast(`Trovate ${res.walls.length} pareti${nd ? ' e ' + nd + ' porte' : ''}: controlla e correggi (Ctrl+Z per annullare tutto)`);
  } catch (e) { console.error(e); toast('Rilevamento non riuscito: ' + e.message); } finally { busy(null); }
}

async function applyPerspective() {
  const bg = app.doc.background;
  try {
    busy('Raddrizzo la foto…');
    await new Promise(r => setTimeout(r, 30));
    const r = await warpPerspective(bg.src, photo.quad);
    // il nuovo centro resta dov'era il centro del quadrilatero
    const q = photo.quad, cu = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cv = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const c = photo.toPlan(cu, cv);
    Object.assign(bg, { sid: G.newId('b'), src: r.src, w: r.w, h: r.h, cx: c.x, cy: c.y, calibrated: false });
    await photo.refresh();
    photo.setMode('move');
    commit('Raddrizza foto');
    plan.fit();
  } catch (e) { toast('Non riuscito: ' + e.message); } finally { busy(null); }
}
async function runOCR() {
  const bg = app.doc.background;
  if (!photo.map) { toast('Un attimo: sto ancora analizzando la foto'); return; }
  try {
    busy('Scarico il lettore di testo (solo la prima volta)…');
    ocrResult = await ocrScale(bg.src, photo.map, (st, p) => busy(ocrStatus(st) + (p ? ' ' + Math.round(p * 100) + '%' : '')));
    photo.ocr = ocrResult;
    photo.setMode('ocr');
  } catch (e) { console.error(e); toast('Lettura non riuscita: ' + (e.message || e)); ocrResult = null; } finally { busy(null); renderPanel(); }
}
function ocrStatus(s) {
  return ({ 'loading tesseract core': 'Carico il lettore…', 'initializing tesseract': 'Avvio il lettore…', 'loading language traineddata': 'Scarico i dati per le cifre…', 'initializing api': 'Avvio…', 'recognizing text': 'Leggo le quote…', 'quote orizzontali': 'Leggo le quote orizzontali…', 'quote verticali': 'Leggo le quote verticali…' })[s] || s;
}
async function askCalibration(a, b) {
  const v = await promptText('Quanto misura questo tratto nella realtà?', '', 'Imposta scala', 'es. 345 (cm) o 3,45 m');
  photo.calib = [];
  if (v == null) { plan.redraw(); return; }
  const cm = parseLen(v);
  if (!cm) { toast('Misura non valida'); return; }
  photo.applyScale(a, b, cm);
  app.doc.background.calibrated = true;
  photo.setMode('move');
  commit('Taratura foto');
  toast('Foto in scala: ora ricalca i muri con «Pareti»');
}

// ---------- modelli importati ----------
const geoCache = new Map();
function modelGeos() {
  const out = new Map();
  for (const [id, rec] of Object.entries(app.doc.models || {})) {
    const key = id + ':' + (rec.v || 0);
    if (!geoCache.has(key)) { try { geoCache.set(key, MD.geometryFromRecord(rec)); } catch (e) { console.warn(e); continue; } }
    out.set(id, geoCache.get(key));
  }
  return out;
}
$('#fileModel').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    busy('Leggo il modello…');
    await new Promise(r => setTimeout(r, 30));
    let { tris, cols } = await MD.readModelFile(f);
    const n0 = tris.length / 9;
    ({ tris, cols } = MD.simplify(tris, cols));
    const { size } = MD.normalize(tris);
    const mx = Math.max(...size);
    const u = mx < 12 ? 100 : mx > 800 ? 0.1 : 1; // metri, millimetri o centimetri
    const single = MD.singleColor(cols) ? '#' + [cols[0], cols[1], cols[2]].map(v => v.toString(16).padStart(2, '0')).join('') : null;
    const id = G.newId('m');
    app.doc.models[id] = { name: f.name.replace(/\.[^.]+$/, ''), pos: MD.f32ToB64(tris), col: single ? null : MD.u8ToB64(cols), single, size: size.map(s => Math.max(2, Math.round(s * u))), v: 1 };
    toast(n0 > tris.length / 9 ? `Modello semplificato: ${n0.toLocaleString('it-IT')} → ${(tris.length / 9).toLocaleString('it-IT')} triangoli` : 'Modello importato');
    chooseItem('modello', id);
  } catch (err) { console.error(err); toast('Import non riuscito: ' + err.message); } finally { busy(null); }
});
function rotateModel(it, axis) {
  const m = app.doc.models[it.model];
  const tris = MD.b64ToF32(m.pos).slice();
  MD.rotate90(tris, axis);
  m.pos = MD.f32ToB64(tris);
  m.v = (m.v || 0) + 1;
  const [w, hh, d] = [it.w, it.h, it.d];
  if (axis === 'x') { it.h = d; it.d = hh; } else if (axis === 'y') { it.w = d; it.d = w; } else { it.w = hh; it.h = w; }
  m.size = [it.w, it.h, it.d];
  commit('Raddrizza modello');
}
function purgeModels() {
  const used = new Set(app.doc.items.filter(i => i.model).map(i => i.model));
  for (const id of Object.keys(app.doc.models || {})) if (!used.has(id)) delete app.doc.models[id];
}

// ---------- misure da tastiera ----------
function parseLen(s) {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase().replace(/\s/g, '');
  const m = t.match(/^([0-9]+(?:[.,][0-9]+)?)(cm|m|mm)?$/);
  if (!m) return null;
  let v = parseFloat(m[1].replace(',', '.'));
  if (m[2] === 'm' || (!m[2] && /[.,]/.test(m[1]) && v < 30)) v *= 100;
  else if (m[2] === 'mm') v /= 10;
  return v > 0 ? v : null;
}
async function editLength(b) {
  const d = app.doc;
  if (b.dim) { const dm = d.dims.find(x => x.id === b.dim); if (dm) setSel({ type: 'dim', id: dm.id }); return; }
  const w = G.wallById(d, b.wall);
  if (!w) return;
  setSel({ type: 'wall', id: w.id });
  const label = b.kind === 'inner' ? 'Misura interna della parete' : b.kind === 'outer' ? 'Misura esterna della parete' : 'Lunghezza della parete';
  const cur = b.L != null ? b.L : G.wallLength(d, w);
  const v = await promptText(label, fmtCm(cur), 'Applica', 'cm, oppure 3,45 m');
  const L = parseLen(v);
  if (!L) return;
  const how = await choose('Come applico la misura giusta?', `La parete misura ${fmtCm(cur)} cm, deve misurare ${fmtCm(L)} cm.`, [
    ['scale', 'Riscala tutta la pianta', 'tutto in proporzione: quando l’intera pianta è un po’ fuori scala (es. foto tarata male)'],
    ['stretch', 'Allunga solo questa parete', 'sposta ciò che c’è oltre la parete: per correggere una misura singola'],
  ]);
  if (!how) return;
  if (how === 'scale') {
    const center = G.wallLength(d, w);
    scalePlan((L + (center - cur)) / center);
    toast('Pianta riscalata: ora controlla un’altra misura per conferma');
  } else stretchWall(w, L - cur);
  commit('Misura parete');
}
/** Riscala tutta la pianta di f (pareti, stanze, quote, posizione dei mobili e la foto di sfondo; non le misure dei mobili). */
function scalePlan(f) {
  const d = app.doc;
  if (!d.nodes.length || !(f > 0)) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of d.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const sc = p => { p.x = cx + (p.x - cx) * f; p.y = cy + (p.y - cy) * f; };
  d.nodes.forEach(sc); d.items.forEach(sc); d.rooms.forEach(sc);
  for (const dm of d.dims) { sc(dm.a); sc(dm.b); }
  for (const o of d.openings) o.pos *= f;
  if (d.background) { d.background.k *= f; const p = { x: d.background.cx, y: d.background.cy }; sc(p); d.background.cx = p.x; d.background.cy = p.y; }
}
function onTyped(s) {
  const t = $('#typed');
  t.hidden = !s;
  t.textContent = s ? s + ' cm  ↵' : '';
}

// ---------- tastiera ----------
window.addEventListener('keydown', e => {
  if (isTyping(e) || !$('#modal').hidden) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicateSel(); return; }
  if (app.view === '2d' && plan.key(e)) { e.preventDefault(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { if (app.sel) { e.preventDefault(); deleteSel(); } return; }
  if (e.key === 'Escape') { if (app.sel) setSel(null); else if (panelMode) { panelMode = null; renderPanel(); } return; }
  const sel = app.sel && app.sel.type === 'item' ? findSel(app.sel) : null;
  if (sel && k === 'e') { sel.rot = (sel.rot + 90) % 360; commit('Ruota'); return; }
  if (sel && e.key.startsWith('Arrow') && !(app.view !== '2d' && view.mode === 'walk')) {
    e.preventDefault();
    const st = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') sel.x -= st; if (e.key === 'ArrowRight') sel.x += st; if (e.key === 'ArrowUp') sel.y -= st; if (e.key === 'ArrowDown') sel.y += st;
    commit('Sposta');
    return;
  }
  if (app.view !== '2d') return;
  const map = { v: 'select', w: 'wall', r: 'rect', l: 'divider', d: 'door', f: 'window', q: 'dim', m: 'furniture', p: 'photo' };
  if (map[k]) pickTool(map[k]);
  if (e.key === 'Home') plan.fit();
});
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);

// ---------- progetti ----------
function packDoc() { return JSON.parse(JSON.stringify({ ...app.doc, name: project ? project.name : app.doc.name })); }
let saveTimer = null, lastSaved = '';
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(persistProject, 600); }
async function persistProject() {
  if (!project) return;
  const doc = packDoc();
  const json = JSON.stringify(doc);
  if (json === lastSaved) return;
  lastSaved = json;
  try {
    await store.saveProject({ id: project.id, name: project.name, doc, rev: project.rev || 0, dirty: true, remoteOnly: false });
    sync.schedulePush(project.id);
  } catch (e) { toast('Salvataggio non riuscito: ' + e.message); }
}
function loadDoc(doc) {
  const d = { ...G.emptyDoc(), ...doc };
  d.settings = { ...G.emptyDoc().settings, ...(doc.settings || {}) };
  for (const k of ['nodes', 'walls', 'openings', 'rooms', 'items', 'dims']) d[k] = d[k] || [];
  d.models = d.models || {};
  d.textures = d.textures || {};
  setCustomFloors(d.textures);
  if (d.background && !d.background.sid) d.background.sid = G.newId('b');
  app.doc = d;
  app.sel = null;
  ocrResult = null;
  photo.refresh();
  resetHistory();
  view._framed = false;
  refresh();
  requestAnimationFrame(() => plan.fit());
}
async function openProject(id) {
  try {
    if (project) await persistProject();
    const rec = await sync.ensureLocal(id);
    if (!rec || !rec.doc) throw new Error('Progetto vuoto');
    project = { id: rec.id, name: rec.name, rev: rec.rev || 0 };
    lastSaved = JSON.stringify(rec.doc);
    loadDoc(rec.doc);
    store.setLastProjectId(id);
    sync.watch(id);
    renderProjectBar();
  } catch (e) { toast('Apertura non riuscita: ' + e.message); }
}
async function newProject(doc, name) {
  if (project) await persistProject();
  const id = store.newId();
  name = nextProjectName(name || 'Nuova casa');
  doc.name = name;
  project = { id, name, rev: 0 };
  loadDoc(doc);
  lastSaved = '';
  await persistProject();
  store.setLastProjectId(id);
  sync.watch(id);
  renderProjectBar();
}
let projNames = [];
function nextProjectName(base) {
  if (!projNames.includes(base)) return base;
  for (let i = 2; ; i++) if (!projNames.includes(`${base} ${i}`)) return `${base} ${i}`;
}
async function renameProject(id, name) {
  name = name.trim().slice(0, 60);
  if (!name) return;
  if (project && project.id === id) { project.name = name; app.doc.name = name; lastSaved = ''; await persistProject(); }
  else { const rec = await store.loadProject(id); if (rec) { await store.saveProject({ ...rec, name, doc: rec.doc ? { ...rec.doc, name } : rec.doc, dirty: !!rec.doc }); if (rec.doc) sync.schedulePush(id); } }
  renderProjectBar();
}
async function openProjects() {
  const list = await store.listProjects();
  projNames = list.map(p => p.name);
  const when = t => t ? new Date(t).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '';
  modal(`<h2>Progetti</h2>
    <div class="row"><button class="primary" data-new>Nuova casa</button><button class="btn" data-sample>Esempio arredato</button></div>
    <div class="projects">${list.map(p => `<div class="proj ${project && p.id === project.id ? 'cur' : ''}" data-open="${esc(p.id)}">
      <div class="pn"><b>${esc(p.name)}</b><small>${when(p.updated)}${p.remoteOnly ? ' · online' : ''}</small></div>
      <button class="btn" data-ren="${esc(p.id)}">Rinomina</button><button class="btn" data-dup="${esc(p.id)}">Copia</button><button class="btn danger" data-del="${esc(p.id)}">Elimina</button></div>`).join('') || '<p class="note">Nessun progetto.</p>'}</div>
    <footer><button class="btn" data-imp>Importa file…</button><button class="btn" data-exp>Esporta questo progetto</button><span class="grow"></span><button class="btn" data-close>Chiudi</button></footer>`, (el, close) => {
    el.addEventListener('click', async e => {
      const t = e.target.closest('[data-new],[data-sample],[data-open],[data-ren],[data-dup],[data-del],[data-imp],[data-exp]');
      if (!t) return;
      e.stopPropagation();
      const D = t.dataset;
      if (D.new !== undefined) { close(); await newProject(G.emptyDoc(), 'Nuova casa'); }
      else if (D.sample !== undefined) { close(); await newProject(sampleDoc(), 'Appartamento di esempio'); }
      else if (D.ren) { const p = list.find(x => x.id === D.ren); close(); const v = await promptText('Nome del progetto', p.name, 'Rinomina'); if (v) await renameProject(p.id, v); }
      else if (D.dup) { close(); await duplicateProject(D.dup); }
      else if (D.del) { const p = list.find(x => x.id === D.del); close(); if (await confirmBox('Eliminare «' + p.name + '»?', 'Il progetto sparisce da questo dispositivo e dal salvataggio online.', 'Elimina')) await removeProject(p.id); }
      else if (D.imp !== undefined) { close(); $('#fileProject').click(); }
      else if (D.exp !== undefined) { close(); exportProject(); }
      else if (D.open) { close(); if (!project || D.open !== project.id) await openProject(D.open); }
    });
  });
}
async function duplicateProject(id) {
  try {
    if (project && project.id === id) await persistProject();
    const rec = await sync.ensureLocal(id);
    const nid = store.newId(), name = nextProjectName(rec.name + ' (copia)');
    await store.saveProject({ ...rec, id: nid, name, doc: { ...rec.doc, name }, rev: 0, dirty: true, remoteOnly: false });
    sync.schedulePush(nid);
    toast('Creata la copia «' + name + '»');
  } catch (e) { toast('Copia non riuscita: ' + e.message); }
}
async function removeProject(id) {
  await store.deleteProject(id);
  await sync.remove(id);
  if (project && project.id === id) {
    project = null;
    const list = (await store.listProjects()).filter(p => !p.remoteOnly);
    if (list.length) await openProject(list[0].id); else await newProject(G.emptyDoc(), 'Nuova casa');
  }
}
/** Salva un file: sul telefono e sull'iPad con il foglio di condivisione, sul computer nei Download. */
async function saveBlob(blob, name) {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare) {
    try {
      const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  if (!touch) toast('Salvato nella cartella Download: ' + name);
}
const fileBase = () => (project ? project.name : 'pianta').replace(/[\\/:*?"<>|]/g, '-');
function exportProject() {
  saveBlob(new Blob([JSON.stringify(packDoc())], { type: 'application/json' }), fileBase() + '.pianta.json');
}
function exportPlanImage() {
  const url = plan.exportImage(2600);
  if (!url) { toast('La pianta è vuota'); return; }
  fetch(url).then(r => r.blob()).then(b => saveBlob(b, fileBase() + ' - pianta.png'));
}
async function exportGLB() {
  try {
    busy('Preparo il modello 3D…');
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const { group } = buildHouse(app.doc, { ceilings: false, models: modelGeos() });
    group.traverse(o => { if (o.isLight) o.visible = false; });
    const buf = await new GLTFExporter().parseAsync(group, { binary: true, onlyVisible: true });
    await saveBlob(new Blob([buf], { type: 'model/gltf-binary' }), fileBase() + '.glb');
  } catch (e) { console.error(e); toast('Esportazione non riuscita: ' + e.message); } finally { busy(null); }
}
function openFileMenu() {
  modal(`<h2>File</h2>
    <div class="conflict filemenu">
      <button class="btn" data-f="export"><b>Esporta il progetto</b><small>file .pianta.json con tutto (foto, pavimenti, modelli 3D): per tenerne una copia o aprirlo su un altro dispositivo</small></button>
      <button class="btn" data-f="import"><b>Importa un progetto</b><small>apre un file .pianta.json come nuovo progetto (quello attuale resta)</small></button>
      <button class="btn" data-f="png"><b>Pianta come immagine</b><small>PNG ad alta risoluzione con quote, stanze e arredi</small></button>
      <button class="btn" data-f="glb"><b>Modello 3D (GLB)</b><small>casa e arredi con i materiali: si apre in Blender, SketchUp, nei visualizzatori 3D di Windows e Mac</small></button>
    </div>
    <p class="note">Puoi anche trascinare un file sulla finestra: un progetto (.json), la foto di una planimetria o un modello 3D (OBJ, STL, GLB).</p>
    <footer><button class="btn" data-close>Chiudi</button></footer>`, (el, close) => {
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      close();
      ({ export: exportProject, import: () => $('#fileProject').click(), png: exportPlanImage, glb: exportGLB })[b.dataset.f]();
    });
  });
}
$('#btnFile').addEventListener('click', openFileMenu);
// trascinare un file sulla finestra
window.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', e => {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (!f) return;
  e.preventDefault();
  const n = f.name.toLowerCase();
  const target = /\.json$/.test(n) ? '#fileProject' : /\.(obj|stl|glb|gltf)$/.test(n) ? '#fileModel' : /^image\//.test(f.type) ? '#fileImg' : null;
  if (!target) { toast('Formato non riconosciuto: ' + f.name); return; }
  if (target === '#fileImg' && app.view !== '2d') setView('2d');
  if (target === '#fileImg') pickTool('photo');
  const dt = new DataTransfer(); dt.items.add(f);
  const inp = $(target); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
});
$('#fileProject').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const doc = JSON.parse(await f.text()); if (!doc.walls) throw new Error('Non è un progetto di Pianta'); await newProject(doc, doc.name || f.name.replace(/\.pianta\.json$|\.json$/, '')); toast('Progetto «' + project.name + '» importato'); }
  catch (err) { toast('Import non riuscito: ' + err.message); }
});
$('#btnProjects').addEventListener('click', openProjects);

const sync = new Sync({
  store,
  currentId: () => project && project.id,
  onStatus: () => renderProjectBar(),
  onUser: () => renderProjectBar(),
  onSynced: (id, rev) => { if (project && project.id === id) project.rev = rev; },
  onRemoteDoc: (id, doc, rev) => {
    if (!project || project.id !== id) return;
    project.rev = rev; project.name = doc.name || project.name;
    lastSaved = JSON.stringify(doc);
    loadDoc(doc);
    toast('Progetto aggiornato da un altro dispositivo');
    renderProjectBar();
  },
  askConflict: (local, remote) => askConflict(local, remote),
  onListChanged: () => {},
});

// ---------- dialoghi, account, barra del progetto (come Orizzonte) ----------
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function modal(html, setup) {
  const host = $('#modal'), box = $('#modalBox');
  box.innerHTML = html;
  host.hidden = false;
  const close = () => { host.hidden = true; box.innerHTML = ''; };
  host.onclick = e => { if (e.target === host) close(); };
  box.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  if (setup) setup(box, close);
  return close;
}
function onModalClosed(cb) {
  const host = $('#modal');
  const obs = new MutationObserver(() => { if (host.hidden) { obs.disconnect(); cb(); } });
  obs.observe(host, { attributes: true });
}
function promptText(title, value, okLabel, placeholder = '') {
  return new Promise(resolve => {
    let done = false;
    modal(`<h2>${esc(title)}</h2><input type="text" class="name-in" id="promptIn" maxlength="60" value="${esc(value)}" placeholder="${esc(placeholder)}" inputmode="${placeholder ? 'decimal' : 'text'}">
      <footer><button class="btn" data-close>Annulla</button><button class="primary" data-ok>${esc(okLabel || 'OK')}</button></footer>`, (el, close) => {
      const inp = el.querySelector('#promptIn');
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
      const ok = () => { done = true; close(); resolve(inp.value); };
      el.querySelector('[data-ok]').addEventListener('click', ok);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); });
    });
    onModalClosed(() => { if (!done) resolve(null); });
  });
}
function confirmBox(title, text, okLabel) {
  return new Promise(resolve => {
    let done = false;
    modal(`<h2>${esc(title)}</h2><p class="note">${esc(text)}</p>
      <footer><button class="btn" data-close>Annulla</button><button class="primary danger-bg" data-ok>${esc(okLabel)}</button></footer>`, (el, close) => {
      el.querySelector('[data-ok]').addEventListener('click', () => { done = true; close(); resolve(true); });
    });
    onModalClosed(() => { if (!done) resolve(false); });
  });
}
function askConflict(local, remote) {
  const when = t => (t ? new Date(t).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '?');
  return new Promise(resolve => {
    let done = false;
    modal(`<h2>Modificato su due dispositivi</h2>
      <p class="note">«${esc(local.name)}» è stato salvato su un altro dispositivo (${when(remote && remote.updated)}) mentre lo modificavi qui (${when(local.updated)}). Quale versione tieni?</p>
      <div class="conflict">
        <button class="btn" data-c="local"><b>Questo dispositivo</b><small>sovrascrive la versione online</small></button>
        <button class="btn" data-c="remote"><b>L’altro dispositivo</b><small>le modifiche fatte qui si perdono</small></button>
        <button class="btn" data-c="both"><b>Tieni entrambe</b><small>questa diventa una copia separata</small></button>
      </div>`, (el, close) => {
      el.addEventListener('click', e => { const b = e.target.closest('[data-c]'); if (b) { done = true; close(); resolve(b.dataset.c); } });
    });
    onModalClosed(() => { if (!done) resolve('both'); });
  });
}
const CLOUD_UI = { out: 'Accedi per salvare online', sync: 'Sincronizzo…', ok: 'Salvato online', pending: 'Da caricare online', offline: 'Offline: caricherò al ritorno della rete', warn: '', error: 'Errore di sincronizzazione' };
const CLOUD_ICON = '<svg viewBox="0 0 24 24"><path d="M7 18h11a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 18z"/></svg>';
function renderProjectBar() {
  $('#projName').textContent = project ? project.name : '…';
  document.title = project ? project.name + ' · Pianta' : 'Pianta';
  const b = $('#btnCloud'), st = sync.status;
  b.innerHTML = CLOUD_ICON + (sync.user && sync.user.photo ? `<img src="${esc(sync.user.photo)}" alt="" referrerpolicy="no-referrer">` : '');
  b.title = st.msg || CLOUD_UI[st.state] || '';
  b.className = 'cloudbtn ' + st.state;
}
function openAccount() {
  const u = sync.user, st = sync.status;
  modal(`<h2>Salvataggio online</h2>
    ${u ? `<div class="acct">${u.photo ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer">` : ''}<div><b>${esc(u.name || '')}</b><small>${esc(u.email || '')}</small></div></div>
      <p class="note">${esc(st.msg || CLOUD_UI[st.state] || '')}. I progetti si salvano online da soli e li ritrovi su ogni dispositivo in cui accedi con questo account (lo stesso di Officina e Orizzonte). Solo tu puoi vederli.</p>
      <footer><button class="btn" data-out>Esci</button><span class="grow"></span><button class="btn" data-syncnow>Sincronizza ora</button><button class="primary" data-close>Chiudi</button></footer>`
    : `<p class="note">Accedi con Google per ritrovare i tuoi progetti su PC e iPad. Ogni modifica si salva online da sola; senza rete continui a lavorare e si carica al ritorno della connessione. Solo tu puoi vedere i tuoi progetti.</p>
      <footer><button class="btn" data-close>Non ora</button><button class="primary" data-in>Accedi con Google</button></footer>`}`, (el, close) => {
    el.addEventListener('click', async e => {
      const t = e.target.closest('button');
      if (!t) return;
      try {
        if (t.dataset.in !== undefined) { close(); await sync.signIn(); }
        else if (t.dataset.out !== undefined) { close(); await sync.signOut(); toast('Disconnesso: i progetti restano su questo dispositivo'); }
        else if (t.dataset.syncnow !== undefined) { close(); await sync.syncAll(); }
      } catch (err) { toast('Accesso non riuscito: ' + err.message); }
    });
  });
}
$('#btnCloud').addEventListener('click', openAccount);
$('#projName').addEventListener('click', async () => {
  if (!project) return;
  const v = await promptText('Nome del progetto', project.name, 'Rinomina');
  if (v) renameProject(project.id, v);
});
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2600);
}
function busy(msg) { $('#busy').hidden = !msg; if (msg) $('#busyMsg').textContent = msg; }

// ---------- avvio ----------
function onResize() { if (app.view === '2d') plan.resize(); else view.resize(); }
new ResizeObserver(onResize).observe($('#stage'));
window.addEventListener('beforeunload', () => { persistProject(); renderStopped(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) persistProject(); });

/** La pagina e' stata chiusa dal sistema durante un render (iPhone/iPad con poca memoria)? */
function checkRenderCrash() {
  let run = null;
  try { run = JSON.parse(lsGet('pianta.renderRun') || 'null'); } catch (e) { run = null; }
  if (!run || Date.now() - run.t > 6 * 3600e3) { lsSet('pianta.renderRun', null); return; }
  lsSet('pianta.renderRun', null);
  const shot = lsGet('pianta.renderShot');
  let msg;
  if (run.stage === 'denoising') {
    lsSet('pianta.noDenoise', '1'); renderOpts.denoise = false;
    msg = 'Il telefono ha chiuso la pagina mentre toglievo il rumore (memoria finita). Da ora su questo dispositivo il filtro è spento: puoi riattivarlo nel pannello del render.' + (shot ? ' L’immagine era già calcolata: eccola, senza il filtro.' : '');
  } else {
    renderOpts.scale = Math.min(renderOpts.scale, 0.75);
    msg = 'Il telefono ha chiuso la pagina durante il render (memoria finita). La prossima volta prova la risoluzione al 75% o la qualità «Buona».';
  }
  modal(`<h2>Il render si è interrotto</h2><p class="note">${esc(msg)}</p>${shot ? `<img src="${shot}" alt="" style="width:100%;border-radius:8px">` : ''}
    <footer>${shot ? '<button class="primary" data-save>Salva immagine</button>' : ''}<button class="btn" data-close>Chiudi</button></footer>`, (el, close) => {
    const b = el.querySelector('[data-save]');
    if (b) b.addEventListener('click', async () => { const blob = await (await fetch(shot)).blob(); await saveBlob(blob, fileBase() + ' - render.jpg'); });
  });
  lsSet('pianta.renderShot', null);
}

(async function start() {
  plan.resize();
  renderTools(); setHint();
  try {
    const list = await store.listProjects();
    projNames = list.map(p => p.name);
    const last = store.lastProjectId();
    const pick = list.find(p => p.id === last && !p.remoteOnly) || list.find(p => !p.remoteOnly);
    if (QP.get('esempio') !== null) await newProject(sampleDoc(), 'Appartamento di esempio');
    else if (pick) await openProject(pick.id);
    else await newProject(sampleDoc(), 'Appartamento di esempio');
  } catch (e) {
    console.error(e);
    project = null;
    loadDoc(sampleDoc());
    toast('Archivio del browser non disponibile: i progetti non verranno salvati');
  }
  sync.start();
  checkRenderCrash();
  const v = QP.get('vista');
  if (v === '3d' || v === 'render') setView(v);
  if (QP.get('cammina') !== null) { view.setMode('walk'); updateWalkpad(); renderTools(); }
  window.__pianta = { app, plan, view, setView, newProject, openProject, sampleDoc, pickTool, commit, setSel, runDetect };
})();
