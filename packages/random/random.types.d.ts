export {};

/**
 * A `RandomSource` is a function that fills a `Uint8Array` with random
 * bytes.  The shape mirrors `crypto.getRandomValues` (minus the
 * return value), so the canonical browser/Node entropy source and a
 * `@endo/chacha12`-backed source returned by `makeChaCha12(seed)` are
 * both directly usable wherever a `RandomSource` is expected.
 *
 * Implementations MUST mutate the supplied buffer in place; they
 * MUST NOT retain the buffer reference after the call returns.
 */
export type RandomSource = (out: Uint8Array) => void;
