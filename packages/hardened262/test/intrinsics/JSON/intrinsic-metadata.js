/*---
description: The %JSON% namespace intrinsic exposes coherent metadata and parse/stringify behavior across Hardened JavaScript hosts
features: [JSON, Symbol.toStringTag]
---*/

// %JSON% is a namespace object rather than a constructor. Lockdown hardens the
// intrinsic, but must preserve its identity and ordinary prototype chain.
var metadata = [
  typeof JSON,
  Object.getPrototypeOf(JSON) === Object.prototype,
  JSON[Symbol.toStringTag],
  Object.prototype.toString.call(JSON),
  typeof JSON.parse,
  typeof JSON.stringify,
].join('|');

assert.sameValue(
  metadata,
  'object|true|JSON|[object JSON]|function|function',
  'the %JSON% namespace is an object rooted at %Object.prototype% with callable parse and stringify methods',
);

var parsed = JSON.parse('{"answer":21,"items":[1,2]}', function (key, value) {
  if (key === 'answer') {
    return value * 2;
  }
  return value;
});
assert.sameValue(parsed.answer, 42, '%JSON.parse% applies a reviver');
assert.sameValue(
  parsed.items.join(','),
  '1,2',
  '%JSON.parse% reconstructs arrays',
);

var stringified = JSON.stringify(
  { keep: 1, omit: 2, nested: { keep: 3 } },
  function (key, value) {
    if (key === 'omit') {
      return undefined;
    }
    if (typeof value === 'number') {
      return value * 10;
    }
    return value;
  },
);

assert.sameValue(
  stringified,
  '{"keep":10,"nested":{"keep":30}}',
  '%JSON.stringify% applies a replacer to fresh post-lockdown data',
);

assert.throws(
  SyntaxError,
  function () {
    JSON.parse('{not json}');
  },
  '%JSON.parse% rejects malformed input with a SyntaxError',
);
