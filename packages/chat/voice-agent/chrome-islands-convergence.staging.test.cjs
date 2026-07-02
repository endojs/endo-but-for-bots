#!/usr/bin/env node
// chrome-islands-convergence.staging.test.cjs — STAGING (real-run) proof for the FIRST INCREMENT of
// ARCH-1 (designs/preact-component-trie.md "ARCH-1 convergence"): two vite ISLANDS with app.js inline
// twins are promoted onto the git-backed CHROME lane —
//   • message-controls (island + userBubbleControls twin)  → chrome-msg-controls  (ISL-2)
//   • exhausted-card   (island + renderExhausted twin)      → chrome-exhausted     (ISL-3/DEAD-3)
// Each is now a `(endowments, props) => vnode` source seeded into component-git at boot, rendered through
// the confined no-iframe path under FIELD_LOCKDOWN, alt-click-selectable by registry identity, live-editable
// (render-check-gated: a throwing edit is REFUSED and the seed stays), and mounted by the host with the
// original hardcoded DOM kept as the fallback branch (renderChrome → false → legacy render, never a blank).
// ACTIONS STAY HOST CALLBACKS: the confined component only fires onRetry/onFork/onTopUp/onAbandon — the
// props ARE the ocap boundary; no new authority crosses it.
//
// Boots an ISOLATED voice-agent (throwaway state dirs — never touches the live :8778 component-git).
// Run: node chrome-islands-convergence.staging.test.cjs   (SKIPs browser checks without chromium).

const { startIsolatedServer, loadChromium, launchBrowser, injectCap } = require('./test-harness.cjs');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };

