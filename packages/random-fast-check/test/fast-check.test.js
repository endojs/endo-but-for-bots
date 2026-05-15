// @ts-check
/* eslint no-bitwise: ["off"] */

import test from '@endo/ses-ava/test.js';

import { fc } from '@fast-check/ava';

import { makeChaCha12 } from '@endo/chacha12';

import { makeRandomTypeFromSeed } from '../index.js';

const chaCha12RandomType = makeRandomTypeFromSeed(
  seed => makeChaCha12(seed).fillRandomBytes,
);

test('chaCha12-backed randomType drives fc.assert successfully', t => {
  // A property that is always true exercises the adapter: fast-check
  // invokes `chaCha12RandomType(seed)`, pulls values via
  // RandomGenerator.next() / unsafeNext(), and reports no failures.
  fc.assert(
    fc.property(fc.integer(), () => true),
    /** @type {any} */ ({
      randomType: chaCha12RandomType,
      seed: 0xdeadbeef,
      numRuns: 100,
    }),
  );
  t.pass();
});

// `fc.assert` calls the supplied `randomType` with a 32-bit integer
// seed and then drives the resulting `RandomGenerator`.  This test
// observes both: it instruments the `makeSourceFromSeed` factory
// passed into `makeRandomTypeFromSeed` and asserts that the seed
// argument fast-check passes through is what `makeRandomTypeFromSeed`
// then broadcasts into the 32-byte ChaCha12 key, and that the
// resulting source actually receives `fillBytes` calls (i.e. bytes
// are pulled through the adapter).
test('randomType is invoked with the configured seed and bytes are read', t => {
  const seedsSeen = [];
  let bytesPulled = 0;

  const instrumentedRandomType = makeRandomTypeFromSeed(seed => {
    // Capture the seed as broadcast by makeRandomTypeFromSeed: the
    // 32-bit signed integer fast-check passed in is replicated 8
    // times as little-endian Int32 across the 32-byte key.
    const view = new DataView(seed.buffer);
    seedsSeen.push(view.getInt32(0, true));

    const inner = makeChaCha12(seed).fillRandomBytes;
    return out => {
      inner(out);
      bytesPulled += out.length;
    };
  });

  const fcSeed = 0xc0ffee;
  fc.assert(
    fc.property(fc.integer(), () => true),
    /** @type {any} */ ({
      randomType: instrumentedRandomType,
      seed: fcSeed,
      numRuns: 50,
    }),
  );

  // fast-check invoked our randomType at least once, with the seed
  // we configured.  (The seed is `0xc0ffee` interpreted as a signed
  // 32-bit int, which is positive, so `| 0` is a no-op.)
  t.true(seedsSeen.length >= 1, 'randomType was invoked at least once');
  t.true(
    seedsSeen.every(s => s === (fcSeed | 0)),
    `every observed seed equals ${fcSeed | 0}, got ${seedsSeen.join(',')}`,
  );

  // The chacha12 source backing the RandomGenerator was driven:
  // fast-check pulled bytes through the adapter to materialize the
  // 32-bit int values.  At minimum, one 4-byte pull per run.
  t.true(
    bytesPulled >= 50 * 4,
    `expected at least 200 bytes pulled, got ${bytesPulled}`,
  );
});
