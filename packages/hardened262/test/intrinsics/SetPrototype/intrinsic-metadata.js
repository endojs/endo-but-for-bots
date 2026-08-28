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

var metadata = [
  typeof SetPrototype.add,
  SetPrototype.add.name,
  SetPrototype.add.length,
  SetPrototype.has.name,
  SetPrototype.has.length,
  SetPrototype.delete.name,
  SetPrototype.delete.length,
  SetPrototype.clear.name,
  SetPrototype.clear.length,
  SetPrototype.forEach.name,
  SetPrototype.forEach.length,
  SetPrototype.entries.name,
  SetPrototype.values.name,
  SetPrototype.keys === SetPrototype.values,
  SetPrototype[Symbol.iterator] === SetPrototype.values,
  typeof Object.getOwnPropertyDescriptor(SetPrototype, 'size').get,
  SetPrototype[Symbol.toStringTag],
  prototypeOf(SetPrototype) === Object.prototype,
].join('|');

assert.sameValue(
  metadata,
  'function|add|1|has|1|delete|1|clear|0|forEach|1|entries|values|true|true|function|Set|true',
  'the %Set.prototype% method table, size accessor, keys/values alias, and chain agree',
);
