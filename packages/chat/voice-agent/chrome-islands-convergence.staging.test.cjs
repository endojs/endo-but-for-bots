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

  // ── 2. render-check gate: a THROWING edit is REFUSED — the live piece can only degrade to its own seed ─
  const badMc = await jpost('/components/edit', { cap: srv.cap, id: 'chrome-msg-controls', source: '(endowments, props) => { throw new Error("mc boom") }' });
  ok(badMc.ok === false && /render check/i.test(badMc.error || ''), `a throwing chrome-msg-controls edit is refused by the render check (${(badMc.error || '').slice(0, 46)}…)`);
  const badEx = await jpost('/components/edit', { cap: srv.cap, id: 'chrome-exhausted', source: 'garbage(((' });
  ok(badEx.ok === false, 'an unparseable chrome-exhausted edit is refused (seed preserved)');
  const reg2 = await jget('/chrome/components');
  const b2 = Object.fromEntries((reg2.components || []).map(c => [c.id, c]));
  ok(/mc-btn/.test((b2['chrome-msg-controls'] || {}).source) && /'confirm'/.test((b2['chrome-exhausted'] || {}).source),
    'after the refused edits the served HEAD sources are still the seeds (history untouched)');

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

    ok(r.broken.returnedFalse, 'a throwing chrome source → renderChrome returns FALSE → the host falls back to the legacy DOM (never a blank)');
    ok(errs.length === 0, `no uncaught page errors during the confined mounts (${errs.slice(0, 2).join(' | ')})`);
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
