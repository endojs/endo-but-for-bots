const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');
const ok = (c, m) => { if (c) { console.log('  ok -', m); } else { console.error('  FAIL -', m); process.exitCode = 1; } };
(async () => {
  const chromium = loadChromium();
  if (!chromium) { console.log('  SKIP - no chromium'); return; }
  const srv = await startIsolatedServer();
  const br = await launchBrowser(chromium);
  try {
    const page = await br.newPage();
    await page.route('**/app.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '/* blocked */' }));
    // same-origin module (script-src 'self' allows it) that exercises the real grain-ui render path
    await page.route('**/__sptest.mjs', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: `
      import { renderWidgets } from '/grain-ui.js';
      const box = document.createElement('div'); box.id = '__t'; document.body.appendChild(box);
      renderWidgets(box, [{ type: 'site-preview', url: 'https://archua.taildd002.ts.net/sites/a9fabaf058eab534/', name: 'SK936 Jet-Lag Plan' }], {});
      window.__done = true;
    `}));
    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { const s = document.createElement('script'); s.type = 'module'; s.src = '/__sptest.mjs'; document.body.appendChild(s); });
    await page.waitForFunction(() => window.__done === true, { timeout: 5000 });
    const r = await page.evaluate(() => { const ifr = document.querySelector('#__t iframe'); const lbl = document.querySelector('#__t .gw-site'); return { src: ifr && ifr.getAttribute('src'), text: lbl && lbl.textContent }; });
    ok(r.src === '/sites/a9fabaf058eab534/', `iframe src is same-origin path (got: ${r.src})`);
    ok(!/taildd002/.test(r.src || ''), 'iframe src dropped the unreachable tailnet host');
    ok(/sites\/a9fabaf058eab534/.test(r.text || ''), `label shows the site path (got: ${JSON.stringify(r.text)})`);
    await page.close();
  } finally { await br.close(); srv.close(); }
})();
