#!/usr/bin/env node
// extension-noise-provenance.staging.test.cjs — STAGING (real-run) proof of dan's invariant:
//   a browser-EXTENSION / WALLET-provider error is NEVER attributed to a component, and NEVER blocks a render.
//
// The live bug (chat 60f47c96, 2026-07-02): MetaMask Flask injects window.ethereum into EVERY iframe —
// including our opaque-origin confined.html frames. In that frame the provider can't reach its extension
// background, so ~10s after mount its init REJECTS with "Failed to connect to MetaMask". The confined frame's
// unhandledrejection reporter misattributed that as a COMPONENT error → red note + /error/flag → phantom
// auto-fix backlog goal + 🔔 feed card + a "your widget FAILED — rebuild it" injection into the agent's next
// turn, AND it tore down the Tier-2 WebGL trace island mid-run.
//
// Layers (all against an isolated instance with throwaway state — never the live host state):
//   1. SERVER belt: an extension-noise POST to /error/flag is IGNORED (no backlog goal, no feed card, no
//      queued component-error); a GENUINE component error still files/queues (no over-suppression).
//   2. CONFINED FRAME (real confined.html, headless chromium): a synthetic extension-origin unhandledrejection
//      (reason.stack chrome-extension://…, message "Failed to connect to MetaMask") is NOT reported over the
//      port; an extension-origin error EVENT (e.filename chrome-extension://…) is NOT reported; a GENUINE
//      post-mount runtime throw IS still reported (runtime:true).
//   3. APP PAGE belt: __fieldReportError(extension noise) paints NO note + POSTs nothing; a genuine error
//      still paints the note + POSTs /error/flag.
//   4. TRACE ISLAND: a real Tier-2 trace turn mounts + advances frames; a GENUINE post-mount runtime rejection
//      injected into the LIVE trace iframe (frames already advancing) does NOT tear the island down (the
//      runtime-flag / frames>0 guard) — while a MOUNT-phase failure still falls back (proven by trace-viz-island).
//
// Run: node extension-noise-provenance.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // PID-derived port (never a fixed 879x)
const LLM_PORT = 21000 + (process.pid % 4000);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-noise-'));
const BACKLOG_FILE = path.join(tmp, 'improvement-backlog.json');
const FEED_FILE = path.join(tmp, 'dash-state', 'feed.json'); // server derives FEED_FILE from DASH_STATE_DIR
const COMP_ERRS_FILE = path.join(tmp, 'voice-state', 'component-errors.json');
let srv = null; let stub = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { stub && stub.close(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const jpost = (p, b) => post(p, b).then(r => r.json());
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const backlogGoals = () => (readJson(BACKLOG_FILE, { items: [] }).items || []);
const feedEntries = () => (readJson(FEED_FILE, { entries: [] }).entries || []);

// stub CodeMode LLM (for the trace-turn leg): round 1 runs real tools → trace cell; round 2 answers, delayed
// so the turn stays open long enough for the browser to watch the island animate + accept an injected reject.
const PROGRAM_1 = ['```js', "updateProgress('phase one');", "await showChoices({ prompt: 'noise-proof', options: ['a', 'b'] });", "await showChoices({ prompt: 'noise-proof-2', options: ['c', 'd'] });", "return 'NP-PHASE1';", '```'].join('\n');
const PROGRAM_2 = '```js\nanswer("extension noise proof done");\n```';
const startStub = () => new Promise(resolve => {
  stub = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', () => {
      let text = '{}'; let delay = 30;
      if (/SECURE SANDBOX/.test(body)) { if (/NP-PHASE1/.test(body)) { text = PROGRAM_2; delay = 6000; } else { text = PROGRAM_1; delay = 200; } }
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); }, delay);
    });
  });
  stub.listen(LLM_PORT, '127.0.0.1', resolve);
});

