/*---
description: Async generator intrinsic metadata is coherent across Hardened JavaScript hosts
features: [async-iteration, Symbol.toStringTag]
---*/

async function* generator() {}

var AsyncGenerator = Object.getPrototypeOf(generator);
var AsyncGeneratorPrototype = AsyncGenerator.prototype;

var metadata = [
  AsyncGeneratorPrototype.constructor === AsyncGenerator,
  AsyncGeneratorPrototype.next.name,
  AsyncGeneratorPrototype.next.length,
  AsyncGeneratorPrototype.return.name,
  AsyncGeneratorPrototype.return.length,
  AsyncGeneratorPrototype.throw.name,
  AsyncGeneratorPrototype.throw.length,
  Object.prototype.toString.call(
    Object.getPrototypeOf(Object.getPrototypeOf(generator())),
  ),
].join('|');

assert.sameValue(
  metadata,
  'true|next|1|return|1|throw|1|[object AsyncGenerator]',
  'the intrinsic prototype chain and method metadata agree',
);

var replacementPrototype = {};
generator.prototype = replacementPrototype;
assert.sameValue(
  generator.prototype,
  replacementPrototype,
  'an async generator function retains an assignable prototype',
);
