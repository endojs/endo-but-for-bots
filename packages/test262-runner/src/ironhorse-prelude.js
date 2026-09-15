// The Ironhorse SES prelude, the third host of the `ses-xs-parity` axis.
//
// `xs-prelude.js` omits `ses/compartment-shim.js` because XS builds
// `Compartment` into every realm. Ironhorse does not bind it at all, so this
// prelude takes the shim's, as `node-prelude.js` does.
//
// The `assert` dance is the same one both siblings perform, and it is not
// optional: SES installs its own hardened `assert`, which is non-extensible
// before `lockdown()` even runs, so test262's `assert.sameValue = ...` is
// silently swallowed. Capture test262's before the shim, restore it after, and
// restore it again inside a wrapped `lockdown` because lockdown re-installs
// SES's.
import './capture-test262-assert.js';
import './ironhorse-pre-shim.js';
import 'ses/lockdown-shim.js';
import 'ses/compartment-shim.js';
import 'ses/assert-shim.js';
import './expose-pass-style-bytes-globals.js';

const test262AssertSymbol = Symbol.for('test262Assert');
const test262Assert = globalThis[test262AssertSymbol];
delete globalThis[test262AssertSymbol];
// @ts-expect-error lockdown-shim initializes this global at module evaluation.
const sesLockdown = globalThis.lockdown;
globalThis.assert = test262Assert;
globalThis.environment = 'ironhorse-ses';
globalThis.lockdown = options => {
  const result = sesLockdown(options);
  globalThis.assert = test262Assert;
  return result;
};
