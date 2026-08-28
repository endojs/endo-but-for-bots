/*---
description: The %Map.prototype% intrinsic exposes coherent methods, a `size` accessor, and prototype chain across Hardened JavaScript hosts
features: [Symbol.iterator, Symbol.toStringTag]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Reach %Map.prototype% from a fresh instance rather than the constructor
// global, then pin the method table, the `size` accessor, the iterator
// aliasing, and the single-link chain up to %Object.prototype%.
var MapPrototype = prototypeOf(new Map());

// Each metadatum is an independent assertion so a divergence names the exact
// property that drifted rather than failing an opaque joined string.
assert.sameValue(
  typeof MapPrototype.get,
  'function',
  '%Map.prototype%.get is callable',
);
assert.sameValue(MapPrototype.get.name, 'get', '%Map.prototype%.get.name');
assert.sameValue(MapPrototype.get.length, 1, '%Map.prototype%.get.length');
assert.sameValue(MapPrototype.set.name, 'set', '%Map.prototype%.set.name');
assert.sameValue(MapPrototype.set.length, 2, '%Map.prototype%.set.length');
assert.sameValue(MapPrototype.has.name, 'has', '%Map.prototype%.has.name');
assert.sameValue(MapPrototype.has.length, 1, '%Map.prototype%.has.length');
assert.sameValue(
  MapPrototype.delete.name,
  'delete',
  '%Map.prototype%.delete.name',
);
assert.sameValue(
  MapPrototype.delete.length,
  1,
  '%Map.prototype%.delete.length',
);
assert.sameValue(
  MapPrototype.clear.name,
  'clear',
  '%Map.prototype%.clear.name',
);
assert.sameValue(MapPrototype.clear.length, 0, '%Map.prototype%.clear.length');
assert.sameValue(
  MapPrototype.forEach.name,
  'forEach',
  '%Map.prototype%.forEach.name',
);
assert.sameValue(
  MapPrototype.forEach.length,
  1,
  '%Map.prototype%.forEach.length',
);
assert.sameValue(
  MapPrototype.entries.name,
  'entries',
  '%Map.prototype%.entries.name',
);
assert.sameValue(
  MapPrototype.entries.length,
  0,
  '%Map.prototype%.entries.length',
);
assert.sameValue(MapPrototype.keys.name, 'keys', '%Map.prototype%.keys.name');
assert.sameValue(MapPrototype.keys.length, 0, '%Map.prototype%.keys.length');
assert.sameValue(
  MapPrototype.values.name,
  'values',
  '%Map.prototype%.values.name',
);
assert.sameValue(
  MapPrototype.values.length,
  0,
  '%Map.prototype%.values.length',
);
assert.sameValue(
  MapPrototype[Symbol.iterator],
  MapPrototype.entries,
  '%Map.prototype%[Symbol.iterator] aliases entries',
);
assert.sameValue(
  typeof Object.getOwnPropertyDescriptor(MapPrototype, 'size').get,
  'function',
  '%Map.prototype% size is an accessor',
);
assert.sameValue(
  Object.getOwnPropertyDescriptor(MapPrototype, 'size').set,
  undefined,
  '%Map.prototype% size is a getter-only accessor (no setter)',
);
assert.sameValue(
  MapPrototype[Symbol.toStringTag],
  'Map',
  '%Map.prototype%[Symbol.toStringTag]',
);
assert.sameValue(
  prototypeOf(MapPrototype),
  Object.prototype,
  '%Map.prototype% chains directly to %Object.prototype%',
);
