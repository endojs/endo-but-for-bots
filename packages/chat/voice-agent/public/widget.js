// widget.js — a dual-purpose embeddable "capability widget" (D3 reference SPWA). Its authority is a
// bootstrap with {skill, ask, rpc} = exactly the powers it was granted. It obtains that bootstrap two ways:
//   • EMBEDDED — a host page hands it a cap over a postMessage cap-channel (serveCapBootstrap). The widget
//     never sees the swissnum; the host relays each call server-side. (See app.js openWidget.)
//   • STANDALONE — a cap in the URL (`#cap=…` preferred — fragments never hit the server; `?cap=…` also
//     accepted). The widget drives the same /chat /skill /rpc relay itself, then strips the cap from the
//     address bar (cap-hygiene: no bookmark / referrer / scrollback leak).
import { serveCapBootstrap } from './cap-channel.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let agent = null;

const connect = async (remote, mode) => {
  agent = remote;
  $('status').textContent = 'connected · ' + mode;
  try {
    const sk = await remote.skill(); // self-describing: what was I granted?
    const ps = (sk && sk.powers) || [];
    $('powers').innerHTML = ps.length ? ps.map(p => `<span class="chip">${esc(p)}</span>`).join('') : '<span class="dim">(no powers granted)</span>';
  } catch (e) { $('powers').textContent = 'skill failed: ' + e.message; }
};

$('send').onclick = async () => {
  const t = $('q').value.trim(); if (!t || !agent) return;
  $('send').disabled = true; $('out').textContent = '…';
  try { const r = await agent.ask(t); $('out').textContent = (r && (r.answer || r.error)) || '(no answer)'; }
  catch (e) { $('out').textContent = 'error: ' + e.message; }
  $('send').disabled = false;
};
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') $('send').click(); });

// Standalone: read a cap from the URL (fragment first, then query). When the widget holds the swissnum
// itself it drives the relay directly — the SAME {ask,skill,rpc} surface the host would otherwise relay.
const capFromUrl = () => {
  const frag = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const qs = new URLSearchParams(location.search);
  return frag.get('cap') || qs.get('cap') || '';
};
const standaloneBootstrap = cap => ({
  ask: async text => (await (await fetch('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, text, sessionId: 'widget-' + String(cap).slice(0, 8) }) })).json()),
  skill: async () => (await (await fetch('/skill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json()),
  rpc: async (method, args = []) => (await (await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ swissnum: cap, method, args }) })).json()),
});

const urlCap = capFromUrl();
if (urlCap) {
  // cap-hygiene: drop the swissnum from the address bar immediately (no bookmark / referrer / scrollback leak).
  try { history.replaceState(null, '', location.pathname); } catch {}
  connect(standaloneBootstrap(urlCap), 'standalone');
} else {
  // Embedded: wait for the host to hand us the cap-channel port (the port IS the authority).
  serveCapBootstrap(remote => connect(remote, 'embedded'));
}
