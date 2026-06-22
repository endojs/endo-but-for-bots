#!/usr/bin/env node
// theme-review.cjs — the EYES of the adversarial theming reviewer. Renders one confined island (by name,
// with representative props) across the built-in themes, and for each theme captures (a) a PNG screenshot
// and (b) a precise computed-style render report for every text / interactive node — the evidence the
// review lenses reason over (colours, contrast, font scale, cursor, focus outline, tap-target size, radius,
// spacing) plus document-level interaction signals (hover/focus-visible/transition/reduced-motion/aria).
//
//   node theme-review.cjs <IslandName> [--out <dir>]
//   → writes <dir>/report.json + <dir>/<theme>.png ; prints the dir + a one-line summary.
//
// It does NOT judge — it gathers. The judgement is the `theme-review` workflow (adversarial lenses over
// this report + the component source). Pairs with theme-matrix.staging.test.cjs (the deterministic floor).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const PUB = path.join(HERE, 'public');
const NAME = process.argv[2] || 'KitSampler';
const outFlag = process.argv.indexOf('--out');
const OUT = outFlag > -1 ? process.argv[outFlag + 1] : path.join('/tmp/theme-review', NAME);
fs.mkdirSync(OUT, { recursive: true });

// representative props per island (shapes mirror islands-ui.test.mjs) so the review sees a realistic render.
const SAMPLE = {
  ProposalCard: { proposal: { id: 'p1', type: 'email', title: 'Send email', detail: { to: 'a@b.c', subject: 'Hi', body: 'a message body' } }, icon: '✉️', accent: '#7c5cff', mayConfirm: true, dontAsk: true },
  AskCard: { ask: { id: 'a1', title: 'Pick', requestedBy: 'agent', body: 'some context', questions: [{ id: 'choice', q: 'one?', type: 'choice', options: ['x', 'y'] }, { id: 'ms', q: 'many?', type: 'multiselect', options: ['p', 'q'] }, { id: 'num', q: 'how many?', type: 'number' }, { id: 'pw', q: 'secret?', type: 'secret' }, { id: 'free', q: 'notes?', type: 'text' }] }, answers: { choice: 'x', ms: ['p'] }, status: '', accent: '#2ea043' },
  DevTaskCard: { task: { id: 't1', to: 'blacksmith', status: 'working', task: 'Do a thing', result: 'a result line', thread: [{ role: 'you', text: 'hi' }, { role: 'blacksmith', text: 'ok' }] }, accent: '#7c5cff', expanded: true, draft: 'my reply' },
  TraceSignature: { steps: [{ name: 'webSearch', icon: '🔎', ok: true, childCount: 2, detail: 'a query' }, { name: 'fetch', icon: '🌐', ok: false, detail: 'failed' }], expanded: true, legend: 'symbols…' },
  ChatList: { items: [{ id: 'c1', title: 'Berlin trip', active: true, needs: true }, { id: 'c2', title: 'voice memo', voice: true, perm: 'read' }], more: 3 },
  ChatMetaBar: { mode: 'chat', title: 'Berlin', shareMode: 'write', metered: true, parent: { id: 'p0', title: 'Research', available: true }, project: { id: 'pr0', name: 'Europe' } },
  MessageControls: { hasAudio: true, varIx: 1, varCount: 3 },
  ExhaustedCard: { isRoot: true },
  NotificationCard: { id: 'n1', title: 'Reminder', body: 'a notification body line', agent: 'field-agent', status: '', links: [{ label: 'open note' }], withDone: true },
  ChangelogList: { merges: [{ id: 'm1', title: 'Tweak the orchestrator', when: '2m ago', reverted: false }, { id: 'm2', title: 'An older change', reverted: true }] },
  PowersBanner: { items: [{ power: 'notes', icon: '📓' }, { power: 'email', icon: '✉️' }], manageable: true },
  ObjectBrowser: { crumbs: [{ label: 'HA' }], roOnly: false, items: [{ label: 'Lights', sub: '4 entities' }, { label: 'Front door', sub: 'lock.front', leaf: true }] },
  ShareLinkManager: { title: 'Trip', links: [{ token: 't1', name: 'kumavis', mode: 'read' }, { token: 't2', name: 'team', mode: 'write', allowanceUsd: 5, adjusting: true }], newName: 'x', newMode: 'read' },
  SharesPanel: {}, KitSampler: {},
};

