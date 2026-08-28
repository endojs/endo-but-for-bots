/*---
description: The %SetIteratorPrototype% intrinsic exposes a coherent `next` method and prototype chain across Hardened JavaScript hosts
features: [Symbol.iterator]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Every built-in iterator inherits from the single %IteratorPrototype%
// intrinsic, reached two links up from a fresh iterator instance.
var IteratorPrototype = prototypeOf(prototypeOf([][Symbol.iterator]()));

var SetIteratorPrototype = prototypeOf(new Set()[Symbol.iterator]());

var metadata = [
  typeof SetIteratorPrototype.next,
  SetIteratorPrototype.next.name,
  SetIteratorPrototype.next.length,
  prototypeOf(SetIteratorPrototype) === IteratorPrototype,
  SetIteratorPrototype[Symbol.toStringTag],
].join('|');

assert.sameValue(
  metadata,
  'function|next|0|true|Set Iterator',
  'the %SetIteratorPrototype% next method, prototype chain, and toStringTag agree',
);
