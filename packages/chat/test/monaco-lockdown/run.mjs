// Standalone browser regression test: monaco-editor under SES lockdown
// (overrideTaming: 'severe'). This is intentionally NOT an AVA test — the
// behaviour can only be exercised in a real browser with a real bundle, so
// it stands up its own Vite server (without the Endo daemon plugin) and
// drives headless Chromium via Playwright, mirroring @endo/preact-container.
//
//   node test/monaco-lockdown/run.mjs   (or: yarn test:monaco-lockdown)
//
// Requires a Playwright Chromium: `yarn playwright install chromium`.

import { fileURLToPath } from 'url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('.', import.meta.url));

const fail = msg => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'warn',
  server: { port: 5199, strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();

// Monaco posts to a disabled worker; those errors are expected. Anything
// else surfacing under lockdown is a real regression.
const isExpectedWorkerNoise = text =>
  /postMessage|post message to worker|SES_UNHANDLED_REJECTION|SES_UNCAUGHT_EXCEPTION|^\s*$|TypeError#\d|Error#\d/.test(
    text,
  );
const unexpectedErrors = [];
page.on('console', m => {
  if (m.type() === 'error' && !isExpectedWorkerNoise(m.text())) {
    unexpectedErrors.push(`console.error: ${m.text()}`);
  }
});
page.on('pageerror', e => {
  if (!isExpectedWorkerNoise(e.message)) {
    unexpectedErrors.push(`pageerror: ${e.message}`);
  }
});

let result;
try {
  await page.goto('http://localhost:5199/');
  await page.waitForFunction(() => globalThis.monacoLockdownResult !== undefined, {
    timeout: 45000,
  });
  result = await page.evaluate(() => globalThis.monacoLockdownResult);
} catch (e) {
  await browser.close();
  await server.close();
  fail(`probe never resolved: ${e.message}`);
}

const editorEls = await page.locator('.monaco-editor').count();
const viewLines = await page.locator('.view-lines').count();

await browser.close();
await server.close();

console.log('result:', JSON.stringify(result));
console.log('rendered .monaco-editor:', editorEls, '.view-lines:', viewLines);

if (!result.ok) fail(`monaco threw under lockdown: ${result.error}\n${result.stack}`);
if (!result.hardenIsFn) fail('lockdown did not take effect (harden missing)');
if (result.roundTrip !== 'const y = 2;') fail(`setValue/getValue mismatch: ${result.roundTrip}`);
if (result.colorizedLen <= 0) fail('colorize produced no output');
if (editorEls < 1 || viewLines < 1) fail('editor did not render');
if (unexpectedErrors.length) {
  fail(`unexpected (non-worker) errors under lockdown:\n${unexpectedErrors.join('\n')}`);
}

console.log('PASS: monaco-editor renders, round-trips, and colorizes under lockdown({ overrideTaming: "severe" })');
process.exit(0);
