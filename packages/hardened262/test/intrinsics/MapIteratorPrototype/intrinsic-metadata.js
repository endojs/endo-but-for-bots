/*---
description: The %MapIteratorPrototype% intrinsic exposes a coherent `next` method and prototype chain across Hardened JavaScript hosts
features: [Symbol.iterator]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Every built-in iterator inherits from the single %IteratorPrototype%
// intrinsic, reached two links up from a fresh iterator instance.
var IteratorPrototype = prototypeOf(prototypeOf([][Symbol.iterator]()));

var MapIteratorPrototype = prototypeOf(new Map()[Symbol.iterator]());

var metadata = [
  typeof MapIteratorPrototype.next,
  MapIteratorPrototype.next.name,
  MapIteratorPrototype.next.length,
  prototypeOf(MapIteratorPrototype) === IteratorPrototype,
  MapIteratorPrototype[Symbol.toStringTag],
].join('|');

assert.sameValue(
  metadata,
  'function|next|0|true|Map Iterator',
  'the %MapIteratorPrototype% next method, prototype chain, and toStringTag agree',
);
