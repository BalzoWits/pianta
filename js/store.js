// Archivio nel browser (IndexedDB): progetti e modelli 3D importati.
const DB = 'pianta';
let dbp = null;
export function openDB() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('meshes')) d.createObjectStore('meshes');
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('projects', mode);
    const req = fn(t.objectStore('projects'));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}

export async function listProjects() {
  const all = (await tx('readonly', s => s.getAll())) || [];
  return all.map(p => ({
    id: p.id, name: p.name, updated: p.updated, objects: p.doc && p.doc.walls ? p.doc.walls.length : null,
    dirty: !!p.dirty, remoteOnly: !!p.remoteOnly, rev: p.rev || 0,
  })).sort((a, b) => b.updated - a.updated);
}
export const listFull = async () => (await tx('readonly', s => s.getAll())) || [];
export const loadProject = id => tx('readonly', s => s.get(id));
/** keepTime: conserva la data di modifica (sincronizzazione), altrimenti e' "adesso". */
export const saveProject = (p, { keepTime = false } = {}) => tx('readwrite', s => s.put({ ...p, updated: keepTime && p.updated ? p.updated : Date.now() }));
export const deleteProject = id => tx('readwrite', s => s.delete(id));
export function newId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

export function lastProjectId() { try { return localStorage.getItem('pianta.ultimo'); } catch (e) { return null; } }
export function setLastProjectId(id) { try { localStorage.setItem('pianta.ultimo', id); } catch (e) { /* niente */ } }
