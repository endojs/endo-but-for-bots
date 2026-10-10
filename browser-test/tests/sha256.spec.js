// @ts-check
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { test, expect } = require('@playwright/test');

const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const makeBrowserBundle = async () => {
  await import(
    pathToFileURL(
      path.join(__dirname, '..', '..', 'packages', 'ses', 'index.js'),
    ).href
  );
  const { makeBundle } = await import(
    pathToFileURL(
      path.join(
        __dirname,
        '..',
        '..',
        'packages',
        'compartment-mapper',
        'bundle.js',
      ),
    ).href
  );
  const entryLocation = pathToFileURL(
    path.join(
      __dirname,
      '..',
      '..',
      'packages',
      'sha256',
      'test',
      'browser-entry.js',
    ),
  ).href;
  /** @param {string} location */
  const read = location => fs.promises.readFile(new URL(location));
  return makeBundle(read, entryLocation, {
    conditions: new Set(['browser']),
  });
};

test('browser-condition bundle provides working sync and async sha256', async ({
  page,
}) => {
  const bundle = await makeBrowserBundle();

  await page.goto('http://127.0.0.1:3000/blank');
  await page.addScriptTag({
    content: `globalThis.sha256BrowserBundle = ${bundle};`,
  });

  const result = await page.evaluate(async () => {
    await null;
    const { sha256, sha256Async } = /** @type {any} */ (globalThis)
      .sha256BrowserBundle;
    const bytes = new TextEncoder().encode('abc');
    /** @param {Uint8Array} digest */
    const toHex = digest =>
      Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');

    return {
      sync: toHex(sha256(bytes)),
      async: toHex(await sha256Async(bytes)),
      webCrypto: typeof globalThis.crypto?.subtle?.digest === 'function',
    };
  });

  expect(result).toEqual({
    sync: ABC_SHA256,
    async: ABC_SHA256,
    webCrypto: true,
  });
});
