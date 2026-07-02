#!/usr/bin/env node
// meeting-history.staging.test.cjs — STAGING guard for INC-7: the record-meeting feature persists a
// transcript-only record per cap (👥 → /meeting/transcribe writes <VOICE_STATE_DIR>/meetings/<capHash>/…);
// this proves the history-BROWSE half now round-trips end to end:
//   (1) /meeting/list reads a seeded record back (newest-first, transcript included), and
//   (2) the 🗂 button opens a modal that lists it and shows the full transcript.
// Isolated server + ephemeral port + mkdtemp (never the live :8778). SKIPs the UI leg without chromium.
//
// Run: node meeting-history.staging.test.cjs
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const capHash = c => crypto.createHash('sha256').update(String(c || '')).digest('hex').slice(0, 16); // mirror server.mjs

(async () => {
  const srv = await startIsolatedServer();
  const cap = srv.cap;
  try {
    // Seed a meeting record directly into the sandbox meetings dir (same layout /meeting/transcribe writes),
    // so the test needs no external diarizer.
    const mdir = path.join(srv.dir, 'voice', 'meetings', capHash(cap));
    fs.mkdirSync(mdir, { recursive: true });
    const TRANSCRIPT = 'Alice: shall we ship the meeting history? Bob: yes, wire the list button.';
    const rec = { id: 'mtg-seedaaa1', at: '2026-06-30T14:00:00.000Z', speakers: ['Alice', 'Bob'], segments: [], transcript: TRANSCRIPT };
    fs.writeFileSync(path.join(mdir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
    // A second, newer one to prove newest-first ordering.
    const rec2 = { id: 'mtg-seedaaa2', at: '2026-07-01T09:30:00.000Z', speakers: ['Carol'], segments: [], transcript: 'Carol: standup notes.' };
    fs.writeFileSync(path.join(mdir, `${rec2.id}.json`), JSON.stringify(rec2, null, 2));

    // ── (1) route round-trip ─────────────────────────────────────────────────────────────
    const r = await (await fetch(`${srv.base}/meeting/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
    ok(Array.isArray(r.meetings) && r.meetings.length === 2, `/meeting/list returns both seeded meetings (got ${r.meetings ? r.meetings.length : 'none'})`);
    ok(r.meetings && r.meetings[0] && r.meetings[0].id === 'mtg-seedaaa2', 'newest-first ordering (newer record first)');
    const seen = (r.meetings || []).find(m => m.id === 'mtg-seedaaa1');
    ok(seen && seen.transcript === TRANSCRIPT, 'the full transcript rides back in the list');
    ok(seen && Array.isArray(seen.speakers) && seen.speakers.length === 2, 'speakers are listed');

    // no-cap is refused (gate parity with the persist route)
    const noCap = await fetch(`${srv.base}/meeting/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    ok(noCap.status === 403, `/meeting/list without a cap is 403 (got ${noCap.status})`);

    // ── (2) UI round-trip ────────────────────────────────────────────────────────────────
    const chromium = loadChromium();
    if (!chromium) { console.log('  SKIP - no chromium (route leg still asserted)'); }
    else {
      const br = await launchBrowser(chromium);
      try {
        const page = await br.newPage();
        await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
        await page.goto(`${srv.base}/`, { waitUntil: 'load' });
        await page.waitForTimeout(2500);
        const hasBtn = await page.evaluate(() => !!document.getElementById('meeting-hist-btn'));
        ok(hasBtn, 'the 🗂 past-meetings button is mounted next to 👥');
        await page.evaluate(() => document.getElementById('meeting-hist-btn').click());
        await page.waitForTimeout(1200);
        const listText = await page.evaluate(() => { const m = document.getElementById('qrmodal'); return m ? m.textContent : ''; });
        ok(/Past meetings/.test(listText) && /2 speakers/.test(listText), 'the modal lists past meetings with speaker counts');
        // open the older meeting's full transcript
        const opened = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('#qrmodal [data-mtg-open]')];
          const b = btns[btns.length - 1]; if (!b) return false; b.click(); return true; // last row = oldest
        });
        ok(opened, 'an "open" affordance exists per meeting row');
        await page.waitForTimeout(600);
        const detail = await page.evaluate(() => { const m = document.getElementById('qrmodal'); return m ? m.textContent : ''; });
        ok(/ship the meeting history/.test(detail), 'opening a meeting shows its full diarized transcript');
        await page.close();
      } finally { await br.close(); }
    }
  } finally { srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