const styleBlock = (fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
// 'frame-kit' target = the in-frame ui.island kit (the .cu-* components in confined.html, used by reply widgets).
// Its CSS IS the source of truth; render its sampler DOM + theme it like any other surface.
const confinedStyle = (fs.readFileSync(path.join(PUB, 'confined.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const FRAME_KIT_STAGE = `<div id="stage">
  <div class="cu-card"><div class="cu-title">A reused card (ui.island Card)</div>
    <div class="cu-row"><button class="cu-btn primary">Confirm</button><button class="cu-btn">Cancel</button><button class="cu-btn danger">Delete</button></div>
    <div class="cu-meta">agent · just now · v2</div></div>
  <div class="cu-row"><span class="cu-chip">beta</span><span class="cu-badge">3</span></div>
  <div class="cu-banner info">ℹ an info banner</div><div class="cu-banner warn">⚠ a warning</div>
  <div class="cu-banner error">✗ an error</div><div class="cu-banner ok">✓ all good</div>
  <div class="cu-empty">nothing here yet</div>
  <div class="cu-prog"><span style="width:60%"></span></div>
  <label class="cu-field"><span class="cu-label">Your name</span><input class="cu-in" value="typed text" placeholder="name"></label>
  <hr class="cu-divider"><div class="cu-stack"><div class="cu-meta">a stacked meta line</div></div></div>`;
const HARNESS = NAME === 'frame-kit'
  ? `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;} #stage{padding:18px;max-width:720px;background:var(--bg);color:var(--ink)}
${confinedStyle}
</style></head><body>${FRAME_KIT_STAGE}
<script type="module">
  import { applyTheme, applyVars, BUILTINS, theme } from '/theme.js';
  theme.subscribe(t => { applyVars(document.documentElement, t.vars); try { document.documentElement.style.colorScheme = t.mode || 'dark'; } catch {} });
  window.__applyTheme = applyTheme; window.__BUILTINS = BUILTINS; window.__renderError = null; window.__ready = true;
</script></body></html>`
  : `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:var(--bg)} #stage{padding:18px;max-width:720px}
${styleBlock}
</style></head><body><div id="stage"></div>
<script type="module">
  import { applyTheme, applyVars, BUILTINS, theme } from '/theme.js';
  import '/islands/islands.js';
  theme.subscribe(t => { applyVars(document.documentElement, t.vars); try { document.documentElement.style.colorScheme = t.mode || 'dark'; } catch {} });
  window.__applyTheme = applyTheme; window.__BUILTINS = BUILTINS;
  const props = ${JSON.stringify(SAMPLE[NAME] || {})};
  window.__renderError = null;
  try { globalThis.__fieldIslands.renderInto(${JSON.stringify(NAME)}, document.getElementById('stage'), props); }
  catch (e) { window.__renderError = String(e && e.message); }
  window.__ready = true;
</script></body></html>`;

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/__review') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HARNESS); }
  const fp = path.join(PUB, u);
  if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, buf) => { if (e) { res.writeHead(404); return res.end('nf'); } res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(buf); });
});

// per-theme computed-style probe of every text/interactive node (runs in the page).
const PROBE = () => {
  const parse = c => { const m = String(c).match(/[\d.]+/g) || []; return { r: +m[0] || 0, g: +m[1] || 0, b: +m[2] || 0, a: m[3] == null ? 1 : +m[3] }; };
  const over = (f, b) => { const a = f.a + b.a * (1 - f.a); const mx = k => a ? (f[k] * f.a + b[k] * b.a * (1 - f.a)) / a : 0; return { r: mx('r'), g: mx('g'), b: mx('b'), a }; };
  const eff = el => { const L = []; let n = el; while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0) L.push(c); n = n.parentElement; } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = L.length - 1; i >= 0; i--) base = over(L[i], base); return base; };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
  const vis = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity !== 0 && el.getClientRects().length > 0; };
  const interactive = el => /^(button|a|input|select|textarea)$/i.test(el.tagName) || el.hasAttribute('role') || el.hasAttribute('tabindex') || getComputedStyle(el).cursor === 'pointer';
  const out = [];
  const stage = document.getElementById('stage');
  let idx = 0;
  for (const el of stage.querySelectorAll('*')) {
    if (!vis(el)) { idx++; continue; }
    let txt = ''; for (const n of el.childNodes) if (n.nodeType === 3) txt += n.textContent; txt = txt.replace(/\s+/g, ' ').trim();
    const act = interactive(el);
    if (!txt && !act) { idx++; continue; }
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); const bg = eff(el); const fg = over(parse(cs.color), bg);
    out.push({ i: idx++, tag: el.tagName.toLowerCase(), cls: el.className || '', text: txt.slice(0, 40), interactive: act,
      role: el.getAttribute('role') || null, tabindex: el.getAttribute('tabindex'),
      color: cs.color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`, contrast: ratio(fg, bg),
      fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, cursor: cs.cursor,
      outlineWidth: cs.outlineWidth, w: Math.round(r.width), h: Math.round(r.height),
      padding: cs.padding, borderRadius: cs.borderTopLeftRadius, textDecoration: cs.textDecorationLine });
  }
  return out;
};

