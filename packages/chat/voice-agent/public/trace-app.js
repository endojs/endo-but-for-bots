// trace-app.js — the standalone, stateless 3D trace app. Pure function of the `chat`
// capability handed to it over a postMessage MessagePort. It reuses the same Three.js
// renderer (trace.js) the inline view uses. A dev agent owns this file: change how the
// trace renders here and reload the iframe; nothing else needs to change because the only
// thing crossing the boundary is the capability.
import { makeTrace } from './trace.js';
import { makeCapChannel } from './cap-channel.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let trace = null, chat = null;

// Receive the capability port from the parent (the port is the only authority granted).
window.addEventListener('message', ev => {
  if (!ev.data || ev.data.t !== '__capport' || !ev.ports || !ev.ports[0]) return;
  const ch = makeCapChannel(ev.ports[0], { refresh: () => render() }); // parent calls refresh() when the trace changes
  chat = ch.remote;
  $('status').textContent = '';
  boot();
});

async function boot() {
  try { if (!trace) trace = makeTrace($('c')); await render(); }
  catch (e) { showErr(e.message); }
}

async function render() {
  if (!chat || !trace) return;
  try {
    const model = await chat.getTrace();
    trace.render(Array.isArray(model) ? model : []);
    const info = (await chat.getInfo()) || {};
    $('title').textContent = '⊿ ' + (info.title || 'trace');
    renderVersions(info);
  } catch (e) { showErr(e.message); }
}

function renderVersions(info) {
  const vs = (info && info.versions) || []; const i = info ? (info.index || 0) : 0;
  $('vers').innerHTML = vs.length > 1
    ? `<button id="vp" ${i <= 0 ? 'disabled' : ''}>◀</button> <b>${esc((vs[i] || {}).label || ('v' + i))}</b> <span>${i + 1}/${vs.length}</span> <button id="vn" ${i >= vs.length - 1 ? 'disabled' : ''}>▶</button>`
    : '';
  $('note').textContent = (info && info.note) || '';
  const vp = $('vp'), vn = $('vn');
  if (vp) vp.onclick = async () => { try { await chat.selectVersion(i - 1); await render(); } catch (e) { showErr(e.message); } };
  if (vn) vn.onclick = async () => { try { await chat.selectVersion(i + 1); await render(); } catch (e) { showErr(e.message); } };
}

function showErr(m) { const e = $('err'); e.classList.remove('hide'); e.textContent = 'trace app: ' + m; }
window.addEventListener('resize', () => { try { trace && trace.resize(); } catch {} });
