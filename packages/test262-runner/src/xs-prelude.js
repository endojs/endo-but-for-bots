/* global globalThis */
import './capture-test262-assert.js';
import 'ses/lockdown-shim.js';
import 'ses/assert-shim.js';
import './expose-pass-style-bytes-globals.js';

const test262AssertSymbol = Symbol.for('test262Assert');
const test262Assert = globalThis[test262AssertSymbol];
delete globalThis[test262AssertSymbol];
const sesLockdown = globalThis.lockdown;
globalThis.assert = test262Assert;
globalThis.environment = 'xs-ses';
globalThis.lockdown = options => {
  const result = sesLockdown(options);
  globalThis.assert = test262Assert;
  return result;
};
