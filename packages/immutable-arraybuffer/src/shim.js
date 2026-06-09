/* global globalThis */

import { immutableArrayBufferLibProperties } from './lib.js';

const {
  ArrayBuffer,
  JSON,
  Object,
  Reflect,
  // eslint-disable-next-line no-restricted-globals
} = globalThis;

const { getOwnPropertyDescriptors, defineProperties } = Object;
const { ownKeys } = Reflect;
const { prototype: arrayBufferPrototype } = ArrayBuffer;
const { stringify } = JSON;

// The lib's property record installs methods that intentionally overwrite
// the genuine `slice`, `resize`, `transfer`, and `transferToFixedLength`
// methods on `ArrayBuffer.prototype`, plus the four read accessors
// (`byteLength`, `detached`, `maxByteLength`, `resizable`) that the
// resizable-ArrayBuffer proposal added on Node >= 19. The replacements use
// the amplifier-with-this-fallthrough pattern: they discriminate on brand
// WeakMap membership, dispatch to the captured genuine method when the
// receiver is a genuine `ArrayBuffer`, and either throw or do the
// emulated-immutable thing when the receiver is in the brand WeakMap. The
// overwrite is load-bearing (the genuine methods do not know about the
// brand), so the overwrite-warning suppresses these eight to keep cold-start
// logs clean. On Hermes and XS (and Node <= 18) the four read accessors are
// absent from `ArrayBuffer.prototype`, so they do not surface in the
// `overwrites` list on those platforms; listing them here is harmless. Any
// other overwrite (a new genuine accessor that ships in a later browser
// before the proposal stabilises, or a competing shim) still fires the
// warning so the shim author can investigate.
//
// The console-guard below is the second line of defense: on Hermes and XS
// the bare interpreter contexts the smoke tests use have no `console`
// global at all, so an unguarded `console.warn` reference would throw
// `ReferenceError` even when the `overwrites` list is empty. Both
// suppressions are needed: the expected-overwrite filter to keep modern
// Node's cold-start logs clean, and the console-guard to keep the shim
// loadable on engines that lack `console`.
const expectedOverwrites = [
  'slice',
  'resize',
  'transfer',
  'transferToFixedLength',
  'byteLength',
  'detached',
  'maxByteLength',
  'resizable',
];
const isExpectedOverwrite = key => {
  for (let i = 0; i < expectedOverwrites.length; i += 1) {
    if (expectedOverwrites[i] === key) return true;
  }
  return false;
};

// Modern shim practice frowns on conditional installation, at least for
// proposals prior to stage 3. This is so changes to the proposal since
// an old shim was distributed don't need to worry about the proposal
// breaking old code depending on the old shim. Thus, if we detect that
// we're about to overwrite a prior installation, we simply issue this
// warning and continue.
//
// TODO, if the primordials are frozen after the prior implementation, such as
// by `lockdown`, then this precludes overwriting as expected. However, for
// this case, the following warning text will be confusing.
//
// Allowing polymorphic calls because these occur during initialization.
// eslint-disable-next-line @endo/no-polymorphic-call
const overwrites = ownKeys(immutableArrayBufferLibProperties).filter(
  key => key in arrayBufferPrototype && !isExpectedOverwrite(key),
);
if (
  overwrites.length > 0 &&
  typeof console !== 'undefined' &&
  typeof console.warn === 'function'
) {
  // eslint-disable-next-line @endo/no-polymorphic-call
  console.warn(
    `About to overwrite ArrayBuffer.prototype properties ${stringify(overwrites)}`,
  );
}

defineProperties(
  arrayBufferPrototype,
  getOwnPropertyDescriptors(immutableArrayBufferLibProperties),
);
