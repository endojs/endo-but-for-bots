/*---
description: >
  Frozen-view integer-indexed assignment in SLOPPY mode, emulated vs emulated.
  On a frozen plain-object wrapper the write is SILENTLY SWALLOWED (an ordinary
  frozen object drops a new own property in sloppy mode). On a frozen Proxy
  wrapper the write still THROWS via the set trap — the Proxy makes the write
  fail-loud regardless of strictness, which is the divergence from the plain
  wrapper this test pins down.
flags: [noStrict]
features: [immutable-arraybuffer-parity, TypedArray, Proxy]
---*/

function immutableOf(bytes) {
  var ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  return ab.sliceToImmutable();
}

// Plain-object wrapper, frozen: sloppy-mode indexed write is swallowed.
var plain = new Uint8Array(immutableOf([10, 20, 30, 40]));
Object.freeze(plain);
plain[0] = 42; // swallowed, no throw
assert.sameValue(plain[0], undefined, 'frozen plain wrapper: no own property created');
assert.sameValue(
  Object.prototype.hasOwnProperty.call(plain, '0'),
  false,
  'frozen plain wrapper: sloppy write created no own property',
);
assert.sameValue(plain.at(0), 10, 'plain buffer unchanged');

// Proxy wrapper, frozen: the set trap throws even in sloppy mode.
var proxy = makeFreezableProxyTypedArray(Uint8Array, immutableOf([10, 20, 30, 40]));
Object.freeze(proxy);
assert.throws(
  TypeError,
  function () {
    proxy[0] = 42;
  },
  'frozen proxy wrapper throws on indexed write even in sloppy mode',
);
assert.sameValue(proxy.at(0), 10, 'proxy buffer unchanged');
