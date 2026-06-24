// app.js — the Dietician SPA. The swissnum rides in the URL fragment (#cap=…) and IS the authority; we read it
// once, then STRIP it from the address bar (cap-hygiene — never leave a cap in the location). Everything is a
// POST /rpc {swissnum, method, args}. A share() mints a narrower link; we COPY it to the clipboard and never
// render the swissnum/url to the screen.
const cap = (location.hash.match(/cap=([0-9a-f]{16,})/) || [])[1] || '';
if (cap) { try { history.replaceState(null, '', location.pathname); } catch {} }

const $ = id => document.getElementById(id);
const rpc = async (method, ...args) => {
  const r = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ swissnum: cap, method, args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'rpc failed');
  return j.result;
};
const el = (tag, props = {}, kids = []) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of [].concat(kids)) if (k != null) e.append(k); return e; };
const card = (title, kids) => el('div', { className: 'card' }, [title ? el('h2', { textContent: title }) : null, ...[].concat(kids)]);
const out = (parent, obj, okMsg) => { const p = parent.querySelector('pre') || parent.appendChild(el('pre')); p.textContent = okMsg ? okMsg + '\n' + JSON.stringify(obj, null, 2) : JSON.stringify(obj, null, 2); };
const note = (n, msg, cls = 'ok') => { let s = n.querySelector('.note'); if (!s) { s = el('span', { className: 'note' }); n.append(' ', s); } s.className = 'note ' + cls; s.textContent = msg; };

const countsRow = c => el('div', { className: 'counts' }, [
  el('span', { className: 'pill g', textContent: `🟢 VIABLE ${c.VIABLE || 0}` }),
  el('span', { className: 'pill y', textContent: `🟡 BORDERLINE ${c.BORDERLINE || 0}` }),
  el('span', { className: 'pill', textContent: `SKIP ${c.SKIP || 0}` }),
  el('span', { className: 'pill', textContent: `UNKNOWN ${c.UNKNOWN || 0}` }),
  el('span', { className: 'pill muted', textContent: `total ${c.total || 0}` }),
]);

async function copyLink(url, btn) {
  try { await navigator.clipboard.writeText(url); note(btn.parentElement, 'link copied to clipboard ✓', 'ok'); }
  catch { note(btn.parentElement, 'copy failed — long-press to copy is unavailable here', 'err'); }
}

async function renderRoot(app, d) {
  app.append(card('Status', [countsRow(d.counts || {}), el('div', { className: 'muted', style: 'margin-top:6px', textContent: `${d.cities} cities configured` })]));

  // scan / evaluate
  let cities = [];
  try { cities = await rpc('listCities'); } catch {}
  const sel = el('select', {}, cities.map(c => el('option', { value: c.slug, textContent: `${c.name} (${c.slug})` })));
  const scanRow = el('div', { className: 'row' }, [sel,
    el('button', { className: 'go', textContent: 'Scan', onclick: async (e) => { try { note(e.target.parentElement, 'scanning…'); out(scanCard, await rpc('scan', sel.value), 'scan ' + sel.value); note(e.target.parentElement, 'done ✓'); } catch (err) { note(e.target.parentElement, err.message, 'err'); } } }),
    el('button', { textContent: 'Evaluate (3)', onclick: async (e) => { try { note(e.target.parentElement, 'judging…'); out(scanCard, await rpc('evaluate', { city: sel.value, limit: 3 }), 'evaluate ' + sel.value); note(e.target.parentElement, 'done ✓'); } catch (err) { note(e.target.parentElement, err.message, 'err'); } } }),
  ]);
  const scanCard = card('Scan & evaluate a city', [scanRow]);
  app.append(scanCard);

  // build / generate
  const genCard = card('Map & guides', [el('div', { className: 'row' }, [
    el('button', { textContent: '🗺️ Build map (KML)', onclick: async (e) => { try { note(e.target.parentElement, 'building…'); out(genCard, await rpc('buildMap'), 'safe-eats.kml'); note(e.target.parentElement, 'done ✓'); } catch (err) { note(e.target.parentElement, err.message, 'err'); } } }),
    el('button', { textContent: '🍽️ Eats guide', onclick: async (e) => { try { note(e.target.parentElement, 'generating…'); out(genCard, await rpc('generateGuide', 'eats'), 'eats guide'); note(e.target.parentElement, 'done ✓'); } catch (err) { note(e.target.parentElement, err.message, 'err'); } } }),
    el('button', { textContent: '🏰 Disney guide', onclick: async (e) => { try { note(e.target.parentElement, 'generating…'); out(genCard, await rpc('generateGuide', 'disney'), 'disney guide'); note(e.target.parentElement, 'done ✓'); } catch (err) { note(e.target.parentElement, err.message, 'err'); } } }),
  ])]);
  app.append(genCard);

  // shares
  const kindSel = el('select', {}, [['guide', 'Guide (read-only)'], ['scanner', 'Scanner (scan one city)'], ['editor', 'Editor (edit diet)']].map(([v, t]) => el('option', { value: v, textContent: t })));
  const nameIn = el('input', { placeholder: 'name this link (to revoke later)' });
  const cityIn = el('input', { placeholder: 'scanner city slug (optional)', style: 'min-width:140px' });
  const list = el('div', {});
  const refresh = async () => {
    list.replaceChildren();
    const shares = await rpc('listShares');
    if (!shares.length) { list.append(el('div', { className: 'muted', textContent: 'no shares yet' })); return; }
    for (const s of shares) {
      list.append(el('div', { className: 'share-row' }, [
        el('span', {}, [el('strong', { textContent: s.label }), el('span', { className: 'muted', textContent: `  · ${s.kind}` })]),
        el('button', { className: 'bad', textContent: 'Revoke', onclick: async () => { await rpc('revoke', s.swiss); refresh(); } }),
      ]));
    }
  };
  const shareRow = el('div', { className: 'row' }, [kindSel, nameIn, cityIn,
    el('button', { className: 'go', textContent: 'Mint + copy link', onclick: async (e) => {
      try {
        const opts = kindSel.value === 'scanner' && cityIn.value.trim() ? { city: cityIn.value.trim() } : {};
        const r = await rpc('share', kindSel.value, nameIn.value.trim() || `${kindSel.value} link`, opts);
        await copyLink(r.url, e.target); nameIn.value = ''; refresh();
      } catch (err) { note(e.target.parentElement, err.message, 'err'); }
    } }),
  ]);
  app.append(card('Share a capability', [el('div', { className: 'muted', style: 'margin-bottom:6px', textContent: 'Mint a narrower link to hand out. The link is copied to your clipboard — it is never shown on screen (it IS the authority).' }), shareRow, el('h2', { textContent: 'Active shares', style: 'margin-top:14px' }), list]));
  refresh();
}

