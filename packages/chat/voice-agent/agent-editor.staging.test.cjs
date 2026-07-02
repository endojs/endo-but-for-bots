#!/usr/bin/env node
// agent-editor.staging.test.cjs — STAGING proof of the friendly Agent EDITOR: open Settings → 🕸️ Agents →
// ✏️ Edit agent, and confirm the editor loads the agent's system prompt AND its STANDING REFERENCE DOCUMENTS
// (the fold-docs pattern surfaced as a first-class "Always-on reference documents" field), then SAVES them
// back through /agents/save. Runs against the live service on :8778 with the root cap.
const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
(async () => {
  const chromium = loadChromium();
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); process.exit(0); }
  const srv = await startIsolatedServer();
  const cap = srv.cap;
  const br = await launchBrowser(chromium);
  try {
    const page = await br.newPage();
    let saved = null;
    // capture the save payload but DON'T persist it (fulfill with a fake ok) so the test never mutates live config
    await page.route('**/agents/save', async route => { try { saved = JSON.parse(route.request().postData() || '{}'); } catch {} route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 'dietician' }) }); });
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForTimeout(3500);
    // open Settings → Agents tab
    await page.evaluate(() => { const f = document.getElementById('drawer-foot'); f && f.click(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { const b = [...document.querySelectorAll('.setnav-item')].find(x => /Agents/.test(x.textContent)); b && b.click(); });
    await page.waitForTimeout(500);
    // pick the Dietician in the agent dropdown, then Edit
    await page.evaluate(() => { const s = document.getElementById('shape-agent'); if (s) { const o = [...s.options].find(o => /Dietician/.test(o.textContent)); if (o) { s.value = o.value; s.dispatchEvent(new Event('change')); } } });
    await page.waitForTimeout(300);
    await page.evaluate(() => { const e = document.getElementById('shape-edit'); e && e.click(); });
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => {
      const instr = document.getElementById('ae-instr');
      const scope = document.getElementById('ae-scope');
      const docs = [...document.querySelectorAll('.ae-docpath')].map(i => i.value);
      return { hasInstr: !!instr && instr.value.length > 50, scope: scope ? scope.value : null, docs };
    });
    ok(r.hasInstr, "the editor loads the agent's system prompt");
    ok(r.scope === 'Dietician', `the reference-docs scope is shown (got "${r.scope}")`);
    ok(r.docs.some(d => /Diet Preferences|Alexa|Dan/.test(d)), `the standing reference documents are listed (${r.docs.length} docs)`);
    // add a doc + Save → assert the save payload carries instructions + foldDocs + foldScope
    await page.evaluate(() => { const a = document.getElementById('ae-add'); a && a.click(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { const inputs = [...document.querySelectorAll('.ae-docpath')]; const last = inputs[inputs.length - 1]; if (last) { last.value = 'Dietician/Test Folded Doc.md'; } });
    await page.evaluate(() => { const s = document.getElementById('ae-save'); s && s.click(); });
    await page.waitForTimeout(900);
    ok(saved && typeof saved.instructions === 'string' && saved.instructions.length > 50, 'Save posts the edited system prompt');
    ok(saved && Array.isArray(saved.foldDocs) && saved.foldDocs.includes('Dietician/Test Folded Doc.md'), 'Save posts the edited reference-documents list');
    ok(saved && saved.foldScope === 'Dietician', 'Save posts the reference-docs scope');
    const out = await page.evaluate(() => { const o = document.getElementById('ae-out'); return o ? o.textContent : ''; });
    ok(/saved/i.test(out), `the editor confirms the save (got "${out}")`);
    await page.close();
  } finally { await br.close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
