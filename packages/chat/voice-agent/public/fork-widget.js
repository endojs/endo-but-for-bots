// fork-widget.js — mount a confined FORK inline in a chat (the in-tree, no-iframe render path).
//
// It fetches the fork's SOURCE — the owner via /forks/read (cap), a recipient via /forks/open (share token,
// no cap) — and renders it through window.__fieldIslands.renderSource, which itself REFUSES unless the realm
// is locked down (so this is inert, with a clear note, until FIELD_LOCKDOWN is on). It carries the in-place
// lifecycle affordances:
//   ✎ Edit   — the owner's micro-agent rewrites the fork's source (a new version), re-renders live.
//   ⇪ Share  — mint a least-authority link (copied, never rendered — cap-hygiene) others can open + re-fork.
//   ⑂ Make mine — a recipient adopts a shared fork as their OWN (create from the opened source) so they can
//                 edit + re-share it. This is the re-share branch of the lifecycle.
// State/props binding to grains is Phase 2 work; an MVP fork renders with the props it's given (default {}).

const pf = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
const el = (tag, attrs = {}, kids = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'style') n.style.cssText = v; else if (k === 'class') n.className = v; else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); } for (const c of [].concat(kids)) n.append(c); return n; };
const btn = (label, onClick, title) => el('button', { style: 'font:inherit;font-size:11px;cursor:pointer;background:var(--panel,#11141f);border:1px solid var(--edge,#262c3d);color:var(--ink,#e6edf3);border-radius:7px;padding:3px 8px', title: title || '', onclick: onClick }, [label]);

