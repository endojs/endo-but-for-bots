/*---
description: Generator intrinsic metadata is coherent across Hardened JavaScript hosts
features: [generators, Symbol.toStringTag]
---*/

function* generator() {}

var Generator = Object.getPrototypeOf(generator);
var GeneratorPrototype = Generator.prototype;

var metadata = [
  GeneratorPrototype.constructor === Generator,
  GeneratorPrototype.next.name,
  GeneratorPrototype.next.length,
  GeneratorPrototype.return.name,
  GeneratorPrototype.return.length,
  GeneratorPrototype.throw.name,
  GeneratorPrototype.throw.length,
  Object.prototype.toString.call(
    Object.getPrototypeOf(Object.getPrototypeOf(generator())),
  ),
].join('|');

assert.sameValue(
  metadata,
  'true|next|1|return|1|throw|1|[object Generator]',
  'the intrinsic prototype chain and method metadata agree',
);

var replacementPrototype = {};
generator.prototype = replacementPrototype;
assert.sameValue(
  generator.prototype,
  replacementPrototype,
  'a generator function retains an assignable prototype',
);
