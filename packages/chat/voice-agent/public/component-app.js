// component-app.js — the standalone home of a broken-out component (served at /c/<id>). Two ways in:
//   • the OWNER, on this origin, already has a cap in localStorage (or a #cap= fragment).
//   • a RECIPIENT opens a shared link /c/<id>#k=<token> — a LEAST-AUTHORITY component-share token that can
//     ONLY subscribe to this component's declared cells (read-only). It is NOT a cap: it can't open a chat,
//     hold a power, or reach any other data.
// The credential is lifted out of the address bar immediately (cap-hygiene) and kept in JS only; it never
// re-enters the visible DOM/URL. The component renders CONFINED + live via the same grain-ui machinery.
import { renderWidgets } from '/grain-ui.js';

const CAP_KEY = 'field-agent-cap';
const hp = (() => { try { return new URLSearchParams(location.hash.slice(1)); } catch { return new URLSearchParams(); } })();
const shareToken = hp.get('k') || null; // a component-share token (recipient)
let cap = null;
if (!shareToken) {
  cap = hp.get('cap') || (() => { try { return localStorage.getItem(CAP_KEY); } catch { return null; } })();
  if (hp.get('cap')) { try { localStorage.setItem(CAP_KEY, hp.get('cap')); } catch { /* */ } }
}
if (location.hash) { try { history.replaceState(null, '', location.pathname); } catch { /* */ } } // lift the credential out of the address bar

const id = decodeURIComponent((location.pathname.split('/').filter(Boolean).pop()) || '');
const app = document.getElementById('app');

(async () => {
  if (!cap && !shareToken) { app.textContent = 'Open this from your agent, or use a share link.'; return; }
  let r;
  try { r = await (await fetch('/c/ui', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, shareToken, id }) })).json(); }
  catch (e) { app.textContent = 'could not load: ' + e.message; return; }
  if (!r || !r.ok) { app.textContent = (r && r.error) || 'component not found'; return; }
  document.title = `${r.name} — component`;
  const t = document.getElementById('title'); if (t) t.textContent = r.name;
  const sub = document.querySelector('.sub'); if (sub && shareToken) sub.textContent = 'Shared with you — live, read-only, limited to this component’s data.';
  // ⚑ ADD-ONLY issue filing (recipient): the share token lets you file an issue on the author's backlog
  // for THIS component — and nothing more (no read of the backlog comes with it; the author sees it live).
  if (shareToken && sub) {
    const report = document.createElement('button');
    report.textContent = '⚑ Report an issue';
    report.style.cssText = 'margin-left:10px;font:inherit;font-size:11px;cursor:pointer;background:#161b22;border:1px solid #30363d;color:#e6edf3;border-radius:7px;padding:2px 8px';
    report.onclick = async () => {
      const title = window.prompt('⚑ Report an issue on this component to its author:');
      if (!title) return;
      let rr; try { rr = await (await fetch('/components/backlog/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shareToken, title }) })).json(); } catch (e) { rr = { ok: false, error: e.message }; }
      report.textContent = rr.ok ? '⚑ reported — thank you' : `⚠︎ ${rr.error || 'could not report'}`;
    };
    sub.appendChild(report);
  }
  app.textContent = '';
  // pass the credential through as a cap OR a least-authority shareToken; the broker uses whichever is set.
  renderWidgets(app, [{ type: 'component', source: r.source, cells: r.cells || [], height: 600, componentId: id, name: r.name }], { cap, shareToken, onChoice: () => {} });
})();
