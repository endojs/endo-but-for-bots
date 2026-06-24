// disney-guide.staging.test.mjs — STAGING proof: build the Disney guide from dan's IMPORTED DB and drive it
// in a real headless browser. Asserts the resort + hotel SVG maps render with dot anchors, the zone radios
// filter sections, "safe bets only" hides borderline cards + dots, and clicking a map dot navigates to a card.
// Run: node disney-guide.staging.test.mjs
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
  const store = makeDietStore(makeFsFolder(DEST), { person: 'alexa' });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'disney-site-'));
  const siteStore = makeDietStore(makeFsFolder(out), { person: 'alexa' });
  const gen = makePipeline({ store: { ...store, writeArtifact: siteStore.writeArtifact }, person: 'alexa' });
  const r = await gen.generateGuide('disney');
  ok(r.ok && r.cards > 5, `generated Disney guide from the imported DB (${r.cards} park cards + ${r.hotel} hotel rows)`);
  const indexPath = path.join(out, 'site', 'disney', 'index.html');
  ok(fs.existsSync(indexPath), 'site/disney/index.html written');
  const html = fs.readFileSync(indexPath, 'utf8');
  ok(/<svg viewBox="0 0 860 560" class="dl-map"/.test(html) && /class="dl-map hotel-map"/.test(html), 'both inline-SVG maps present (resort + hotel)');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless check (playwright-core unavailable); structure asserted by node --test');
  } else {
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage();
      page.on('pageerror', e => console.error('  [pageerror]', e.message));
      await page.goto('file://' + indexPath, { waitUntil: 'domcontentloaded' });

      const dots = await page.$$eval('.dl-map .dot', els => els.length);
      const mapAnchors = await page.$$eval('.dl-map a[href^="#card-"]', els => els.length);
      ok(dots > 5 && mapAnchors > 5, `resort+hotel maps render ${dots} dots, ${mapAnchors} of them card anchors`);

      // zone radio: select "Around the Hotel" → only the hotel section (+ shared) visible
      await page.click('label[for="z-hotel"]');
      const parkVisible = await page.$$eval('section[data-zone="dlr"], section[data-zone="dca"], section[data-zone="ddd"]', els => els.filter(s => s.offsetParent !== null).length);
      const hotelVisible = await page.$eval('.hotel-section', el => el.offsetParent !== null);
      ok(parkVisible === 0 && hotelVisible, 'zone filter "Around the Hotel" hides park sections, shows the hotel section');
      await page.click('label[for="z-all"]');

      // safe-only: borderline cards AND borderline map dots hidden
      const blCardsBefore = await page.$$eval('.card.borderline', els => els.filter(c => c.offsetParent !== null).length);
      await page.click('label[for="safe-only"]');
      const blCardsAfter = await page.$$eval('.card.borderline', els => els.filter(c => c.offsetParent !== null).length);
      const blDotsAfter = await page.$$eval('.dl-map .dot.borderline', els => els.filter(d => d.getBoundingClientRect().width > 0).length);
      ok(blCardsBefore > 0 && blCardsAfter === 0 && blDotsAfter === 0, `"safe bets only" hides ${blCardsBefore} borderline cards + their map dots`);
      await page.click('label[for="safe-only"]');

      // clicking a map dot navigates to its card (hash + :target)
      const firstHref = await page.$eval('.dl-map a[href^="#card-"]', a => a.getAttribute('href'));
      await page.click(`.dl-map a[href="${firstHref}"]`);
      const hash = await page.evaluate(() => location.hash);
      ok(hash === firstHref, `clicking a map dot jumps to its card (${hash})`);
    } finally { await browser.close(); }
  }

  fs.rmSync(out, { recursive: true, force: true });
  console.log(`\n${fail ? '✗' : '✓'} disney-guide staging: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
