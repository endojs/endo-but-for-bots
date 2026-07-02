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
      // Pin PUBLIC_BASE_URL to the loopback origin the browser actually loads: the default (tailnet IP) makes
      // a boot-time resource load cross-origin and ABORT, wedging the client at "connecting…" (tab-components
      // never un-hides). Same-origin here → boot completes deterministically. (Pre-existing flake, not the SUT.)
      PUBLIC_BASE_URL: BASE,
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
  ok(reg.ok && Array.isArray(reg.components) && reg.components.length === 4, `GET /chrome/components lists the seeded chrome (${(reg.components || []).length})`);
  ok((reg.components || []).some(c => c.id === 'chrome-trace-view' && /THE CELL IS THE INTERFACE/.test(c.source)), 'chrome-trace-view seeded with the cell-contract header (the schema riffers see in the edit chat)');
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

  // ── 4b. chrome-studio: the Components/Studio LIST itself is registry-backed chrome (wave 1) ──────
  // dan's ask: the Studio's section ORDER was a hardcoded concat in app.js; now it's DATA in the source
  // (SECTION_ORDER) → "reorder sections" is a one-line source edit, persisted as a git commit.
  const studioOf = r => (r.components || []).find(c => c.id === 'chrome-studio');
  const s0 = studioOf(reg);
  ok(!!s0, 'chrome-studio is seeded + served at HEAD (the Studio list is now editable chrome)');
  ok(s0 && /SECTION_ORDER/.test(s0.source) && /props\.onAdmit/.test(s0.source) && /THE SECTION ORDER IS DATA/.test(s0.source),
    'chrome-studio ships SECTION_ORDER + the props/callback contract in its header (riffers see the schema in the edit chat)');
  ok(s0 && /^[0-9a-f]{6,40}$/.test(String(s0.version)), `chrome-studio carries a real git version (${s0 && String(s0.version).slice(0, 8)})`);
  // anti-brick floor 1: a throwing edit is REFUSED by the render check; HEAD stays live
  const sbad = await jpost('/components/edit', { cap: rootCap, id: 'chrome-studio', source: '(endowments, props) => { throw new Error("studio boom") }' });
  ok(sbad.ok === false && /render check/i.test(sbad.error || ''), `a throwing chrome-studio edit is REFUSED by the render check (${(sbad.error || '').slice(0, 50)}…)`);
  ok(studioOf(await jget('/chrome/components')).version === s0.version, 'chrome-studio HEAD is unchanged after the refused edit (previous version stays live)');
  // REORDER the sections purely by editing the source (the whole point) — exact-source lane, deterministic
  const reordered = s0.source.replace(/const SECTION_ORDER = \[[^\]]*\];/, "const SECTION_ORDER = ['islands', 'chrome', 'admitted', 'pending'];");
  ok(reordered !== s0.source, 'the SECTION_ORDER line is present + rewritable (reorder = a one-line source edit)');
  const sedit = await jpost('/components/edit', { cap: rootCap, id: 'chrome-studio', source: reordered });
  ok(sedit.ok === true && sedit.version && sedit.version !== s0.version, `a section-order edit passes the gate + commits a new version (${String(sedit.version || '').slice(0, 8)})`);
  const s1 = studioOf(await jget('/chrome/components'));
  ok(/\['islands', 'chrome', 'admitted', 'pending'\]/.test(s1.source), 'the served HEAD carries the REORDERED SECTION_ORDER (persists as a git commit → survives reload)');
  const shist = await jpost('/components/history', { cap: rootCap, id: 'chrome-studio' });
  ok(shist.ok && (shist.versions || []).length >= 2, `chrome-studio git lineage records the reorder version (${(shist.versions || []).length} versions)`);
  // revert restores the seed order (non-destructive; history preserved)
  const srev = await jpost('/components/revert', { cap: rootCap, id: 'chrome-studio', version: s0.version });
  ok(srev.ok === true, 'chrome-studio reverts to the seed order (non-destructive)');
  ok(/\['pending', 'admitted', 'chrome', 'islands'\]/.test(studioOf(await jget('/chrome/components')).source), 'after revert the served SECTION_ORDER is the seed order again (HEAD moved back, history kept)');

  // ── 4c. chrome-studio SORT + FOLD contract lives in the seed source (dan 2026-07-02) ────────────
  //   most-recent(proxy)-first + fold the long tail, needs-review pinned+unfolded, + the increment-2 note.
  const s0src = s0.source;
  ok(/byRecent/.test(s0src) && /versions\.length/.test(s0src), 'chrome-studio sorts sections by a byRecent() recency proxy (versions.length — the only per-item activity signal in props)');
  ok(/FOLD_AT/.test(s0src) && /show '\s*\+\s*rest\s*\+\s*' more/.test(s0src) && /endowments\.useState/.test(s0src), 'chrome-studio folds the long tail behind a useState "show N more" toggle');
  ok(/NEVER (?:sorted-away or )?folded/.test(s0src) && /pending: \(\) =>/.test(s0src), 'needs-review (pending) is pinned top + exempt from the fold in the source');
  ok(/INCREMENT-2 FOLLOW-UP/.test(s0src) && /usageCount/.test(s0src) && /updatedAt/.test(s0src), 'the increment-2 gap (per-component usageCount + updatedAt need a store/props addition) is documented in the source header');
  // it still compiles + passes the render-check gate: an exact re-commit of the seed source is accepted
  // (a broken source would be REFUSED — proven for the throwing case in §4b above).
  const sReedit = await jpost('/components/edit', { cap: rootCap, id: 'chrome-studio', source: s0src });
  ok(sReedit.ok === true, 'the sort+fold seed source passes the real render-check gate (an exact re-commit is accepted)');
  await jpost('/components/revert', { cap: rootCap, id: 'chrome-studio', version: s0.version }); // back to seed HEAD

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
      const overlaps = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
      const el = document.getElementById('composer-tagline');
      const tagged = el && (el.getAttribute('data-component-id') || (el.querySelector('[data-component-id]') || {}).getAttribute?.('data-component-id'));
      const sug = el ? [...el.querySelectorAll('button.welcome-suggest')] : [];
      // GEOMETRY (dan: the suggestions must NOT overlay the input or clobber the trusted path — they sit
      // in normal flow and push the input box DOWN). Measure BEFORE clicking a suggestion (the click only
      // fills the composer; it must not change the landing layout).
      const landing = document.body.classList.contains('landing');
      const wRect = el ? el.getBoundingClientRect() : null;
      const composer = document.getElementById('composer');
      const cRect = composer ? composer.getBoundingClientRect() : null;
      const text = document.getElementById('text');
      const tRect = text ? text.getBoundingClientRect() : null;
      // the composer sits BELOW the welcome panel (its top is at/under the panel's bottom) → no overlap.
      const composerBelow = !!(wRect && cRect) && cRect.top >= wRect.bottom - 1;
      const welcomeOverComposer = !!(wRect && cRect) && overlaps(wRect, cRect);
      // the welcome panel must not overlap ANY [data-trusted-path] surface currently on screen.
      const tp = [...document.querySelectorAll('[data-trusted-path]')]
        .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const tpCount = tp.length;
      const welcomeOverTrusted = !!wRect && tp.some(e => overlaps(wRect, e.getBoundingClientRect()));
      // the input box is fully visible + not occluded: its centre point hits #text (not something on top).
      let inputClickable = false;
      if (tRect && tRect.width > 0 && tRect.height > 0) {
        const top = document.elementFromPoint(tRect.left + tRect.width / 2, tRect.top + tRect.height / 2);
        inputClickable = !!top && (top === text || text.contains(top));
      }
      if (sug[0]) sug[0].click();
      return { tagged, nSuggest: sug.length, composer: (document.getElementById('text') || {}).value || '',
        landing, composerBelow, welcomeOverComposer, tpCount, welcomeOverTrusted, inputClickable,
        wRect: wRect && { top: Math.round(wRect.top), bottom: Math.round(wRect.bottom) },
        cTop: cRect && Math.round(cRect.top) };
    });
    ok(wr.tagged === 'chrome-welcome', `the landing welcome panel is the chrome-welcome component (tagged ${wr.tagged})`);
    ok(wr.nSuggest >= 3, `welcome renders starter suggestions (${wr.nSuggest})`);
    ok(wr.composer.length > 0, `tapping a suggestion fills the composer ("${wr.composer.slice(0, 40)}…")`);
    // ── 5b. IN-FLOW LAYOUT: the welcome panel pushes the input DOWN, never overlays it or the trusted path ─
    ok(wr.landing, 'the fresh boot opens the empty landing chat (welcome panel visible)');
    ok(wr.composerBelow && !wr.welcomeOverComposer, `the welcome panel is in normal flow ABOVE the docked composer — composer top (${wr.cTop}) is below the panel bottom (${wr.wRect && wr.wRect.bottom}); no overlap`);
    ok(wr.tpCount >= 1, `at least one [data-trusted-path] surface is on the landing screen (${wr.tpCount}) — the powers banner`);
    ok(!wr.welcomeOverTrusted, 'the welcome panel does NOT overlap any [data-trusted-path] surface (the trusted path is never occluded)');
    ok(wr.inputClickable, 'the composer input box is fully visible + clickable (nothing overlays it at its centre)');

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

    // ── 12. chrome-studio renders the Studio list confined + alt-selectable + section order is DATA ──
    await page.evaluate(() => { const t = document.getElementById('tab-components'); if (t) t.click(); });
    await page.waitForSelector('#components-list[data-component-id=chrome-studio]', { timeout: 12000 }).catch(() => {});
    const st = await page.evaluate(() => {
      const list = document.getElementById('components-list');
      const secs = [...(list ? list.querySelectorAll('.shares-sec') : [])].map(s => s.textContent);
      const ci = secs.findIndex(s => /App chrome/.test(s));
      const ii = secs.findIndex(s => /Islands/.test(s));
      return { tagged: list && list.getAttribute('data-component-id'), secs,
        hasChrome: ci >= 0, hasIsl: ii >= 0, chromeBeforeIsl: ci >= 0 && ii >= 0 && ci < ii };
    });
    ok(st.tagged === 'chrome-studio', `the Components list is rendered by the confined chrome-studio component (tagged ${st.tagged})`);
    ok(st.hasChrome && st.hasIsl, `chrome-studio renders the App chrome + Islands sections (${st.secs.join(' | ').slice(0, 80)})`);
    ok(st.chromeBeforeIsl, 'the seed SECTION_ORDER puts App chrome BEFORE Islands (the order is DATA in the source — reorder it to swap)');
    // alt-click the list chrome OUTSIDE any card (a section header) → closest() resolves to the
    // chrome-studio-tagged list → the chip names the Studio (registry identity). Clicking a card would
    // instead select THAT card's component (data-component-id) — the intended per-piece drill-in.
    const stSel = await page.evaluate(() => {
      const sec = document.querySelector('#components-list .shares-sec');
      const r = sec.getBoundingClientRect();
      sec.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: r.left + 4, clientY: r.top + 4 }));
      // the selection CHIP is the floating element carrying data-act=edit + data-act=x (in document.body,
      // not inside the list). Its innerHTML is rewritten on each selection → its text names the target.
      const x = document.querySelector('button[data-act=x]');
      const chip = x && x.parentElement;
      return { label: chip ? chip.textContent : '', shown: !!chip && getComputedStyle(chip).display === 'flex' };
    });
    ok(stSel.shown && /Component Studio/.test(stSel.label), `alt-click the Studio selects chrome-studio by registry identity ("${stSel.label.slice(0, 40)}")`);
    // REVERT through the CALLBACK path: chrome-studio has >1 version (reorder+revert above) → its own row
    // shows a revert button → clicking it fires props.onRevert → host studioRevert → /components/revert.
    let revertCall = null;
    await page.route('**/components/revert', r => { try { revertCall = JSON.parse(r.request().postData() || '{}'); } catch {} r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
    page.on('dialog', d => d.accept());
    const hadRevert = await page.evaluate(() => {
      const b = [...document.querySelectorAll('#components-list button')].find(x => (x.textContent || '') === 'revert');
      if (b) b.click(); return !!b;
    });
    await page.waitForTimeout(500);
    ok(hadRevert && revertCall && /^chrome-/.test(String(revertCall.id || '')), `a revert button in the confined Studio fires the onRevert CALLBACK host-side (id ${revertCall && revertCall.id}) — actions stay host-gated`);

    // ── 13. ADMIT through the CALLBACK path (fresh page, fake pending tool via routed /tools/review) ──
    const page3 = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page3.route('**/tools/review', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, tools: [
      { id: 'pend-1', status: 'pending', name: 'Fake pending tool', proposedBy: 'agent-x', review: { worst: 'none', findings: [{ discipline: 'safety', severity: 'none' }] }, code: 'const x = 1;' },
    ] }) }));
    let admitCall = null;
    await page3.route('**/tools/admit', r => { try { admitCall = JSON.parse(r.request().postData() || '{}'); } catch {} r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
    await page3.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, rootCap);
    await page3.goto(`${BASE}/`, { waitUntil: 'load' });
    await page3.waitForTimeout(1500);
    await page3.evaluate(() => { const t = document.getElementById('tab-components'); if (t) t.click(); });
    await page3.waitForSelector('#components-list[data-component-id=chrome-studio]', { timeout: 12000 }).catch(() => {});
    const adm = await page3.evaluate(() => {
      const list = document.getElementById('components-list');
      const pendingSec = [...list.querySelectorAll('.shares-sec')].some(s => /Pending review/.test(s.textContent));
      const admitBtn = [...list.querySelectorAll('button')].find(b => (b.textContent || '') === 'admit');
      if (admitBtn) admitBtn.click();
      return { pendingSec, hadAdmit: !!admitBtn };
    });
    await page3.waitForTimeout(500);
    ok(adm.pendingSec && adm.hadAdmit, 'chrome-studio renders the Pending review section + an admit button from the props');
    ok(admitCall && admitCall.id === 'pend-1', `clicking admit fires the onAdmit CALLBACK to the host with the right id (${admitCall && admitCall.id})`);
    await page3.close();

    // ── 14. FALLBACK: a broken chrome-studio source → the imperative LEGACY Studio list (+ backlog) ──
    const page4 = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page4.route('**/chrome/components', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, components: [
      { id: 'chrome-msg-toolbar', name: 'Message toolbar', version: 'v', source: '(e,p)=>e.h("div",null,"tb")' },
      { id: 'chrome-welcome', name: 'Welcome panel', version: 'v', source: '(e,p)=>e.h("div",null,"wc")' },
      { id: 'chrome-trace-view', name: 'Trace view (live)', version: 'v', source: '(e,p)=>e.h("div",null,"tv")' },
      { id: 'chrome-studio', name: 'Component Studio', version: 'broken', source: '(endowments, props) => { throw new Error("staged chrome-studio breakage") }' },
    ] }) }));
    await page4.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, rootCap);
    await page4.goto(`${BASE}/`, { waitUntil: 'load' });
    await page4.waitForTimeout(1500);
    await page4.evaluate(() => { const t = document.getElementById('tab-components'); if (t) t.click(); });
    await page4.waitForTimeout(1800);
    const fbs = await page4.evaluate(() => {
      const list = document.getElementById('components-list');
      return { tagged: list && list.getAttribute('data-component-id'),
        legacyEditBtns: list ? list.querySelectorAll('[data-edit]').length : 0, // imperative fallback wires data-edit
        chromeSec: [...(list ? list.querySelectorAll('.shares-sec') : [])].some(s => /App chrome/.test(s.textContent)) };
    });
    ok(fbs.tagged !== 'chrome-studio', 'a broken chrome-studio does NOT tag the list (the confined mount refused → fell through)');
    ok(fbs.legacyEditBtns >= 1 && fbs.chromeSec, `the broken Studio falls back to a WORKING imperative list (${fbs.legacyEditBtns} data-edit ✎ buttons) — admit/edit/revert still reachable`);
    await page4.waitForTimeout(1200); // let /error/flag land
    const sbl = await jpost('/components/backlog', { cap: rootCap, id: 'chrome-studio' });
    const sItem = (sbl.items || []).find(i => i.kind === 'error' && /chrome component failed/.test(i.title));
    ok(!!sItem, `the chrome-studio mount failure auto-filed onto its OWN backlog ("${sItem && sItem.title.slice(0, 50)}…")`);
    await page4.close();

    // ── 15. SORT + FOLD (dan 2026-07-02): recency(proxy)-sorted sections, a long-tail fold, needs-review
    //   pinned + NEVER folded. Fresh page with routed data: 8 pending + 9 admitted; one admitted item (a8)
    //   carries extra versions so byRecent (versions.length proxy) floats it to the TOP. Real chrome-studio
    //   source (we DON'T route /chrome/components) renders it. ──
    const page5 = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const p5errs = []; page5.on('pageerror', e => p5errs.push(e.message));
    const pend5 = []; for (let i = 0; i < 8; i++) pend5.push({ id: 'p' + i, status: 'pending', name: 'pending' + i, proposedBy: 'agent-x', review: { worst: 'none', findings: [{ discipline: 'safety', severity: 'none' }] }, code: 'const x=1;' });
    const adm5 = []; for (let i = 0; i < 9; i++) adm5.push({ id: 'a' + i, status: 'admitted', name: 'tool' + i, kind: 'instance' });
    await page5.route('**/tools/review', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, tools: [...pend5, ...adm5] }) }));
    // per-id history: a8 has 5 versions (most-edited → recency-proxy top); everyone else 1.
    await page5.route('**/components/history', r => { let id = ''; try { id = JSON.parse(r.request().postData() || '{}').id; } catch {} const n = id === 'a8' ? 5 : 1; const versions = []; for (let k = 0; k < n; k++) versions.push({ version: 'v' + id + k, summary: 's' }); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, versions, grains: {} }) }); });
    await page5.route('**/components/islands', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, islands: [] }) }));
    await page5.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, rootCap);
    await page5.goto(`${BASE}/`, { waitUntil: 'load' });
    await page5.waitForTimeout(1500);
    await page5.evaluate(() => { const t = document.getElementById('tab-components'); if (t) t.click(); });
    await page5.waitForSelector('#components-list[data-component-id=chrome-studio]', { timeout: 12000 }).catch(() => {});
    const readStudio = () => page5.evaluate(() => {
      const list = document.getElementById('components-list');
      // the confined studio mounts as #components-list > div.studio-list > [headers + cards + folds]; walk a
      // FLAT document-ordered query (headers precede their cards) tracking the current section.
      const nodes = list ? [...list.querySelectorAll('.shares-sec, .comp, .studio-fold')] : [];
      const sections = {}; let cur = null;
      for (const el of nodes) {
        if (el.classList.contains('shares-sec')) { const t = el.textContent || ''; cur = /Pending/.test(t) ? 'pending' : /Admitted/.test(t) ? 'admitted' : /App chrome/.test(t) ? 'chrome' : /Islands/.test(t) ? 'islands' : 't'; sections[cur] = sections[cur] || { cards: [], fold: null }; continue; }
        if (!cur) continue;
        if (el.classList.contains('studio-fold')) { sections[cur].fold = el.textContent || ''; continue; }
        if (el.classList.contains('comp')) sections[cur].cards.push((el.querySelector('b') || {}).textContent || '');
      }
      const folds = list ? [...list.querySelectorAll('.studio-fold')] : [];
      return { tagged: list && list.getAttribute('data-component-id'), sections, totalComp: list ? list.querySelectorAll('.comp').length : 0, foldCount: folds.length, foldDataAttrs: folds.map(f => f.getAttribute('data-fold')) };
    });
    const st0 = await readStudio();
    ok(st0.tagged === 'chrome-studio', `§15 renders through the real confined chrome-studio (tagged ${st0.tagged})`);
    ok(st0.sections.pending && st0.sections.pending.cards.length === 8 && st0.sections.pending.fold === null, `needs-review shows ALL 8 pending items and is NEVER folded (${st0.sections.pending && st0.sections.pending.cards.length} cards, fold=${st0.sections.pending && st0.sections.pending.fold})`);
    ok(st0.sections.admitted && st0.sections.admitted.cards.length === 6 && /show 3 more/.test(st0.sections.admitted.fold || ''), `the 9-item Admitted section folds to the top 6 + a "▸ show 3 more" toggle (${st0.sections.admitted && st0.sections.admitted.cards.length} shown, fold="${st0.sections.admitted && st0.sections.admitted.fold}")`);
    ok(st0.sections.chrome && st0.sections.chrome.cards.length <= 6 && st0.sections.chrome.fold === null, `the short App-chrome section (${st0.sections.chrome && st0.sections.chrome.cards.length}) is NOT folded (only the long tail folds)`);
    ok(st0.foldCount === 1 && !st0.foldDataAttrs.includes('pending'), `exactly ONE fold toggle on the page (admitted), never on needs-review (${st0.foldDataAttrs.join(',')})`);
    ok(st0.sections.admitted && st0.sections.admitted.cards[0] === 'tool8', `byRecent floats the most-edited item (a8, 5 versions) to the TOP of Admitted (first card="${st0.sections.admitted && st0.sections.admitted.cards[0]}") — the recency proxy sorts`);
    // expand the tail
    await page5.evaluate(() => { const b = document.querySelector('.studio-fold[data-fold=admitted]'); if (b) b.click(); });
    await page5.waitForTimeout(300);
    const st1 = await readStudio();
    ok(st1.sections.admitted && st1.sections.admitted.cards.length === 9 && /show less/.test(st1.sections.admitted.fold || ''), `clicking "show more" reveals the full 9-item tail + flips to "▾ show less" (${st1.sections.admitted && st1.sections.admitted.cards.length} cards, fold="${st1.sections.admitted && st1.sections.admitted.fold}")`);
    ok(st1.totalComp === st0.totalComp + 3, `the 3 hidden long-tail cards appear on expand (${st0.totalComp} → ${st1.totalComp})`);
    // collapse again
    await page5.evaluate(() => { const b = document.querySelector('.studio-fold[data-fold=admitted]'); if (b) b.click(); });
    await page5.waitForTimeout(300);
    const st2 = await readStudio();
    ok(st2.sections.admitted && st2.sections.admitted.cards.length === 6 && /show 3 more/.test(st2.sections.admitted.fold || ''), 'clicking "show less" re-folds the long tail (6 shown again) — the toggle is fully reversible');
    ok(p5errs.length === 0, `§15 no page errors (${p5errs.slice(0, 2).join(' | ')})`);
    await page5.close();

    ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
