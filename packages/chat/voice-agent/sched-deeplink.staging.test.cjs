#!/usr/bin/env node
// sched-deeplink.staging.test.cjs — STAGING proof for #sched=<id> deep links (dan: "It's in my root
// powers' scheduled tasks object. I should have a way to link to those.").
//
// Drives the LIVE voice-agent (:8778) with the real root cap against the real projects store:
//   1. root + #sched=sched-7dd77b8ee7cf → the Projects Detail opens with THAT task's card spotlighted:
//      name, config (mode/model/always-reports), 🔗 copy-link affordance, run history auto-expanded
//      with today's real runs (each run with a chatId gets an "open" button → its chat).
//   2. root + an unknown id → the graceful "Not found — … or your capability doesn't own it" path.
//      (Server-side owner gating is the EXISTING /projects/list gate: an invalid cap gets 403, a
//      non-owner cap gets an owner-filtered list — the id designates, the cap authorizes.)
//   3. NO cap + #sched=… → inert: the no-link gate shows, no detail modal, no page errors
//      (the deep link carries only a designator; without a stored cap it resolves to nothing).
//   4. feed-card round-trip: a 🔔 notification whose links[] carries {label:'scheduled task',
//      href:'<public origin>/#sched=<id>'} renders as an in-app "⏰ scheduled task" link (cross-origin
//      href routed IN-APP — never a capless bounce through the other origin) and clicking it opens the
//      task's Detail. (/feed/load stubbed for determinism — forcing a real run would spend real inference.)
//
// Run: node sched-deeplink.staging.test.cjs   (exits non-zero on any failure)
const fs = require('node:fs');
const path = require('node:path');
const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');

const SCHED_ID = 'sched-7dd77b8ee7cf'; // Weekly self-eval → eval-gated improvement
const SIB_ID = 'sched-64b31253dfb8';   // the disabled sibling
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };

(async () => {
  // ISOLATED server + its OWN projects store, seeded with a fixture matching the deep-link assertions.
  // (This test used to drive the LIVE :8778 against dan's REAL scheduled-task store — reading production data.
  // The UNIT under test is the #sched deep-link routing UI, so we seed an equivalent task set here.)
  const srv = await startIsolatedServer();
  const BASE = srv.base;
  const cap = srv.cap;
  const nowIso = () => new Date().toISOString();
  const fixture = { updated: nowIso(), projects: { 'proj-sched-fixture': {
    id: 'proj-sched-fixture', name: 'Scheduled tasks', owner: 'root', chatIds: [],
    homeSubkey: 'project-proj-sched-fixture', createdAt: nowIso(), scheduledAgents: [
      { id: SCHED_ID, name: 'Weekly self-eval → eval-gated improvement', prompt: 'review the week',
        tools: ['roles', 'chatCorpus', 'selfImprove'], schedule: { kind: 'weekly', day: 1, at: '02:00' }, trigger: null,
        model: 'anthropic:claude-sonnet-5', mode: 'implement', enabled: true, alwaysReport: true, originChat: null,
        createdAt: nowIso(), lastRun: nowIso(), lastRunChatId: 'chat-schedrun-1', nextAt: null, runs: [
          { at: nowIso(), chatId: 'chat-schedrun-1', ok: true, nProp: 1, summary: 'reviewed the week', spentUusd: 0 },
          { at: nowIso(), chatId: 'chat-schedrun-2', ok: true, nProp: 0, summary: 'no-op run', spentUusd: 0 },
        ] },
      { id: SIB_ID, name: 'Nightly digest — Disabled 2026-07-01', prompt: 'digest',
        tools: ['chatCorpus'], schedule: { kind: 'daily', at: '03:00' }, trigger: null,
        model: 'default', mode: 'recommend', enabled: false, alwaysReport: false, originChat: null,
        createdAt: nowIso(), lastRun: null, nextAt: null, runs: [] },
    ] } } };
  fs.writeFileSync(path.join(srv.dir, 'projects.json'), JSON.stringify(fixture, null, 2));

  // ── server-side gate (curl-level): the designator resolves only through a valid cap ──
  const bad = await fetch(`${BASE}/projects/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: 'not-a-cap' }) });
  ok(bad.status === 403, `/projects/list rejects an invalid cap (403) — the sched id alone grants nothing (got ${bad.status})`);
  const good = await (await fetch(`${BASE}/projects/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
  const proj = (good.projects || []).find(p => (p.scheduledAgents || []).some(a => a.id === SCHED_ID));
  ok(!!proj, `root's /projects/list resolves ${SCHED_ID} (project: ${proj && proj.name})`);
  const agent = proj && proj.scheduledAgents.find(a => a.id === SCHED_ID);
  ok(agent && (agent.runs || []).length > 0, `the task has real run history (${agent && (agent.runs || []).length} runs)`);

  const chromium = loadChromium();
  if (!chromium) { console.log('  SKIP - no chromium (browser half skipped)'); console.log(`\n${pass} passed, ${fail} failed`); srv.close(); process.exit(fail ? 1 : 0); }
  const br = await launchBrowser(chromium);
  try {
    // ── 1. root cap + #sched=<real id> → the task's Detail, spotlighted, runs expanded ──
    {
      const page = await br.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
      await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
      await page.goto(`${BASE}/#sched=${SCHED_ID}`, { waitUntil: 'load' });
      // the spotlight outline auto-clears after 2.5s — sample it the moment the card lands, not on a fixed wait
      await page.waitForFunction(sid => !!document.querySelector(`#qrmodal [data-schedcard="${sid}"]`), SCHED_ID, { timeout: 20000 });
      const spotlighted = await page.evaluate(sid => { const c = document.querySelector(`#qrmodal [data-schedcard="${sid}"]`); return !!(c && c.style.outline); }, SCHED_ID);
      await page.waitForTimeout(1500);
      const r = await page.evaluate(sid => {
        const m = document.getElementById('qrmodal');
        const card = m && m.querySelector(`[data-schedcard="${sid}"]`);
        const runlog = card && card.querySelector(`details[data-runlog="${sid}"]`);
        return {
          modalShown: !!m && !m.classList.contains('hide'),
          hashStripped: !location.hash.includes('sched'),
          text: (m && m.textContent) || '',
          cardText: (card && card.textContent) || '',
          hasCard: !!card,
          runlogOpen: !!(runlog && runlog.open),
          runRows: runlog ? runlog.querySelectorAll('.share').length : 0,
          runOpenBtns: runlog ? runlog.querySelectorAll('[data-openrun]').length : 0,
          hasCopyLink: !!(card && card.querySelector(`[data-schedlink="${sid}"]`)),
        };
      }, SCHED_ID);
      r.spotlighted = spotlighted;
      ok(r.modalShown && r.hasCard, 'detail opens on the deep link, with THAT task\'s card present');
      ok(r.hashStripped, 'the #sched fragment is stripped from the address bar after routing');
      ok(/Scheduled tasks/.test(r.text), 'shows the owning project ("Scheduled tasks")');
      ok(/Weekly self-eval/.test(r.cardText), 'shows the task name (Weekly self-eval → eval-gated improvement)');
      ok(/mode: implement/.test(r.cardText), 'config: mode: implement shown');
      ok(/always-reports/.test(r.cardText), 'config: alwaysReport shown');
      ok(/model: anthropic:claude-sonnet-5/.test(r.cardText), 'config: model shown');
      ok(/tools: roles, chatCorpus, selfImprove/.test(r.cardText), 'config: tool ring shown');
      ok(r.runlogOpen && r.runRows > 0, `run history auto-expanded with today's real runs (${r.runRows} rows)`);
      ok(r.runOpenBtns > 0, `runs with a chatId link to their chat (${r.runOpenBtns} open buttons)`);
      ok(r.hasCopyLink, 'the 🔗 copy-link affordance is on the card');
      ok(r.spotlighted, 'the deep-linked card is spotlighted (outline)');
      // the DISABLED sibling task carries its state + note on the same surface
      const sib = await page.evaluate(() => { const c = document.querySelector('[data-schedcard="sched-64b31253dfb8"]'); return (c && c.textContent) || ''; });
      ok(/⏸ disabled/.test(sib) && /Disabled 2026-07-01/.test(sib), 'sibling disabled task shows ⏸ disabled + its note');
      ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
      await page.close();
    }
    // ── 2. root cap + unknown id → graceful not-found ──
    {
      const page = await br.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
      await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
      await page.goto(`${BASE}/#sched=sched-000000000000`, { waitUntil: 'load' });
      await page.waitForTimeout(5000);
      const r = await page.evaluate(() => { const m = document.getElementById('qrmodal'); return { shown: !!m && !m.classList.contains('hide'), text: (m && m.textContent) || '' }; });
      ok(r.shown && /Not found/.test(r.text) && /doesn't own it/.test(r.text), 'unknown id → graceful "Not found … or your capability doesn\'t own it"');
      ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
      await page.close();
    }
    // ── 3. NO cap + #sched=<real id> → inert (the id is a designator, not authority) ──
    {
      const page = await br.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
      await page.goto(`${BASE}/#sched=${SCHED_ID}`, { waitUntil: 'load' });
      await page.waitForTimeout(2500);
      const r = await page.evaluate(() => ({
        noCap: !document.getElementById('nocap').classList.contains('hide'),
        modalHidden: document.getElementById('qrmodal').classList.contains('hide'),
      }));
      ok(r.noCap && r.modalHidden, 'without a stored cap the deep link is inert (no-link gate, no detail leaked)');
      ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
      await page.close();
    }
    // ── 4. feed-card round-trip: 🔔 card link → in-app Detail ──
    {
      const page = await br.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
      await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
      // deterministic feed: exactly what runProjectAgent's postFeed now emits, PUBLIC-origin href on purpose
      // (proves cross-origin #sched links are routed in-app, not bounced to a possibly-capless other origin).
      await page.route('**/feed/load', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'n-sched-test', date: new Date().toISOString(), agent: 'Weekly self-eval → eval-gated improvement', avatar: '⏰', title: 'Scheduled tasks › Weekly self-eval → eval-gated improvement', body: 'Reviewed the week. 1 proposal.', status: 'needs your input · 1 proposal(s)', chatId: null, note: 'tools: roles, chatCorpus, selfImprove', links: [{ label: 'scheduled task', url: `https://agentc.chu.vmkqx.com/#sched=${SCHED_ID}`, href: `https://agentc.chu.vmkqx.com/#sched=${SCHED_ID}` }], attention: true, dismissed: false }], attentionCount: 1 }) }));
      await page.goto(`${BASE}/`, { waitUntil: 'load' });
      await page.waitForTimeout(4500);
      await page.evaluate(() => document.getElementById('bell-btn').click());
      await page.waitForTimeout(1200);
      const link = await page.evaluate(sid => { const a = document.querySelector(`#att-list .nlink[data-opensched="${sid}"]`); return a ? a.textContent : null; }, SCHED_ID);
      ok(link === '⏰ scheduled task', `the feed card renders the sched link as an in-app affordance (got: ${JSON.stringify(link)})`);
      await page.evaluate(sid => { const a = document.querySelector(`#att-list .nlink[data-opensched="${sid}"]`); if (a) a.click(); }, SCHED_ID);
      await page.waitForTimeout(2500);
      const r = await page.evaluate(sid => { const m = document.getElementById('qrmodal'); const card = m && m.querySelector(`[data-schedcard="${sid}"]`); return { shown: !!m && !m.classList.contains('hide'), hasCard: !!card, name: !!(card && /Weekly self-eval/.test(card.textContent)) }; }, SCHED_ID);
      ok(r.shown && r.hasCard && r.name, 'clicking the feed-card link lands on the task\'s Detail (round-trip complete)');
      ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
      await page.close();
    }
  } finally { await br.close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', (e && e.stack) || e); process.exit(2); });
