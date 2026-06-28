// self-improve-review: a STAGED self-improvement branch surfaces in the 🔔 inbox as an actionable approve/reject
// notification, and acting on it routes server-side to the merge/discard handler (no off-app flush). Proves the
// user's question — "staged branches present as notifications with inline decision UI I can act on right there" — YES.
const fs = require('node:fs'); const os = require('node:os');
const ASKS = os.homedir() + '/.local/state/field-dashboard/asks.json';
const cap = fs.readFileSync(os.homedir() + '/.config/field-agent/root.swiss', 'utf8').trim();
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const backup = fs.existsSync(ASKS) ? fs.readFileSync(ASKS, 'utf8') : null;
const restore = () => { try { if (backup === null) fs.unlinkSync(ASKS); else fs.writeFileSync(ASKS, backup); } catch {} };
(async () => {
  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); process.exit(0); }
  // seed a self-improve review ask (the exact shape raiseStagedReview produces). Bogus branch + dirty live tree →
  // the real merge SAFELY refuses (no git mutation); we assert the UI + the decision ROUTING, not merge success.
  const seeded = { updated: new Date().toISOString(), asks: [{
    id: 'ask-e2e-selfimprove', title: '🌱 Self-improve ready to review: add a retry to tool errors',
    body: 'A confined executor implemented this on an isolated branch and it passed INDEPENDENT verification (green).\n\nBranch: improve-e2e-bogus\n\nApprove → I safe-merge it. Reject → I discard the branch.',
    questions: [{ id: 'decision', q: 'Merge this verified change into the live app?', type: 'approve-reject' }],
    origin: { kind: 'self-improve', branch: 'improve-e2e-bogus', goal: 'add a retry to tool errors', backlogId: '' },
    requestedBy: 'self-improve', status: 'open', createdAt: new Date().toISOString(),
  }] };
  fs.writeFileSync(ASKS, JSON.stringify(seeded, null, 2));
  const br = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await br.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    let answerResp = null;
    page.on('response', async r => { if (r.url().endsWith('/asks/answer')) { try { answerResp = await r.json(); } catch {} } });
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(3500);
    // open the 🔔 inbox
    await page.evaluate(() => { const b = document.getElementById('bell-btn'); if (b) b.click(); }); await page.waitForTimeout(900);
    const card = await page.evaluate(() => { const el = [...document.querySelectorAll('#att-list .ask')].find(a => /Self-improve ready to review/.test(a.textContent)); return el ? { has: true, approve: /✅\s*Approve/.test(el.textContent), reject: /❌\s*Reject/.test(el.textContent), submit: /Submit/.test(el.textContent) } : { has: false }; });
    ok(card.has, 'the staged-branch review renders as an actionable card in the 🔔 inbox');
    ok(card.approve && card.reject, 'it shows inline ✅ Approve / ❌ Reject decision controls');
    ok(card.submit, 'it has a Submit button to act right there');
    // pick Approve, then Submit
    await page.evaluate(() => { const el = [...document.querySelectorAll('#att-list .ask')].find(a => /Self-improve ready to review/.test(a.textContent)); const lab = [...el.querySelectorAll('label,span,div')].find(n => /✅\s*Approve/.test(n.textContent) && n.querySelector('input,*') !== undefined); const inp = el.querySelector('input[value="approve"]') || (lab && lab.querySelector('input')); if (inp) { inp.click(); } else if (lab) lab.click(); });
    await page.waitForTimeout(250);
    await page.evaluate(() => { const el = [...document.querySelectorAll('#att-list .ask')].find(a => /Self-improve ready to review/.test(a.textContent)); const btn = [...el.querySelectorAll('button')].find(b => /Submit/.test(b.textContent)); if (btn) btn.click(); });
    await page.waitForTimeout(1200);
    ok(answerResp && answerResp.ok === true, `/asks/answer returned ok (${JSON.stringify(answerResp)})`);
    ok(answerResp && answerResp.selfImprove === 'merging', `server routed the APPROVE to the merge handler (selfImprove=${answerResp && answerResp.selfImprove})`);
    // the ask is resolved out of the inbox (marked done by the interceptor)
    const stillOpen = await page.evaluate(async () => { const r = await (await fetch('/asks/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: localStorage.getItem('field-agent-cap') }) })).json(); return (r.asks || []).some(a => a.id === 'ask-e2e-selfimprove'); });
    ok(stillOpen === false, 'the review is resolved out of the inbox once acted on');
    ok(errs.length === 0, `no page errors (${errs.slice(0,2).join(' | ')})`);
    await page.close();
  } finally { await br.close(); restore(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); restore(); process.exit(2); });
