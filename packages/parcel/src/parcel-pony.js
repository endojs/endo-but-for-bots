/* The no-side-effect `@endo/parcel` ponyfill. Calls delegate to the Parcel
 * constructor selected by the realm's first-wins shim.
 */

import { provideParcel } from './parcel-shim.js';

/** @import { Parcel, ParcelOpenHook } from './types.js' */

const { freeze } = Object;

/**
 * @param {string} location
 * @param {ParcelOpenHook} openHook
 * @returns {Parcel}
 */
export const makeParcel = (location, openHook) => {
  const Parcel = provideParcel();
  return new Parcel(location, openHook);
};

/**
 * @param {Parcel} parcel
 * @returns {Promise<unknown>}
 */
export const open = parcel => provideParcel().open(parcel);

/**
 * @param {unknown} value
 * @returns {value is Parcel}
 */
export const isParcel = value => provideParcel().isParcel(value);

/**
 * @param {Parcel} parcel
 * @returns {string}
 */
export const locate = parcel => {
  const Parcel = provideParcel();
  if (!('locate' in Parcel)) {
    throw TypeError('Parcel.locate is not available on the shared constructor');
  }
  return Parcel.locate(parcel);
};

freeze(makeParcel);
freeze(open);
freeze(isParcel);
freeze(locate);
