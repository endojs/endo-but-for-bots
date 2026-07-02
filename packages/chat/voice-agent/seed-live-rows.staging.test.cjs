#!/usr/bin/env node
// seed-live-rows.staging.test.cjs — a STAGING (real-run, headless) guard that INBOUND CAPTURES being
// ingested show up in the chats list IN REAL TIME, advancing by stage, and RESOLVE into the normal
// seed-chat row without duplication.
//
// It boots an isolated voice-agent (with the SEED_CELL_TEST_SEAM route, so stage transitions are driven
// deterministically without needing the LLM) and asserts, over the REAL HTTP broker + REAL client:
//   1. a root cap subscribing to `seeds:self` on /cells/subscribe receives the stage SEQUENCE
//      (received → understanding → proposed) as the capture is driven;
//   2. a REAL POST /ingest emits the first in-voice-agent stages (received, understanding) synchronously
//      (pre-LLM), proving the ingest pipeline itself is wired to the cell;
//   3. a NON-OWNER cap (a scoped invite cap) is REFUSED the owner's `seeds:root` cell (owner gate holds);
//   4. headless: driving a capture through the seam renders a live in-flight row (spinner + stage label)
//      at the top of the chat list, the row ADVANCES its stage, and when it reaches `proposed` (its
//      seed-chat has landed) it RESOLVES into the normal row — with NO duplicate.
//
// Run: node seed-live-rows.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8811;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-live-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

// tiny JSON POST helper
const post = (pathname, body) => new Promise((resolve, reject) => {
  const q = http.request(`${BASE}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' } }, x => {
    let d = ''; x.on('data', c => (d += c)); x.on('end', () => { try { resolve({ status: x.statusCode, body: d ? JSON.parse(d) : null }); } catch { resolve({ status: x.statusCode, body: d }); } });
  });
  q.on('error', reject); q.end(JSON.stringify(body));
});

// open a /cells/subscribe SSE stream; collect parsed data frames for `id` until `predicate(frames)` or timeout.
const collectStream = (body, id, predicate, timeoutMs = 8000) => new Promise(resolve => {
  const frames = [];
  const q = http.request(`${BASE}/cells/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' } }, x => {
    let buf = '';
    const done = err => { try { q.destroy(); } catch {} resolve({ status: x.statusCode, frames, err }); };
    x.on('data', c => {
      buf += c.toString();
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
        try { const m = JSON.parse(line.slice(5).trim()); if (m && m.id === id) { frames.push(m); if (predicate(frames)) return done(null); } } catch {}
      }
    });
    x.on('end', () => resolve({ status: x.statusCode, frames, err: 'ended' }));
  });
  q.on('error', e => resolve({ status: 0, frames, err: e.message }));
  q.end(JSON.stringify(body));
  setTimeout(() => { try { q.destroy(); } catch {} resolve({ status: 200, frames, err: 'timeout' }); }, timeoutMs);
});

