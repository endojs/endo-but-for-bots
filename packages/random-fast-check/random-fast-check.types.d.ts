export {};

/**
 * A `RandomSource` is a function that fills a `Uint8Array` with random
 * bytes.  This restates the structural contract that `@endo/random`'s
 * sampler functions use; both definitions describe the same shape so
 * a `RandomSource` produced by `@endo/random` (or by a
 * `@endo/chacha12`-backed source, or by `crypto.getRandomValues`'s
 * argument shape) is directly usable wherever this type is expected.
 *
 * Implementations MUST mutate the supplied buffer in place; they
 * MUST NOT retain the buffer reference after the call returns.
 */
export type RandomSource = (out: Uint8Array) => void;

/**
 * The shape of a `pure-rand` v5 `RandomGenerator`, the contract used
 * by `fast-check@^3` to drive property-based tests via the
 * `randomType` parameter.  We restate it locally rather than depend
 * on `pure-rand` directly so `@endo/random-fast-check` stays
 * dependency-free at runtime.
 *
 * `next()` returns a `[value, nextGenerator]` tuple where `value` is
 * a 32-bit signed integer in `[min(), max()]` (typically
 * `[-0x80000000, 0x7fffffff]`).  The returned generator MAY be the
 * same instance with mutated state.
 *
 * `clone()` is required by `pure-rand` v5; for serial keystreams
 * without state-snapshot support the adapter returns an alias whose
 * state is shared with the original.
 */
export interface PureRandomGenerator {
  next(): [number, PureRandomGenerator];
  unsafeNext(): number;
  clone(): PureRandomGenerator;
  min(): number;
  max(): number;
}

/**
 * The shape of a `pure-rand` v8 `RandomGenerator`, the contract used
 * by `fast-check@4` (which depends on `pure-rand@^8.0.0`) to drive
 * property-based tests via the `randomType` parameter.  We restate
 * it locally rather than depend on `pure-rand` directly so
 * `@endo/random-fast-check` stays dependency-free at runtime.
 *
 * `next()` returns a 32-bit signed integer in
 * `[-0x80000000, 0x7fffffff]` and mutates the generator state.  The
 * v5 tuple form and the separate `unsafeNext` / `min` / `max` /
 * `unsafeJump` methods were removed in v8.  See `JumpableRandomGenerator`
 * in `pure-rand` for the optional `jump()` capability; this interface
 * intentionally mirrors only the base `RandomGenerator`.
 *
 * `clone()` is documented in v8 as "produce a fully independent
 * clone".  For serial keystreams without state-snapshot support the
 * adapter returns an alias whose state is shared with the original
 * (sufficient for forward sampling; shrinking quality may degrade).
 *
 * `getState()` returns the generator's internal state as a
 * `readonly number[]`.  For sources without snapshot support the
 * adapter returns an empty array; consumers that need a real
 * snapshot must drive a fresh source from a freshly-derived seed.
 */
export interface PureRandomGeneratorV8 {
  next(): number;
  clone(): PureRandomGeneratorV8;
  getState(): readonly number[];
}
