// @ts-check
/* global document */
// Playwright mutates Error instances internally; keep its driver outside SES.
// The application loaded in each page still runs the normal locked-down bundle.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const a = await browser.newPage();
  const b = await browser.newPage();
  for (const page of [a, b]) {
    page.on('pageerror', error => console.error('PAGE ERROR', error.message));
    page.setDefaultTimeout(10_000);
  }
  await Promise.all([a.goto(process.argv[2]), b.goto(process.argv[2])]);
  await Promise.all([
    a.waitForFunction(
      () => document.querySelector('output')?.textContent === '0',
    ),
    b.waitForFunction(
      () => document.querySelector('output')?.textContent === '0',
    ),
  ]);
  await a.getByRole('button', { name: 'Add one' }).click();
  await b.waitForFunction(
    () => document.querySelector('output')?.textContent === '1',
  );
  await a.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await a.waitForFunction(
    () =>
      document.querySelector('#status')?.textContent ===
      'Connected · live updates',
  );
  assert.equal(await a.locator('output').textContent(), '1');
  await b.getByRole('button', { name: 'Add one' }).click();
  await a.waitForFunction(
    () => document.querySelector('output')?.textContent === '2',
  );
  await b.waitForFunction(
    () => document.querySelector('output')?.textContent === '2',
  );
  assert.equal(await b.locator('output').textContent(), '2');
  await a.addScriptTag({
    type: 'module',
    content:
      "import * as runtime from '/runtime.js'; window.runtimeExportNames = Object.keys(runtime);",
  });
  await a.waitForFunction(() => Array.isArray(globalThis.runtimeExportNames));
  const exports = await a.evaluate(() => globalThis.runtimeExportNames);
  assert(exports.includes('makeBrowserEndo'));
  assert(exports.includes('connectApplication'));
  console.log('Two native browser pages synchronized and reconnected');
} finally {
  await browser.close();
}
