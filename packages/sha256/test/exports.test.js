// @ts-check

// The conditional-export map is the only thing deciding which build a
// consumer receives, and every other test file imports `../src/*.js` by
// path, so a typo'd or misrouted arm would redden nothing. These tests
// resolve each arm from `package.json` and run it.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import test from 'ava';

const packageJsonUrl = new URL('../package.json', import.meta.url);

/** @returns {Promise<any>} */
const readPackageJson = async () =>
  JSON.parse(await readFile(packageJsonUrl, 'utf8'));

const abc = new TextEncoder().encode('abc');
const abcHex = createHash('sha256').update(abc).digest('hex');

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const hex = bytes => Buffer.from(bytes).toString('hex');

test('every condition arm resolves to a working digest', async t => {
  const { exports } = await readPackageJson();
  const arms = exports['.'];
  t.deepEqual(
    Object.keys(arms).sort(),
    ['browser', 'default', 'node', 'xs'],
    'the arms the design prescribes, and no others',
  );
  const originalHostSha256Bytes = Object.getOwnPropertyDescriptor(
    globalThis,
    'hostSha256Bytes',
  );
  Object.defineProperty(globalThis, 'hostSha256Bytes', {
    value: (/** @type {Uint8Array} */ bytes) =>
      createHash('sha256').update(bytes).digest(),
    configurable: true,
  });
  try {
    for (const [condition, target] of Object.entries(arms)) {
      const url = new URL(/** @type {string} */ (target), packageJsonUrl);
      // eslint-disable-next-line no-await-in-loop
      const { sha256, sha256Into } = await import(url.href);
      t.is(typeof sha256, 'function', `${condition}: exports sha256`);
      t.is(typeof sha256Into, 'function', `${condition}: exports sha256Into`);
      t.is(hex(sha256(abc)), abcHex, `${condition}: hashes "abc" correctly`);
    }
  } finally {
    if (originalHostSha256Bytes === undefined) {
      delete (/** @type {any} */ (globalThis).hostSha256Bytes);
    } else {
      Object.defineProperty(
        globalThis,
        'hostSha256Bytes',
        originalHostSha256Bytes,
      );
    }
  }
});

test('the xs arm selects the Endor host contract', async t => {
  // The condition identifies the bundle that runs under Endor. The target
  // names the platform contract instead of either supported engine.
  const { exports } = await readPackageJson();
  const arms = exports['.'];
  t.not(arms.xs, arms.default);
  t.is(arms.xs, './src/sha256-endor.js');
  t.not(arms.node, arms.default);
  t.is(arms.browser, arms.default, 'default is the browser build');
});

test('the pure-JS build is reachable by its own subpath', async t => {
  // `packages/chat/node-crypto-shim.js` imports it directly, bypassing
  // condition resolution, so the subpath is part of the contract.
  const { exports } = await readPackageJson();
  const target = exports['./src/sha256-js.js'];
  t.is(typeof target, 'string');
  const { jsSha256 } = await import(
    new URL(/** @type {string} */ (target), packageJsonUrl).href
  );
  t.is(hex(jsSha256(abc)), abcHex);
});
