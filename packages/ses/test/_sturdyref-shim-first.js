// Stands in for the `@endo/sturdyref` shim having installed `SturdyRef`
// before `lockdown`. It has the same shape as the shim's constructor (a class
// with `enliven` and `isSturdyRef` statics and a `SturdyRef` toStringTag) and
// the same non-writable, non-configurable global descriptor. It leaves
// hardening to `lockdown`, which hardens every permitted intrinsic.

const { defineProperty, freeze } = Object;
const { apply } = Reflect;

const handlers = new WeakMap();

class SturdyRef {
  constructor(handler) {
    const { enliven } = handler;
    if (typeof enliven !== 'function') {
      throw TypeError('SturdyRef handler must have an enliven method');
    }
    freeze(this);
    handlers.set(this, { handler, enliven });
  }

  static isSturdyRef(value) {
    return handlers.has(value);
  }

  static enliven(ref) {
    return Promise.resolve().then(() => {
      const entry = handlers.get(ref);
      if (entry === undefined) {
        throw TypeError('SturdyRef.enliven expects a SturdyRef');
      }
      return apply(entry.enliven, entry.handler, [ref]);
    });
  }
}

defineProperty(SturdyRef.prototype, Symbol.toStringTag, {
  value: 'SturdyRef',
  writable: false,
  enumerable: false,
  configurable: false,
});

defineProperty(globalThis, 'SturdyRef', {
  value: SturdyRef,
  enumerable: false,
  writable: false,
  configurable: false,
});
