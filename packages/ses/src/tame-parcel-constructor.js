// @ts-check

import { TypeError, construct, defineProperties, freeze } from './commons.js';

/**
 * Derive the powerless `%SharedParcel%` constructor from the shim-installed
 * `%InitialParcel%` constructor. Both constructors use the initial
 * constructor's prototype and private brand table, but only the initial
 * constructor exposes `locate`.
 *
 * Every member comes from the descriptor snapshot `sampleParcel` validated,
 * never from a fresh `[[Get]]` on the candidate, which a Proxy could answer
 * with `locate`.
 *
 * @param {import('./intrinsics.js').ParcelSample | undefined} sample
 */
export default function tameParcelConstructor(sample) {
  if (sample === undefined) {
    return {};
  }
  const { Parcel: InitialParcel, open, isParcel, prototype } = sample;

  // Constructor emulation is one of the repository's documented exceptions
  // to the function-keyword rule. The function's specified name is Parcel.
  const SharedParcel = function Parcel(location, openHook) {
    if (new.target === undefined) {
      throw TypeError('Parcel requires new');
    }
    return construct(InitialParcel, [location, openHook], new.target);
  };

  defineProperties(SharedParcel, {
    length: { value: 2 },
    open: { value: open },
    isParcel: { value: isParcel },
    prototype: {
      value: prototype,
      writable: false,
      enumerable: false,
      configurable: false,
    },
  });

  // Prevent `Parcel.prototype.constructor` from revealing the powered initial
  // constructor to a child compartment.
  defineProperties(prototype, {
    constructor: { value: SharedParcel },
  });

  return freeze({
    '%InitialParcel%': InitialParcel,
    '%SharedParcel%': SharedParcel,
  });
}
