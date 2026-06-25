// apps-host.js — standalone SPWA host for ONE island, served at /apps/<name>.
//
// This is the "islands as SPWAs off agentc.chu" surface: an app is just a registered
// island + a thin host controller, served from THIS origin — no per-app ngrok tunnel.
// Cap hygiene mirrors component-app.js: the capability arrives in the #cap= fragment
// (or localStorage on this origin), is lifted out of the address bar immediately, and
// is held in JS only — never re-entered into the DOM/URL. The island itself is confined
// (renderConfined) and never sees the cap; the host fetches on its behalf.

const CAP_KEY = 'field-agent-cap';
const hp = (() => { try { return new URLSearchParams(location.hash.slice(1)); } catch { return new URLSearchParams(); } })();
let cap = hp.get('cap') || (() => { try { return localStorage.getItem(CAP_KEY); } catch { return null; } })();
if (hp.get('cap')) { try { localStorage.setItem(CAP_KEY, hp.get('cap')); } catch { /* */ } }
if (location.hash) { try { history.replaceState(null, '', location.pathname); } catch { /* */ } } // lift the cap out of the address bar

const appName = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
const root = document.getElementById('app');
const setHead = (title, sub) => { const t = document.getElementById('apptitle'); if (t) t.textContent = title; document.title = `${title} · Agent C`; const s = document.getElementById('appsub'); if (s && sub) s.textContent = sub; };

const pf = (path, body = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, ...body }) }).then(r => r.json()).catch(e => ({ error: e.message }));
const fileToB64 = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
const dlB64 = (nm, b64) => { const bin = atob(b64), arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i); const u = URL.createObjectURL(new Blob([arr])); const a = document.createElement('a'); a.href = u; a.download = nm; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000); };
const renderInto = (comp, el, props) => { if (globalThis.__fieldIslands && globalThis.__fieldIslands.renderInto) globalThis.__fieldIslands.renderInto(comp, el, props); else el.textContent = '(islands bundle not loaded)'; };

// ── app: file-browser (the FileBrowser island + its host controller) ──
const mountFileBrowser = async el => {
  setHead('📂 Files', 'Browse + add files in your power folders — a confined island, served from this origin.');
  const roots = ((await pf('/files/roots')).roots) || [];
  const st = { root: (roots[0] && roots[0].key) || 'vault', path: '', entries: [], file: null, busy: false, error: '' };
  const rel = n => (st.path ? `${st.path}/${n}` : n);
  const draw = () => renderInto('FileBrowser', el, { roots, root: st.root, path: st.path, entries: st.entries, file: st.file, busy: st.busy, error: st.error, onRoot, onOpen, onCrumb, onAdd, onDownload, onRemove, onCloseFile });
  const list = async () => { st.busy = true; st.error = ''; st.file = null; draw(); const r = await pf('/files/list', { root: st.root, path: st.path }); st.busy = false; if (r.error) { st.error = r.error; st.entries = []; } else st.entries = r.entries || []; draw(); };
  const onRoot = k => { st.root = k; st.path = ''; st.file = null; list(); };
  const onCrumb = i => { const segs = st.path.split('/').filter(Boolean); st.path = i < 0 ? '' : segs.slice(0, i + 1).join('/'); st.file = null; list(); };
  const onOpen = async (n, isDir) => { if (isDir) { st.path = rel(n); list(); return; } st.busy = true; draw(); const r = await pf('/files/get', { root: st.root, path: rel(n) }); st.busy = false; if (r.error) st.error = r.error; else st.file = { name: r.name, text: r.text, size: r.size, b64: r.b64 }; draw(); };
  const onCloseFile = () => { st.file = null; draw(); };
  const onDownload = () => { const f = st.file; if (f && f.b64) dlB64(f.name, f.b64); };
  const onRemove = async n => { if (!confirm(`Delete ${n}?`)) return; const r = await pf('/files/rm', { root: st.root, path: rel(n) }); if (r.error) { st.error = r.error; draw(); } else { st.file = null; list(); } };
  const onAdd = () => { const inp = document.createElement('input'); inp.type = 'file'; inp.onchange = async () => { const f = inp.files && inp.files[0]; if (!f) return; if (f.size > 25 * 1024 * 1024) { st.error = `${f.name} is over the 25MB limit`; draw(); return; } st.busy = true; draw(); const b64 = await fileToB64(f); const r = await pf('/files/put', { root: st.root, path: rel(f.name), b64 }); st.busy = false; if (r.error) st.error = r.error; list(); }; inp.click(); };
  list();
};

// The app registry: slug → mount(el). Add new island-backed apps here.
const APPS = { 'file-browser': mountFileBrowser };

(async () => {
  if (!cap) { root.textContent = 'Open this from your agent — the link carries your capability.'; return; }
  for (let i = 0; i < 60 && !globalThis.__fieldIslands; i += 1) await new Promise(r => setTimeout(r, 25)); // wait for the islands bundle global
  const mount = APPS[appName];
  if (!mount) { root.textContent = `Unknown app "${appName}". Known: ${Object.keys(APPS).join(', ') || '(none)'}.`; return; }
  root.textContent = '';
  try { await mount(root); } catch (e) { root.textContent = 'could not start: ' + (e && e.message); }
})();
