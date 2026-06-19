// browser-run.cjs — a one-shot headless-browser worker the field agent's `browser`
// capability shells out to. Kept in a SEPARATE process so Playwright (which mutates
// intrinsics) never runs inside the agent's SES realm. Uses the system chromium with the
// scoped compat libs (Arch ships nettle 4.0; chromium wants the .so.8/.6 soname).
//   node browser-run.cjs visit <url>            → {ok,title,url,text}
//   node browser-run.cjs shot  <url> <outPath>  → {ok,savedTo,title,url}
const PW = '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const CHROMIUM = process.env.FIELD_CHROMIUM || '/usr/bin/chromium';
const LD = process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs';

(async () => {
  let chromium;
  try { ({ chromium } = require(PW)); } catch (e) { console.log(JSON.stringify({ ok: false, error: `playwright-core unavailable: ${e.message}` })); return; }
  const [, , cmd, url, out] = process.argv;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: LD } });
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