const stagesSeen = frames => frames.filter(f => !f.error && Array.isArray(f.value)).flatMap(f => f.value.map(c => c.stage));

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', SEED_CELL_TEST_SEAM: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      SEED_CHATS_FILE: path.join(tmp, 'seed-chats.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  // readiness = OUR server wrote its root.swiss AND answers HTTP (guards against a stale server on the port
  // answering `/` while ours failed to bind — that would leave root.swiss missing).
  const swissPath = path.join(tmp, 'root.swiss');
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if ((r.ok || r.status === 404) && fs.existsSync(swissPath)) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (root.swiss written)');
  if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(swissPath, 'utf8').trim();

  // ── 1. the seeds:self cell delivers the driven stage SEQUENCE to the owner ─────────────────────────
  const capId = 'chat-seamtest1';
  // start the subscriber, then drive stages; resolve once we've seen the capture reach 'proposed'.
  const streamP = collectStream({ cap: rootCap, cells: ['seeds:self'] }, 'seeds:self',
    frames => stagesSeen(frames).includes('proposed'));
  await sleep(300); // let the stream attach (initial empty snapshot arrives)
  await post('/ingest/_test-stage', { cap: rootCap, id: capId, stage: 'received', title: '' });
  await sleep(120);
  await post('/ingest/_test-stage', { cap: rootCap, id: capId, stage: 'understanding' });
  await sleep(120);
  await post('/ingest/_test-stage', { cap: rootCap, id: capId, stage: 'proposed', title: 'Buy milk and call Sam', chatId: capId });
  const s1 = await streamP;
  const seq = stagesSeen(s1.frames);
  ok(seq.includes('received'), 'owner sees stage: received');
  ok(seq.includes('understanding'), 'owner sees stage: understanding');
  ok(seq.includes('proposed'), 'owner sees stage: proposed');
  ok(seq.indexOf('received') <= seq.indexOf('understanding') && seq.indexOf('understanding') <= seq.indexOf('proposed'), 'stages arrive in monotonic order');
  const last = s1.frames.filter(f => Array.isArray(f.value)).pop();
  ok(last && last.value.some(c => c.id === capId && c.title === 'Buy milk and call Sam' && c.chatId === capId), 'the proposed row carries the scrubbed title + chatId (no cap)');

  // ── 2. a REAL /ingest emits the first in-voice-agent stages synchronously (pre-LLM) ────────────────
  const ingestStreamP = collectStream({ cap: rootCap, cells: ['seeds:self'] }, 'seeds:self',
    frames => { const st = stagesSeen(frames); return st.includes('received') && st.includes('understanding'); }, 6000);
  await sleep(300);
  post('/ingest', { cap: rootCap, transcript: 'remember to water the plants and email the landlord about the leak', source: 'voice' }).catch(() => {});
  const s2 = await ingestStreamP;
  const st2 = stagesSeen(s2.frames);
  ok(st2.includes('received') && st2.includes('understanding'), 'a real POST /ingest drives the pipeline stages into the cell');

  // ── 3. owner gate: a NON-OWNER scoped cap is refused the root owner's seeds:root cell ──────────────
  const inv = await post('/invite', { cap: rootCap, powers: ['reference'], label: 'SeedGuest' });
  const guestCap = inv.body && inv.body.scopedCap;
  ok(!!guestCap, 'minted a scoped (non-root) guest cap');
  if (guestCap) {
    const g = await collectStream({ cap: guestCap, cells: ['seeds:root'] }, 'seeds:root',
      frames => frames.some(f => f.error), 3000);
    ok(g.frames.some(f => f.error === 'not your captures'), 'a non-owner cap is REFUSED the owner\'s seeds:root cell');
    // …but the guest CAN follow its OWN captures (seeds:self resolves to its own key — allowed, just empty)
    const gSelf = await collectStream({ cap: guestCap, cells: ['seeds:self'] }, 'seeds:self',
      frames => frames.length > 0, 3000);
    ok(gSelf.frames.some(f => !f.error && Array.isArray(f.value) && f.value.length === 0), 'the guest may follow its OWN (empty) seeds:self cell');
  }

  // ── 4. headless: a live in-flight row appears, advances, and resolves without duplication ──────────
  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - headless render checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', e.message));
    page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });
    await page.addInitScript(cap => { localStorage.setItem('field-agent-cap', cap); }, rootCap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    // wait for BOOT to complete: initChats() renders the sidebar (#chat-items) + starts subscribeSeedCells.
    await page.waitForSelector('#chat-items', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800); // let the seeds:self stream attach

    const hcap = 'chat-headless1';
    // drive: received → the in-flight row must appear with a spinner + stage label, and NO real chat row yet
    await post('/ingest/_test-stage', { cap: rootCap, id: hcap, stage: 'received', title: '' });
    await page.waitForSelector(`#chat-items .chat-item.inflight[data-inflight="${hcap}"]`, { timeout: 5000 }).catch(() => {});
    const row = page.locator(`#chat-items .chat-item.inflight[data-inflight="${hcap}"]`);
    ok(await row.count() === 1, 'an inbound capture renders a live in-flight row at the top of the chat list');
    ok(await row.locator('.ci-spin').count() === 1, 'the in-flight row shows a spinner');
    const label1 = (await row.locator('.ci-stage').textContent().catch(() => '')) || '';
    ok(/received/i.test(label1), `the row shows the received stage (got: "${label1}")`);

    // advance → understanding: the SAME row updates its stage label (no new row)
    await post('/ingest/_test-stage', { cap: rootCap, id: hcap, stage: 'understanding' });
    await page.waitForTimeout(400);
    const label2 = (await page.locator(`#chat-items .chat-item.inflight[data-inflight="${hcap}"] .ci-stage`).textContent().catch(() => '')) || '';
    ok(/understanding/i.test(label2), `the in-flight row ADVANCED its stage in place (got: "${label2}")`);
    ok(await page.locator(`#chat-items .chat-item.inflight[data-inflight="${hcap}"]`).count() === 1, 'still exactly ONE in-flight row for this capture (advanced in place, not duplicated)');

    // screenshot the live row mid-processing (evidence) — open the drawer so the sidebar list is visible
    await page.evaluate(() => document.getElementById('hamburger') && document.getElementById('hamburger').click()).catch(() => {});
    await page.waitForTimeout(400);
    const shot = path.join(__dirname, 'seed-live-rows.screenshot.png');
    await page.screenshot({ path: shot }).catch(() => {});
    console.log('  screenshot →', shot);

    // clear the synthetic seam row so it can't confuse the resolve check (drive it done + past the render dedupe)
    await post('/ingest/_test-stage', { cap: rootCap, id: hcap, stage: 'done', chatId: hcap });

    // ── RESOLVE / DEDUPE, end-to-end through the REAL /ingest pipeline (no seam): a real voice note runs
    //    the full received → understanding → proposed lifecycle, its seed-chat is persisted, and the client
    //    (which fires loadSeedChats on 'proposed') adopts it — the in-flight row must RESOLVE into a SINGLE
    //    normal chat row with the same id, never a duplicate.
    const ing = await post('/ingest', { cap: rootCap, transcript: 'water the plants and email the landlord about the leak', source: 'voice' });
    const rid = ing.body && ing.body.chatId;
    ok(!!rid, `real /ingest created a seed-chat (${rid})`);
    // give the client time to receive the 'proposed' push + round-trip loadSeedChats + adopt
    let resolved = false, dupCount = -1, normalCount = -1;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      dupCount = await page.locator(`#chat-items .chat-item.inflight[data-inflight="${rid}"]`).count();
      normalCount = await page.locator(`#chat-items .chat-item[data-id="${rid}"]:not(.inflight)`).count();
      if (dupCount === 0 && normalCount === 1) { resolved = true; break; }
    }
    ok(resolved, `the ingested capture resolved into exactly ONE normal chat row with no in-flight duplicate (inflight=${dupCount}, normal=${normalCount})`);
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