(async () => {
  const srv = await startIsolatedServer({ lockdown: true });
  const jget = p => fetch(`${srv.base}${p}`).then(r => r.json());
  const jpost = (p, b) => fetch(`${srv.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
  ok(!!srv.cap, 'isolated server booted with a per-instance root cap (throwaway state, FIELD_LOCKDOWN=1)');

  // ── 1. the registry: both new pieces seeded at boot, served at HEAD with their contract headers ──────
  const reg = await jget('/chrome/components');
  const byId = Object.fromEntries((reg.components || []).map(c => [c.id, c]));
  ok(reg.ok && byId['chrome-msg-controls'], 'chrome-msg-controls is seeded into component-git + served at /chrome/components');
  ok(reg.ok && byId['chrome-exhausted'], 'chrome-exhausted is seeded into component-git + served at /chrome/components');
  const mc = byId['chrome-msg-controls'] || {};
  const ex = byId['chrome-exhausted'] || {};
  ok(/mc-btn/.test(mc.source) && /props\.onFork/.test(mc.source) && /msg-ctrl/.test(mc.source),
    'chrome-msg-controls source carries the load-bearing classes (msg-ctrl/mc-btn) + the onFork contract');
  ok(/'confirm'/.test(ex.source) && /props\.onTopUp/.test(ex.source) && /props\.onAbandon/.test(ex.source),
    'chrome-exhausted source carries the .confirm button + the onTopUp/onAbandon contract');
  ok(/^[0-9a-f]{6,40}$/.test(String(mc.version)) && /^[0-9a-f]{6,40}$/.test(String(ex.version)),
    `both promoted pieces carry a real git version (${String(mc.version).slice(0, 8)} / ${String(ex.version).slice(0, 8)})`);

  // ── increment 2: chrome-dev-task-card / chrome-ask-card / chrome-chat-bar seeded with their contracts ──
  const dt = byId['chrome-dev-task-card'] || {};
  const ac = byId['chrome-ask-card'] || {};
  const cb = byId['chrome-chat-bar'] || {};
  ok(reg.ok && byId['chrome-dev-task-card'] && byId['chrome-ask-card'] && byId['chrome-chat-bar'],
    'increment-2 pieces (chrome-dev-task-card / chrome-ask-card / chrome-chat-bar) are all seeded + served');
  ok(/dev-thread-toggle/.test(dt.source) && /props\.onReplySend/.test(dt.source) && /props\.onToggle/.test(dt.source),
    'chrome-dev-task-card source carries the .dev-thread-toggle class + the onToggle/onReplySend contract');
  ok(/ask-btns/.test(ac.source) && /type: 'password'/.test(ac.source) && /props\.onSubmit/.test(ac.source),
    'chrome-ask-card source carries .ask-btns, the masked password (secret hygiene), + the onSubmit contract');
  ok(/cb-title/.test(cb.source) && /cb-scrub/.test(cb.source) && /onRerun/.test(cb.source) && /onOpenProject/.test(cb.source),
    'chrome-chat-bar source carries .cb-title/.cb-scrub + the memo (onRerun) + chat (onOpenProject) contracts');
  ok(dt.source.length < 16000 && ac.source.length < 16000 && cb.source.length < 16000,
    `all three increment-2 sources are under the 16k source cap (${dt.source.length}/${ac.source.length}/${cb.source.length})`);
  ok(/^[0-9a-f]{6,40}$/.test(String(dt.version)) && /^[0-9a-f]{6,40}$/.test(String(ac.version)) && /^[0-9a-f]{6,40}$/.test(String(cb.version)),
    'each increment-2 piece carries a real git version (its own lineage + backlog)');

  // ── 2. render-check gate: a THROWING edit is REFUSED — the live piece can only degrade to its own seed ─
  const badMc = await jpost('/components/edit', { cap: srv.cap, id: 'chrome-msg-controls', source: '(endowments, props) => { throw new Error("mc boom") }' });
  ok(badMc.ok === false && /render check/i.test(badMc.error || ''), `a throwing chrome-msg-controls edit is refused by the render check (${(badMc.error || '').slice(0, 46)}…)`);
  const badEx = await jpost('/components/edit', { cap: srv.cap, id: 'chrome-exhausted', source: 'garbage(((' });
  ok(badEx.ok === false, 'an unparseable chrome-exhausted edit is refused (seed preserved)');
  const reg2 = await jget('/chrome/components');
  const b2 = Object.fromEntries((reg2.components || []).map(c => [c.id, c]));
  ok(/mc-btn/.test((b2['chrome-msg-controls'] || {}).source) && /'confirm'/.test((b2['chrome-exhausted'] || {}).source),
    'after the refused edits the served HEAD sources are still the seeds (history untouched)');
  // the same render-check gate protects the increment-2 pieces (proves the alt-click edit lane works for them)
  const badDt = await jpost('/components/edit', { cap: srv.cap, id: 'chrome-dev-task-card', source: '(endowments, props) => { throw new Error("dt boom") }' });
  ok(badDt.ok === false && /render check/i.test(badDt.error || ''), 'a throwing chrome-dev-task-card edit is refused by the render check (seed preserved)');

  // ── 3. a GOOD edit lands as a new version (proves the alt-click edit-chat lane works for the new ids) ──
  const V2 = mc.source.replace('const kids = [', 'const kids = [ /* mc-v2 */');
  const good = await jpost('/components/edit', { cap: srv.cap, id: 'chrome-msg-controls', source: V2 });
  ok(good.ok !== false, 'a well-formed chrome-msg-controls edit passes the render check + commits');
  const rev = await jpost('/components/revert', { cap: srv.cap, id: 'chrome-msg-controls', version: String(mc.version) });
  ok(rev.ok !== false, 'reverting chrome-msg-controls to the seed version is accepted (non-destructive history)');

  // ── 4. BROWSER: the confined render path, host-callback actions, alt-click identity, broken-edit fallback
  const chromium = loadChromium();
  if (!chromium) {
    console.log('  SKIP - browser checks (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed`); srv.close(); process.exit(fail ? 1 : 0);
  }
  const browser = await launchBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await injectCap(page, srv.cap);
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    // renderChrome refuses outside lockdown — confirm the realm is frozen (else the whole path is decorative).
    const locked = await page.evaluate(() => {
      try { return typeof globalThis.lockdown === 'function' && Object.isFrozen(Object.prototype); } catch { return false; }
    });
    ok(locked, 'the page realm is locked down (severe taming) — the confined chrome path is real, not decorative');

    const r = await page.evaluate(async () => {
      const reg3 = await (await fetch('/chrome/components')).json();
      const idx = Object.fromEntries(reg3.components.map(c => [c.id, c]));
      const isl = window.__fieldIslands;
      const out = {};

      // chrome-msg-controls: mount through the SAME renderChrome path app.js uses; fire onFork via a click.
      {
        const el = document.createElement('div'); document.body.appendChild(el);
        let forked = null; let retried = false;
        const okm = isl.renderChrome(el, idx['chrome-msg-controls'].source,
          { hasAudio: true, varIx: 1, varCount: 3, onRetry() { retried = true; }, onEdit() {}, onPlayAudio() {}, onFork(d) { forked = d; } },
          { componentId: 'chrome-msg-controls', name: 'Message controls' });
        const btns = [...el.querySelectorAll('.mc-btn')];
        const count = (el.querySelector('.mc-count') || {}).textContent || '';
        const retryBtn = btns.find(b => b.textContent === '↻'); if (retryBtn) retryBtn.click();
        const nextBtn = btns.find(b => b.textContent === '▶'); if (nextBtn) nextBtn.click();
        out.mc = { okm, nbtns: btns.length, hasNav: !!el.querySelector('.mc-nav'), count, forked, retried,
          id: el.getAttribute('data-component-id'), name: el.getAttribute('data-component-name') };
      }

      // chrome-exhausted: the host mount host carries .exhausted-card (as renderExhausted sets it); the
      // confined component renders .confirm/.reject inside. Fire onTopUp via clicking the confirm button.
      {
        const el = document.createElement('div'); el.className = 'prop msg exhausted-card'; document.body.appendChild(el);
        let topped = false; let abandoned = false;
        const oke = isl.renderChrome(el, idx['chrome-exhausted'].source,
          { isRoot: false, invited: true, showMetaMask: true, metaMaskLabel: '⛓️ Subscribe with MetaMask', onTopUp() { topped = true; }, onAbandon() { abandoned = true; }, onMetaMask() {} },
          { componentId: 'chrome-exhausted', name: 'Out-of-allowance card' });
        const confirmViaCardSelector = !!document.querySelector('.exhausted-card .confirm'); // the staging selector real flows use
        const conf = el.querySelector('.confirm'); if (conf) conf.click();
        const rej = el.querySelector('.reject'); if (rej) rej.click();
        out.ex = { oke, confirmViaCardSelector, hasConfirm: !!el.querySelector('.confirm'), hasReject: !!el.querySelector('.reject'),
          hasMetaMask: /Subscribe with MetaMask/.test(el.textContent), invitedBlurb: /invite/.test(el.textContent),
          topped, abandoned, id: el.getAttribute('data-component-id') };
      }

      // chrome-dev-task-card: confined mount; toggle the thread + send a reply → host callbacks fire.
      {
        const el = document.createElement('div'); document.body.appendChild(el);
        let toggled = false; let sent = false; let draft = '';
        const okd = isl.renderChrome(el, idx['chrome-dev-task-card'].source,
          { task: { id: 't1', to: 'blacksmith', status: 'done', task: 'do the thing', result: 'done it', thread: [{ role: 'you', text: 'hi' }] },
            accent: '#7c5cff', who: 'blacksmith', expanded: true, draft: 'wip',
            onToggle() { toggled = true; }, onReplyChange(v) { draft = v; }, onReplySend() { sent = true; } },
          { componentId: 'chrome-dev-task-card', name: 'Dev task card' });
        const toggle = el.querySelector('.dev-thread-toggle'); if (toggle) toggle.click();
        const send = [...el.querySelectorAll('button')].find(b => b.textContent === 'Send'); if (send) send.click();
        out.dt = { okd, who: /🔨 blacksmith/.test(el.textContent), status: /done/.test(el.textContent),
          hasThreadBody: !!el.querySelector('.dev-thread-body'), draftVal: (el.querySelector('.dev-thread-row input') || {}).value,
          toggled, sent, id: el.getAttribute('data-component-id') };
      }

      // chrome-ask-card: confined mount; answer a choice (onChange) + submit (onSubmit); secret stays masked.
      {
        const el = document.createElement('div'); document.body.appendChild(el);
        let changed = null; let submitted = null;
        const oka = isl.renderChrome(el, idx['chrome-ask-card'].source,
          { ask: { id: 'k1', title: 'Pick one', requestedBy: 'agent-code',
              questions: [{ id: 'q1', q: 'yes or no?', type: 'bool' }, { id: 'q2', q: 'token', type: 'secret' }] },
            answers: {}, status: '', accent: '#0af',
            onChange(qid, v) { changed = [qid, v]; }, onSubmit(id) { submitted = id; }, onOpenOrigin: undefined },
          { componentId: 'chrome-ask-card', name: 'Ask card' });
        const radios = [...el.querySelectorAll('.kit-check input[type=radio]')];
        if (radios[0]) radios[0].click();
        const pw = el.querySelector('input[type=password]');
        const submit = [...el.querySelectorAll('button')].find(b => b.textContent === 'Submit'); if (submit) submit.click();
        out.ac = { oka, hasTitle: /Pick one/.test(el.textContent), nradios: radios.length, secretMasked: !!pw,
          reqChip: !!el.querySelector('.ask-title .pill'), changed, submitted, id: el.getAttribute('data-component-id') };
      }

      // chrome-chat-bar: both modes. memo → scrubber + rerun; chat → parent/project chips + share badge.
      {
        const em = document.createElement('div'); document.body.appendChild(em);
        let rerun = false; let vnext = false;
        const okm = isl.renderChrome(em, idx['chrome-chat-bar'].source,
          { mode: 'memo', title: 'my memo', versionLabel: 'v1', varIx: 0, varCount: 3,
            onVersionPrev() {}, onVersionNext() { vnext = true; }, onRerun() { rerun = true; } },
          { componentId: 'chrome-chat-bar', name: 'Chat top bar' });
        const nav = [...em.querySelectorAll('.cb-scrub .mini')].find(b => b.textContent === '▶'); if (nav) nav.click();
        const rr = [...em.querySelectorAll('.mini')].find(b => /Re-run/.test(b.textContent)); if (rr) rr.click();

        const ec = document.createElement('div'); document.body.appendChild(ec);
        let openedParent = null; let openedProj = null;
        const okc = isl.renderChrome(ec, idx['chrome-chat-bar'].source,
          { mode: 'chat', title: 'a chat', shareMode: 'read', metered: false,
            parent: { id: 'p1', title: 'parent', available: true }, project: { id: 'pr1', name: 'Proj' },
            onOpenParent(id) { openedParent = id; }, onOpenProject(id) { openedProj = id; } },
          { componentId: 'chrome-chat-bar', name: 'Chat top bar' });
        const par = ec.querySelector('.cb-parent'); if (par) par.click();
        const proj = ec.querySelector('.cb-proj'); if (proj) proj.click();
        out.cb = { okm, okc, memoTitle: /🎙 my memo/.test(em.textContent), scrub: /1\/3/.test(em.textContent),
          vnext, rerun, chatTitle: /a chat/.test(ec.textContent), badge: /read-only/.test(ec.textContent),
          openedParent, openedProj };
      }

      // broken edit → renderChrome returns FALSE (the host then paints the legacy fallback, never a blank).
      {
        const el = document.createElement('div'); document.body.appendChild(el);
        const okb = isl.renderChrome(el, '(endowments, props) => { throw new Error("boom") }', {}, { componentId: 'chrome-msg-controls', name: 'x' });
        out.broken = { returnedFalse: okb === false };
      }
      return out;
    });

    ok(r.mc.okm === true && r.mc.nbtns === 5, `chrome-msg-controls renders confined (${r.mc.nbtns} mc-btn buttons: ↻ ✎ 🔊 ◀ ▶)`);
    ok(r.mc.hasNav && r.mc.count === '2/3', `the fork pager shows ◀ 2/3 ▶ from varIx/varCount props (count="${r.mc.count}")`);
    ok(r.mc.forked === 1 && r.mc.retried === true, 'clicking ▶ fires onFork(1) and ↻ fires onRetry — actions cross as HOST CALLBACKS, not authority');
    ok(r.mc.id === 'chrome-msg-controls' && /Message controls/.test(r.mc.name || ''), `the mount is alt-click-selectable by registry identity ("${r.mc.name}")`);

    ok(r.ex.oke === true && r.ex.hasConfirm && r.ex.hasReject, 'chrome-exhausted renders confined with the .confirm top-up + .reject abandon buttons');
    ok(r.ex.confirmViaCardSelector, 'the ".exhausted-card .confirm" selector real flows drive resolves against the confined render');
    ok(r.ex.hasMetaMask && r.ex.invitedBlurb, 'showMetaMask prop surfaces the ⛓️ rail + the invitee blurb renders from props');
    ok(r.ex.topped === true && r.ex.abandoned === true, 'clicking the confirm/abandon buttons fires onTopUp/onAbandon — host callbacks, the props boundary');
    ok(r.ex.id === 'chrome-exhausted', 'the exhausted card mount is alt-click-selectable by registry identity');

    ok(r.dt.okd === true && r.dt.who && r.dt.status && r.dt.hasThreadBody, 'chrome-dev-task-card renders confined (🔨 who · status + the expanded .dev-thread-body)');
    ok(r.dt.draftVal === 'wip', 'the reply draft is a host-owned prop (draft="wip" round-trips into the confined input)');
    ok(r.dt.toggled === true && r.dt.sent === true, 'clicking the thread toggle + Send fires onToggle/onReplySend — host callbacks, the props boundary');
    ok(r.dt.id === 'chrome-dev-task-card', 'the dev-task card mount is alt-click-selectable by registry identity');

    ok(r.ac.oka === true && r.ac.hasTitle && r.ac.nradios === 2, 'chrome-ask-card renders confined (title + a 2-option bool radio group from typed questions)');
    ok(r.ac.secretMasked && r.ac.reqChip, 'the secret question renders as a MASKED password field (secret hygiene) + the requestedBy chip shows');
    ok(Array.isArray(r.ac.changed) && r.ac.changed[0] === 'q1' && r.ac.changed[1] === 'yes' && r.ac.submitted === 'k1',
      'answering the radio fires onChange(q1,"yes") and Submit fires onSubmit("k1") — host callbacks');
    ok(r.ac.id === 'chrome-ask-card', 'the ask card mount is alt-click-selectable by registry identity');

    ok(r.cb.okm === true && r.cb.memoTitle && r.cb.scrub, 'chrome-chat-bar (memo mode) renders confined with the 🎙 title + the ◀ 1/3 ▶ version scrubber');
    ok(r.cb.vnext === true && r.cb.rerun === true, 'clicking ▶ + "↻ Re-run" fires onVersionNext/onRerun — host callbacks (memo mode)');
    ok(r.cb.okc === true && r.cb.chatTitle && r.cb.badge, 'chrome-chat-bar (chat mode) renders the title + the 🔒 read-only share-rights badge from props');
    ok(r.cb.openedParent === 'p1' && r.cb.openedProj === 'pr1', 'clicking the ↑parent + 📂project chips fires onOpenParent/onOpenProject — host callbacks (chat mode)');

    ok(r.broken.returnedFalse, 'a throwing chrome source → renderChrome returns FALSE → the host falls back to the legacy DOM (never a blank)');
    ok(errs.length === 0, `no uncaught page errors during the confined mounts (${errs.slice(0, 2).join(' | ')})`);
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
