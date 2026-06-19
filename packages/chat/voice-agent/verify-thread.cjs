// Headless verification of reply-in-thread: open the proposal-feed chat (which has a dev
// task), expand its thread, confirm the earlier reply shows IN the thread, send a new
// reply from the thread composer, and confirm it lands in the thread — AND that the
// reply is NOT a top-level chat bubble (context isolation).
const { chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core');
const fs = require('fs');

(async () => {
  const ROOT = fs.readFileSync(`${process.env.HOME}/.config/field-agent/root.swiss`, 'utf8').trim();
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:8778/#cap=${ROOT}&chat=chat-482a9b534c80`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => { const s = document.getElementById('scope'); return s && !/connecting/.test(s.textContent); }, { timeout: 20000 });

  // the dev card (with its thread toggle) appears once /dev/updates resolves for this chat
  await page.waitForSelector('.dev-thread-toggle', { timeout: 20000 });
  await page.click('.dev-thread-toggle');                       // expand the thread
  await page.waitForSelector('.dev-thread-body', { timeout: 8000 });
  const hasEarlier = await page.evaluate(() => [...document.querySelectorAll('.dev-thread-msg')].some(m => /agent avatars/.test(m.textContent)));
  console.log('earlier reply visible IN thread:', hasEarlier);

  // send a NEW reply from the thread composer
  await page.fill('.dev-thread-row .ask-in', 'And ship it behind the homepage flag.');
  await page.click('.dev-thread-row .mini');
  await page.waitForFunction(() => [...document.querySelectorAll('.dev-thread-msg')].some(m => /homepage flag/.test(m.textContent)), { timeout: 15000 });
  console.log('new thread reply rendered IN thread: true');

  // CONTEXT ISOLATION: the thread reply must NOT appear as a top-level chat bubble
  const leakedToTop = await page.evaluate(() => [...document.querySelectorAll('#log > .msg .body')].some(b => /homepage flag/.test(b.textContent)));
  console.log('thread reply leaked into top-level chat bubbles:', leakedToTop, leakedToTop ? '❌' : '✓ (isolated)');

  await browser.close();
})().catch(e => { console.error('VERIFY FAILED:', e.message); process.exit(1); });
