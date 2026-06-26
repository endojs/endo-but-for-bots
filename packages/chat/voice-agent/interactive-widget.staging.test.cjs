#!/usr/bin/env node
// interactive-widget.staging.test.cjs — STAGING proof that a blossomed renderer can be INTERACTIVE: a
// confined widget reads an input (via the SafeEvent target snapshot) and INVOKES the object's method via
// the mediated props.call — the "send a message to Kumavis" proof of concept. Pre-seeds an interactive
// renderer + object so it's deterministic; intercepts /rpc to confirm the send fired with the typed text.
//
// Run: node interactive-widget.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8827;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iwidget-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const METHODS = ['send', 'inbox', 'describe'];
const sig = `sig-${crypto.createHash('sha256').update(`iface:object|${[...METHODS].sort().join(',')}`).digest('hex').slice(0, 16)}`;
// an INTERACTIVE renderer: a text field + a Send button that invokes props.call('send', [text]) via the mediated cap
const RENDERER = "(endowments, props) => { const { h, useState } = endowments; const [text, setText] = useState(''); const [flash, setFlash] = useState(''); return h('div', { class: 'kbox' }, [ h('div', null, '✉ to ' + (props.name || '')), h('input', { id: 'w-input', value: text, oninput: e => setText(e.target.value) }), h('button', { id: 'w-send', onclick: () => { props.call('send', [text]).then(() => setFlash('sent')); } }, 'Send'), flash ? h('span', { id: 'w-flash' }, flash) : null ]); }";

(async () => {
  const objectsFile = path.join(tmp, 'objects.json');
  const forksFile = path.join(tmp, 'forks.json');
  const blossomFile = path.join(tmp, 'blossom.json');
  fs.writeFileSync(objectsFile, JSON.stringify({ objects: [{ name: 'Kumavis', transport: 'endo-peer', peer: true, address: 'endo://x', swissnum: 'x', methods: METHODS, description: 'a peer', addedAt: 'now' }] }));
  const stamp = new Date().toISOString();
  fs.writeFileSync(forksFile, JSON.stringify({ forks: { 'fork-iw': { id: 'fork-iw', name: 'Kumavis renderer', baseId: `blossom:${sig}`, owner: 'root', source: RENDERER, createdAt: stamp, updatedAt: stamp, history: [{ source: RENDERER, at: stamp, note: 'blossom' }] } }, shares: {} }));
  fs.writeFileSync(blossomFile, JSON.stringify({ renderers: { [sig]: { sig, status: 'ready', forkId: 'fork-iw', name: 'Kumavis', methods: METHODS, at: stamp, completedAt: stamp } }, count: 1 }));

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
  ok(up, 'isolated server booted (seeded interactive renderer + Kumavis, FIELD_LOCKDOWN=1)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser (no chromium)'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    let sentCall = null;
    // intercept /rpc: capture the objectCall('Kumavis','send',…); fulfill it (no real peer in the test). Let
    // everything else (objectsList, etc.) hit the real server.
    await page.route('**/rpc', async route => {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
      if (body.method === 'objectCall' && Array.isArray(body.args) && body.args[1] === 'send') { sentCall = body.args; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: { ok: true, value: { delivered: true } } }) }); }
      return route.continue();
    });
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' }); await sleep(2200);
    await page.evaluate(() => window.objectInspector('Kumavis'));
    // the bespoke INTERACTIVE widget renders (an input + a Send button) inline under lockdown
    await page.waitForFunction(() => !!document.querySelector('#insp-bloom #w-send'), { timeout: 8000 }).catch(() => {});
    ok(await page.$('#insp-bloom #w-send') !== null, 'the bespoke interactive widget rendered (input + Send button) inline');
    ok(await page.$('#insp-bloom iframe') === null, 'rendered confined WITHOUT an iframe');

    // type a message + click Send → the confined widget invokes props.call('send', [text])
    await page.fill('#insp-bloom #w-input', 'hello kumavis');
    await page.waitForTimeout(150);
    await page.click('#insp-bloom #w-send');
    await page.waitForFunction(() => !!window.__lastSendSeen || true, { timeout: 1000 }).catch(() => {});
    for (let i = 0; i < 30 && !sentCall; i++) await sleep(150);
    ok(!!sentCall, 'clicking Send invoked the object’s method through the mediated props.call');
    ok(sentCall && sentCall[0] === 'Kumavis' && sentCall[1] === 'send' && Array.isArray(sentCall[2]) && sentCall[2][0] === 'hello kumavis',
      `the call carried the typed message — got: ${JSON.stringify(sentCall)}`);
    // the widget reacted (flash) — the round-trip completed back into the confined component
    await page.waitForFunction(() => { const f = document.querySelector('#insp-bloom #w-flash'); return f && /sent/.test(f.textContent); }, { timeout: 3000 }).catch(() => {});
    ok(await page.evaluate(() => { const f = document.querySelector('#insp-bloom #w-flash'); return !!f && /sent/.test(f.textContent || ''); }), 'the result flowed back INTO the confined widget (it flashed "sent")');
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
