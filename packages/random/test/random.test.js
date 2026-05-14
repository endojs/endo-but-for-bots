// @ts-check

import test from '@endo/ses-ava/test.js';

import { random } from '../src/random.js';
import { makeSource, seedA, seedB, cloneSeed } from './_make-source.js';

test('random(source) yields values in [0, 1)', t => {
  const source = makeSource(cloneSeed(seedA));
  for (let i = 0; i < 1000; i += 1) {
    const x = random(source);
    t.true(Number.isFinite(x), 'finite');
    t.true(x >= 0, `x >= 0 (got ${x})`);
    t.true(x < 1, `x < 1 (got ${x})`);
  }
});

test('determinism: same seed produces same random() sequence', t => {
  const a = makeSource(cloneSeed(seedA));
  const b = makeSource(cloneSeed(seedA));
  for (let i = 0; i < 32; i += 1) {
    t.is(random(a), random(b), `random mismatch at index ${i}`);
  }
});

test('different seeds produce different random() sequences', t => {
  const a = makeSource(cloneSeed(seedA));
  const b = makeSource(cloneSeed(seedB));
  let differs = false;
  for (let i = 0; i < 8; i += 1) {
    if (random(a) !== random(b)) differs = true;
  }
  t.true(differs);
});

test('mean of 10000 random() samples is close to 0.5', t => {
  const source = makeSource(cloneSeed(seedA));
  const n = 10000;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += random(source);
  const mean = sum / n;
  // True uniform stddev ~ sqrt(1/12) / sqrt(10000) ~= 0.00289.
  t.true(Math.abs(mean - 0.5) < 0.05, `mean=${mean}`);
});

// The float-extraction recipe is `randomUint53(source) * 2 ** -53`,
// not a multiplication by a hand-rolled magic constant.  We pin that
// equivalence here so a future edit to the implementation cannot
// silently drift from `2 ** -53` (the only multiplier that preserves
// exactly the 53 bits randomUint53 produces, regardless of engine
// rounding).
test('random(source) = randomUint53(source) * 2 ** -53', t => {
  // Mock RandomSource that fills `out` from a fixed byte sequence,
  // so randomUint53 returns a known integer and we can compare
  // random()'s float to integer * 2 ** -53 exactly.
  /** @param {number[]} bytes */
  const fromBytes =
    bytes =>
    /** @param {Uint8Array} out */
    out => {
      for (let i = 0; i < out.length; i += 1) out[i] = bytes[i] || 0;
    };
  // 8 bytes little-endian: lo=1, hi21=0 → randomUint53 = 1.
  t.is(random(fromBytes([1, 0, 0, 0, 0, 0, 0, 0])), 1 * 2 ** -53);
  // 8 bytes: lo = 0xffffffff, hi21 = 0x1fffff → randomUint53 = 2**53 - 1.
  t.is(
    random(fromBytes([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0])),
    (2 ** 53 - 1) * 2 ** -53,
  );
  // Random 53-bit value chosen to land away from both endpoints.
  // lo = 0xdeadbeef, hi21 = 0x12345 → randomUint53 = 0x12345 * 2**32 + 0xdeadbeef.
  const u53 = 0x12345 * 4294967296 + 0xdeadbeef;
  t.is(
    random(fromBytes([0xef, 0xbe, 0xad, 0xde, 0x45, 0x23, 0x01, 0])),
    u53 * 2 ** -53,
  );
});

// Pinned golden vector: first random() outputs for a fixed seed.
// Computed from the implementation the day this test was authored.
// If a future change silently alters the keystream or the
// float-extraction recipe, this fails.
//
// These values come from running the pure-JavaScript path with
// seed = [0..31].  The keystream itself is independently exercised
// by the Strombergson ChaCha12 vector tests in
// `@endo/chacha12/test/chacha12.test.js`; this test pins the
// float-extraction recipe specifically.
test('golden vector: random() is deterministic for a fixed seed', t => {
  const source = makeSource(cloneSeed(seedA));
  const expected = [
    0.20249271387871048, 0.02854497348759155, 0.21078592422473108,
    0.8157776664794457,
  ];
  for (let i = 0; i < expected.length; i += 1) {
    t.is(random(source), expected[i], `random[${i}] matches golden`);
  }
});
