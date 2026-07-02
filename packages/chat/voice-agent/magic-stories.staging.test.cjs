#!/usr/bin/env node
// magic-stories.staging.test.cjs — STAGING (real-run) proof of 🪄 MAGIC STORIES (MAGIC-STORIES-1 collector +
// MAGIC-STORIES-2 gallery). dan (2026-07-02): "a fun-filled gallery of interesting stories sanitized from
// identity implications representing different flows made possible by this system." Layers:
//
//   SERVER (isolated instance + a stub OpenAI-compatible LLM so a REAL /chat turn builds a real trace):
//     1. /stories/save SANITIZES on write — a planted email / #cap / @handle / swissnum in the title/why
//        never reaches the stored candidate; the response reports how many shapes it scrubbed.
//     2. the candidate lands in the ROOT review queue (/stories/list canReview) and NOT in `published`.
//     3. /stories/publish is the GATE — a sanitized candidate publishes and appears in `published`.
//     4. a non-root cap CANNOT publish (403); a raw planted-cap story CANNOT publish (the leak gate refuses).
//   BROWSER (headless chromium + swiftshader for the confined flow-viz WebGL):
//     5. run a real turn → the agent message carries the ⭐ "save as story" affordance; clicking it opens the
//        collector form; saving captures + sanitizes the flow.
//     6. the 🪄 gallery shows the candidate in the review queue; Publish moves it to the published showcase,
//        rendering the flow as a cap-free authority-flow viz (reusing the trace-viz splash-card mechanism).
//     7. a screenshot of the published gallery.
//
// Run: node magic-stories.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8866;
const LLM_PORT = 8867;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-stories-'));
let srv = null; let stub = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { stub && stub.close(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const jpost = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

// stub CodeMode LLM: round 1 runs real tools (emitStep → trace cell → a capturable flow), round 2 answers.
const PROGRAM_1 = ['```js', "updateProgress('gathering');", "await showChoices({ prompt: 'ms-proof', options: ['a', 'b'] });", "return 'MS-PHASE1';", '```'].join('\n');
const PROGRAM_2 = '```js\nanswer("a device shared, composed with an agent — magic stories proof");\n```';
const startStub = () => new Promise(resolve => {
  stub = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', () => {
      let text = '{}'; let delay = 30;
      if (/SECURE SANDBOX/.test(body)) { if (/MS-PHASE1/.test(body)) { text = PROGRAM_2; delay = 120; } else { text = PROGRAM_1; delay = 120; } }
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); }, delay);
    });
  });
  stub.listen(LLM_PORT, '127.0.0.1', resolve);
});

// identity planted in the collector inputs — every shape the sanitizer must strip before persistence.
const PLANTED = { email: 'dan@example.com', cap: '#cap=deadbeefdeadbeefdeadbeef1234', handle: '@alice_operator', hex: '0123456789abcdef0123456789abcdef' };

