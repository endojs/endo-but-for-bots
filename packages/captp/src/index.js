/**
 * `export *` does not carry `@typedef` declarations from a sibling module,
 * so types that the `makeCapTP` surface references are forwarded here to
 * make `@import { Foo } from '@endo/captp'` resolve.
 *
 * @typedef {import('./types.js').SturdyRefData} SturdyRefData
 */

export { Nat } from '@endo/nat';

export * from '@endo/marshal';

export * from './captp.js';
export { makeLoopback } from './loopback.js';
export * from './atomics.js';
