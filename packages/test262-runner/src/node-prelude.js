/* global globalThis */
import './capture-test262-assert.js';
import 'ses/lockdown-shim.js';
import 'ses/compartment-shim.js';
import 'ses/assert-shim.js';
import './expose-pass-style-bytes-globals.js';

const { TextDecoder, TextEncoder } = /** @type {any} */ (globalThis).require(
  'node:util',
);

const test262AssertSymbol = Symbol.for('test262Assert');
const test262Assert = globalThis[test262AssertSymbol];
delete globalThis[test262AssertSymbol];
// @ts-expect-error lockdown-shim initializes this global at module evaluation.
const sesLockdown = globalThis.lockdown;
globalThis.assert = test262Assert;
globalThis.environment = 'node-ses';
globalThis.TextDecoder = TextDecoder;
globalThis.TextEncoder = TextEncoder;
globalThis.lockdown = options => {
  const result = sesLockdown(options);
  globalThis.assert = test262Assert;
  return result;
};