(async () => {
  await startStub();
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', PRINT_ROOT_CAP: '1', FIELD_LOCKDOWN: '1',
      AGENT_LLM: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'), DASH_STATE_DIR: path.join(tmp, 'dash-state'),
      IMPROVEMENT_BACKLOG: BACKLOG_FILE,
      COMPONENT_GIT_DIR: path.join(tmp, 'component-git'), BACKLOG_STORE: path.join(tmp, 'component-backlog.json'),
      CUSTOM_TOOLS_STORE: path.join(tmp, 'custom-tools.json'), CUSTOM_TOOLS_STATE: path.join(tmp, 'tool-state'),
      COMPONENT_GRAINS: path.join(tmp, 'component-grains'), FORKS_STORE: path.join(tmp, 'forks.json'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      USERS_FILE: path.join(tmp, 'users.json'), AUTO_ADMIT: '0', AUTO_REVISE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (throwaway state; FEED_FILE + IMPROVEMENT_BACKLOG isolated to tmp)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── LAYER 1: SERVER belt — extension noise is IGNORED; a genuine error still files ──────────────────
  const NOISE = 'unhandled rejection after mount: Failed to connect to MetaMask';
  const noiseSid = 'ext-noise-sid-1';
  const g0 = backlogGoals().length, f0 = feedEntries().length;
  const noiseRes = await jpost('/error/flag', { cap, kind: 'component-render', sessionId: noiseSid, name: 'component', error: NOISE, source: '(ui) => { // TRACE-VIZ … }' });
  ok(noiseRes.ok === false && noiseRes.ignored === 'extension-noise', `/error/flag IGNORES extension/wallet noise (ok:false, ignored:"extension-noise") — got ${JSON.stringify(noiseRes)}`);
  ok(backlogGoals().length === g0, 'extension noise files NO self-improve backlog goal (backlog unchanged)');
  ok(feedEntries().length === f0, 'extension noise posts NO 🔔 feed card (feed unchanged)');
  ok(!backlogGoals().some(x => /MetaMask/i.test(x.goal || '')), 'no "Failed to connect to MetaMask" goal anywhere in the backlog');
  const noiseQueued = readJson(COMP_ERRS_FILE, {});
  ok(!Object.keys(noiseQueued).some(k => k.includes(noiseSid)), 'extension noise queues NO component-error for that chat (agent never told to rebuild MetaMask)');

  // an extension-origin chrome-extension:// stack in the message is ALSO ignored (whole-class filter, not just MetaMask)
  const extStack = await jpost('/error/flag', { cap, kind: 'component-render', sessionId: 'ext-noise-sid-2', name: 'component', error: 'TypeError: x is undefined\n  at inject (chrome-extension://abcd/inpage.js:1:1)' });
  ok(extStack.ok === false && extStack.ignored === 'extension-noise', 'a chrome-extension:// origin in the error text is ignored too (the whole extension-noise class)');
  ok(backlogGoals().length === g0, 'still no backlog goal after the chrome-extension:// report');

  // a GENUINE component error STILL files + queues (the fix does NOT over-suppress real breakage)
  const genuineSid = 'genuine-sid-1';
  const GENUINE = 'component threw while building: safeSaleAmount is not defined';
  const genRes = await jpost('/error/flag', { cap, kind: 'component-render', sessionId: genuineSid, name: 'Equity Slice Simulator', error: GENUINE, source: '(ui) => …' });
  ok(genRes.ok === true && genRes.filed === true && genRes.queued === true, `a GENUINE component error STILL files + queues (filed:${genRes.filed}, queued:${genRes.queued})`);
  ok(backlogGoals().some(x => /safeSaleAmount is not defined/.test(x.goal || '')), 'the genuine error DID file a backlog goal (real breakage still reaches the loop)');
  ok(feedEntries().length > f0, 'the genuine error DID post a 🔔 feed card');

  // ── browser half ────────────────────────────────────────────────────────────────────────────────
  let chromium = null;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser layers (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    // ── LAYER 2: the REAL confined.html frame filters extension noise at the source ────────────────────
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(`${BASE}/`);
    // Mount a benign component, then have it schedule a SYNTHETIC event after mount, and collect any error
    // messages the frame emits over its port for ~2.5s. `kind` selects which synthetic event to fire.
    const mountAndWatch = async kind => await page.evaluate(async k => {
      const fr = document.createElement('iframe');
      fr.setAttribute('sandbox', 'allow-scripts');
      fr.src = '/confined.html';
      document.body.appendChild(fr);
      // The component fires the chosen synthetic event ~120ms after mount, exactly as an injected extension
      // script would: an unhandledrejection whose reason.stack names chrome-extension://, or an error event
      // with filename chrome-extension://, or a genuine (non-extension) post-mount throw.
      const SRC = {
        // an unhandledrejection whose reason.stack names a chrome-extension:// origin (exactly the MetaMask
        // "Failed to connect to MetaMask" shape) — filtered by the EXT_ORIGIN_RE stack branch.
        'ext-reject': "(ui) => { setTimeout(() => { var e = new Error('Failed to connect to MetaMask'); e.stack = 'Error: Failed to connect to MetaMask\\n  at i (chrome-extension://abcdefghijklmnop/inpage.js:2:9)'; Promise.reject(e); }, 120); return ui.create('div').text('mounted'); }",
        // an ERROR EVENT whose message is the wallet-noise class — filtered by the error-handler's message
        // branch. (A true chrome-extension:// FILENAME requires a real loaded extension — a headed/matrix check;
        // here we exercise the same window.onerror filter path via the message signature.)
        'ext-error': "(ui) => { setTimeout(() => { throw new Error('Failed to connect to MetaMask'); }, 120); return ui.create('div').text('mounted'); }",
        'genuine': "(ui) => { setTimeout(() => { deadButtonBug(); }, 120); return ui.create('div').text('mounted'); }",
        'genuine-reject': "(ui) => { setTimeout(() => { Promise.reject(new Error('genuine async failure in the component')); }, 120); return ui.create('div').text('mounted'); }",
      }[k];
      return await new Promise(resolve => {
        const errors = [];
        setTimeout(() => resolve({ errors }), 2500);
        window.addEventListener('message', function onMsg(e) {
          const m = e.data; if (!m || m.__cu !== 1) return;
          if (m.type === 'ready') {
            const ch = new MessageChannel();
            ch.port1.onmessage = pe => { const pm = pe.data; if (pm && pm.__cu === 1 && pm.type === 'error') errors.push({ error: pm.error, runtime: !!pm.runtime }); };
            ch.port1.start();
            fr.contentWindow.postMessage({ __cu: 1, type: 'mount', source: SRC }, '*', [ch.port2]);
          }
        });
      });
    }, kind);

    const extReject = await mountAndWatch('ext-reject');
    ok(extReject.errors.length === 0, `a synthetic extension-origin unhandledrejection ("Failed to connect to MetaMask", stack chrome-extension://) is NOT reported over the port (got ${JSON.stringify(extReject.errors).slice(0, 120)})`);

    const extError = await mountAndWatch('ext-error');
    ok(!extError.errors.some(e => /Failed to connect to MetaMask/.test(e.error)), `a wallet-noise error EVENT (window.onerror path) is NOT reported (got ${JSON.stringify(extError.errors).slice(0, 120)})`);

    const genuine = await mountAndWatch('genuine');
    ok(genuine.errors.some(e => e.runtime && /deadButtonBug/.test(e.error)), `a GENUINE post-mount runtime throw IS still reported (runtime:true) — no over-suppression (got ${JSON.stringify(genuine.errors).slice(0, 120)})`);

    const genReject = await mountAndWatch('genuine-reject');
    ok(genReject.errors.some(e => e.runtime && /genuine async failure/.test(e.error)), 'a GENUINE async rejection (non-extension) IS still reported (runtime:true)');
    await page.close();

    // ── LAYER 3: the APP PAGE belt — __fieldReportError drops extension noise, keeps genuine ───────────
    const app = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    let flaggedCount = 0; let lastFlag = null;
    await app.route('**/error/flag', async route => { flaggedCount++; try { lastFlag = route.request().postDataJSON(); } catch {} await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
    await app.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await app.goto(`${BASE}/`);
    await app.waitForFunction(() => typeof window.__fieldReportError === 'function', null, { timeout: 15000 });
    // extension noise → no note, no POST
    await app.evaluate(() => window.__fieldReportError('unhandled rejection after mount: Failed to connect to MetaMask', '(ui) => …', { name: 'component' }));
    await app.waitForTimeout(400);
    ok((await app.$('.comp-err-note')) === null, 'the app page paints NO "component failed" note for extension/wallet noise');
    ok(flaggedCount === 0, 'the app page POSTs NOTHING to /error/flag for extension/wallet noise (stale-client belt)');
    // genuine → note + POST
    await app.evaluate(() => window.__fieldReportError('component threw while building: safeSaleAmount is not defined', '(ui) => …', { name: 'Equity Slice Simulator' }));
    await app.waitForSelector('.comp-err-note', { timeout: 5000 });
    const noteText = await app.$eval('.comp-err-note', el => el.textContent);
    ok(/Equity Slice Simulator/.test(noteText) && /safeSaleAmount/.test(noteText), 'a GENUINE component error still paints the visible note');
    ok(flaggedCount === 1 && lastFlag && /safeSaleAmount/.test(lastFlag.error || ''), 'a GENUINE component error still POSTs /error/flag (exactly once)');
    await app.close();

    // ── LAYER 4: a live trace island is NOT torn down by a POST-MOUNT runtime error (frames>0 guard) ────
    // Opaque-origin frames block parent eval, so instead of injecting from outside we use the TEST-ONLY
    // __traceVizSourceOverride seam to run a viz that MOUNTS + advances frames, then THROWS at runtime (its
    // own window.onerror → confined.html reportRuntime → grain-ui onComponentError(err, {runtime:true}) →
    // the trace island onError). With frames>0 that runtime error must be reported but NOT fatal — the island
    // stays up. (A MOUNT-phase throw still falls back to the legacy pendant — proven by trace-viz-island #10.)
    const RUNTIME_THROW_VIZ = "(ui) => { var c = ui.create('canvas').style({display:'block',width:'100%',height:'200px'}); var n = 0; ui.grain(ui.props.cell).subscribe(function(v){ n++; if (typeof ui.call === 'function') ui.call('vizDiag', { mode:'2d', frames:n, steps:(v&&v.steps?v.steps.length:0) }); }); setTimeout(function(){ throw new Error('post-mount trace runtime boom'); }, 1600); return c; }";
    const chatId = 'np-trace-1';
    const tp = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await tp.addInitScript(({ c, id, ov }) => { try {
      localStorage.setItem('field-agent-cap', c);
      localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'noisechat', ts: Date.now(), lastMsgAt: Date.now() }]));
      localStorage.setItem('field-agent-active', id);
      localStorage.setItem('field-agent-tx-' + id, JSON.stringify([{ who: 'you', text: 'warmup' }, { who: 'agent', text: 'ready' }]));
      window.__traceVizSourceOverride = ov; // test-only: mount a viz that throws AFTER mount
    } catch {} }, { c: cap, id: chatId, ov: RUNTIME_THROW_VIZ });
    await tp.goto(`${BASE}/`, { waitUntil: 'load' });
    await tp.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    await tp.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /noisechat/.test(s.textContent)); if (it) it.click(); });
    await tp.waitForTimeout(400);
    await tp.evaluate(() => { document.getElementById('text').value = 'run the trace island'; document.getElementById('send').click(); });
    const islandSel = '#log .trace-island-host';
    await tp.waitForSelector(`${islandSel} iframe`, { timeout: 15000 });
    // wait for the brokered cell to advance frames (the island is genuinely rendering) BEFORE the throw fires
    let frames = 0;
    for (let i = 0; i < 44 && frames < 2; i++) { frames = await tp.evaluate(() => (window.__traceIsland || {}).frames || 0); if (frames < 2) await sleep(250); }
    ok(frames >= 2, `the Tier-2 trace island is live + advancing frames before the runtime throw (${frames} frames)`);
    // let the post-mount throw (at ~1600ms) fire + propagate back over the port → onError({runtime:true})
    await tp.waitForTimeout(2600);
    const survived = await tp.evaluate(islSel => {
      const island = !!document.querySelector(islSel + ' iframe');
      const w = document.getElementById('pendant-wrap');
      const pendant = !!w && !w.classList.contains('hide');
      return { island, pendant, frames: (window.__traceIsland || {}).frames || 0 };
    }, islandSel);
    ok(survived.island && !survived.pendant, `the live trace island SURVIVES a post-mount runtime error (island up=${survived.island}, legacy-pendant fallback fired=${survived.pendant}) — no mid-run teardown`);
    ok(survived.frames >= frames, `the island kept advancing frames through the runtime error (${frames} → ${survived.frames})`);
    await tp.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
