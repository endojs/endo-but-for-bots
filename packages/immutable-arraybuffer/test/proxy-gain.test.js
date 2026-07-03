// @ts-nocheck
// Objection 3 (design "Why not a Proxy wrapper?"): "the gain is small and
// asymmetric". This test makes the gain concrete by contrasting what
// `view[0] = 42` observably does across the three emulations, and shows what the
// gain does NOT buy (buffer immutability already holds in every case).
import '../src/shim.js';
import test from 'ava';
import { makeFreezableIndexRejectingProxy } from '../src/proxy-lib.js';

const makeImmutable = bytes => {
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  return ab.sliceToImmutable();
};

test('objection 3: the three emulations diverge only in what an indexed WRITE does', t => {
  // 1. Genuine TypedArray over a genuine mutable buffer: write-through.
  const genuine = new Uint8Array([10, 20, 30, 40]);
  genuine[0] = 42;
  t.is(genuine[0], 42);
  t.is(Uint8Array.prototype.at.call(genuine, 0), 42); // buffer really changed

  // 2. Shipped plain-object wrapper: creates a wrapper-local own property that
  //    shadows the indexed read; the underlying immutable buffer is untouched.
  const iab2 = makeImmutable([10, 20, 30, 40]);
  const plain = new Uint8Array(iab2);
  plain[0] = 42;
  t.is(plain[0], 42); // reads the shadowing own property
  t.is(Uint8Array.prototype.at.call(plain, 0), 10); // buffer unchanged

  // 3. Proxy wrapper: the indexed write THROWS (the gain).
  const iab3 = makeImmutable([10, 20, 30, 40]);
  const proxy = makeFreezableIndexRejectingProxy(
    new Uint8Array(iab3.slice(0)),
    iab3,
    Uint8Array.prototype,
  );
  t.throws(
    () => {
      proxy[0] = 42;
    },
    { instanceOf: TypeError },
  );
  t.is(proxy.at(0), 10); // buffer unchanged
});

test('objection 3: what the gain does NOT buy — buffer immutability already holds in all three', t => {
  // The security-relevant invariant (the bytes of the immutable buffer never
  // change through the wrapper) holds for BOTH the plain-object wrapper and the
  // proxy wrapper. The only difference is whether the failed write throws or is
  // silently absorbed into a wrapper-local own property.
  const iabPlain = makeImmutable([1, 2, 3, 4]);
  const plain = new Uint8Array(iabPlain);
  plain[0] = 99;
  t.is(Uint8Array.prototype.at.call(plain, 0), 1);

  const iabProxy = makeImmutable([1, 2, 3, 4]);
  const proxy = makeFreezableIndexRejectingProxy(
    new Uint8Array(iabProxy.slice(0)),
    iabProxy,
    Uint8Array.prototype,
  );
  t.throws(() => {
    proxy[0] = 99;
  });
  t.is(proxy.at(0), 1);

  // Both preserve the buffer. The proxy's extra guarantee is only that the
  // *observable read-back* through the wrapper is undefined-of-throw rather than
  // the shadowing 99 — a nicety, not a safety property.
  t.not(plain[0], proxy.at(0)); // plain reads back 99; proxy never accepted it
});
