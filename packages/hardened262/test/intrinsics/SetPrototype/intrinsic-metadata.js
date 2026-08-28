/*---
description: The %Set.prototype% intrinsic exposes coherent methods, a `size` accessor, and the `keys`/`values` alias across Hardened JavaScript hosts
features: [Symbol.iterator, Symbol.toStringTag]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Reach %Set.prototype% from a fresh instance rather than the constructor
// global. `Set.prototype.keys` is the very same function object as
// `Set.prototype.values` (hence its `.name` is `values`) and the default
// iterator aliases `values` — both are pinned as cross-host tells.
var SetPrototype = prototypeOf(new Set());

// Each metadatum is an independent assertion so a divergence names the exact
// property that drifted rather than failing an opaque joined string.
assert.sameValue(
  typeof SetPrototype.add,
  'function',
  '%Set.prototype%.add is callable',
);
assert.sameValue(SetPrototype.add.name, 'add', '%Set.prototype%.add.name');
assert.sameValue(SetPrototype.add.length, 1, '%Set.prototype%.add.length');
assert.sameValue(SetPrototype.has.name, 'has', '%Set.prototype%.has.name');
assert.sameValue(SetPrototype.has.length, 1, '%Set.prototype%.has.length');
assert.sameValue(
  SetPrototype.delete.name,
  'delete',
  '%Set.prototype%.delete.name',
);
assert.sameValue(
  SetPrototype.delete.length,
  1,
  '%Set.prototype%.delete.length',
);
assert.sameValue(
  SetPrototype.clear.name,
  'clear',
  '%Set.prototype%.clear.name',
);
assert.sameValue(SetPrototype.clear.length, 0, '%Set.prototype%.clear.length');
assert.sameValue(
  SetPrototype.forEach.name,
  'forEach',
  '%Set.prototype%.forEach.name',
);
assert.sameValue(
  SetPrototype.forEach.length,
  1,
  '%Set.prototype%.forEach.length',
);
assert.sameValue(
  SetPrototype.entries.name,
  'entries',
  '%Set.prototype%.entries.name',
);
assert.sameValue(
  SetPrototype.entries.length,
  0,
  '%Set.prototype%.entries.length',
);
assert.sameValue(
  SetPrototype.values.name,
  'values',
  '%Set.prototype%.values.name',
);
assert.sameValue(
  SetPrototype.values.length,
  0,
  '%Set.prototype%.values.length',
);
assert.sameValue(
  SetPrototype.keys,
  SetPrototype.values,
  '%Set.prototype%.keys is the same object as values',
);
assert.sameValue(
  SetPrototype[Symbol.iterator],
  SetPrototype.values,
  '%Set.prototype%[Symbol.iterator] aliases values',
);
assert.sameValue(
  typeof Object.getOwnPropertyDescriptor(SetPrototype, 'size').get,
  'function',
  '%Set.prototype% size is an accessor',
);
assert.sameValue(
  SetPrototype[Symbol.toStringTag],
  'Set',
  '%Set.prototype%[Symbol.toStringTag]',
);
assert.sameValue(
  prototypeOf(SetPrototype),
  Object.prototype,
  '%Set.prototype% chains directly to %Object.prototype%',
);
