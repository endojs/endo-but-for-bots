/*---
description: The %IteratorPrototype% intrinsic is shared and coherent across Hardened JavaScript hosts
features: [Symbol.iterator]
---*/

function iteratorPrototypeOf(iterable) {
  return Object.getPrototypeOf(
    Object.getPrototypeOf(iterable[Symbol.iterator]()),
  );
}

// Every built-in iterator inherits from the single %IteratorPrototype%
// intrinsic, so the prototype reached through an array, string, Map, and Set
// iterator must be one and the same object.
var IteratorPrototype = iteratorPrototypeOf([]);
var sharing = [
  IteratorPrototype === iteratorPrototypeOf(''),
  IteratorPrototype === iteratorPrototypeOf(new Map()),
  IteratorPrototype === iteratorPrototypeOf(new Set()),
].join('|');

assert.sameValue(
  sharing,
  'true|true|true',
  'array, string, Map, and Set iterators all inherit from one %IteratorPrototype%',
);

var iterator = IteratorPrototype[Symbol.iterator];
var metadata = [
  typeof iterator,
  iterator.name,
  iterator.length,
  iterator.call(IteratorPrototype) === IteratorPrototype,
  Object.getPrototypeOf(IteratorPrototype) === Object.prototype,
].join('|');

assert.sameValue(
  metadata,
  'function|[Symbol.iterator]|0|true|true',
  'the %IteratorPrototype% [Symbol.iterator] method and prototype chain agree',
);