(async () => {
  await startStub();
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', PRINT_ROOT_CAP: '1', FIELD_LOCKDOWN: '1',
      AGENT_LLM: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'), DASH_STATE_DIR: path.join(tmp, 'dash-state'),
      COMPONENT_GIT_DIR: path.join(tmp, 'component-git'), BACKLOG_STORE: path.join(tmp, 'component-backlog.json'),
      CUSTOM_TOOLS_STORE: path.join(tmp, 'custom-tools.json'), CUSTOM_TOOLS_STATE: path.join(tmp, 'tool-state'),
      COMPONENT_GRAINS: path.join(tmp, 'component-grains'), FORKS_STORE: path.join(tmp, 'forks.json'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      STORIES_STORE: path.join(tmp, 'stories.json'),
      USERS_FILE: path.join(tmp, 'users.json'), AUTO_ADMIT: '0', AUTO_REVISE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (throwaway state, FIELD_LOCKDOWN=1, stub LLM)');
  if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── 1. /stories/save SANITIZES on write ──────────────────────────────────────────────────────────────
  const saved = await jpost('/stories/save', { cap: rootCap, sid: 'no-trace-yet',
    title: `${PLANTED.email} shared a rover ${PLANTED.cap}`,
    why: `composed with ${PLANTED.handle} — swiss ${PLANTED.hex}`, quality: 'composition' });
  ok(saved && saved.ok && saved.scrubbed >= 3, `save() sanitized the planted identity (scrubbed=${saved && saved.scrubbed})`);

  // ── 2. the candidate is in the ROOT review queue + provably clean, NOT published ──────────────────────
  const listed = await jpost('/stories/list', { cap: rootCap });
  const cand = (listed.candidates || []).find(c => c.id === saved.id);
  ok(!!cand && listed.canReview === true, 'the candidate is in the root review queue (canReview)');
  const candBlob = JSON.stringify(cand || {});
  const clean = cand && !candBlob.includes(PLANTED.email) && !candBlob.includes(PLANTED.cap) && !candBlob.includes(PLANTED.handle) && !candBlob.includes(PLANTED.hex);
  ok(clean, 'the STORED candidate contains none of the planted email / #cap / @handle / swissnum');
  ok(!(listed.published || []).some(p => p.id === saved.id), 'the candidate is NOT yet published (review-gated)');

  // ── 3. /stories/publish GATE: a sanitized candidate publishes ────────────────────────────────────────
  const pub = await jpost('/stories/publish', { cap: rootCap, id: saved.id });
  ok(pub && pub.ok, `publish() promoted the sanitized candidate (${JSON.stringify(pub)})`);
  const after = await jpost('/stories/list', { cap: rootCap });
  ok((after.published || []).some(p => p.id === saved.id), 'the story now appears in the published gallery');

  // ── 4. a NON-root cap cannot publish; a raw planted-cap story cannot publish (the leak gate) ──────────
  const invite = await jpost('/invite', { cap: rootCap, label: 'guest' }).catch(() => ({}));
  const guestCap = invite && invite.scopedCap;
  if (guestCap) {
    const g2 = await jpost('/stories/save', { cap: guestCap, title: 'guest nominates a flow', why: 'x', quality: 'other' });
    const gp = g2 && g2.ok ? await jpost('/stories/publish', { cap: guestCap, id: g2.id }) : { error: 'no-guest-save' };
    ok(gp && !gp.ok && /root/.test(String(gp.error || '')), 'a non-root cap is refused publish (needs root)');
  } else { console.log('  info - skip guest-cap publish check (no invite route in this build)'); }
  // raw planted-cap story written directly to the store → publish must refuse.
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'stories.json'), 'utf8'));
  raw.items.push({ id: 'story-raw-leak', title: 'leaky', why: `holds ${PLANTED.cap}`, quality: 'other', flow: null, status: 'candidate', addedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(tmp, 'stories.json'), JSON.stringify(raw));
  const refused = await jpost('/stories/publish', { cap: rootCap, id: 'story-raw-leak' });
  ok(refused && refused.ok === false && Array.isArray(refused.leaks) && refused.leaks.length >= 1, 'the publish gate REFUSES a non-sanitized story (leaks listed)');

  // ── browser half ────────────────────────────────────────────────────────────────────────────────────
  let chromium = null;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  const shotDir = process.env.MAGIC_STORIES_SHOTS || __dirname;
  const seed = (page, chatId) => page.addInitScript(({ c, id }) => { try {
    localStorage.setItem('field-agent-cap', c);
    localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'storychat', ts: Date.now(), lastMsgAt: Date.now() }]));
    localStorage.setItem('field-agent-active', id);
    localStorage.setItem('field-agent-tx-' + id, JSON.stringify([{ who: 'you', text: 'warmup' }, { who: 'agent', text: 'ready' }]));
  } catch {} }, { c: rootCap, id: chatId });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await seed(page, 'ms-chat-1');
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('#stories-btn', { timeout: 15000 });
    ok(true, 'the 🪄 Magic Stories toolbar item is present');

    // ── 5. run a real turn → the agent message carries the ⭐ save-as-story affordance ──────────────────
    await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /storychat/.test(s.textContent)); if (it) it.click(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { document.getElementById('text').value = 'show me a magical composition flow'; document.getElementById('send').click(); });
    await page.waitForSelector('.msg-star', { timeout: 20000 });
    await page.waitForTimeout(800);
    ok(await page.evaluate(() => !!document.querySelector('.msg-star')), 'the agent message carries the ⭐ "save as story" affordance');

    // click ⭐ → the collector form; fill it (with planted identity to prove client→server sanitize) + save.
    await page.evaluate(() => document.querySelector('.msg-star').click());
    await page.waitForSelector('#story-title', { timeout: 8000 });
    ok(true, 'the ⭐ collector form opened');
    await page.evaluate(() => { document.getElementById('story-title').value = 'A stranger’s device composed with my agent (contact me@evil.com)'; document.getElementById('story-why').value = 'A capability passed hand to hand — least authority at every hop.'; const q = document.getElementById('story-quality'); if (q) q.value = 'multi-hop-delegation'; });
    await page.evaluate(() => document.getElementById('story-save').click());
    await page.waitForTimeout(1200);

    // ── 6. the 🪄 gallery shows the candidate for review → Publish moves it to the showcase ─────────────
    await page.evaluate(() => window.openMagicStories());
    await page.waitForSelector('#magic-stories-overlay [data-story-review-grid] [data-story]', { timeout: 10000 });
    await page.waitForTimeout(600);
    const reviewCount = await page.evaluate(() => document.querySelectorAll('#magic-stories-overlay [data-story-review-grid] [data-story]').length);
    ok(reviewCount >= 1, `the gallery shows the new candidate in the review queue (${reviewCount})`);
    const noLeakInGallery = await page.evaluate(() => !document.querySelector('#magic-stories-overlay').textContent.includes('me@evil.com'));
    ok(noLeakInGallery, 'the planted email from the collector form was sanitized (absent from the gallery DOM)');
    // publish it
    await page.evaluate(() => document.querySelector('#magic-stories-overlay [data-story-publish]').click());
    await page.waitForTimeout(1400);
    const publishedCount = await page.evaluate(() => document.querySelectorAll('#magic-stories-overlay [data-story-grid] [data-story]').length);
    ok(publishedCount >= 1, `after Publish, the story appears in the published showcase grid (${publishedCount})`);
    // the published story renders its flow as a confined viz (the splash-card mechanism)
    let vizFrames = 0; for (let i = 0; i < 24; i++) { vizFrames = await page.evaluate(() => document.querySelectorAll('#magic-stories-overlay [data-story-grid] [data-story] iframe').length); if (vizFrames >= 1) break; await sleep(250); }
    ok(vizFrames >= 1, `the published story renders a cap-free flow viz (confined iframe present: ${vizFrames})`);
    ok(errs.length === 0, `no page errors across the collector + gallery flow (${errs.slice(0, 2).join(' | ')})`);

    // ── 7. screenshot of the published gallery ─────────────────────────────────────────────────────────
    try { await page.screenshot({ path: path.join(shotDir, 'magic-stories.screenshot.png'), fullPage: true }); console.log('  info - screenshot:', path.join(shotDir, 'magic-stories.screenshot.png')); } catch {}
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
