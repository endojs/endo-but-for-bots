// @ts-check
import harden from '@endo/harden';

/**
 * @import {ParcelObject} from './types.js';
 */

const { getOwnPropertyDescriptor } = Object;

/**
 * Every Parcel is a key in the private WeakMap from each parcel to its
 * internal slots (location and open hook) that `@endo/parcel` holds, and the
 * `Parcel.isParcel` it installs on `globalThis` asks that WeakMap. An object
 * of the same shape that the constructor did not make is therefore not a
 * Parcel. Pass-style reaches the WeakMap only through this global because the
 * shim does not depend on pass-style.
 *
 * The shim must run before anything installs `harden`, including this
 * module's own import, so the global is already present now or never will be.
 * Capturing it once also keeps `passStyleOf`'s memo stable. The global and its
 * `isParcel` are read through descriptors because the shim and SES both
 * reject an accessor there, and a non-function leaves no object a Parcel
 * rather than making every `passStyleOf` throw.
 *
 * @type {((value: unknown) => boolean) | undefined}
 */
const isParcel = (() => {
  const Parcel = getOwnPropertyDescriptor(globalThis, 'Parcel')?.value;
  if (typeof Parcel !== 'function') {
    return undefined;
  }
  const candidate = getOwnPropertyDescriptor(Parcel, 'isParcel')?.value;
  return typeof candidate === 'function' ? candidate : undefined;
})();

/**
 * @param {unknown} candidate
 * @returns {candidate is ParcelObject}
 */
export const isParcelObject = candidate =>
  typeof candidate === 'object' &&
  candidate !== null &&
  isParcel !== undefined &&
  isParcel(candidate);
harden(isParcelObject);
