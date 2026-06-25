#!/usr/bin/env node
// lockdown-survive.staging.test.cjs — STAGING (real-browser) proof that the live app survives a
// severe-taming SES lockdown AND that the lockdown actually CONTAINS an untrusted forked component —
// the precondition for rendering forks inline (no iframe) per designs/preact-component-trie.md.
//
// This drives the REAL server switch (FIELD_LOCKDOWN=1), not a test-only shim: the server then (a) serves
// the shell with <html data-field-lockdown="1"> so islands.js calls lockdown({overrideTaming:'severe'})
// before app.js, and (b) widens the shell CSP to script-src 'unsafe-eval' — which SES REQUIRES to install
// its safe evaluators. (Discovered the hard way: with the strict default CSP, lockdown freezes the realm
// but tameFunctionConstructors silently no-ops, leaving endowments.h.constructor('return globalThis')() a
// live host escape. The probe catches exactly that — a green unit test did not.)
//
// Asserts, in real headless Chromium, two boots:
//   A) FIELD_LOCKDOWN=1: 1. realm frozen + islands loaded, 2. real app.js booted (interactive shell),
//      3. no frozen-realm boot errors, 4. a built-in island renders, 5. an UNTRUSTED confined-from-source
//      component renders inline WITHOUT an iframe, 6. a MALICIOUS fork CANNOT reach host globals via the
//      Function-constructor escape (the containment that the CSP fix restores).
//   B) default (lockdown OFF): 7. realm NOT frozen (today's live default), 8. renderSource REFUSES
//      untrusted source (the gate holds when the realm is open).
//
// Run: node lockdown-survive.staging.test.cjs   (exits non-zero on any failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };

// boot one isolated server (own port + throwaway state); returns { srv, base, cap, tmp }
const boot = async (port, lockdown) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lockdown-staging-'));
  const env = { ...process.env, PORT: String(port), BIND: '127.0.0.1',
    SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
    PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
    PRINT_ROOT_CAP: '1' };
  if (lockdown) env.FIELD_LOCKDOWN = '1';
  const srv = spawn('node', ['server.mjs'], { cwd: __dirname, env, stdio: ['ignore', 'ignore', 'ignore'] });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${base}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  const cap = up ? fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim() : '';
  return { srv, base, cap, tmp, up };
};

const servers = [];
const cleanup = () => { for (const s of servers) { try { s.srv.kill('SIGKILL'); } catch {} try { fs.rmSync(s.tmp, { recursive: true, force: true }); } catch {} } };

