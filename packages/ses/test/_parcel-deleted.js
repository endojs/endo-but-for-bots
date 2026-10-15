// Stands in for a `Parcel` global that is a Proxy over a compatible
// constructor, whose `getOwnPropertyDescriptor` trap deletes the global while
// `lockdown` inspects the candidate's statics.

const { defineProperty } = Object;
const { getOwnPropertyDescriptor } = Reflect;
const fixtureGlobal = /** @type {any} */ (globalThis);

class Target {
  static open() {}

  static locate() {}

  static isParcel() {
    return false;
  }
}

let armed = true;
export const Parcel = new Proxy(Target, {
  getOwnPropertyDescriptor(target, name) {
    if (armed) {
      armed = false;
      delete fixtureGlobal.Parcel;
    }
    return getOwnPropertyDescriptor(target, name);
  },
});
// Keep the permit's `prototype.constructor` pointing at the admitted value.
defineProperty(Target.prototype, 'constructor', { value: Parcel });

defineProperty(fixtureGlobal, 'Parcel', {
  value: Parcel,
  enumerable: false,
  writable: true,
  configurable: true,
});
