/*---
description: The %WeakMap.prototype% intrinsic exposes a coherent method table, `Symbol.toStringTag`, and prototype chain across Hardened JavaScript hosts
features: [WeakMap, Symbol.toStringTag]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Reach %WeakMap.prototype% from a fresh instance rather than the constructor
// global. A WeakMap exposes no iterator or `size` — pinning that the method
// table is exactly get/set/has/delete is itself a cross-host tell.
var WeakMapPrototype = prototypeOf(new WeakMap());

var metadata = [
  typeof WeakMapPrototype.get,
  WeakMapPrototype.get.name,
  WeakMapPrototype.get.length,
  WeakMapPrototype.set.name,
  WeakMapPrototype.set.length,
  WeakMapPrototype.has.name,
  WeakMapPrototype.has.length,
  WeakMapPrototype.delete.name,
  WeakMapPrototype.delete.length,
  Symbol.iterator in WeakMapPrototype,
  WeakMapPrototype[Symbol.toStringTag],
  prototypeOf(WeakMapPrototype) === Object.prototype,
].join('|');

assert.sameValue(
  metadata,
  'function|get|1|set|2|has|1|delete|1|false|WeakMap|true',
  'the %WeakMap.prototype% method table, toStringTag, and chain agree',
);
