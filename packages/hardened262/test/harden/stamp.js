/*---
description:
features: [harden]
flags: [onlyStrict,onlyLockdown,noSesNode]
---*/

// noSesNode: PrivateFieldAdd (ECMA-262 §7.3.27; §7.3.28 is
// PrivateMethodOrAccessorAdd) stamps a private field without
// consulting [[Extensible]], so a JS-level `harden` shim structurally cannot
// intercept the stamp — only a native control (bare XS / SES-on-XS) can enforce
// that a hardened object rejects it. The Node shim is excluded because it would
// spuriously fail this native-only guarantee, not because the case is unfinished.

const object = {};
const frozenObject = Object.freeze({});
const hardenedObject = harden({});

class Stamper extends class {
  constructor(obj) {
    return obj;
  }
} {
  #stamp = 'oops';
  static getStamp(obj) {
    return obj.#stamp;
  }
}

function test(it) {
  return function () {
    new Stamper(it);
    return Stamper.getStamp(it);
  };
}

assert.sameValue(test(object)(), 'oops', 'object can be stamped');
assert.sameValue(test(frozenObject)(), 'oops', 'frozen object can be stamped');
assert.throws(
  TypeError,
  test(hardenedObject),
  'hardened object cannot be stamped',
);
