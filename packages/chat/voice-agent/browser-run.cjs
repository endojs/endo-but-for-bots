// browser-run.cjs — a one-shot headless-browser worker the field agent's `browser`
// capability shells out to. Kept in a SEPARATE process so Playwright (which mutates
// intrinsics) never runs inside the agent's SES realm.
//   node browser-run.cjs visit <url>            → {ok,title,url,text}
//   node browser-run.cjs shot  <url> <outPath>  → {ok,savedTo,title,url}
// Portability seams:
//   PLAYWRIGHT_CORE  — path to a playwright-core install (default: archua's @playwright/cli vendored
//                      copy; falls back to require.resolve('playwright-core') from this package).
//   FIELD_CHROMIUM   — browser binary. linux default /usr/bin/chromium; darwin default is Chrome.app
//                      ('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome').
//   FIELD_CHROMIUM_LDPATH — LINUX-ONLY compat-libs shim (Arch ships nettle 4.0; chromium wants the
//                      .so.8/.6 soname → /var/lib/obsidian/oldlibs). Never applied on darwin.
const PW = process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const CHROMIUM = process.env.FIELD_CHROMIUM
  || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');

(async () => {
  let chromium;
  try { ({ chromium } = require(PW)); }
  catch (e1) {
    try { ({ chromium } = require('playwright-core')); }
    catch { console.log(JSON.stringify({ ok: false, error: `playwright-core unavailable: ${e1.message} (set PLAYWRIGHT_CORE or npm i playwright-core)` })); return; }
  }
  const [, , cmd, url, out] = process.argv;
  // the LD_LIBRARY_PATH shim is a linux (Arch nettle soname) fix ONLY — on darwin it would break dyld.
  const env = process.platform === 'linux'
    ? { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' }
    : process.env;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(800); // let late JS settle
    const title = await page.title();
    if (cmd === 'shot') {
      await page.screenshot({ path: out });
      console.log(JSON.stringify({ ok: true, savedTo: out, title, url: page.url() }));
    } else {
      const text = (await page.evaluate(() => (document.body ? document.body.innerText : ''))).replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
      console.log(JSON.stringify({ ok: true, title, url: page.url(), text }));
    }
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
})();
