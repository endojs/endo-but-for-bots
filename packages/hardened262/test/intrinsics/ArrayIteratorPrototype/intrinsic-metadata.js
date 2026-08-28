/*---
description: The %ArrayIteratorPrototype% intrinsic exposes a coherent `next` method and prototype chain across Hardened JavaScript hosts
features: [Symbol.iterator]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Every built-in iterator inherits from the single %IteratorPrototype%
// intrinsic, reached two links up from a fresh iterator instance.
var IteratorPrototype = prototypeOf(prototypeOf([][Symbol.iterator]()));

var ArrayIteratorPrototype = prototypeOf([][Symbol.iterator]());

var metadata = [
  typeof ArrayIteratorPrototype.next,
  ArrayIteratorPrototype.next.name,
  ArrayIteratorPrototype.next.length,
  prototypeOf(ArrayIteratorPrototype) === IteratorPrototype,
  ArrayIteratorPrototype[Symbol.toStringTag],
].join('|');

assert.sameValue(
  metadata,
  'function|next|0|true|Array Iterator',
  'the %ArrayIteratorPrototype% next method, prototype chain, and toStringTag agree',
);
