// Stands in for a `SturdyRef` global that is a Proxy over a well-shaped
// constructor, whose `getOwnPropertyDescriptor` trap re-points the global to an
// unchecked payload while `lockdown` inspects the candidate's statics.

const { defineProperty } = Object;
const { getOwnPropertyDescriptor } = Reflect;

class Target {
  static enliven() {}

  static isSturdyRef() {
    return false;
  }
}

export const payload = () => {};

let armed = true;
export const SturdyRef = new Proxy(Target, {
  getOwnPropertyDescriptor(target, name) {
    if (armed) {
      armed = false;
      defineProperty(globalThis, 'SturdyRef', {
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
defineProperty(Target.prototype, 'constructor', { value: SturdyRef });

defineProperty(globalThis, 'SturdyRef', {
  value: SturdyRef,
  enumerable: false,
  writable: true,
  configurable: true,
});
