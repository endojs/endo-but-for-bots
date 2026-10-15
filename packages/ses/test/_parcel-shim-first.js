// Copy of the bootstrap-mutable initial constructor installed by
// `@endo/parcel/shim.js`. The real package depends on SES, so this fixture
// keeps the lockdown test acyclic.

const { defineProperty, freeze } = Object;
const { apply } = Reflect;
const { Promise, TypeError, WeakMap } = globalThis;
const details = new WeakMap();

class Parcel {
  constructor(location, openHook) {
    if (new.target.prototype !== Parcel.prototype) {
      throw TypeError(
        'Parcel construction requires the shared Parcel prototype',
      );
    }
    if (typeof location !== 'string') {
      throw TypeError('Parcel location must be a string');
    }
    if (typeof openHook !== 'function') {
      throw TypeError('Parcel open hook must be a function');
    }
    freeze(this);
    details.set(this, freeze({ location, openHook }));
  }

  static isParcel(value) {
    return details.has(value);
  }

  static open(parcel) {
    return Promise.resolve().then(() => {
      const entry = details.get(parcel);
      if (entry === undefined) {
        throw TypeError('Parcel.open expects a Parcel');
      }
      return apply(entry.openHook, undefined, [entry.location, parcel]);
    });
  }

  static locate(parcel) {
    const entry = details.get(parcel);
    if (entry === undefined) {
      throw TypeError('Parcel.locate expects a Parcel');
    }
    return entry.location;
  }
}

defineProperty(Parcel.prototype, Symbol.toStringTag, {
  value: 'Parcel',
  writable: false,
  enumerable: false,
  configurable: false,
});

defineProperty(globalThis, 'Parcel', {
  value: Parcel,
  enumerable: false,
  writable: false,
  configurable: false,
});
