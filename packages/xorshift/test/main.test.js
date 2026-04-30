import test from '@endo/ses-ava/test.js';

import { makeXorShift } from '../index.js';

const seedA = Uint8Array.of(
  0xb0,
  0xb5,
  0xc0,
  0xff,
  0xee,
  0xfa,
  0xca,
  0xde,
  0xb0,
  0xb5,
  0xc0,
  0xff,
  0xee,
  0xfa,
  0xca,
  0xde,
);
const seedB = Uint8Array.of(
  0x12,
  0x34,
  0x56,
  0x78,
  0x9a,
  0xbc,
  0xde,
  0xf0,
  0x0f,
  0xed,
  0xcb,
  0xa9,
  0x87,
  0x65,
  0x43,
  0x21,
);

test('determinism: same seed produces same sequence', t => {
  const a = makeXorShift(seedA);
  const b = makeXorShift(seedA);
  for (let i = 0; i < 32; i += 1) {
    t.is(a.random(), b.random(), `mismatch at index ${i}`);
  }
});

test('different seeds produce different sequences', t => {
  const a = makeXorShift(seedA);
  const b = makeXorShift(seedB);
  // Compare the first 8 outputs; with 64-bit state and unrelated seeds,
  // a collision in the first 8 is astronomically unlikely.
  let differs = false;
  for (let i = 0; i < 8; i += 1) {
    if (a.random() !== b.random()) {
      differs = true;
    }
  }
  t.true(differs);
});

test('random() yields values in [0, 1)', t => {
  const prng = makeXorShift(seedA);
  for (let i = 0; i < 1000; i += 1) {
    const x = prng.random();
    t.true(Number.isFinite(x), 'finite');
    t.true(x >= 0, `x >= 0 (got ${x})`);
    t.true(x < 1, `x < 1 (got ${x})`);
  }
});

test('mean of 10000 random() samples is close to 0.5', t => {
  const prng = makeXorShift(seedA);
  const n = 10000;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += prng.random();
  }
  const mean = sum / n;
  // Generous slack: a true uniform mean over 10000 samples has stddev
  // ~ sqrt(1/12) / sqrt(10000) ~= 0.00289.  0.05 is ~17 sigma.
  t.true(Math.abs(mean - 0.5) < 0.05, `mean=${mean}`);
});

test('returned generator passes through harden', t => {
  // The factory calls `harden(...)` on the returned object.  Whether
  // that produces a frozen object depends on the active harden
  // implementation (SES with default taming freezes; unsafe taming is
  // a no-op; the @endo/harden non-SES fallback freezes own
  // properties).  We just check that the contract — "the returned
  // object is `harden(prng)`" — is observed by exercising both
  // members.
  const prng = makeXorShift(seedA);
  t.is(typeof prng.random, 'function');
  t.is(typeof prng.int, 'function');
  // Sanity check: after harden, both members work.
  t.true(Number.isFinite(prng.random()));
  t.true(Number.isInteger(prng.int(0, 100)));
});

test('shorter seed is left-padded with zero bytes', t => {
  // A 1-byte seed of `0x01` is equivalent to a 16-byte seed whose
  // last byte is `0x01` and whose other 15 bytes are zero.
  const a = makeXorShift(Uint8Array.of(0x01));
  const b = makeXorShift(
    Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01),
  );
  for (let i = 0; i < 16; i += 1) {
    t.is(a.random(), b.random(), `mismatch at ${i}`);
  }
});

test('throws on bad seed', t => {
  // Type errors: not a Uint8Array.
  t.throws(() => makeXorShift(/** @type {any} */ (undefined)), {
    instanceOf: TypeError,
  });
  t.throws(() => makeXorShift(/** @type {any} */ ([1, 2, 3, 4])), {
    instanceOf: TypeError,
  });
  t.throws(() => makeXorShift(/** @type {any} */ ('not a Uint8Array')), {
    instanceOf: TypeError,
  });
  t.throws(() => makeXorShift(/** @type {any} */ (new ArrayBuffer(16))), {
    instanceOf: TypeError,
  });
  // Range errors: empty or longer than 16 bytes.
  t.throws(() => makeXorShift(new Uint8Array(0)), { instanceOf: RangeError });
  t.throws(() => makeXorShift(new Uint8Array(17)), { instanceOf: RangeError });
  // The all-zero state is the absorbing fixed point of xorshift128+;
  // a 1-byte zero seed pads to all-zero too and must be rejected.
  t.throws(() => makeXorShift(new Uint8Array(16)), { instanceOf: RangeError });
  t.throws(() => makeXorShift(Uint8Array.of(0)), { instanceOf: RangeError });
});

