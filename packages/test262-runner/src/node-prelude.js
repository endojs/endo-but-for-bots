import './capture-test262-assert.js';
import 'ses/lockdown-shim.js';
import 'ses/compartment-shim.js';
import 'ses/assert-shim.js';
import './install-pre-lockdown-harden.js';
import './expose-pass-style-bytes-globals.js';

const { TextDecoder, TextEncoder } = /** @type {any} */ (globalThis).require(
  'node:util',
);

const test262AssertSymbol = Symbol.for('test262Assert');
const test262Assert = globalThis[test262AssertSymbol];
delete globalThis[test262AssertSymbol];
// `lockdown-shim` initializes this global at module evaluation.
const sesLockdown = globalThis.lockdown;
globalThis.assert = test262Assert;
globalThis.environment = 'node-ses';
globalThis.TextDecoder = TextDecoder;
globalThis.TextEncoder = TextEncoder;
globalThis.lockdown = options => {
  // Withdraw the BORROWED codecs first.
  //
  // `TextEncoder`/`TextDecoder` above are the HOST realm's, reached through
  // `globalThis.require('node:util')`, because the realm this prelude runs in
  // has none of its own: eshost builds its vm context with exactly
  // `{ setTimeout, require, console, print }`
  // (`eshost/lib/agents/node.js`). A borrowed intrinsic cannot survive
  // `lockdown()`. `ses/src/permits-intrinsics.js` walks
  // `intrinsics.TextEncoder.__proto__`, finds the host realm's
  // `Function.prototype` instead of this one's, and aborts with
  // `Unexpected [[Prototype]] at intrinsics.TextEncoder.__proto__ (expected
  // %FunctionPrototype%)` -- it cannot clean a `[[Prototype]]` it cannot
  // reach, and it is right not to try.
  //
  // So hand them back on the way in, the way
  // `./install-pre-lockdown-harden.js` hands back its hardener. The split is
  // clean rather than lucky: the six cases that need the codecs never call
  // `lockdown()`, and the one case that calls it never touches them. Only our
  // own loans are withdrawn, so a case that installed its own codec keeps it
  // and gets SES's own diagnostic rather than a silent removal.
  if (globalThis.TextEncoder === TextEncoder) {
    delete (/** @type {any} */ (globalThis).TextEncoder);
  }
  if (globalThis.TextDecoder === TextDecoder) {
    delete (/** @type {any} */ (globalThis).TextDecoder);
  }
  const result = sesLockdown(options);
  globalThis.assert = test262Assert;
  return result;
};
