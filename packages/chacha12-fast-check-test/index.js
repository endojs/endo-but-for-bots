// @ts-check
/* eslint no-bitwise: ["off"] */

// Integration-test package only.  The adapter exported here exists
// for the test in `test/fast-check.test.js`; it is intentionally
// not published as a reusable library surface.  See
// `packages/random-fast-check/` (designed in
// `designs/random-pure-rand-v8-interface.md`) for the
// production-shaped fast-check / pure-rand adapters.

import harden from '@endo/harden';

import { makeChaCha12, makeChaCha12FromState } from '@endo/chacha12';

// Local restatement of the public `ChaCha12Generator` shape from
// `@endo/chacha12`.  The package does not expose the typedef under
// its `exports` map, so we re-state it here for the integration
// test's type signature only.
/**
 * @typedef {object} ChaCha12Generator
 * @property {() => number} next
 * @property {() => readonly number[]} getState
 * @property {() => ChaCha12Generator} clone
 * @property {(out: Uint8Array) => void} fillRandomBytes
 */

/**
 * Builds a fast-check `randomType` callback from `@endo/chacha12`.
 * The returned callback takes a 32-bit signed seed (the shape
 * `fast-check` invokes its `randomType` with) and produces a
 * `ChaCha12Generator` whose `next` / `clone` / `getState` surface is
 * structurally compatible with `pure-rand` v8's `RandomGenerator`
 * (and therefore with `fast-check@4`'s `randomType` parameter).
 *
 * The seed is broadcast across the full 32-byte ChaCha12 key by
 * little-endian writes into 8 successive u32 slots.  This is the
 * same broadcast pattern proposed for `@endo/random-fast-check`'s
 * `makeRandomTypeFromSeedV8` builder; we restate it inline here to
 * keep this integration-test package free of any fast-check adapter
 * production code.
 *
 * Because `@endo/chacha12` now exposes a real keystream snapshot
 * (`getState` / `makeChaCha12FromState`) and a real fully-independent
 * `clone`, the returned generator satisfies the v8 contract directly
 * with no "alias clone" or "empty getState" placeholder.
 *
 * @returns {(seed: number) => ChaCha12Generator}
 */
export const makeChaCha12RandomType = () => {
  /** @param {number} seed */
  const randomType = seed => {
    const key = new Uint8Array(32);
    const view = new DataView(key.buffer);
    for (let i = 0; i < 8; i += 1) {
      view.setInt32(i * 4, seed | 0, true);
    }
    return makeChaCha12(key);
  };
  return harden(randomType);
};
harden(makeChaCha12RandomType);

// Re-export so consumers (currently just the test) can import
// everything from one place.
export { makeChaCha12, makeChaCha12FromState };
