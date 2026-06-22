#!/usr/bin/env node
// theme-matrix.staging.test.cjs — the empirical half of the theme check: render the REAL surfaces + EVERY
// confined island (incl. KitSampler = the whole design system) using the REAL index.html CSS + theme.js,
// then measure WCAG contrast of every visible text node across each theme. Fails any text below the
// "unreadable" floor (3:1) — the check that would have caught the light-mode bug automatically.
//
//   node packages/chat/voice-agent/theme-matrix.staging.test.cjs
//   (needs chromium; skips cleanly if playwright-core is unavailable, like the confinement test)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const PUB = path.join(HERE, 'public');
const FAIL_AT = 3.0;   // WCAG: < 3:1 is unreadable (the bug class measured ~1:1). Hard failure.
const WARN_AT = 4.5;   // WCAG AA for normal text. Reported, not failed (muted labels live here by design).

const styleBlock = (fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];

// Representative raw surfaces (the bug-prone classes) + a mount point per island. The render script imports
// the real theme.js + the built islands bundle and renders KitSampler + every COMPONENT into the stage.
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  #stage{padding:16px;display:flex;flex-direction:column;gap:10px}
${styleBlock}
</style></head><body>
<div id="stage"><div id="log">
  <div class="msg"><div class="who">agent</div><div class="body">an agent reply with a <a href="#">link</a> inside it</div></div>
  <div class="msg user"><div class="who">you</div><div class="body">a user prompt<div class="msg-ctrl"><button class="mc-btn">↻</button><button class="mc-btn">✎</button><span class="mc-nav"><button class="mc-btn">◀</button><span class="mc-count">2/3</span><button class="mc-btn">▶</button></span></div></div></div>
  <div class="prop"><div class="ptitle">⚠️ Proposed action</div><div class="pmeta">a meta note</div><div class="kv"><div><b>to</b>someone@example.com</div></div><div class="warn">a warning line</div></div>
  <div class="ask"><div class="ask-title">❓ A question</div><div class="ask-body">some surrounding context</div><div class="ask-q"><div class="ask-qtext">pick an option</div><input class="ask-in" value="a typed answer"></div></div>
  <div><input value="a generic form field"><select><option>a select option</option></select></div>
  <input class="kit-in" value="a kit design-system input">
  <div class="powers-banner"><span class="pb-label">🔑 this chat can</span><span class="chip">📖 read</span><span class="chip-add">+ Add</span></div>
  <div class="budget-chip">$0.42 left</div>
  <div class="tools">⚙ webSearch, fetch</div>
  <div class="qrcard"><div class="dkm">reveal sheet with a <code>swiss</code> chip</div></div>
  <div class="trace-strip"><span class="ts-label">⊿ trace · 3</span><span class="tn">🔎 webSearch</span><span class="tn bad">✗ failed</span>
    <div class="trace-sig" style="background:var(--trace-bg);border:1px solid var(--trace-edge);padding:8px;border-radius:8px">
      <div style="color:var(--trace-ok);font:600 12px ui-monospace,monospace">🔎 a successful step</div>
      <div style="color:var(--trace-bad)">✗ a failed step</div>
      <div style="color:var(--trace-call)">▸ a call detail</div>
      <div style="color:var(--trace-result)">◂ a result detail</div></div></div>
  <div class="notif"><div class="ntime">2m ago</div><div class="nbody">a notification body line</div><div class="nmeta"><a class="nlink">a link</a></div></div>
  <div id="chat-list"><div class="chat-item"><span class="ci-title">a chat title</span></div><div class="chat-item on"><span class="ci-title">the active chat</span></div></div>
  <div class="codeview">a code/terminal block (intentionally fixed dark palette)</div>
</div></div>
<script type="module">
  import { applyTheme, applyVars, BUILTINS, theme } from '/theme.js';
  import '/islands/islands.js'; // side-effect: sets globalThis.__fieldIslands
  // wire the propagator exactly as initTheme() does — apply each theme's vars to :root so the WHOLE page
  // (raw surfaces AND confined islands, which inherit :root) re-themes live, not just the static fallback.
  theme.subscribe(t => { applyVars(document.documentElement, t.vars); try { document.documentElement.style.colorScheme = t.mode || 'dark'; } catch {} });
  window.__applyTheme = applyTheme; window.__BUILTINS = BUILTINS;
  const stage = document.getElementById('stage');
  const F = globalThis.__fieldIslands;
  const NAMES = ['KitSampler','SharesPanel','NotificationCard','ChangelogList','PowersBanner','AskCard','ProposalCard','ChatList','MessageControls','ChatMetaBar','DevTaskCard','ExhaustedCard','TraceSignature','ObjectBrowser','ShareLinkManager'];
  window.__renderErrors = [];
  for (const name of NAMES) {
    const box = document.createElement('div'); box.setAttribute('data-island', name); stage.appendChild(box);
    try { F.renderInto(name, box, {}); } catch (e) { window.__renderErrors.push(name + ': ' + (e && e.message)); }
  }
  window.__ready = true;
