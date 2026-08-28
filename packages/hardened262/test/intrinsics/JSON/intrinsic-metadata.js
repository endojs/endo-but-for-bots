/*---
description: The %JSON% namespace intrinsic exposes coherent metadata and parse/stringify behavior across Hardened JavaScript hosts
features: [JSON, Symbol.toStringTag]
---*/

// %JSON% is a namespace object rather than a constructor. Lockdown hardens the
// intrinsic, but must preserve its identity and ordinary prototype chain; each
// fact is pinned as its own assertion.
assert.sameValue(typeof JSON, 'object', '%JSON% is a namespace object');
assert.sameValue(
  Object.getPrototypeOf(JSON),
  Object.prototype,
  '%JSON% chains directly to %Object.prototype%',
);
assert.sameValue(JSON[Symbol.toStringTag], 'JSON', '%JSON%[Symbol.toStringTag]');
assert.sameValue(
  Object.prototype.toString.call(JSON),
  '[object JSON]',
  '%JSON% Object.prototype.toString tag',
);
assert.sameValue(typeof JSON.parse, 'function', '%JSON.parse% is callable');
assert.sameValue(
  typeof JSON.stringify,
  'function',
  '%JSON.stringify% is callable',
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
