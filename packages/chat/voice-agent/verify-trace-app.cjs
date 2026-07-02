// Headless verification of the trace iframe app's postMessage cap-channel handshake.
// Drives the REAL app in chromium: boots with the root cap, opens the trace app, and
// asserts the iframe completed the handshake (its #status cleared + #title came back over
// the channel via chat.getInfo()). Same-origin iframe → contentDocument is readable.
const { loadChromium, launchBrowser } = require('./test-harness.cjs'); // PORT-5: portable playwright/chromium/LD seams (mac-friendly)
const fs = require('fs');

(async () => {
  const chromium = loadChromium();
  if (!chromium) { console.log('SKIP — playwright-core unavailable'); process.exit(0); }
  const ROOT = fs.readFileSync(`${process.env.HOME}/.config/field-agent/root.swiss`, 'utf8').trim();
  const browser = await launchBrowser(chromium);
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(`http://127.0.0.1:8778/#cap=${ROOT}`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => { const s = document.getElementById('scope'); return s && !/connecting/.test(s.textContent); }, { timeout: 20000 });
  console.log('app booted · scope =', JSON.stringify(await page.$eval('#scope', e => e.textContent)));

  await page.click('#trace-btn');     // open inline trace (lazy-loads three.js, reveals trace-bar)
  await page.waitForTimeout(1500);
  await page.click('#trace-appbtn');  // open the iframe trace app

  // the handshake is proven when the iframe's #status clears AND #title arrives over the cap channel
  await page.waitForFunction(() => {
    const f = document.getElementById('trace-app-frame');
    if (!f || !f.contentDocument) return false;
    const st = f.contentDocument.getElementById('status');
    const ti = f.contentDocument.getElementById('title');
    return st && st.textContent === '' && ti && ti.textContent.startsWith('⊿');
  }, { timeout: 20000 });

  const info = await page.evaluate(() => {
    const d = document.getElementById('trace-app-frame').contentDocument;
    return { title: d.getElementById('title').textContent, hasCanvas: !!d.getElementById('c'), err: (d.getElementById('err') || {}).textContent || '' };
  });
  console.log('✅ IFRAME CAP-CHANNEL HANDSHAKE OK');
  console.log('   iframe title (came back via chat.getInfo over the channel):', JSON.stringify(info.title));
  console.log('   iframe canvas present:', info.hasCanvas, '| iframe error:', JSON.stringify(info.err));
  console.log('   page console errors:', errors.length ? errors.slice(0, 6) : '(none)');
  await browser.close();
})().catch(e => { console.error('VERIFY FAILED:', e.message); process.exit(1); });