test('golden vector: first random() outputs match a pinned reference', t => {
  // The first four 64-bit outputs from xorshift128+ for `seedA`,
  // expressed as `[hi32, lo32]`, are pinned to the upstream reference
  // (AndreasMadsen/xorshift @ d60ca9c):
  //   [0x616b81ff, 0xddf595bc]
  //   [0x2b28a1b2, 0x2e0c4106]
  //   [0x3156daaf, 0xbf870d61]
  //   [0x471d80dd, 0x9dda9ea5]
  // After the `random()` reduction `hi/2^32 + (lo>>>12)/2^52` they
  // produce the literal floats below.  If a future "optimization"
  // silently changes either the stream or the reduction, this fails.
  const expected = [
    0.3805466890025484, 0.16858873939604369, 0.19273154059149178,
    0.27779393587648316,
  ];
  const prng = makeXorShift(seedA);
  for (let i = 0; i < expected.length; i += 1) {
    t.is(prng.random(), expected[i], `random()[${i}] mismatch`);
  }
});

test('int(lo, hi) returns integers in [lo, hi)', t => {
  const prng = makeXorShift(seedA);
  for (let i = 0; i < 1000; i += 1) {
    const x = prng.int(10, 20);
    t.true(Number.isInteger(x), `integer (got ${x})`);
    t.true(x >= 10 && x < 20, `in range (got ${x})`);
  }
});

test('int with single-element range always returns lo', t => {
  const prng = makeXorShift(seedA);
  for (let i = 0; i < 8; i += 1) {
    t.is(prng.int(42, 43), 42);
  }
});

test('int with negative lo', t => {
  const prng = makeXorShift(seedA);
  for (let i = 0; i < 200; i += 1) {
    const x = prng.int(-5, 5);
    t.true(x >= -5 && x < 5, `in range (got ${x})`);
    t.true(Number.isInteger(x));
  }
});

test('int distribution over 10 buckets is roughly uniform', t => {
  const prng = makeXorShift(seedA);
  const n = 10000;
  const k = 10;
  const counts = Array.from({ length: k }, () => 0);
  for (let i = 0; i < n; i += 1) {
    counts[prng.int(0, k)] += 1;
  }
  // Each bucket has expected count n/k = 1000 with stddev
  // sqrt(n * 1/k * (k-1)/k) ~= sqrt(900) = 30.  150 is ~5 sigma.
  for (let i = 0; i < k; i += 1) {
    t.true(Math.abs(counts[i] - n / k) < 150, `bucket[${i}]=${counts[i]}`);
  }
});

test('int determinism: same seed yields same int sequence', t => {
  const a = makeXorShift(seedA);
  const b = makeXorShift(seedA);
  for (let i = 0; i < 32; i += 1) {
    t.is(a.int(0, 1_000_000), b.int(0, 1_000_000));
  }
});

test('int throws on bad args', t => {
  const prng = makeXorShift(seedA);
  t.throws(() => prng.int(1.5, 10), { instanceOf: TypeError });
  t.throws(() => prng.int(0, /** @type {any} */ ('hi')), {
    instanceOf: TypeError,
  });
  t.throws(() => prng.int(NaN, 10), { instanceOf: TypeError });
  // Empty or inverted range.
  t.throws(() => prng.int(10, 10), { instanceOf: RangeError });
  t.throws(() => prng.int(10, 5), { instanceOf: RangeError });
  // hi must itself be a safe integer; 2^53 is not.
  t.throws(() => prng.int(0, Number.MAX_SAFE_INTEGER + 1), {
    instanceOf: TypeError,
  });
  // Range overflowing safe-integer space, even if both bounds are safe.
  t.throws(() => prng.int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), {
    instanceOf: RangeError,
  });
});
