#!/usr/bin/env node
// blossom-objects.staging.test.cjs — STAGING (real-run) guard for "blossom objects in messages" (increment 1b).
// The agent's reply can hand answer()/ask()/blocked() a LIVE value (a remotable, a record, an array) that the
// server carries as a cap-safe descriptor on donePayload.objects and de-smells to a "🌱 … (unrendered object)"
// text placeholder (see server.mjs OBJECT CHANNEL + codemode describeRef/refPlaceholder). The CLIENT half renders
// each descriptor RICHLY in the bubble: the generic valNode drill-down tree by default (not "[object Object]",
// not a bare placeholder), a "🌱 change how this looks" affordance on interfaced objects, and a redaction chip
// for a redacted cap (value NEVER shown).
//
// Boots an isolated voice-agent on a throwaway port, loads the REAL app with the root cap, and drives the REAL
// renderAgentResponse() with a seam-injected donePayload.objects, then asserts END-TO-END in headless chromium:
//   (a) a PLAIN OBJECT → an explorable valNode tree (its data is shown; no "[object Object]"; no raw placeholder);
//   (b) a REMOTABLE with methods → offers the 🌱 blossom affordance;
//   (c) a REDACTED cap → a redaction chip, and its value is NEVER rendered;
//   (d) the in-text placeholder is REPLACED in place (anchored where the object was in the sentence).
// Also writes a screenshot of a rendered object bubble to ./blossom-objects.staging.png.
//
// Run: node blossom-objects.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blossom-objects-staging-'));
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
  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless render checks (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed`);
    cleanup(); process.exit(fail ? 1 : 0);
  }
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e && e.message || e)));
    await page.goto(`${BASE}/#cap=${rootCap}`, { waitUntil: 'load' });
    // wait for the app to expose the staging seam
    await page.waitForFunction(() => typeof window.renderAgentResponse === 'function', { timeout: 15000 }).catch(() => {});
    ok(await page.evaluate(() => typeof window.renderAgentResponse === 'function'), 'app booted; renderAgentResponse seam present');

    // Drive the REAL answer render with a seam-injected object channel — placeholders inline in the prose.
    const result = await page.evaluate(() => {
      const objects = [
        // (a) a plain object → valNode tree
        { kind: 'object', name: 'SensorReading', methods: [], sample: JSON.stringify({ state: 'open', battery: 87, since: '10:42' }), preview: '{state, battery, …}', blossomSig: 'sig-obj-plain' },
        // (b) a remotable with methods → blossomable
        { kind: 'remotable', name: 'DoorLock', methods: ['lock', 'unlock', 'status'], sample: JSON.stringify({ id: 'front', locked: true }), preview: 'DoorLock', blossomSig: 'sig-remotable-door' },
        // (c) a redacted cap → chip only, never a value
        { kind: 'cap', name: 'capability', methods: [], sample: '«redacted capability»', preview: '«redacted capability»', redacted: true, blossomSig: 'sig-empty' },
      ];
      const answer = `Here is the reading: ${'🌱 object — SensorReading (unrendered object)'}. The lock is ${'🌱 remotable — DoorLock (unrendered object)'}. And a secret ${'🌱 capability (redacted — not shown)'}.`;
      window.renderAgentResponse({ answer, objects, agentId: 'field-agent' });
      const body = [...document.querySelectorAll('#log .msg .body')].pop();
      const cards = body ? [...body.querySelectorAll('.msg-object')] : [];
      return {
        bodyText: body ? body.textContent : '',
        cardCount: cards.length,
        cardTexts: cards.map(c => c.textContent),
        hasBlossomBtn: cards.map(c => !!c.querySelector('button')),
        // the raw placeholder text should be GONE from the prose (replaced in place)
        placeholderLeft: /\(unrendered object\)/.test(body ? body.textContent : ''),
        objectSmell: /\[object Object\]/.test(body ? body.textContent : ''),
      };
    });

    ok(result.cardCount === 3, `all 3 object descriptors rendered as cards (got ${result.cardCount})`);
    ok(!result.objectSmell, 'no "[object Object]" smell anywhere in the bubble');
    ok(!result.placeholderLeft, 'the raw "(unrendered object)" placeholder was replaced in place');
    // (a) plain object → its data is explorable/visible
    ok(/battery|87|state|open/.test(result.cardTexts[0] || ''), `(a) plain object shows its data as a tree — "${(result.cardTexts[0] || '').slice(0, 60)}"`);
    ok(result.hasBlossomBtn[0] === false, '(a) a method-less plain object offers NO bespoke-renderer button (valNode tree is the default)');
    // (b) remotable with methods → blossom affordance
    ok(result.hasBlossomBtn[1] === true, '(b) a remotable-with-methods offers the 🌱 blossom affordance');
    ok(/lock|unlock|status/.test(result.cardTexts[1] || ''), '(b) the remotable surfaces its method set');
    // (c) redacted cap → chip, no value
    ok(/redacted/.test(result.cardTexts[2] || ''), '(c) the redacted cap renders a redaction chip');
    ok(!/«redacted capability»|locked|front/.test(result.cardTexts[2] || '') || /redacted, not shown/.test(result.cardTexts[2] || ''), '(c) the redacted cap value is NOT expanded/shown');
    ok(errs.length === 0, `no page errors during render (${errs.slice(0, 2).join(' | ')})`);

    // screenshot the rendered bubble
    try {
      const shot = path.join(__dirname, 'blossom-objects.staging.png');
      await page.screenshot({ path: shot, fullPage: true });
      console.log('  screenshot ->', shot);
    } catch (e) { console.log('  (screenshot skipped:', e.message, ')'); }
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
