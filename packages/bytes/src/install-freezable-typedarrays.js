// @ts-nocheck

/**
 * Installs one freezable TypedArray constructor per family at
 * `Ctor[Symbol.for('freezable')]`. The installed constructor accepts
 * an emulated immutable `ArrayBuffer` as its sole argument and
 * returns a freezable view whose mutators throw; for non-immutable
 * arguments it delegates to the original `Ctor`.
 *
 * The maker that builds these constructors lives in
 * `./freezable-typedarray-pony.js`, an internal module of
 * `@endo/bytes` that imports its dependencies from a deliberately
 * narrow `@endo/immutable-arraybuffer/private-for-bytes.js` subpath.
 * Consumers of `@endo/bytes` reach the installed constructors via
 * `Ctor[Symbol.for('freezable')]` on each TypedArray family, not by
 * importing the maker.
 */

import {
  CapturedBigInt64Array,
  CapturedBigUint64Array,
  CapturedFloat32Array,
  CapturedFloat64Array,
  CapturedInt16Array,
  CapturedInt32Array,
  CapturedInt8Array,
  CapturedUint16Array,
  CapturedUint32Array,
  CapturedUint8Array,
  CapturedUint8ClampedArray,
  installOrAdopt,
} from './install-helpers.js';
import { makePseudoTypedArrayConstructor } from './freezable-typedarray-pony.js';

const symFreezable = Symbol.for('freezable');

const typedArrayFamilies = [
  CapturedUint8Array,
  CapturedUint8ClampedArray,
  CapturedUint16Array,
  CapturedUint32Array,
  CapturedInt8Array,
  CapturedInt16Array,
  CapturedInt32Array,
  CapturedFloat32Array,
  CapturedFloat64Array,
  CapturedBigInt64Array,
  CapturedBigUint64Array,
];

/** @type {Map<Function, Function>} */
const freezableConstructorsByFamily = new Map();
for (const Ctor of typedArrayFamilies) {
  if (Ctor !== undefined) {
    const installed = installOrAdopt(
      Ctor,
      symFreezable,
      makePseudoTypedArrayConstructor(Ctor),
    );
    freezableConstructorsByFamily.set(Ctor, installed);
  }
}

export const getFreezableConstructor = Ctor =>
  freezableConstructorsByFamily.get(Ctor);

export { symFreezable };
