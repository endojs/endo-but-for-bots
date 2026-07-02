#!/usr/bin/env node
// inbox-cells.staging.test.cjs — a STAGING (real-run) guard that the 🔔 bell + inbox surfaces are PUSH-fed
// over the one /cells/subscribe broker (feed:/asks: cell families) instead of a 60s poll.
//
// It boots an ISOLATED voice-agent (ephemeral port, mkdtemp state dirs — NEVER the live :8778 / real feed)
// and asserts, over the REAL HTTP broker:
//   1. a root cap subscribing to `feed:self` gets an initial snapshot AND a fresh {rev} push the moment a
//      feed entry is written (POST /error/flag → postFeed → bump + fs.watch);
//   2. `asks:self` pushes when asks.json changes (an ask written to the store → fs.watch push);
//   3. a NON-OWNER scoped cap is REFUSED the owner's `feed:root` / `asks:root` cells (owner gate holds),
//      but may follow its OWN (valid-but-idle) feed:self / asks:self;
//   4. the poke carries NO content (rev/at only — cap-hygiene: no swissnum, no feed body in the cell value).
//
// Run: node inbox-cells.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8813;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-cells-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

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
    const done = () => { try { q.destroy(); } catch {} resolve({ status: x.statusCode, frames }); };
    x.on('data', c => {
      buf += c.toString();
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
        try { const m = JSON.parse(line.slice(5).trim()); if (m && m.id === id) { frames.push(m); if (predicate(frames)) return done(); } } catch {}
      }
    });
    x.on('end', () => resolve({ status: x.statusCode, frames }));
  });
  q.on('error', () => resolve({ status: 0, frames }));
  q.end(JSON.stringify(body));
  setTimeout(() => { try { q.destroy(); } catch {} resolve({ status: 200, frames }); }, timeoutMs);
});

const revsSeen = frames => frames.filter(f => !f.error && f.value && typeof f.value.rev === 'number').map(f => f.value.rev);

(async () => {
  // Isolation: DASH_STATE_DIR (feed.json + asks.json) + VOICE_STATE_DIR to mkdtemp — NEVER the live feed.
  // CONFIG_DIR is left real (FIELD_MODE=personal + persona load), matching the proven seed-live-rows recipe;
  // this test writes only isolated feed/asks/notif/invite state.
  const dash = path.join(tmp, 'dash');
  const voice = path.join(tmp, 'voice');
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      DASH_STATE_DIR: dash, VOICE_STATE_DIR: voice, FIELD_STATE_DIR: path.join(tmp, 'state'),
      MEMO_RUNS_FILE: path.join(tmp, 'memo.json'), SEED_CHATS_FILE: path.join(tmp, 'seed-chats.json'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const swissPath = path.join(tmp, 'root.swiss');
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if ((r.ok || r.status === 404) && fs.existsSync(swissPath)) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (root.swiss written)');
  if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(swissPath, 'utf8').trim();

  // ── 1. feed:self pushes when feed.json is written (the fs.watch trigger — this is the cross-process path
  //    the agent-facing notify/pushFeed writer takes) ─────────────────────────────────────────────────
  const feedFile = path.join(dash, 'feed.json');
  const feedP = collectStream({ cap: rootCap, cells: ['feed:self'] }, 'feed:self', frames => revsSeen(frames).some(r => r >= 1));
  await sleep(300); // let the stream attach (initial rev:0 snapshot arrives)
  // write a feed entry directly (mirrors the external notify/pushFeed writer → fs.watch push).
  fs.writeFileSync(feedFile, JSON.stringify({ entries: [{ id: 'sched-staging1', date: new Date().toISOString(), kind: 'notification', title: 'A staging notification', status: '🔔 needs your attention' }] }, null, 2));
  const f1 = await feedP;
  const feedRevs = revsSeen(f1.frames);
  ok(feedRevs.includes(0), 'feed:self delivers the initial snapshot (rev 0)');
  ok(feedRevs.some(r => r >= 1), 'feed:self PUSHES a bumped revision the moment a feed entry is written');
  const feedVals = f1.frames.filter(f => !f.error && f.value).map(f => f.value);
  ok(feedVals.every(v => Object.keys(v).sort().join(',') === 'at,rev'), 'the feed poke carries ONLY {rev,at} — no content, no swissnum (cap-hygiene)');

  // ── 2. asks:self pushes when asks.json changes ─────────────────────────────────────────────────────
  const asksFile = path.join(dash, 'asks.json');
  const asksP = collectStream({ cap: rootCap, cells: ['asks:self'] }, 'asks:self', frames => revsSeen(frames).some(r => r >= 1));
  await sleep(300);
  // write an open ask directly to the store file (mirrors an off-app agent raising an ask → fs.watch push).
  const ask = { id: 'ask-staging1', title: 'A staging ask', status: 'open', origin: { kind: 'chat', chatId: 'c1' }, questions: [{ id: 'q', q: 'ok?', type: 'bool' }] };
  fs.writeFileSync(asksFile, JSON.stringify({ asks: [ask] }, null, 2));
  const a1 = await asksP;
  const askRevs = revsSeen(a1.frames);
  ok(askRevs.includes(0), 'asks:self delivers the initial snapshot (rev 0)');
  ok(askRevs.some(r => r >= 1), 'asks:self PUSHES when asks.json changes (fs.watch trigger)');

  // ── 2b. dev:self pushes when the Blacksmith dev-task queue changes (/thread/reply appends → bump) ───
  const devP = collectStream({ cap: rootCap, cells: ['dev:self'] }, 'dev:self', frames => revsSeen(frames).some(r => r >= 1));
  await sleep(300);
  await post('/thread/reply', { cap: rootCap, parent: 'task-staging1', chatId: 'c1', text: 'a staging dev follow-up' });
  const d1 = await devP;
  ok(revsSeen(d1.frames).includes(0), 'dev:self delivers the initial snapshot (rev 0)');
  ok(revsSeen(d1.frames).some(r => r >= 1), 'dev:self PUSHES when the dev-task queue changes');

  // ── 3. owner gate: a NON-OWNER scoped cap is refused the owner's feed:root / asks:root cells ────────
  const inv = await post('/invite', { cap: rootCap, powers: ['reference'], label: 'InboxGuest' });
  const guestCap = inv.body && inv.body.scopedCap;
  ok(!!guestCap, 'minted a scoped (non-root) guest cap');
  if (guestCap) {
    const gFeed = await collectStream({ cap: guestCap, cells: ['feed:root'] }, 'feed:root', frames => frames.some(f => f.error), 3000);
    ok(gFeed.frames.some(f => f.error === 'not your inbox'), 'a non-owner cap is REFUSED the owner\'s feed:root cell');
    const gAsks = await collectStream({ cap: guestCap, cells: ['asks:root'] }, 'asks:root', frames => frames.some(f => f.error), 3000);
    ok(gAsks.frames.some(f => f.error === 'not your inbox'), 'a non-owner cap is REFUSED the owner\'s asks:root cell');
    // …but the guest CAN follow its OWN (valid-but-idle) feed:self — resolves to its own key, empty inbox.
    const gSelf = await collectStream({ cap: guestCap, cells: ['feed:self'] }, 'feed:self', frames => frames.length > 0, 3000);
    ok(gSelf.frames.some(f => !f.error && f.value && f.value.rev === 0), 'the guest may follow its OWN (idle) feed:self cell');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