</script></body></html>`;

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/__theme_harness') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HARNESS); }
  const fp = path.join(PUB, u);
  if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(buf);
  });
});

// the contrast math + walker, injected + run in the page for the CURRENT theme.
const PAGE_MEASURE = ({ FAIL, WARN }) => {
  const parse = c => { const m = String(c).match(/[\d.]+/g) || []; return { r: +m[0] || 0, g: +m[1] || 0, b: +m[2] || 0, a: m[3] == null ? 1 : +m[3] }; };
  const over = (fg, bg) => { const a = fg.a + bg.a * (1 - fg.a); const mix = k => a ? (fg[k] * fg.a + bg[k] * bg.a * (1 - fg.a)) / a : 0; return { r: mix('r'), g: mix('g'), b: mix('b'), a }; };
  const effBg = el => { const layers = []; let n = el; while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0) layers.push(c); n = n.parentElement; } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const relLum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const L1 = relLum(a), L2 = relLum(b); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); };
  const vis = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) !== 0 && el.getClientRects().length > 0; };
  const fails = [], warns = [];
  for (const el of document.getElementById('stage').querySelectorAll('*')) {
    if (!vis(el)) continue;
    let txt = ''; for (const nd of el.childNodes) if (nd.nodeType === 3) txt += nd.textContent;
    txt = txt.replace(/\s+/g, ' ').trim(); if (!txt) continue;
    const cs = getComputedStyle(el); const raw = parse(cs.color); if (raw.a === 0) continue;
    const bg = effBg(el); const fg = over(raw, bg); const r = ratio(fg, bg);
    const rec = { ratio: Math.round(r * 100) / 100, text: txt.slice(0, 44), where: (el.getAttribute('data-island') ? 'island ' + el.getAttribute('data-island') + ' / ' : '') + (el.className || el.tagName.toLowerCase()), fg: cs.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')' };
    if (r < FAIL) fails.push(rec); else if (r < WARN) warns.push(rec);
  }
  return { fails, warns };
};

(async () => {
  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('SKIP — playwright-core unavailable (theme-coverage.test.mjs still gates the var invariants)'); process.exit(0); }

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  let failed = 0;
  try {
    const page = await browser.newPage();
    const perr = [];
    page.on('pageerror', e => perr.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/__theme_harness`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });

    const renderErrors = await page.evaluate(() => window.__renderErrors || []);
    if (renderErrors.length) console.log('  note — island(s) declined to render with empty props (shells still measured): ' + renderErrors.join('; '));
    if (perr.length) { console.log('  FAIL — page errors: ' + perr.join('; ')); failed++; }

    // dark + light (shipped) + a PARTIAL custom theme (only --bg/--ink set) to exercise the backfill path.
    const themes = await page.evaluate(() => {
      const b = window.__BUILTINS;
      return { dark: b.dark, light: b.light, 'partial-dark (backfill)': { name: 'pd', vars: { '--bg': '#0f1226', '--ink': '#e9e9f5' } }, 'partial-light (backfill)': { name: 'pl', vars: { '--bg': '#fbfbfd', '--ink': '#1a1a22' } } };
    });

    for (const tname of Object.keys(themes)) {
      await page.evaluate(t => window.__applyTheme(t), themes[tname]);
      const { fails, warns } = await page.evaluate(PAGE_MEASURE, { FAIL: FAIL_AT, WARN: WARN_AT });
      if (fails.length) {
        failed++;
        console.log(`  FAIL [${tname}] — ${fails.length} unreadable text node(s) (contrast < ${FAIL_AT}:1):`);
        for (const f of fails) console.log(`     ${f.ratio}:1  «${f.text}»  [${f.where}]  fg ${f.fg} on bg ${f.bg}`);
      } else {
        console.log(`  ok - [${tname}] all text ≥ ${FAIL_AT}:1${warns.length ? `  (${warns.length} below AA 4.5 — muted/secondary, not failed)` : ''}`);
      }
    }
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
  console.log(failed ? `\n${failed} theme(s)/check(s) FAILED` : '\nALL THEMES: every text node readable (≥ 3:1)');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