(async () => {
  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('SKIP — playwright-core unavailable'); process.exit(0); }
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  const report = { component: NAME, generatedFor: 'adversarial theme review', themes: {}, renderError: null, screenshots: {} };
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 760, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/__review`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
    report.renderError = await page.evaluate(() => window.__renderError);
    for (const tname of ['dark', 'light']) {
      await page.evaluate(t => window.__applyTheme(window.__BUILTINS[t]), tname);
      await page.waitForTimeout(120);
      report.themes[tname] = await page.evaluate(PROBE);
      const png = path.join(OUT, `${tname}.png`);
      await page.locator('#stage').screenshot({ path: png });
      report.screenshots[tname] = png;
    }
  } finally { await browser.close(); await new Promise(r => server.close(r)); }

  // document-level interaction signals from the component's SOURCE + its CSS (regex; informs the a11y/motion lenses).
  const kebab = NAME.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const srcRel = NAME === 'frame-kit' ? 'public/confined.html' : `client/${kebab}.js`; // the in-frame kit lives in confined.html
  let src = ''; try { src = fs.readFileSync(path.join(HERE, srcRel), 'utf8'); } catch {}
  const css = NAME === 'frame-kit' ? confinedStyle : styleBlock;
  report.signals = {
    sourceFile: srcRel, sourceFound: !!src,
    usesAria: /\baria-[a-z]+|role\s*[:=]/.test(src), usesFocusVisible: /:focus-visible/.test(css),
    definesHover: new RegExp(`\\.(${(SAMPLE[NAME] ? '' : '')}[a-z-]*)?:hover`).test(css) && /:hover/.test(css),
    definesTransition: /transition\s*:/.test(src) || /transition\s*:/.test(css), definesAnimation: /@keyframes|animation\s*:/.test(css),
    respectsReducedMotion: /prefers-reduced-motion/.test(css), hardcodedColorsInSource: [...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]).filter((v, i, a) => a.indexOf(v) === i),
  };

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const allNodes = Object.values(report.themes).flat();
  const worst = Math.min(...allNodes.map(n => n.contrast).filter(c => c > 0), 99);
  console.log(`theme-review render report for ${NAME}:`);
  console.log(`  out: ${OUT}  (report.json + dark.png + light.png)`);
  console.log(`  nodes probed: ${report.themes.dark ? report.themes.dark.length : 0}/theme · worst contrast: ${worst}:1 · renderError: ${report.renderError || 'none'}`);
  console.log(`  source: ${report.signals.sourceFile} (${report.signals.sourceFound ? 'found' : 'MISSING'}) · hardcoded colors in source: ${report.signals.hardcodedColorsInSource.join(', ') || 'none'}`);
  process.exit(0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
