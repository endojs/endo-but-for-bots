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