(async () => {
  const A = await boot(8797, true);  servers.push(A);
  const B = await boot(8798, false); servers.push(B);
  ok(A.up && B.up, 'isolated servers booted (lockdown + control)');
  if (!A.up || !B.up) { cleanup(); process.exit(1); }

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless checks (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed (browser checks skipped)`);
    cleanup(); process.exit(fail ? 1 : 0);
  }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    // ── A) FIELD_LOCKDOWN=1 — the target live integration ───────────────────────────────────────────
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, A.cap);
    await page.goto(`${A.base}/`, { waitUntil: 'load' });
    await page.waitForTimeout(2500);

    const locked = await page.evaluate(() => {
      try { return !!(globalThis.__fieldIslands && Object.isFrozen(Object.prototype) && Object.isFrozen(Function.prototype)); } catch { return false; }
    });
    ok(locked, 'realm is frozen (severe lockdown ran) AND the islands bundle loaded');

    const composer = await page.evaluate(() => !!(document.querySelector('#composer, #msg, textarea, [contenteditable], #send, button')));
    ok(composer, 'the real app.js booted in the frozen realm (interactive shell present)');

    const fatal = pageErrors.filter(m => /lockdown|Cannot (assign|define|redefine)|frozen|is not extensible|override mistake|SES_/i.test(m));
    ok(fatal.length === 0, `no lockdown/frozen-realm page errors during boot — saw: ${JSON.stringify(fatal.slice(0, 3))}`);

    const islandHtml = await page.evaluate(async () => {
      const el = document.createElement('div'); document.body.appendChild(el);
      const okk = globalThis.__fieldIslands.renderInto('FileBrowser',
        el, { roots: [{ key: 'vault', label: 'Vault' }], root: 'vault', path: '', entries: [], file: null });
      await new Promise(r => setTimeout(r, 150));
      return { okk, len: el.innerHTML.length, hasId: el.getAttribute('data-component-id') };
    });
    ok(islandHtml.okk && islandHtml.len > 0 && islandHtml.hasId === 'island-FileBrowser',
      `a built-in island rendered confined under lockdown (html ${islandHtml.len}B)`);

    const src = "(endowments, props) => endowments.h('div', { class: 'forked' }, 'FORK-OK ' + (props.name || ''))";
    const fork = await page.evaluate(async source => {
      const el = document.createElement('div'); el.id = 'fork-mount'; document.body.appendChild(el);
      const okk = globalThis.__fieldIslands.renderSource(source, el, { name: 'alice' });
      await new Promise(r => setTimeout(r, 150));
      return { okk, text: el.textContent, hasIframe: !!el.querySelector('iframe'), id: el.getAttribute('data-component-id') };
    }, src);
    ok(fork.okk === true, 'renderSource accepted untrusted source under lockdown');
    ok(/FORK-OK alice/.test(fork.text || ''), `the confined fork rendered its props inline — got: ${JSON.stringify(fork.text)}`);
    ok(fork.hasIframe === false, 'the confined fork rendered WITHOUT an iframe (in-tree renderConfined)');
    ok(fork.id === 'confined-source', 'fork mount carries the confined-source component id');

    // a fork authored in the ISLAND VOCABULARY (ui-kit primitives as compartment globals) renders inline
    const vocab = await page.evaluate(async () => {
      const el = document.createElement('div'); document.body.appendChild(el);
      // Banner is a ui-kit primitive seeded as a compartment global — the fork uses it with no import
      const src = "(endowments, props) => endowments.h(Banner, { kind: 'info' }, 'FORKVOCAB-OK ' + (props.tag || ''))";
      const okk = globalThis.__fieldIslands.renderSource(src, el, { tag: 'beta' });
      await new Promise(r => setTimeout(r, 150));
      return { okk, text: el.textContent, hasIframe: !!el.querySelector('iframe') };
    });
    ok(vocab.okk === true && /FORKVOCAB-OK beta/.test(vocab.text || '') && !vocab.hasIframe,
      `a fork using the ui-kit vocabulary (Banner) renders inline — got: ${JSON.stringify(vocab.text)}`);

    const escaped = await page.evaluate(async () => {
      globalThis.__HOST_SECRET__ = 'host-only';
      const el = document.createElement('div'); document.body.appendChild(el);
      const evil = "(endowments, props) => { let reach='blocked'; try { const g = endowments.h.constructor('return globalThis')(); reach = (g && g.__HOST_SECRET__) ? 'REACHED:'+g.__HOST_SECRET__ : 'safe-global'; } catch (e) { reach = 'threw'; } return endowments.h('div', null, reach); }";
      globalThis.__fieldIslands.renderSource(evil, el, {});
      await new Promise(r => setTimeout(r, 150));
      return el.textContent;
    });
    ok(!/REACHED:/.test(escaped || ''), `a malicious fork CANNOT read host globals via the Function escape — got: ${JSON.stringify(escaped)}`);
    await page.close();

    // ── B) default (lockdown OFF) — today's live default; the gate must REFUSE untrusted source ─────
    const page2 = await browser.newPage();
    await page2.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, B.cap);
    await page2.goto(`${B.base}/`, { waitUntil: 'load' });
    await page2.waitForTimeout(1500);
    const refused = await page2.evaluate(async () => {
      const frozen = (() => { try { return Object.isFrozen(Object.prototype); } catch { return true; } })();
      const el = document.createElement('div'); document.body.appendChild(el);
      const okk = globalThis.__fieldIslands.renderSource("(e,p)=>e.h('div',null,'should-not-render')", el, {});
      return { frozen, okk, text: el.textContent };
    });
    ok(refused.frozen === false, 'control: without the flag the realm is NOT locked down (live default)');
    ok(refused.okk === false && /refusing untrusted source/.test(refused.text || ''),
      `renderSource REFUSES untrusted source when the realm is not locked down — got: ${JSON.stringify(refused.text)}`);
    await page2.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
