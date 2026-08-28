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

// Each metadatum is an independent assertion so a divergence names the exact
// property that drifted rather than failing an opaque joined string.
assert.sameValue(
  typeof WeakSetPrototype.add,
  'function',
  '%WeakSet.prototype%.add is callable',
);
assert.sameValue(
  WeakSetPrototype.add.name,
  'add',
  '%WeakSet.prototype%.add.name',
);
assert.sameValue(
  WeakSetPrototype.add.length,
  1,
  '%WeakSet.prototype%.add.length',
);
assert.sameValue(
  WeakSetPrototype.has.name,
  'has',
  '%WeakSet.prototype%.has.name',
);
assert.sameValue(
  WeakSetPrototype.has.length,
  1,
  '%WeakSet.prototype%.has.length',
);
assert.sameValue(
  WeakSetPrototype.delete.name,
  'delete',
  '%WeakSet.prototype%.delete.name',
);
assert.sameValue(
  WeakSetPrototype.delete.length,
  1,
  '%WeakSet.prototype%.delete.length',
);
assert.sameValue(
  Symbol.iterator in WeakSetPrototype,
  false,
  '%WeakSet.prototype% exposes no Symbol.iterator',
);
assert.sameValue(
  'size' in WeakSetPrototype,
  false,
  '%WeakSet.prototype% exposes no size',
);
// Close the enumeration rather than spot-checking the named methods: pin the
// full own-property-name table so a host exposing a fifth method (or an errant
// `size`) fails here instead of slipping past the per-method assertions above.
assert.sameValue(
  Object.getOwnPropertyNames(WeakSetPrototype).sort().join(','),
  'add,constructor,delete,has',
  '%WeakSet.prototype% own property names are exactly constructor plus the add/has/delete method table',
);
assert.sameValue(
  WeakSetPrototype[Symbol.toStringTag],
  'WeakSet',
  '%WeakSet.prototype%[Symbol.toStringTag]',
);
assert.sameValue(
  prototypeOf(WeakSetPrototype),
  Object.prototype,
  '%WeakSet.prototype% chains directly to %Object.prototype%',
);
