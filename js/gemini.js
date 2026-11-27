// Foto realistica con Gemini: si manda l'immagine del render con le istruzioni di renderla fotografica
// senza cambiare stanza, inquadratura e arredi; torna l'immagine trasformata.
// La chiave API e' dell'utente e resta nel suo browser (localStorage): non e' mai nel codice del sito.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const KEY = 'pianta.geminiKey', MODEL = 'pianta.geminiModel';

export const getKey = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
export const setKey = k => { try { if (k) localStorage.setItem(KEY, k.trim()); else localStorage.removeItem(KEY); } catch (e) { /* niente */ } };
export const getModel = () => { try { return localStorage.getItem(MODEL) || ''; } catch (e) { return ''; } };
export const setModel = m => { try { localStorage.setItem(MODEL, m); } catch (e) { /* niente */ } };
export const DEFAULT_MODEL = 'gemini-2.5-flash-image';

async function api(path, key, body) {
  const r = await fetch(`${BASE}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = (j.error && j.error.message) || r.statusText;
    if (r.status === 400 && /API key/i.test(m)) throw new Error('chiave API non valida');
    if (r.status === 403) throw new Error('chiave senza permesso per questo modello (' + m + ')');
    if (r.status === 429) throw new Error('limite di richieste o credito esaurito per la chiave: ' + m);
    throw new Error(m);
  }
  return j;
}

/** Modelli Gemini che generano immagini (letti da Google: restano validi quando escono modelli nuovi). */
export async function listImageModels(key) {
  const j = await api('models?pageSize=200', key);
  return (j.models || [])
    .filter(m => /image/i.test(m.name) && /gemini/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }));
}

const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'];
export function nearestRatio(w, h) {
  const r = w / h;
  let best = '1:1', bd = Infinity;
  for (const s of RATIOS) { const [a, b] = s.split(':').map(Number); const d = Math.abs(Math.log(r / (a / b))); if (d < bd) { bd = d; best = s; } }
  return best;
}

/** Riduce l'immagine (dataURL) a JPEG con lato lungo massimo maxPx. */
export async function toJpeg(dataUrl, maxPx = 1536) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const k = Math.min(1, maxPx / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
  return { url: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height };
}

export function buildPrompt(notes, creative) {
  const base = creative
    ? 'Transform this 3D interior render into a beautiful, photorealistic architectural photograph. Keep the same room, camera angle, walls, windows, doors and the main furniture with their positions and colors. You may add small realistic details (textiles, books, small decor, plants) and refine materials and lighting.'
    : 'Transform this 3D interior render into a photorealistic photograph taken by a professional architectural photographer. Keep EXACTLY the same room geometry, camera angle and framing, the same furniture with the same shapes, sizes, positions and colors, the same floor and wall materials and colors, and the same windows and doors. Do not add, remove or move any object. Only make materials, textures, lighting, shadows and reflections look real.';
  return base + ' Natural light, realistic exposure, no text, no watermark.' + (notes ? ' Additional instructions from the user (written in Italian): ' + notes : '');
}

/** Chiede a Gemini la versione fotografica. Restituisce un dataURL dell'immagine. */
export async function photoreal({ key, model, image, notes, creative }) {
  const b64 = image.url.split(',')[1];
  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(notes, creative) }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: nearestRatio(image.w, image.h) } },
  };
  let j;
  try { j = await api(`models/${encodeURIComponent(model)}:generateContent`, key, body); }
  catch (e) {
    // alcuni modelli non accettano imageConfig: si riprova senza
    if (/imageConfig|aspect/i.test(e.message)) { delete body.generationConfig.imageConfig; j = await api(`models/${encodeURIComponent(model)}:generateContent`, key, body); }
    else throw e;
  }
  const cand = (j.candidates || [])[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const img = parts.find(p => p.inlineData || p.inline_data);
  if (!img) {
    const txt = parts.map(p => p.text).filter(Boolean).join(' ');
    const why = cand && cand.finishReason && cand.finishReason !== 'STOP' ? ' (' + cand.finishReason + ')' : '';
    throw new Error('Gemini non ha restituito un’immagine' + why + (txt ? ': ' + txt.slice(0, 200) : ''));
  }
  const d = img.inlineData || img.inline_data;
  return `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data}`;
}
