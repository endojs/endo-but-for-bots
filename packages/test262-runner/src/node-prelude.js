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
  // %FunctionPrototype%)`. Its own comment is blunter than "cannot reach":
  // "We can't clean [[Prototype]], therefore abort" -- the test is a
  // mismatch, and a mismatch is as far as it looks.
  //
  // So hand them back on the way in, the way
  // `./install-pre-lockdown-harden.js` hands back its hardener. The split is
  // clean rather than lucky, and measured: of the eight corpus cases exactly
  // TWO reference the codecs (the `TextEncoder`/`TextDecoder`
  // `immutable-arraybuffer-intersection.js` pair), exactly ONE calls
  // `lockdown()` (`Symbol.toStringTag-lockdown.js`), there is no overlap, and
  // nothing in `test262/harness/` calls `lockdown()` either. Only our own
  // loans are withdrawn, by identity, so a case that installed its own
  // in-realm codec keeps it -- and `lockdown()` then accepts it, since an
  // in-realm class is exactly what the permits want.
  //
  // The loans are not restored afterwards. Nothing observes that today: the
  // one case that locks down uses no codec, and no case catches a `lockdown()`
  // throw. A case that did both would need this revisited.
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
