/*---
description: The %RegExpStringIteratorPrototype% intrinsic exposes a coherent `next` method and prototype chain across Hardened JavaScript hosts
features: [String.prototype.matchAll, Symbol.matchAll]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Every built-in iterator inherits from the single %IteratorPrototype%
// intrinsic, reached two links up from a fresh iterator instance.
var IteratorPrototype = prototypeOf(prototypeOf([][Symbol.iterator]()));

var RegExpStringIteratorPrototype = prototypeOf('a'.matchAll(/a/g));

var metadata = [
  typeof RegExpStringIteratorPrototype.next,
  RegExpStringIteratorPrototype.next.name,
  RegExpStringIteratorPrototype.next.length,
  prototypeOf(RegExpStringIteratorPrototype) === IteratorPrototype,
  RegExpStringIteratorPrototype[Symbol.toStringTag],
].join('|');

assert.sameValue(
  metadata,
  'function|next|0|true|RegExp String Iterator',
  'the %RegExpStringIteratorPrototype% next method, prototype chain, and toStringTag agree',
);
