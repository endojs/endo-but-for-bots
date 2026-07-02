#!/usr/bin/env node
// component-backlog-add-ui.staging.test.cjs — STAGING guard for INC-7: the owner can file an issue straight
// into a component's backlog from the live-edit panel (＋⚑). Proves both halves round-trip:
//   (1) POST /components/backlog/add → /components/backlog lists it (+ dedup bumps count), root-gated, and
//   (2) window.openComponentEditChat(id) → clicking ＋⚑ posts the item and the backlog:<id> cell pushes it
//       back into the panel (the ⚑ badge + list repaint with no manual refresh).
// Isolated server + ephemeral port + mkdtemp (never the live :8778). SKIPs the UI leg without chromium.
//
// Run: node component-backlog-add-ui.staging.test.cjs
const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const post = async (base, path, body) => (await (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json());

(async () => {
  const srv = await startIsolatedServer();
  const cap = srv.cap;
  try {
    const ID = 'bl-target-1';
    // ── (1) route round-trip ─────────────────────────────────────────────────────────────
    const a = await post(srv.base, '/components/backlog/add', { cap, id: ID, kind: 'issue', title: 'show newest first is broken' });
    ok(a && a.ok && a.id, 'add returns an item id');
    const list = await post(srv.base, '/components/backlog', { cap, id: ID });
    ok(list.ok && (list.items || []).some(it => it.title === 'show newest first is broken' && it.from === 'owner'), 'the item appears in the component backlog, filed from owner');
    const dup = await post(srv.base, '/components/backlog/add', { cap, id: ID, kind: 'issue', title: 'show newest first is broken' });
    ok(dup && dup.deduped && dup.count === 2, 'a duplicate title dedups (count bumps, not a new row)');
    // root-gated like the rest of the /components block
    const noCap = await fetch(`${srv.base}/components/backlog/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ID, title: 'x' }) });
    ok(noCap.status === 403, `/components/backlog/add without the root cap is 403 (got ${noCap.status})`);

    // ── (2) UI round-trip ────────────────────────────────────────────────────────────────
    const chromium = loadChromium();
    if (!chromium) { console.log('  SKIP - no chromium (route leg still asserted)'); }
    else {
      const br = await launchBrowser(chromium);
      try {
        const page = await br.newPage();
        await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
        await page.addInitScript(() => { window.prompt = () => 'filed from the panel'; }); // stub the title prompt
        await page.goto(`${srv.base}/`, { waitUntil: 'load' });
        await page.waitForTimeout(2500);
        const opened = await page.evaluate(() => { if (typeof window.openComponentEditChat !== 'function') return false; window.openComponentEditChat('bl-ui-comp', 'UI Comp', { kind: 'component' }); return true; });
        ok(opened, 'openComponentEditChat is reachable and opens the live-edit panel');
        await page.waitForTimeout(800);
        const hasAdd = await page.evaluate(() => !!document.querySelector('[data-ce-bladd]'));
        ok(hasAdd, 'the ＋⚑ file-an-issue affordance is present in the panel');
        await page.evaluate(() => document.querySelector('[data-ce-bladd]').click());
        await page.waitForTimeout(1500); // add → backlog:<id> cell push → repaint
        const shown = await page.evaluate(() => { const b = document.querySelector('[data-ce-backlog]'); return b ? b.textContent : ''; });
        ok(/filed from the panel/.test(shown), 'the filed issue pushes back into the panel via the backlog cell (live repaint)');
        // and it really landed server-side
        const srvList = await post(srv.base, '/components/backlog', { cap, id: 'bl-ui-comp' });
        ok(srvList.ok && (srvList.items || []).some(it => it.title === 'filed from the panel'), 'the item is persisted server-side under the component id');
        await page.close();
      } finally { await br.close(); }
    }
  } finally { srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
