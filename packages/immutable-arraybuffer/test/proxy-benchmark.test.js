// @ts-nocheck
/* global performance */
// Objection 2 (design "Why not a Proxy wrapper?"): trap overhead on the hot
// indexed read/write path. This is a representative micro-benchmark, not a
// pass/fail invariant: it drives indexed reads (and the proxy's throwing writes)
// through a genuine TypedArray, the shipped plain-object wrapper, and the Proxy
// wrapper, and logs the relative cost. The single hard assertion is that the
// proxy's indexed read is not FASTER than a genuine read (trap overhead is real,
// never negative); the concrete multiples are logged for the reviewer.
import '../src/shim.js';
import test from 'ava';
import { makeIndexRejectingProxy } from '../src/proxy-lib.js';

const N = 1e6;
const LEN = 64;

const makeHidden = () => {
  const ab = new ArrayBuffer(LEN);
  const seed = new Uint8Array(ab);
  for (let i = 0; i < LEN; i += 1) seed[i] = i % 256;
  const iab = ab.sliceToImmutable();
  return { iab, genuineTA: new Uint8Array(iab.slice(0)) };
};

const timeReads = view => {
  // Warm up.
  let sink = 0;
  for (let i = 0; i < LEN; i += 1) sink += view[i];
  const start = performance.now();
  for (let n = 0; n < N; n += 1) {
    sink += view[n % LEN];
  }
  const ms = performance.now() - start;
  return { ms, sink };
};

test('objection 2: micro-benchmark of indexed reads (genuine vs plain-object vs proxy)', t => {
  const genuine = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i += 1) genuine[i] = i % 256;

  const { iab } = makeHidden();
  const plain = new Uint8Array(iab); // shipped plain-object wrapper

  const { iab: iab2, genuineTA } = makeHidden();
  const proxy = makeIndexRejectingProxy(genuineTA, iab2);

  const g = timeReads(genuine);
  const p = timeReads(plain);
  const x = timeReads(proxy);

  t.log(`indexed reads x${N} over len ${LEN}`);
  t.log(`  genuine TypedArray : ${g.ms.toFixed(1)} ms`);
  t.log(
    `  plain-object wrapper: ${p.ms.toFixed(1)} ms (${(p.ms / g.ms).toFixed(1)}x genuine)`,
  );
  t.log(
    `  Proxy wrapper      : ${x.ms.toFixed(1)} ms (${(x.ms / g.ms).toFixed(1)}x genuine)`,
  );

  // Sanity / parity: the genuine TypedArray and the Proxy wrapper read the same
  // bytes through `view[i]`. The plain-object wrapper does NOT: its indexed
  // reads return `undefined` (no integer-indexed slot on a plain object), so its
  // checksum is NaN. This read-parity gap is asserted directly in
  // proxy-index-parity.test.js; here it explains why the plain sink diverges.
  t.is(g.sink, x.sink);
  t.true(Number.isNaN(p.sink)); // plain-object indexed reads are undefined

  // The proxy's per-read trap overhead is real: an indexed read through the
  // proxy is not faster than a genuine indexed read. (Loose bound to avoid CI
  // flakiness; the logged multiple is the substantive result.)
  t.true(x.ms >= g.ms * 0.9);
});

test('objection 2: micro-benchmark of indexed writes — the proxy pays to throw', t => {
  // A genuine write-through vs the plain wrapper's own-property creation vs the
  // proxy's trap-and-throw. The proxy must construct+throw a TypeError on every
  // indexed write, which is the costliest of the three.
  const genuine = new Uint8Array(LEN);
  const { iab } = makeHidden();
  const plain = new Uint8Array(iab);
  const { iab: iab2, genuineTA } = makeHidden();
  const proxy = makeIndexRejectingProxy(genuineTA, iab2);

  const M = 1e5;

  let s0 = performance.now();
  for (let n = 0; n < M; n += 1) genuine[n % LEN] = n % 256;
  const genuineMs = performance.now() - s0;

  s0 = performance.now();
  for (let n = 0; n < M; n += 1) plain[n % LEN] = n % 256;
  const plainMs = performance.now() - s0;

  s0 = performance.now();
  let thrown = 0;
  for (let n = 0; n < M; n += 1) {
    try {
      proxy[n % LEN] = n % 256;
    } catch {
      thrown += 1;
    }
  }
  const proxyMs = performance.now() - s0;

  t.log(`indexed writes x${M} over len ${LEN}`);
  t.log(`  genuine (write-through): ${genuineMs.toFixed(1)} ms`);
  t.log(
    `  plain (own-property)   : ${plainMs.toFixed(1)} ms (${(plainMs / genuineMs).toFixed(1)}x)`,
  );
  t.log(
    `  proxy (trap + throw)   : ${proxyMs.toFixed(1)} ms (${(proxyMs / genuineMs).toFixed(1)}x)`,
  );

  // Every proxy write threw.
  t.is(thrown, M);
});
