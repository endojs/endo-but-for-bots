/*---
description: >
  Frozen-view integer-indexed assignment in STRICT mode, emulated vs emulated.
  On a frozen plain-object wrapper the write throws (an ordinary frozen object
  rejects a new own property "0"). On a frozen Proxy wrapper the write also
  throws, but via the set trap — so the Proxy's throwing behavior is independent
  of strictness (see the noStrict sibling test).
flags: [onlyStrict]
features: [immutable-arraybuffer-parity, TypedArray, Proxy]
---*/

function immutableOf(bytes) {
  var ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  return ab.sliceToImmutable();
}

// Plain-object wrapper, frozen: strict-mode indexed write throws.
var plain = new Uint8Array(immutableOf([10, 20, 30, 40]));
Object.freeze(plain);
assert.sameValue(Object.isFrozen(plain), true, 'plain wrapper is frozen');
assert.throws(
  TypeError,
  function () {
    plain[0] = 42;
  },
  'frozen plain wrapper rejects indexed write in strict mode',
);
assert.sameValue(plain.at(0), 10, 'plain buffer unchanged');

// Proxy wrapper, frozen: indexed write throws (via the set trap).
var proxy = makeFreezableProxyTypedArray(Uint8Array, immutableOf([10, 20, 30, 40]));
Object.freeze(proxy);
assert.sameValue(Object.isFrozen(proxy), true, 'proxy wrapper is frozen');
assert.throws(
  TypeError,
  function () {
    proxy[0] = 42;
  },
  'frozen proxy wrapper rejects indexed write in strict mode',
);
assert.sameValue(proxy.at(0), 10, 'proxy buffer unchanged');
