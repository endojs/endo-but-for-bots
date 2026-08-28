/*---
description: The %AsyncIteratorPrototype% intrinsic is coherent across Hardened JavaScript hosts
features: [async-iteration, Symbol.asyncIterator]
---*/

async function* generator() {}

// %AsyncGeneratorPrototype% inherits from the single %AsyncIteratorPrototype%
// intrinsic, which in turn inherits directly from %Object.prototype%.
var AsyncGeneratorPrototype = Object.getPrototypeOf(generator).prototype;
var AsyncIteratorPrototype = Object.getPrototypeOf(AsyncGeneratorPrototype);

var asyncIterator = AsyncIteratorPrototype[Symbol.asyncIterator];
var metadata = [
  typeof asyncIterator,
  asyncIterator.name,
  asyncIterator.length,
  asyncIterator.call(AsyncIteratorPrototype) === AsyncIteratorPrototype,
  Object.getPrototypeOf(AsyncIteratorPrototype) === Object.prototype,
].join('|');

assert.sameValue(
  metadata,
  'function|[Symbol.asyncIterator]|0|true|true',
  'the %AsyncIteratorPrototype% [Symbol.asyncIterator] method and prototype chain agree',
);
