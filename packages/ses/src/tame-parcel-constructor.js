// @ts-check

import { TypeError, construct, defineProperties, freeze } from './commons.js';

/**
 * Derive the powerless `%SharedParcel%` constructor from the shim-installed
 * `%InitialParcel%` constructor. Both constructors use the initial
 * constructor's prototype and private brand table, but only the initial
 * constructor exposes `locate`.
 *
 * @param {any} InitialParcel
 */
export default function tameParcelConstructor(InitialParcel) {
  if (InitialParcel === undefined) {
    return {};
  }

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
    open: { value: InitialParcel.open },
    isParcel: { value: InitialParcel.isParcel },
    prototype: {
      value: InitialParcel.prototype,
      writable: false,
      enumerable: false,
      configurable: false,
    },
  });

  // Prevent `Parcel.prototype.constructor` from revealing the powered initial
  // constructor to a child compartment.
  defineProperties(InitialParcel.prototype, {
    constructor: { value: SharedParcel },
  });

  return freeze({
    '%InitialParcel%': InitialParcel,
    '%SharedParcel%': SharedParcel,
  });
}
