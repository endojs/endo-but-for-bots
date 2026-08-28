/*---
description: The %StringIteratorPrototype% intrinsic exposes a coherent `next` method and prototype chain across Hardened JavaScript hosts
features: [Symbol.iterator]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Every built-in iterator inherits from the single %IteratorPrototype%
// intrinsic, reached two links up from a fresh iterator instance.
var IteratorPrototype = prototypeOf(prototypeOf([][Symbol.iterator]()));

var StringIteratorPrototype = prototypeOf(''[Symbol.iterator]());

var metadata = [
  typeof StringIteratorPrototype.next,
  StringIteratorPrototype.next.name,
  StringIteratorPrototype.next.length,
  prototypeOf(StringIteratorPrototype) === IteratorPrototype,
  StringIteratorPrototype[Symbol.toStringTag],
].join('|');

assert.sameValue(
  metadata,
  'function|next|0|true|String Iterator',
  'the %StringIteratorPrototype% next method, prototype chain, and toStringTag agree',
);
