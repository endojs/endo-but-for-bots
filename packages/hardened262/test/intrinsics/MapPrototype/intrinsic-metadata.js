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

var metadata = [
  typeof MapPrototype.get,
  MapPrototype.get.name,
  MapPrototype.get.length,
  MapPrototype.set.name,
  MapPrototype.set.length,
  MapPrototype.has.name,
  MapPrototype.has.length,
  MapPrototype.delete.name,
  MapPrototype.delete.length,
  MapPrototype.clear.name,
  MapPrototype.clear.length,
  MapPrototype.forEach.name,
  MapPrototype.forEach.length,
  MapPrototype.entries.name,
  MapPrototype.entries.length,
  MapPrototype.keys.name,
  MapPrototype.keys.length,
  MapPrototype.values.name,
  MapPrototype.values.length,
  MapPrototype[Symbol.iterator] === MapPrototype.entries,
  typeof Object.getOwnPropertyDescriptor(MapPrototype, 'size').get,
  MapPrototype[Symbol.toStringTag],
  prototypeOf(MapPrototype) === Object.prototype,
].join('|');

assert.sameValue(
  metadata,
  'function|get|1|set|2|has|1|delete|1|clear|0|forEach|1|entries|0|keys|0|values|0|true|function|Map|true',
  'the %Map.prototype% method table, size accessor, iterator alias, and chain agree',
);
