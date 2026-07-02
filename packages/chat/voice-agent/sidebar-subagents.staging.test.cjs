#!/usr/bin/env node
// sidebar-subagents.staging.test.cjs — a STAGING (real-run, headless) guard that SUB-AGENT chats
// (specialists / scoped sub-chats, linked by `parentId`) render NESTED under their parent in the left
// sidebar, collapsed by default and expandable — not as loose top-level rows.
//
// It boots an isolated voice-agent, seeds a parent chat + two sub-agent chats into the client's chat
// store (localStorage, before boot), loads the app headless, and asserts:
//   1. the parent renders with a disclosure triangle; its children are HIDDEN by default (collapsed);
//   2. the two sub-agent chats are NOT loose top-level rows while collapsed;
//   3. clicking the triangle REVEALS both children as nested `.chat-item.child` rows;
//   4. the parent shows a "2" sub-agent count badge.
//
// Run: node sidebar-subagents.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-sub-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - headless sidebar checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }

  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();
  const now = Date.now();
  // one parent chat + two sub-agent chats that point back to it via parentId (the specialist / scoped-subchat link)
  const seededChats = [
    { id: 'p-parent', title: 'Flock cameras plan', ts: now - 5000, lastMsgAt: now - 5000 },
    { id: 'c-legal', title: 'Legal specialist', ts: now - 3000, lastMsgAt: now - 3000, parentId: 'p-parent', agent: 'legal' },
    { id: 'c-research', title: 'Research specialist', ts: now - 1000, lastMsgAt: now - 1000, parentId: 'p-parent', agent: 'research' },
    { id: 'x-other', title: 'Grocery list', ts: now - 4000, lastMsgAt: now - 4000 },
  ];
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    // seed the client store BEFORE any app script runs (initChats reads localStorage on boot)
    await page.addInitScript(([cap, chatsJson]) => {
      localStorage.setItem('field-agent-cap', cap);
      localStorage.setItem('field-agent-chats', chatsJson);
    }, [rootCap, JSON.stringify(seededChats)]);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    // wait for the sidebar to populate from initChats()
    await page.waitForSelector('#chat-items .chat-item', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);

    const parentRow = page.locator('#chat-items .chat-item[data-id="p-parent"]');
    ok(await parentRow.count() === 1, 'parent chat renders in the sidebar');
    ok(await parentRow.locator('.ci-twist').count() === 1, 'parent has a disclosure triangle (has sub-agent chats)');
    ok((await parentRow.locator('.ci-kidcount').textContent().catch(() => '')) === '2', 'parent shows a "2" sub-agent count badge');

    // collapsed by default: the child rows are not present yet
    const childrenVisible = async () => page.locator('#chat-items .chat-item.child').count();
    ok(await childrenVisible() === 0, 'sub-agent chats are HIDDEN by default (collapsed)');
    // and they are NOT loose top-level rows either
    ok(await page.locator('#chat-items .chat-item[data-id="c-legal"]:not(.child)').count() === 0, 'sub-agent chat is not a loose top-level row while collapsed');

    // expand
    // fire the toggle handler directly (the sidebar drawer sits off-viewport in headless; this is a functional check)
    await page.evaluate(() => document.querySelector('#chat-items .chat-item[data-id="p-parent"] .ci-twist').click());
    await page.waitForTimeout(250);
    ok(await childrenVisible() === 2, 'clicking the triangle reveals BOTH sub-agent chats as nested child rows');
    ok(await page.locator('#chat-items .chat-item.child[data-id="c-legal"]').count() === 1, 'the legal specialist appears as a nested child');
    ok(await page.locator('#chat-items .chat-item.child[data-id="c-research"]').count() === 1, 'the research specialist appears as a nested child');
    // the unrelated chat stays a normal top-level row
    ok(await page.locator('#chat-items .chat-item[data-id="x-other"]:not(.child)').count() === 1, 'an unrelated chat stays a top-level row');

    // collapse again → children hidden (toggle works both ways)
    // fire the toggle handler directly (the sidebar drawer sits off-viewport in headless; this is a functional check)
    await page.evaluate(() => document.querySelector('#chat-items .chat-item[data-id="p-parent"] .ci-twist').click());
    await page.waitForTimeout(250);
    ok(await childrenVisible() === 0, 'clicking again collapses the sub-agent chats');
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
