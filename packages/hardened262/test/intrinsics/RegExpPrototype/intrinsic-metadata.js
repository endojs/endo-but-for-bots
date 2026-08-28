/*---
description: The %RegExp.prototype% intrinsic exposes a coherent `exec` method, chain, and prototype-only `source` across Hardened JavaScript hosts
features: [Symbol.match, Symbol.replace, Symbol.search, Symbol.split]
---*/

function prototypeOf(value) {
  return Object.getPrototypeOf(value);
}

// Reach the %RegExp.prototype% intrinsic without the %RegExp% global, one link
// up from a regular-expression literal.
var RegExpPrototype = prototypeOf(/(?:)/);

// %RegExp.prototype% is itself an ordinary object, not a RegExp instance: its
// `source` getter special-cases the prototype receiver to the empty-group
// pattern rather than throwing, the spec-mandated tell that no host has
// smuggled a real RegExp into the prototype slot.
var metadata = [
  typeof RegExpPrototype.exec,
  RegExpPrototype.exec.name,
  RegExpPrototype.exec.length,
  prototypeOf(RegExpPrototype) === Object.prototype,
  RegExpPrototype.source,
  typeof RegExpPrototype[Symbol.match],
  typeof RegExpPrototype[Symbol.replace],
  typeof RegExpPrototype[Symbol.search],
  typeof RegExpPrototype[Symbol.split],
].join('|');

assert.sameValue(
  metadata,
  'function|exec|1|true|(?:)|function|function|function|function',
  'the %RegExp.prototype% exec method, prototype chain, prototype-only source, and well-known-symbol methods agree',
);
