#!/usr/bin/env node
// blossom-studio.staging.test.cjs — STAGING proof of the renderer STUDIO (the "Generate breaks into a chat"
// flow): opening the studio for an object renders a live preview fed the object's REAL data (so it's NOT
// empty) + a Revise prompt to iterate the renderer. Pre-seeds a ready renderer + an endo-peer object whose
// describe() resolves LOCALLY (so the sample/props.value is non-empty without a network round-trip).
//
// Run: node blossom-studio.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8835;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const METHODS = ['send', 'inbox', 'describe'];
const sig = `sig-${crypto.createHash('sha256').update(`iface:${[...METHODS].sort().join(',')}`).digest('hex').slice(0, 16)}`;
// a renderer that reads props.value (the object's data) → proves the preview is fed REAL data, not empty
const RENDERER = "(endowments, props) => endowments.h('div', { class: 'pv' }, 'PEER: ' + ((props.value && props.value.name) || 'EMPTY') + ' / ' + ((props.value && props.value.kind) || '?'))";

(async () => {
  const objectsFile = path.join(tmp, 'objects.json');
  const forksFile = path.join(tmp, 'forks.json');
  const blossomFile = path.join(tmp, 'blossom.json');
  fs.writeFileSync(objectsFile, JSON.stringify({ objects: [{ name: 'Kumavis', transport: 'endo-peer', peer: true, address: 'endo://x', swissnum: 'x', methods: METHODS, description: 'a peer', addedAt: 'now' }] }));
  const stamp = new Date().toISOString();
  fs.writeFileSync(forksFile, JSON.stringify({ forks: { 'fork-st': { id: 'fork-st', name: 'Kumavis renderer', baseId: `blossom:${sig}`, owner: 'root', source: RENDERER, createdAt: stamp, updatedAt: stamp, history: [{ source: RENDERER, at: stamp, note: 'blossom' }] } }, shares: {} }));
  fs.writeFileSync(blossomFile, JSON.stringify({ renderers: { [sig]: { sig, status: 'ready', forkId: 'fork-st', name: 'Kumavis', methods: METHODS, at: stamp, completedAt: stamp } }, count: 1 }));

  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      OBJECTS_FILE: objectsFile, FORKS_STORE: forksFile, BLOSSOM_STORE: blossomFile, PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (seeded renderer + endo-peer, FIELD_LOCKDOWN=1)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' }); await sleep(2000);

    // "Generate" breaks into a chat: a studio widget mounts
    await page.evaluate(() => window.openRendererStudio('Kumavis', ['send', 'inbox', 'describe']));
    await page.waitForFunction(() => !!document.querySelector('.bloom-mount'), { timeout: 6000 }).catch(() => {});
    ok(await page.$('.bloom-mount') !== null, 'Generate broke out into a chat with the renderer studio widget');

    // the preview renders the renderer fed the object's REAL data (describe resolved locally → non-empty)
    await page.waitForFunction(() => { const m = document.querySelector('.bloom-mount'); return m && /PEER: Kumavis/.test(m.textContent || ''); }, { timeout: 8000 }).catch(() => {});
    const stMount = await page.evaluate(() => { const m = document.querySelector('.bloom-mount'); return { text: m ? m.textContent : '', noIframe: m ? !m.querySelector('iframe') : true, reviseBtn: !!Array.from((m || document).querySelectorAll('button')).find(b => /Revise/.test(b.textContent)), reviseEnabled: !!Array.from((m || document).querySelectorAll('button')).find(b => /Revise/.test(b.textContent) && !b.disabled), input: !!(m && m.querySelector('input')) }; });
    ok(/PEER: Kumavis/.test(stMount.text), `the preview renders the object's REAL data (not empty) — got: ${JSON.stringify((stMount.text || '').match(/PEER:[^<]*/)?.[0] || stMount.text.slice(0, 40))}`);
    ok(stMount.noIframe, 'the preview is confined inline (no iframe)');
    ok(stMount.reviseBtn && stMount.input, 'the studio has a "describe a change" prompt + a ✎ Revise button');
    ok(stMount.reviseEnabled, 'Revise is enabled (a renderer fork exists to iterate)');
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
