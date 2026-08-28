/*---
description: The %WeakSet.prototype% intrinsic exposes a coherent method table, `Symbol.toStringTag`, and prototype chain across Hardened JavaScript hosts
features: [WeakSet, Symbol.toStringTag]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Reach %WeakSet.prototype% from a fresh instance rather than the constructor
// global. Like WeakMap it exposes no iterator or `size` — pinning that the
// method table is exactly add/has/delete is itself a cross-host tell.
var WeakSetPrototype = prototypeOf(new WeakSet());

var metadata = [
  typeof WeakSetPrototype.add,
  WeakSetPrototype.add.name,
  WeakSetPrototype.add.length,
  WeakSetPrototype.has.name,
  WeakSetPrototype.has.length,
  WeakSetPrototype.delete.name,
  WeakSetPrototype.delete.length,
  Symbol.iterator in WeakSetPrototype,
  WeakSetPrototype[Symbol.toStringTag],
  prototypeOf(WeakSetPrototype) === Object.prototype,
].join('|');

assert.sameValue(
  metadata,
  'function|add|1|has|1|delete|1|false|WeakSet|true',
  'the %WeakSet.prototype% method table, toStringTag, and chain agree',
);