async function renderGuide(app, d) {
  app.append(card('Status', [countsRow(d.counts || {})]));
  const frame = el('iframe', { sandbox: 'allow-same-origin' });
  const c = card('Safe-eats guide', [el('div', { className: 'row' }, [
    el('button', { className: 'go', textContent: '🍽️ Eats', onclick: async () => { frame.srcdoc = await rpc('readGuide', 'eats'); } }),
    el('button', { textContent: '🏰 Disney', onclick: async () => { frame.srcdoc = await rpc('readGuide', 'disney'); } }),
  ]), frame]);
  app.append(c);
  try { frame.srcdoc = await rpc('readGuide', 'eats'); } catch {}
}

async function renderScanner(app, d) {
  app.append(card(`Scanner${d.city ? ` — ${d.city}` : ''}`, [
    el('div', { className: 'muted', textContent: `${d.remaining} calls remaining this window` }),
    el('div', { className: 'row' }, [
      el('button', { className: 'go', textContent: 'Scan' + (d.city ? ` ${d.city}` : ''), onclick: async (e) => { try { out(e.target.closest('.card'), await rpc('scan', d.city || ''), 'scan'); } catch (err) { note(e.target.parentElement, err.message, 'err'); } } }),
      el('button', { textContent: 'Evaluate (3)', onclick: async (e) => { try { out(e.target.closest('.card'), await rpc('evaluate', { city: d.city || '', limit: 3 }), 'evaluate'); } catch (err) { note(e.target.parentElement, err.message, 'err'); } } }),
    ]),
  ]));
}

async function renderEditor(app, d) {
  const ta = el('textarea', { style: 'width:100%;min-height:300px;background:#010409;color:#c9d1d9;border:1px solid var(--line);border-radius:8px;padding:10px;font:13px ui-monospace,monospace' });
  ta.value = await rpc('readSpec');
  app.append(card('Diet spec (editor)', [ta, el('div', { className: 'row' }, [
    el('button', { className: 'go', textContent: 'Save diet', onclick: async (e) => { try { await rpc('writeSpec', ta.value); note(e.target.parentElement, 'saved ✓'); } catch (err) { note(e.target.parentElement, err.message, 'err'); } } }),
    el('button', { textContent: 'Re-evaluate (3)', onclick: async (e) => { try { out(e.target.closest('.card'), await rpc('evaluate', { limit: 3 }), 're-evaluate'); } catch (err) { note(e.target.parentElement, err.message, 'err'); } } }),
  ])]));
}

(async () => {
  const app = $('app');
  if (!cap) { app.replaceChildren(el('div', { className: 'err', textContent: 'No capability — open this app with your #cap= link.' })); return; }
  let d;
  try { d = await rpc('describe'); } catch (e) { app.replaceChildren(el('div', { className: 'err', textContent: 'This link is dead or revoked.' })); return; }
  $('sub').textContent = `${d.label || d.kind}${d.person ? ' · ' + d.person : ''}`;
  app.replaceChildren();
  if (d.kind === 'guide') return renderGuide(app, d);
  if (d.kind === 'scanner') return renderScanner(app, d);
  if (d.kind === 'editor') return renderEditor(app, d);
  return renderRoot(app, d);
})();
