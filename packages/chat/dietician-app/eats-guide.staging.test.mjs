// eats-guide.staging.test.mjs — STAGING (real-run) proof: generate the Eats Guide from dan's IMPORTED DB and
// drive its filters in a real headless browser. Asserts the page renders many cards across cities, the city
// tabs filter sections, and the "safe bets only" toggle hides BORDERLINE cards. ESM (uses createRequire to
// load playwright-core). Run: node eats-guide.staging.test.mjs
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeFsFolder } from './fs-folder.mjs';
import { makeDietStore } from './store.mjs';
import { makePipeline } from './core.mjs';

const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };

const DEST = process.argv[2] || `${os.homedir()}/.local/state/dietician-app/instances/alexa`;

(async () => {
  // 1. generate the guide from the real store into a temp site dir
  const store = makeDietStore(makeFsFolder(DEST), { person: 'alexa' });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eats-site-'));
  const siteStore = makeDietStore(makeFsFolder(out), { person: 'alexa' });
  // reuse generate but redirect artifacts to the temp dir by wrapping the store's writeArtifact
  const gen = makePipeline({ store: { ...store, writeArtifact: siteStore.writeArtifact }, person: 'alexa' });
  const r = await gen.generateGuide('eats');
  ok(r.ok && r.cards > 50, `generated eats guide from the imported DB (${r.cards} cards: ${r.viable} viable + ${r.borderline} borderline)`);
  const indexPath = path.join(out, 'site', 'eats', 'index.html');
  ok(fs.existsSync(indexPath) && fs.existsSync(path.join(out, 'site', 'eats', 'sort.js')), 'site/eats/index.html + sort.js written');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless filter check (playwright-core unavailable); structure asserted by node --test');
  } else {
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage();
      page.on('pageerror', e => console.error('  [pageerror]', e.message));
      await page.goto('file://' + indexPath, { waitUntil: 'domcontentloaded' });

      const total = await page.$$eval('.card', els => els.length);
      const sections = await page.$$eval('section[data-zone]', els => els.length);
      ok(total > 50 && sections > 1, `rendered ${total} cards across ${sections} city sections`);

      // city tab filter: click the 2nd city tab → only that section visible
      const zone = await page.$eval('.city-tab:not([data-zone="all"])', el => el.getAttribute('data-zone'));
      await page.click(`.city-tab[data-zone="${zone}"]`);
      const visibleSections = await page.$$eval('section[data-zone]', els => els.filter(s => s.style.display !== 'none').length);
      ok(visibleSections === 1, `clicking a city tab shows exactly its section (got ${visibleSections})`);
      await page.click('.city-tab[data-zone="all"]');

      // safe-only toggle: borderline cards hidden (display:none via CSS)
      const borderlineVisibleBefore = await page.$$eval('.card.borderline', els => els.filter(c => c.offsetParent !== null).length);
      await page.click('#safe-only-btn');
      const borderlineVisibleAfter = await page.$$eval('.card.borderline', els => els.filter(c => c.offsetParent !== null).length);
      ok(borderlineVisibleBefore > 0 && borderlineVisibleAfter === 0, `"safe bets only" hides all ${borderlineVisibleBefore} borderline cards`);

      // text search via sort.js
      await page.fill('#text-filter', 'zzzqqq-nomatch');
      await page.waitForTimeout(60);
      const afterSearch = await page.$$eval('.card', els => els.filter(c => c.offsetParent !== null).length);
      ok(afterSearch === 0, 'sort.js text search hides non-matching cards');
    } finally { await browser.close(); }
  }

  fs.rmSync(out, { recursive: true, force: true });
  console.log(`\n${fail ? '✗' : '✓'} eats-guide staging: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
