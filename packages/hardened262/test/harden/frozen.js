/*---
description:
features: [harden]
flags: [onlyStrict]
---*/

class Class {
  constructor(it) {
    this.property = it;
  }
}

const object = new Class({});
Object.freeze(object);
assert.sameValue(Object.isFrozen(object), true, 'frozen object is frozen');
assert.sameValue(
  Object.isFrozen(Object.getPrototypeOf(object)),
  false,
  'frozen object prototype is not frozen',
);
assert.sameValue(
  Object.isFrozen(object.property),
  false,
  'frozen object property is not frozen',
);
// `harden` is ambient on native XS and the SES-on-XS shim but installed only at
// `lockdown()` on the pure-JS Node shim, so guard on its availability to run in
// every scenario (module + lockdownModule) rather than only the lockdown column.
// The post-harden transitive-freeze assertions only hold once `harden` has run.
if (typeof harden === 'function') {
  harden(object);
  assert.sameValue(Object.isFrozen(object), true, 'hardened object is frozen');
  assert.sameValue(
    Object.isFrozen(Object.getPrototypeOf(object)),
    true,
    'hardened object prototype is frozen',
  );
  assert.sameValue(
    Object.isFrozen(object.property),
    true,
    'hardened object property is frozen',
  );
}
