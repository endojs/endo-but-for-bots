#!/usr/bin/env node
// kit-island-children.staging.test.cjs — STAGING guard for the showComponent ui.island kit: the CONTENT
// primitives (Badge/Chip/Banner/Meta/Btn/EmptyState) read their text from a NAMED prop (label/text/parts),
// but agents very often pass it as CHILDREN — e.g. ui.island("Badge",{},[span(time)]). The builders used to
// IGNORE those children, so the content vanished (the "county-fair app never shows the times" bug). They now
// FALL BACK to rendering children. This loads confined.html and mounts a Badge-via-children component,
// asserting the text renders.
//
// Run: node kit-island-children.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const SRC = `(ui) => ui.island("Card", {}, [
  ui.island("Row", {}, [
    ui.island("Badge", {}, [ui.create("span").text("2:30 PM")]),
    ui.island("Chip", {}, [ui.create("span").text("🐷 pigs")]),
  ]),
  ui.island("Banner", {}, [ui.create("span").text("Toddler Picks")]),
])`;
(async () => {
  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); process.exit(0); }
  const br = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await br.newPage();
    await page.goto('http://127.0.0.1:8778/confined.html', { waitUntil: 'load' }); await page.waitForTimeout(500);
    await page.evaluate(src => { window.postMessage({ __cu: 1, type: 'mount', source: src }, '*'); }, SRC);
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => { const t = document.body.textContent || ''; return { badge: /2:30 PM/.test(t), chip: /pigs/.test(t), banner: /Toddler Picks/.test(t), badgeText: (document.querySelector('.cu-badge') || {}).textContent }; });
    ok(r.badge, `a Badge with the text passed as a CHILD renders it (got badge="${r.badgeText}")`);
    ok(r.chip, 'a Chip with text as a child renders it');
    ok(r.banner, 'a Banner with text as a child renders it');
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
