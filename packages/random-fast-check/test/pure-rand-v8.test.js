// @ts-check
/* eslint no-bitwise: ["off"] */

// Unit tests for the pure-rand v8 adapters in `@endo/random-fast-check`.
// These exercise the structural contract of `pure-rand@^8`'s
// `RandomGenerator` interface (`next(): number`, `clone()`,
// `getState()`) and verify byte-level equivalence with the v5 adapter
// pair: a `RandomSource` driven through either generation produces
// the same byte stream when fed the same seed.
//
// See also `pure-rand.test.js` for the v5 adapter tests and
// `fast-check.test.js` for the `fast-check@3` smoke test against the
// v5 path.  A v8 `fc.assert` smoke test will accompany the workspace
// upgrade to `fast-check@4`; that upgrade is its own change.

import test from '@endo/ses-ava/test.js';

import { randomInt } from '@endo/random/int.js';
import { random } from '@endo/random/random.js';

import {
  adaptToPureRandomGenerator,
  adaptToPureRandomGeneratorV8,
  adaptFromPureRandomGeneratorV8,
  makeRandomTypeFromSeedV8,
} from '../index.js';
import { makeSource, seedA, cloneSeed } from './_make-source.js';

test('adaptToPureRandomGeneratorV8 yields signed 32-bit values from next()', t => {
  const source = makeSource(cloneSeed(seedA));
  const rg = adaptToPureRandomGeneratorV8(source);
  for (let i = 0; i < 100; i += 1) {
    const value = rg.next();
    t.true(Number.isInteger(value), 'next() returns an integer (not a tuple)');
    t.true(
      value >= -0x80000000 && value <= 0x7fffffff,
      'value is in the canonical 32-bit signed range',
    );
  }
});

test('v8 adapter returns the documented shape', t => {
  const source = makeSource(cloneSeed(seedA));
  const rg = adaptToPureRandomGeneratorV8(source);
  // Methods present:
  t.is(typeof rg.next, 'function');
  t.is(typeof rg.clone, 'function');
  t.is(typeof rg.getState, 'function');
  // Methods absent (v8 dropped them):
  t.is(/** @type {any} */ (rg).unsafeNext, undefined);
  t.is(/** @type {any} */ (rg).min, undefined);
  t.is(/** @type {any} */ (rg).max, undefined);
});

test('clone() returns an alias that shares state (documented caveat)', t => {
  const source = makeSource(cloneSeed(seedA));
  const rg = adaptToPureRandomGeneratorV8(source);
  const cloned = rg.clone();
  // The contract relaxation: `RandomSource` has no snapshot, so
  // `clone` returns the same generator instance.  Both names refer
  // to the same advancing state.
  t.is(cloned, rg, 'clone returns an alias rather than an independent fork');
  // Pulling from one advances the other (because they ARE the same).
  const a = cloned.next();
  const b = rg.next();
  t.not(a, b, 'shared state advances between successive draws');
});

test('getState() returns an empty array placeholder', t => {
  const source = makeSource(cloneSeed(seedA));
  const rg = adaptToPureRandomGeneratorV8(source);
  const state = rg.getState();
  t.true(Array.isArray(state), 'getState returns an array');
  t.is(state.length, 0, 'placeholder is empty (RandomSource has no snapshot)');
  t.true(Object.isFrozen(state), 'placeholder is hardened');
});

test('round trip: source -> v8 RandomGenerator -> source produces same bytes', t => {
  // `a` feeds the round-trip pipeline; `b` is a fresh twin used as
  // the ground truth.
  const a = makeSource(cloneSeed(seedA));
  const b = makeSource(cloneSeed(seedA));
  const rg = adaptToPureRandomGeneratorV8(a);
  const wrapped = adaptFromPureRandomGeneratorV8(rg);

  const through = new Uint8Array(32);
  wrapped(through);
  const direct = new Uint8Array(32);
  b(direct);
  t.deepEqual([...through], [...direct]);
});

test('v5 and v8 adapters yield identical byte streams from identical sources', t => {
  // The two generations differ only in the surface of the returned
  // generator object; the byte-level pack/unpack must be bit-identical
  // so a consumer can switch generations without changing the
  // underlying entropy stream for a given seed.
  const v5Source = makeSource(cloneSeed(seedA));
  const v5Rg = adaptToPureRandomGenerator(v5Source);
  // Pull 32 bytes through the v5 surface by collecting 8 unsafeNext
  // results and unpacking them little-endian.
  const v5Bytes = new Uint8Array(32);
  const v5View = new DataView(v5Bytes.buffer);
  for (let i = 0; i < 8; i += 1) {
    v5View.setUint32(i * 4, v5Rg.unsafeNext() >>> 0, true);
  }

  const v8Source = makeSource(cloneSeed(seedA));
  const v8Rg = adaptToPureRandomGeneratorV8(v8Source);
  const v8Bytes = new Uint8Array(32);
  const v8View = new DataView(v8Bytes.buffer);
  for (let i = 0; i < 8; i += 1) {
    v8View.setUint32(i * 4, v8Rg.next() >>> 0, true);
  }

  t.deepEqual([...v5Bytes], [...v8Bytes]);
});

test('v8 adapter preserves randomInt distribution shape', t => {
  // Sanity: feeding a randomInt sampler from the round-tripped v8
  // source still yields integers in range.
  const source = makeSource(cloneSeed(seedA));
  const rg = adaptToPureRandomGeneratorV8(source);
  const wrapped = adaptFromPureRandomGeneratorV8(rg);
  for (let i = 0; i < 1000; i += 1) {
    const x = randomInt(wrapped, 0, 99);
    t.true(x >= 0 && x <= 99);
  }
  const f = random(wrapped);
  t.true(f >= 0 && f < 1);
});

test('makeRandomTypeFromSeedV8 broadcasts the int32 seed over 32 bytes', t => {
  const seedsSeen = [];
  const instrumented = makeRandomTypeFromSeedV8(seed => {
    // Capture the seed broadcast: same little-endian Int32 replicated
    // 8 times across the 32-byte buffer, identical to the v5 codepath.
    const view = new DataView(seed.buffer);
    seedsSeen.push(view.getInt32(0, true));
    return makeSource(seed);
  });

  const fcSeed = 0xc0ffee;
  const rg = instrumented(fcSeed);
  // Pull a value to force the seed-builder to run.
  rg.next();

  t.is(seedsSeen.length, 1);
  t.is(seedsSeen[0], fcSeed | 0);
});
