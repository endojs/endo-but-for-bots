#!/usr/bin/env node
// chrome-components.staging.test.cjs — STAGING (real-run) proof for increment 1 of the CHROME
// DECOMPOSITION (designs/preact-component-trie.md): two pieces of the app shell — the per-message
// toolbar (chrome-msg-toolbar) and the landing welcome panel (chrome-welcome) — are registry-backed
// components: seeded into component-git at boot, rendered through the confined no-iframe path under
// FIELD_LOCKDOWN, alt-click-selectable, live-editable (render-check-gated), revertable, and falling
// back to the original hardcoded DOM (with a backlog auto-file) when a mount fails. Plus the TRUSTED-
// PATH DENYLIST: the scope-consent sheet and the Shares panel refuse selection with the 🔒 indicator
// and can never acquire a component identity.
//
// Boots an ISOLATED voice-agent (throwaway state dirs — never touches live component-git/backlogs).
// Run: node chrome-components.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const jget = p => fetch(`${BASE}${p}`).then(r => r.json());
const jpost = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', PRINT_ROOT_CAP: '1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'), DASH_STATE_DIR: path.join(tmp, 'dash-state'),
      COMPONENT_GIT_DIR: path.join(tmp, 'component-git'), BACKLOG_STORE: path.join(tmp, 'component-backlog.json'),
      CUSTOM_TOOLS_STORE: path.join(tmp, 'custom-tools.json'), CUSTOM_TOOLS_STATE: path.join(tmp, 'tool-state'),
      COMPONENT_GRAINS: path.join(tmp, 'component-grains'), FORKS_STORE: path.join(tmp, 'forks.json'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      USERS_FILE: path.join(tmp, 'users.json'), AUTO_ADMIT: '0', AUTO_REVISE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (throwaway state, FIELD_LOCKDOWN=1)');
  if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── 1. the registry: seeded at boot, served at HEAD ─────────────────────────────────────────────
  const reg = await jget('/chrome/components');
  ok(reg.ok && Array.isArray(reg.components) && reg.components.length === 2, `GET /chrome/components lists the seeded chrome (${(reg.components || []).length})`);
  const tb = (reg.components || []).find(c => c.id === 'chrome-msg-toolbar');
  const wc = (reg.components || []).find(c => c.id === 'chrome-welcome');
  ok(!!tb && /props\.onClip/.test(tb.source) && /msg-clip/.test(tb.source), 'chrome-msg-toolbar seeded with the clip/copy source');
  ok(!!wc && /props\.onSuggest/.test(wc.source), 'chrome-welcome seeded with the welcome source');
  ok(!!tb && /^[0-9a-f]{6,40}$/.test(String(tb.version)), `chrome components carry a real git version (${tb && String(tb.version).slice(0, 8)})`);

  // ── 2. the render-check GATE: a broken edit is REFUSED; HEAD stays ──────────────────────────────
  const bad1 = await jpost('/components/edit', { cap: rootCap, id: 'chrome-msg-toolbar', source: '(endowments, props) => { throw new Error("boom") }' });
  ok(bad1.ok === false && /render check/i.test(bad1.error || ''), `a throwing chrome edit is refused by the render check (${(bad1.error || '').slice(0, 60)}…)`);
  const bad2 = await jpost('/components/edit', { cap: rootCap, id: 'chrome-msg-toolbar', source: 'garbage(((' });
  ok(bad2.ok === false, 'a non-parsing chrome edit is refused');
  const reg2 = await jget('/chrome/components');
  const tb2 = reg2.components.find(c => c.id === 'chrome-msg-toolbar');
  ok(tb2.version === tb.version, 'HEAD is unchanged after refused edits (the previous version stays live)');

  // ── 3. a GOOD edit commits a new version; revert restores (non-destructive) ─────────────────────
  const V2 = '(endowments, props) => endowments.h("div", { class: "tb-v2" }, [endowments.h("button", { class: "msg-clip", title: "Clip", onClick: () => props.onClip && props.onClip() }, "🔗v2")])';
  const good = await jpost('/components/edit', { cap: rootCap, id: 'chrome-msg-toolbar', source: V2 });
  ok(good.ok === true && good.version && good.version !== tb.version, `an exact-source edit passes the gate and commits a new version (${String(good.version).slice(0, 8)})`);
  const reg3 = await jget('/chrome/components');
  ok(/tb-v2/.test(reg3.components.find(c => c.id === 'chrome-msg-toolbar').source), 'the served HEAD source is the edited one');
  const hist = await jpost('/components/history', { cap: rootCap, id: 'chrome-msg-toolbar' });
  ok(hist.ok && (hist.versions || []).length >= 2, `component-git history has the lineage (${(hist.versions || []).length} versions)`);
  const rv = await jpost('/components/revert', { cap: rootCap, id: 'chrome-msg-toolbar', version: tb.version });
  ok(rv.ok === true, 'revert to the seed version succeeds (no phantom "no such tool" — git-only components revert clean)');
  const reg4 = await jget('/chrome/components');
  ok(/props\.onCopy/.test(reg4.components.find(c => c.id === 'chrome-msg-toolbar').source), 'after revert the served source is the seed again (history preserved, HEAD moved back)');

  // ── 4. its BACKLOG exists from birth (implicit endowment) ───────────────────────────────────────
  const bl = await jpost('/components/backlog', { cap: rootCap, id: 'chrome-msg-toolbar' });
  ok(bl.ok === true && bl.counts && typeof bl.counts.open === 'number', 'the chrome component has a backlog owner facet from birth');

  // ── browser half ────────────────────────────────────────────────────────────────────────────────
  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - browser checks (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0);
  }
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    // a deterministic consent sheet: stub /scope so clicking Send opens the REAL sheet (no LLM, no auto-approve)
    await page.route('**/scope', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ proposed: ['email'], by: 'test', autoApprove: false, catalog: [{ power: 'email', label: 'send email' }, { power: 'web', label: 'search the web' }] }) }));
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); const id = 'chat-chrome-test';
      localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'chrometest', ts: Date.now(), lastMsgAt: Date.now() }]));
      const tx = []; for (let i = 0; i < 15; i++) { tx.push({ who: 'you', text: `Q${i} UNIQUEUSER` }); tx.push({ who: 'agent', text: `A${i} UNIQUEAGENT` }); }
      localStorage.setItem('field-agent-tx-' + id, JSON.stringify(tx));
    } catch {} }, rootCap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });

    // ── 5. the WELCOME panel renders confined + registry-tagged on the fresh landing ──────────────
    await page.waitForSelector('#composer-tagline [data-component-id=chrome-welcome], #composer-tagline[data-component-id=chrome-welcome]', { timeout: 10000 }).catch(() => {});
    const wr = await page.evaluate(() => {
      const el = document.getElementById('composer-tagline');
      const tagged = el && (el.getAttribute('data-component-id') || (el.querySelector('[data-component-id]') || {}).getAttribute?.('data-component-id'));
      const sug = el ? [...el.querySelectorAll('button.welcome-suggest')] : [];
      if (sug[0]) sug[0].click();
      return { tagged, nSuggest: sug.length, composer: (document.getElementById('text') || {}).value || '' };
    });
    ok(wr.tagged === 'chrome-welcome', `the landing welcome panel is the chrome-welcome component (tagged ${wr.tagged})`);
    ok(wr.nSuggest >= 3, `welcome renders starter suggestions (${wr.nSuggest})`);
    ok(wr.composer.length > 0, `tapping a suggestion fills the composer ("${wr.composer.slice(0, 40)}…")`);

    // ── 6. the CONSENT SHEET is trusted path: 🔒 refusal + no component identity ──────────────────
    // force a FRESH chat (the consent scoper runs on a chat's FIRST message only)
    await page.evaluate(() => { const b = document.getElementById('new-chat'); if (b) b.click(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { document.getElementById('text').value = 'send an email to bob'; document.getElementById('send').click(); });
    await page.waitForSelector('.consent', { timeout: 8000 });
    const cs = await page.evaluate(() => {
      const c = document.querySelector('.consent');
      const r = c.getBoundingClientRect();
      c.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, altKey: true, clientX: r.left + 10, clientY: r.top + 10 }));
      const lockAfterHover = [...document.querySelectorAll('div')].some(d => d.textContent === '🔒 trusted path');
      c.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: r.left + 10, clientY: r.top + 10 }));
      const chipShown = [...document.querySelectorAll('button')].some(b => /✎ edit/.test(b.textContent || '') && b.closest('div') && getComputedStyle(b.closest('div')).display === 'flex');
      return { trusted: c.hasAttribute('data-trusted-path'), compId: c.getAttribute('data-component-id'), innerIds: c.querySelectorAll('[data-component-id]').length, lockAfterHover, chipShown };
    });
    ok(cs.trusted, 'the consent sheet carries data-trusted-path');
    ok(cs.compId === null && cs.innerIds === 0, 'the consent sheet holds NO component identity anywhere inside it');
    ok(cs.lockAfterHover, 'alt-hover over the consent sheet shows the 🔒 trusted path indicator');
    ok(!cs.chipShown, 'alt-click on the consent sheet is REFUSED (no edit chip)');
    // the identity guard is mechanical, not just "nothing tagged it yet": rendering an island INTO a
    // trusted container refuses the tag.
    const guard = await page.evaluate(() => {
      const d = document.createElement('div'); d.setAttribute('data-trusted-path', ''); document.body.appendChild(d);
      try { window.__fieldIslands.renderTaglineHero(d); } catch {}
      const got = d.getAttribute('data-component-id'); d.remove(); return got;
    });
    ok(guard === null, 'tagComponent REFUSES to give a component identity to anything inside [data-trusted-path]');
    await page.evaluate(() => { const b = document.getElementById('sc-cancel'); if (b) b.click(); });

    // ── 7. the per-message TOOLBAR renders confined per message + alt-click selects it ─────────────
    await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /chrometest/.test(s.textContent)); if (it) it.click(); });
    await page.waitForSelector('.msg .msg-toolbar[data-component-id=chrome-msg-toolbar]', { timeout: 10000 });
    const tbr = await page.evaluate(() => ({
      msgs: document.querySelectorAll('.msg').length,
      toolbars: document.querySelectorAll('.msg .msg-toolbar[data-component-id=chrome-msg-toolbar]').length,
      clips: document.querySelectorAll('.msg .msg-toolbar .msg-clip').length,
      copies: document.querySelectorAll('.msg .msg-toolbar .msg-copy').length,
    }));
    ok(tbr.toolbars >= 30, `every message mounts the chrome-msg-toolbar component (${tbr.toolbars}/${tbr.msgs})`);
    ok(tbr.clips >= 30 && tbr.copies >= 30, `each toolbar renders 🔗 clip + 📋 copy (${tbr.clips}/${tbr.copies})`);
    const sel = await page.evaluate(() => {
      const t = document.querySelector('.msg .msg-toolbar[data-component-id=chrome-msg-toolbar]');
      const r = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: r.left + 4, clientY: r.top + 4 }));
      const edit = [...document.querySelectorAll('button')].find(b => (b.textContent || '') === '✎ edit');
      const chip = edit && edit.closest('div');
      const label = chip ? chip.textContent : '';
      return { hasEdit: !!edit, label };
    });
    ok(sel.hasEdit && /Message toolbar/.test(sel.label), `alt-click the toolbar selects it by registry identity ("${sel.label.slice(0, 40)}")`);
    // open its edit chat — the conversational surface addresses chrome-msg-toolbar
    let editChatTarget = null;
    await page.route('**/components/edit-chat', r => { try { editChatTarget = JSON.parse(r.request().postData() || '{}').id; } catch {} r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, answer: 'ok', steps: [] }) }); });
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '') === '✎ edit'); if (b) b.click(); });
    await page.waitForSelector('#ce-input', { timeout: 5000 });
    await page.evaluate(() => { const i = document.getElementById('ce-input'); i.value = 'make the icons bigger'; document.getElementById('ce-send').click(); });
    await page.waitForTimeout(500);
    ok(editChatTarget === 'chrome-msg-toolbar', 'alt-click ✎ opens the conversational edit chat addressed to chrome-msg-toolbar');
    await page.evaluate(() => { const b = document.querySelector('[data-ce-close]'); if (b) b.click(); });

    // ── 8. LIVE APPLY: an edit repaints the mounted chrome without a reload ────────────────────────
    const V3 = '(endowments, props) => endowments.h("div", { class: "tb-live-v3" }, [endowments.h("button", { class: "msg-clip", title: "Clip & share this as a page", onClick: () => props.onClip && props.onClip() }, "🔗"), endowments.h("button", { class: "msg-copy", title: "Copy this message", onClick: () => props.onCopy && props.onCopy() }, "COPY!")])';
    const g2 = await jpost('/components/edit', { cap: rootCap, id: 'chrome-msg-toolbar', source: V3 });
    ok(g2.ok === true, 'a second exact-source edit commits');
    await page.evaluate(async () => { const b = document.getElementById('ce-input'); void b; }); // no-op keepalive
    // the client refreshes chrome after ITS edit-chat edits; an out-of-band edit is picked up by reload —
    // exercise the same reload seam the edit chat uses:
    const live = await page.evaluate(async () => {
      const r = await (await fetch('/chrome/components')).json();
      const c = r.components.find(x => x.id === 'chrome-msg-toolbar');
      // repaint one mounted toolbar through the SAME renderChrome path the app uses on reloadChromeComps
      const host = document.querySelector('.msg .msg-toolbar[data-component-id=chrome-msg-toolbar]');
      const okr = window.__fieldIslands.renderChrome(host, c.source, { onClip: () => {}, onCopy: () => {} }, { componentId: c.id, name: c.name });
      return { okr, hasV3: !!host.querySelector('.tb-live-v3'), copyText: (host.querySelector('.msg-copy') || {}).textContent || '' };
    });
    ok(live.okr && live.hasV3 && live.copyText === 'COPY!', `the edited chrome repaints LIVE in place (no rebuild, no reload) — "${live.copyText}"`);
    await jpost('/components/revert', { cap: rootCap, id: 'chrome-msg-toolbar', version: tb.version }); // restore the seed for the next checks

    // ── 9. PERF: compile-once + render-per-mount stays cheap ──────────────────────────────────────
    const perf = await page.evaluate(async () => {
      const r = await (await fetch('/chrome/components')).json();
      const src = r.components.find(x => x.id === 'chrome-msg-toolbar').source;
      const mk = () => { const d = document.createElement('div'); document.body.appendChild(d); return d; };
      const t0 = performance.now();
      window.__fieldIslands.renderChrome(mk(), src, {}, { componentId: 'chrome-msg-toolbar', name: 'tb' });
      const first = performance.now() - t0; // includes the one-time compile
      const t1 = performance.now();
      const N = 100; const hosts = [];
      for (let i = 0; i < N; i++) { const d = mk(); hosts.push(d); window.__fieldIslands.renderChrome(d, src, {}, { componentId: 'chrome-msg-toolbar', name: 'tb' }); }
      const per = (performance.now() - t1) / N;
      hosts.forEach(d => d.remove());
      return { first: first.toFixed(1), per: per.toFixed(2) };
    });
    console.log(`  info - toolbar mount perf: first (compile+render) ${perf.first}ms, then ${perf.per}ms per mount (compile-once cache)`);
    ok(Number(perf.per) < 5, `per-message mounts are cheap enough to render per message (${perf.per}ms/mount < 5ms)`);

    // ── 10. the SHARES PANEL is trusted path ───────────────────────────────────────────────────────
    await page.evaluate(() => { const t = document.getElementById('tab-shares'); if (t) t.click(); });
    await page.waitForTimeout(800);
    const sh = await page.evaluate(() => {
      const v = document.getElementById('shares-view');
      const r = v.getBoundingClientRect();
      v.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: r.left + 20, clientY: r.top + 20 }));
      const chipShown = [...document.querySelectorAll('button')].some(b => /✎ edit|break out/.test(b.textContent || '') && b.closest('div') && getComputedStyle(b.closest('div')).display === 'flex');
      const lock = [...document.querySelectorAll('div')].some(d => d.textContent === '🔒 trusted path');
      return { trusted: v.hasAttribute('data-trusted-path'), innerIds: v.querySelectorAll('[data-component-id]').length, chipShown, lock };
    });
    ok(sh.trusted, 'the Shares panel (power grant/revoke + auto-confirm rules) carries data-trusted-path');
    ok(sh.innerIds === 0, 'nothing inside the Shares panel holds a component identity (the shares island stays untagged)');
    ok(sh.lock && !sh.chipShown, 'alt-click on the Shares panel is refused with 🔒 (no edit chip)');

    // ── 11. FALLBACK: a chrome mount failure paints the ORIGINAL DOM + auto-files to the backlog ──
    const page2 = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page2.route('**/chrome/components', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, components: [
      { id: 'chrome-msg-toolbar', name: 'Message toolbar', version: 'broken1', source: '(endowments, props) => { throw new Error("staged chrome breakage") }' },
      { id: 'chrome-welcome', name: 'Welcome panel', version: 'broken1', source: '(endowments, props) => { throw new Error("staged chrome breakage") }' },
    ] }) }));
    await page2.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); const id = 'chat-chrome-test';
      localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'chrometest', ts: Date.now(), lastMsgAt: Date.now() }]));
      localStorage.setItem('field-agent-active', id);
      localStorage.setItem('field-agent-tx-' + id, JSON.stringify([{ who: 'you', text: 'hi' }, { who: 'agent', text: 'hello there' }]));
    } catch {} }, rootCap);
    await page2.goto(`${BASE}/`, { waitUntil: 'load' });
    await page2.waitForTimeout(4000);
    await page2.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /chrometest/.test(s.textContent)); if (it) it.click(); });
    await page2.waitForTimeout(1200);
    const fb = await page2.evaluate(() => ({
      legacyClips: document.querySelectorAll('.msg > .msg-clip').length, // the fallback button sits directly on .msg
      chromeMounts: document.querySelectorAll('[data-component-id=chrome-msg-toolbar]').length,
      welcomeChrome: document.querySelectorAll('[data-component-id=chrome-welcome]').length,
    }));
    ok(fb.legacyClips >= 2 && fb.chromeMounts === 0, `a broken chrome toolbar falls back to the original 🔗 DOM (${fb.legacyClips} legacy, ${fb.chromeMounts} chrome) — never a dead toolbar`);
    ok(fb.welcomeChrome === 0, 'the broken welcome chrome also refuses (island/static fallback painted instead)');
    await page2.waitForTimeout(1500); // let /error/flag land
    const bl2 = await jpost('/components/backlog', { cap: rootCap, id: 'chrome-msg-toolbar' });
    const item = (bl2.items || []).find(i => i.kind === 'error' && /chrome component failed/.test(i.title));
    ok(!!item, `the mount failure auto-filed onto chrome-msg-toolbar's OWN backlog ("${item && item.title.slice(0, 60)}…")`);
    await page2.close();

    ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
