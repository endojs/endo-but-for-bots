/*---
description: >
  toBytes wraps a Uint8Array in a hardened frozen Uint8Array backed by an
  immutable ArrayBuffer.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/to-bytes.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

// toBytes is exposed on globalThis by the prelude.

var view = new Uint8Array([1, 2, 3, 4, 5]);
var result = toBytes(view);

assert(result instanceof Uint8Array, 'result is a Uint8Array');
assert.sameValue(result.byteLength, 5, 'byteLength is preserved');

// The backing buffer must be immutable (shim or native).
assert.sameValue(result.buffer.immutable, true, 'backing buffer is immutable');

// The wrapper must be frozen.
assert(Object.isFrozen(result), 'result is frozen');
