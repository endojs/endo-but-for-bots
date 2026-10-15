// Stands in for a `Parcel` global that is a Proxy over a well-shaped
// constructor, whose `getOwnPropertyDescriptor` trap re-points the global to an
// unchecked payload while `lockdown` inspects the candidate's statics.

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

export const payload = () => {};

let armed = true;
export const Parcel = new Proxy(Target, {
  getOwnPropertyDescriptor(target, name) {
    if (armed) {
      armed = false;
      defineProperty(fixtureGlobal, 'Parcel', {
        value: payload,
        enumerable: false,
        writable: true,
        configurable: true,
      });
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
