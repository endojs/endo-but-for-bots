// component-app.js — the standalone home of a broken-out component (served at /c/<id>). Reads its cap
// the SPWA way (a #cap fragment if present, else the origin-scoped localStorage cap the owner already
// has), strips it from the address bar (cap-hygiene), fetches the saved source from /components/ui, and
// renders it CONFINED + live via the same grain-ui machinery the chat uses. cap stays in JS — never in
// the visible DOM/URL.
import { renderWidgets } from '/grain-ui.js';

const CAP_KEY = 'field-agent-cap';
const cap = (() => {
  try { const fromHash = new URLSearchParams(location.hash.slice(1)).get('cap'); if (fromHash) { try { localStorage.setItem(CAP_KEY, fromHash); } catch { /* */ } return fromHash; } } catch { /* */ }
  try { return localStorage.getItem(CAP_KEY); } catch { return null; }
})();
if (location.hash) { try { history.replaceState(null, '', location.pathname); } catch { /* */ } } // lift the cap out of the address bar

const id = decodeURIComponent((location.pathname.split('/').filter(Boolean).pop()) || '');
const app = document.getElementById('app');

(async () => {
  if (!cap) { app.textContent = 'Open this from your agent (no capability in this browser).'; return; }
  let r;
  try { r = await (await fetch('/components/ui', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id }) })).json(); }
  catch (e) { app.textContent = 'could not load: ' + e.message; return; }
  if (!r || !r.ok) { app.textContent = (r && r.error) || 'component not found'; return; }
  document.title = `${r.name} — component`;
  const t = document.getElementById('title'); if (t) t.textContent = r.name;
  app.textContent = '';
  renderWidgets(app, [{ type: 'component', source: r.source, cells: r.cells || [], height: 600 }], { cap, onChoice: () => {} });
})();
