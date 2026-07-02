#!/usr/bin/env node
// fork-distribution.staging.test.cjs — STAGING proof of Phase-5 distribution-trust through real HTTP + a
// real browser: an end-user (forEndUsers) share is GATED until a reviewer approves the served version;
// approval is content-pinned; the trust graph is delegatable; the widget shows the gate + the badge.
//
// Run: node fork-distribution.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-dist-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

const V1 = "(endowments, props) => endowments.h(Banner, { kind: 'info' }, 'DIST v1')";
const V2 = "(endowments, props) => endowments.h(Banner, { kind: 'info' }, 'DIST v2')";

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'), DIST_TRUST_STORE: path.join(tmp, 'dist-trust.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (FIELD_LOCKDOWN=1)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── trust graph (root is the base authority) ─────────────────────────────────────────────────────
  const who = await post('/forks/review/reviewers', { cap });
  ok(who.ok && who.amReviewer === true && who.me === 'root', 'root is a distribution reviewer');
  ok((await post('/forks/review/grant', { cap, reviewerId: 'u:alice' })).ok, 'root vouches for a reviewer (outward trust flow)');

  // ── end-user gate ────────────────────────────────────────────────────────────────────────────────
  const c = await post('/forks/create', { cap, source: V1, name: 'Dist fork' });
  const s = await post('/forks/share', { cap, id: c.id, forEndUsers: true, charge: { scheme: 'free' } });
  ok(c.ok && s.ok && s.token, 'owner created + made an END-USER share');

  let o = await post('/forks/open', { token: s.token });
  ok(o.ok && o.gated === true && o.source === '' && o.distribution.approved === false, 'end-user open is GATED before review (source withheld)');

  ok((await post('/forks/review/approve', { cap, id: c.id })).ok, 'a reviewer (root) approves the fork version');
  o = await post('/forks/open', { token: s.token });
  ok(o.ok && !o.gated && o.source === V1 && o.distribution.approved === true && o.distribution.by === 'root', 'after approval the end-user receives the source');

  // ── content-pinned: an edit at the SAME share still serves the approved pinned version ────────────
  await post('/forks/edit', { cap, id: c.id, source: V2 }); // fork → v2; the share is pinned to v1 (approved)
  o = await post('/forks/open', { token: s.token });
  ok(o.source === V1 && o.distribution.approved === true, 'share still serves the approved v1 (pin) — an edit cannot sneak unreviewed code to end-users');
  // a NEW end-user share at v2 is gated until v2 is reviewed
  const s2 = await post('/forks/share', { cap, id: c.id, forEndUsers: true, charge: { scheme: 'free' } });
  ok((await post('/forks/open', { token: s2.token })).gated === true, 'a fresh end-user share of the EDITED (v2) source is gated (content-pinned approval)');

  // ── revoke approval re-gates ──────────────────────────────────────────────────────────────────────
  ok((await post('/forks/review/unapprove', { cap, id: c.id, source: V1 })).ok, 'reviewer revokes the v1 approval');
  ok((await post('/forks/open', { token: s.token })).gated === true, 'the original end-user share is gated again after un-approval');

  // ── browser: the widget shows the gate, then renders once approved ───────────────────────────────
  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser gate check (no chromium)'); }
  else {
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage();
      await page.addInitScript(cc => { try { localStorage.setItem('field-agent-cap', cc); } catch {} }, cap);
      await page.goto(`${BASE}/#fork=${encodeURIComponent(s.token)}`, { waitUntil: 'load' });
      await page.waitForFunction(() => { const st = document.querySelector('.fork-stage'); return st && /pending|🔒/.test(st.textContent || ''); }, { timeout: 6000 }).catch(() => {});
      ok(await page.evaluate(() => /pending|🔒/.test((document.querySelector('.fork-stage') || {}).textContent || '')), 'the widget shows the gated "pending review" note (no source rendered)');
      // re-approve v1 → re-open in a fresh nav → renders
      await post('/forks/review/approve', { cap, id: c.id, source: V1 });
      await page.goto(`${BASE}/?r=2#fork=${encodeURIComponent(s.token)}`, { waitUntil: 'load' });
      await page.waitForFunction(() => /DIST v1/.test((document.querySelector('.fork-stage') || {}).textContent || ''), { timeout: 6000 }).catch(() => {});
      ok(await page.evaluate(() => /DIST v1/.test((document.querySelector('.fork-stage') || {}).textContent || '')), 'after re-approval the widget renders the approved source');
      await page.close();
    } finally { await browser.close(); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
