import test from '@endo/ses-ava/test.js';

import { makeXorShift } from '../index.js';

const seedA = /** @type {[number, number, number, number]} */ ([
  0xb0b5c0ff, 0xeefacade, 0xb0b5c0ff, 0xeefacade,
]);
const seedB = /** @type {[number, number, number, number]} */ ([
  0x12345678, 0x9abcdef0, 0x0fedcba9, 0x87654321,
]);

test('determinism: same seed produces same sequence', t => {
  const a = makeXorShift([...seedA]);
  const b = makeXorShift([...seedA]);
  for (let i = 0; i < 32; i += 1) {
    t.is(a.random(), b.random(), `mismatch at index ${i}`);
  }
});

test('different seeds produce different sequences', t => {
  const a = makeXorShift([...seedA]);
  const b = makeXorShift([...seedB]);
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
  const prng = makeXorShift([...seedA]);
  for (let i = 0; i < 1000; i += 1) {
    const x = prng.random();
    t.true(Number.isFinite(x), 'finite');
    t.true(x >= 0, `x >= 0 (got ${x})`);
    t.true(x < 1, `x < 1 (got ${x})`);
  }
});

test('randomint() returns a pair of non-negative 32-bit integers', t => {
  const prng = makeXorShift([...seedA]);
  for (let i = 0; i < 1000; i += 1) {
    const pair = prng.randomint();
    t.is(pair.length, 2);
    const [hi, lo] = pair;
    t.true(Number.isInteger(hi), `hi integer (got ${hi})`);
    t.true(Number.isInteger(lo), `lo integer (got ${lo})`);
    t.true(hi >= 0 && hi <= 0xffffffff, `hi in u32 range (got ${hi})`);
    t.true(lo >= 0 && lo <= 0xffffffff, `lo in u32 range (got ${lo})`);
  }
});

test('mean of 10000 random() samples is close to 0.5', t => {
  const prng = makeXorShift([...seedA]);
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
  const prng = makeXorShift([...seedA]);
  t.is(typeof prng.random, 'function');
  t.is(typeof prng.randomint, 'function');
  // Sanity check: after harden, both methods work.
  t.true(Number.isFinite(prng.random()));
  const pair = prng.randomint();
  t.is(pair.length, 2);
});

test('throws TypeError on bad seed', t => {
  const bad = /** @type {any} */ (undefined);
  t.throws(() => makeXorShift(bad), { instanceOf: TypeError });
  t.throws(() => makeXorShift([1, 2, 3]), { instanceOf: TypeError });
  t.throws(() => makeXorShift(/** @type {any} */ ('not an array')), {
    instanceOf: TypeError,
  });
  // Non-integer / non-finite seed values silently coerce to 0 via
  // `| 0`, which can produce the all-zero fixed point or surprising
  // sequences.  Reject up front.
  t.throws(() => makeXorShift([NaN, NaN, NaN, NaN]), {
    instanceOf: TypeError,
  });
  t.throws(() => makeXorShift([1.5, 0, 0, 0]), { instanceOf: TypeError });
  t.throws(() => makeXorShift(/** @type {any} */ ([1, 2, 3, 'four'])), {
    instanceOf: TypeError,
  });
  // The all-zero state is the absorbing fixed point of xorshift128+.
  t.throws(() => makeXorShift([0, 0, 0, 0]), { instanceOf: TypeError });
});

test('golden vector: first outputs match a pinned reference', t => {
  // Pinned reference output for `seedA` from the upstream xorshift128+
  // reference (AndreasMadsen/xorshift @ d60ca9c).  If a future
  // "optimization" silently changes the stream, this will fail.
  const prng = makeXorShift([...seedA]);
  // First 4 randomint() outputs as `[hi, lo]`.
  const expected = [
    [0x616b81ff, 0xddf595bc],
    [0x2b28a1b2, 0x2e0c4106],
    [0x3156daaf, 0xbf870d61],
    [0x471d80dd, 0x9dda9ea5],
  ];
  for (let i = 0; i < expected.length; i += 1) {
    const [hi, lo] = prng.randomint();
    t.is(hi, expected[i][0], `hi[${i}] mismatch`);
    t.is(lo, expected[i][1], `lo[${i}] mismatch`);
  }
});