// mountForkInto(el, { cap, id, shareToken, name, props, onAdopt }) — render a fork + its lifecycle toolbar.
export const mountForkInto = async (host, opts = {}) => {
  const { cap, props = {} } = opts;
  let { id, shareToken, name } = opts;
  host.innerHTML = '';
  const stage = el('div', { class: 'fork-stage', style: 'margin-top:6px;min-height:32px' });
  const upgradeBar = el('div', { class: 'fork-upgrade', style: 'margin-top:4px' }); // Phase 4: recipient upgrade/inbox
  const note = el('div', { style: 'font-size:10px;color:var(--mut,#7d8590);margin-top:4px' });
  const bar = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' });

  // Mode is computed LIVE from shareToken (not captured once): "Make mine" nulls shareToken to flip
  // recipient → owner, and the next render must follow it to /forks/read. For recipients the open result
  // also carries Phase-4 upgrade/inbox metadata.
  const fetchSource = async () => {
    if (shareToken) { const o = await pf('/forks/open', { token: shareToken }); if (!o.ok) return { error: o.error }; name = o.name; return o; }
    const r = await pf('/forks/read', { cap, id }); if (!r.ok) return { error: r.error }; name = r.name; return { source: r.source };
  };
  const paint = src => {
    const ok = window.__fieldIslands && typeof window.__fieldIslands.renderSource === 'function'
      && window.__fieldIslands.renderSource(src, stage, props);
    note.textContent = ok ? '' : 'This fork renders only when the confined runtime is active (lockdown on).';
    return ok;
  };
  // Phase 4 recipient affordances: an owner's newer version is an UPGRADE you choose to take.
  const renderUpgrade = got => {
    upgradeBar.innerHTML = '';
    if (!shareToken) return;
    if (Array.isArray(got.inbox) && got.inbox.length) { const last = got.inbox[got.inbox.length - 1]; upgradeBar.append(el('div', { style: 'font-size:11px;color:var(--mut,#7d8590)' }, [`✉ from the author: ${last.message}`])); }
    if (got.upgradeAvailable) {
      const row = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:3px;font-size:11px;color:var(--acc,#39d3ff)' }, [`⬆ v${got.currentVersion} available (you're on v${got.version})`]);
      row.append(btn('Try it on', async () => { const pv = await pf('/forks/upgrade/preview', { token: shareToken }); if (pv.ok) { paint(pv.source); note.textContent = `previewing v${pv.version} — Accept to keep, or reload to revert`; } }, 'render the new version without committing (non-destructive)'));
      row.append(btn('Accept', async () => { const a = await pf('/forks/upgrade/accept', { token: shareToken }); if (a.ok) { note.textContent = `updated to v${a.version}`; render(); } }, 'atomically take the new version'));
      row.append(btn('Auto', async () => { await pf('/forks/upgrade/auto', { token: shareToken, on: true }); render(); }, 'always ride the author’s latest'));
      upgradeBar.append(row);
    }
  };
  const render = async () => {
    const got = await fetchSource();
    if (got.error) { stage.textContent = '⚠︎ ' + got.error; upgradeBar.innerHTML = ''; return; }
    // Phase 5 end-user gate: a distribution share withholds source a reviewer hasn't approved.
    if (got.gated) { stage.textContent = '🔒 ' + (got.note || 'pending distribution review'); upgradeBar.innerHTML = ''; return; }
    paint(got.source);
    renderUpgrade(got);
    // distribution trust badge (advisory on a normal share; the gate already enforced it on an end-user share)
    if (shareToken && got.distribution) {
      const d = got.distribution;
      upgradeBar.append(el('div', { style: `font-size:10px;margin-top:3px;color:${d.approved ? 'var(--ok,#3fb950)' : 'var(--mut,#7d8590)'}` },
        [d.approved ? `✓ approved for distribution by ${d.by}` : '◌ not yet reviewed for distribution']));
    }
  };

  const doEdit = async () => {
    const prompt = window.prompt(`Describe the change to "${name || 'this fork'}":`);
    if (!prompt) return;
    note.textContent = 'editing…';
    const r = await pf('/forks/edit', { cap, id, prompt });
    if (!r.ok) { note.textContent = '⚠︎ ' + r.error; return; }
    note.textContent = `saved v${r.version}`; render();
  };
  const doShare = async () => {
    const r = await pf('/forks/share', { cap, id, charge: { scheme: 'free' } });
    if (!r.ok) { note.textContent = '⚠︎ ' + r.error; return; }
    const link = `${location.origin}/#fork=${encodeURIComponent(r.token)}`;
    try { await navigator.clipboard.writeText(link); note.textContent = 'share link copied (re-shareable; revoke in Shares)'; }
    catch { note.textContent = 'share created — copy it from the Shares panel (kept off-screen for cap-hygiene)'; }
  };
  const doNotify = async () => {
    const message = window.prompt(`Notify recipients of "${name || 'this fork'}" (they'll see it next open):`);
    if (!message) return;
    const r = await pf('/forks/notify', { cap, id, message });
    note.textContent = r.ok ? `notified ${r.delivered} recipient${r.delivered === 1 ? '' : 's'}` : '⚠︎ ' + r.error;
  };
  const doAdopt = async () => {
    const o = await pf('/forks/open', { token: shareToken }); if (!o.ok) { note.textContent = '⚠︎ ' + o.error; return; }
    const c = await pf('/forks/create', { cap, source: o.source, name: `${o.name || 'fork'} (mine)`, baseId: o.id });
    if (!c.ok) { note.textContent = '⚠︎ ' + c.error; return; }
    id = c.id; shareToken = null; // we now own a copy — switch to owner mode
    if (typeof opts.onAdopt === 'function') opts.onAdopt(c.id);
    rebuildBar(); note.textContent = 'now yours — edit + re-share'; render();
  };

  const rebuildBar = () => {
    bar.innerHTML = '';
    bar.append(el('span', { style: 'font-size:12px;color:var(--mut,#7d8590)' }, [`⑂ ${name || 'fork'}`]));
    if (shareToken) bar.append(btn('⑂ Make mine', doAdopt, 'adopt this shared fork as your own to edit + re-share'));
    else { bar.append(btn('✎ Edit', doEdit, 'agent edits this fork')); bar.append(btn('⇪ Share', doShare, 'mint a re-shareable link')); bar.append(btn('✉ Notify', doNotify, 'tell recipients you changed it')); }
    // Tag the host with the fork's identity so Alt-click selection can act on a LIVE mounted fork (owner
    // forks only — a shared fork isn't yours to edit until you "Make mine"). data-fork-name shows in the chip.
    if (!shareToken && id) { host.setAttribute('data-fork-id', id); host.setAttribute('data-fork-name', name || 'fork'); }
    else { host.removeAttribute('data-fork-id'); host.removeAttribute('data-fork-name'); }
  };

  host.append(bar, stage, upgradeBar, note);
  rebuildBar();
  await render();
};
