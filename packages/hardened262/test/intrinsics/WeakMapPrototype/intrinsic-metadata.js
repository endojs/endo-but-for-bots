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

// Each metadatum is an independent assertion so a divergence names the exact
// property that drifted rather than failing an opaque joined string.
assert.sameValue(
  typeof WeakMapPrototype.get,
  'function',
  '%WeakMap.prototype%.get is callable',
);
assert.sameValue(
  WeakMapPrototype.get.name,
  'get',
  '%WeakMap.prototype%.get.name',
);
assert.sameValue(
  WeakMapPrototype.get.length,
  1,
  '%WeakMap.prototype%.get.length',
);
assert.sameValue(
  WeakMapPrototype.set.name,
  'set',
  '%WeakMap.prototype%.set.name',
);
assert.sameValue(
  WeakMapPrototype.set.length,
  2,
  '%WeakMap.prototype%.set.length',
);
assert.sameValue(
  WeakMapPrototype.has.name,
  'has',
  '%WeakMap.prototype%.has.name',
);
assert.sameValue(
  WeakMapPrototype.has.length,
  1,
  '%WeakMap.prototype%.has.length',
);
assert.sameValue(
  WeakMapPrototype.delete.name,
  'delete',
  '%WeakMap.prototype%.delete.name',
);
assert.sameValue(
  WeakMapPrototype.delete.length,
  1,
  '%WeakMap.prototype%.delete.length',
);
assert.sameValue(
  Symbol.iterator in WeakMapPrototype,
  false,
  '%WeakMap.prototype% exposes no Symbol.iterator',
);
assert.sameValue(
  WeakMapPrototype[Symbol.toStringTag],
  'WeakMap',
  '%WeakMap.prototype%[Symbol.toStringTag]',
);
assert.sameValue(
  prototypeOf(WeakMapPrototype),
  Object.prototype,
  '%WeakMap.prototype% chains directly to %Object.prototype%',
);
