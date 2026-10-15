// Stands in for a `Parcel` global that is a Proxy over a well-shaped
// constructor, whose `get` trap answers `open` with the privileged `locate`
// while its descriptors report the real `open`.

const { defineProperty } = Object;
const { get } = Reflect;
const fixtureGlobal = /** @type {any} */ (globalThis);

const locations = new WeakMap();

class Target {
  constructor(location) {
    locations.set(this, location);
  }

  static open() {
    return 'opened';
  }

  static locate(parcel) {
    return locations.get(parcel);
  }

  static isParcel(value) {
    return locations.has(value);
  }
}

export const Parcel = new Proxy(Target, {
  get(target, name, receiver) {
    if (name === 'open') {
      return target.locate;
    }
    return get(target, name, receiver);
  },
});
defineProperty(Target.prototype, 'constructor', { value: Parcel });
export const { open, locate } = Target;

defineProperty(fixtureGlobal, 'Parcel', {
  value: Parcel,
  enumerable: false,
  writable: false,
  configurable: false,
});
