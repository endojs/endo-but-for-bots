// @ts-check
/* eslint no-bitwise: ["off"] */

import test from '@endo/ses-ava/test.js';

import { randomInt } from '@endo/random/int.js';
import { random } from '@endo/random/random.js';

import {
  adaptToPureRandomGenerator,
  adaptFromPureRandomGenerator,
} from '../index.js';
import { makeSource, seedA, cloneSeed } from './_make-source.js';

test('adaptToPureRandomGenerator yields signed 32-bit values', t => {
  const source = makeSource(cloneSeed(seedA));
  const rg = adaptToPureRandomGenerator(source);
  t.is(rg.min(), -0x80000000);
  t.is(rg.max(), 0x7fffffff);
  for (let i = 0; i < 100; i += 1) {
    const pair = rg.next();
    const value = /** @type {number} */ (pair[0]);
    t.true(Number.isInteger(value));
    t.true(value >= -0x80000000 && value <= 0x7fffffff);
    t.is(pair[1], rg, 'tuple second element advances state in-place');
  }
});

test('round-trip: source -> RandomGenerator -> source produces same bytes', t => {
  // `a` feeds the round-trip pipeline; `b` is a fresh twin used as
  // the ground truth.
  const a = makeSource(cloneSeed(seedA));
  const b = makeSource(cloneSeed(seedA));
  const rg = adaptToPureRandomGenerator(a);
  const wrapped = adaptFromPureRandomGenerator(rg);

  // Each readUint32 against `wrapped` should produce the same little-
  // endian 4 bytes that `b` produces directly.  Verify by pulling 32
  // bytes through each path.
  const through = new Uint8Array(32);
  wrapped(through);
  const direct = new Uint8Array(32);
  b(direct);
  t.deepEqual([...through], [...direct]);
});

test('adapter preserves randomInt distribution shape', t => {
  // Sanity: feeding a randomInt sampler from the round-tripped
  // source still yields integers in range.
  const source = makeSource(cloneSeed(seedA));
  const rg = adaptToPureRandomGenerator(source);
  const wrapped = adaptFromPureRandomGenerator(rg);
  for (let i = 0; i < 1000; i += 1) {
    const x = randomInt(wrapped, 0, 99);
    t.true(x >= 0 && x <= 99);
  }
  const f = random(wrapped);
  t.true(f >= 0 && f < 1);
});
