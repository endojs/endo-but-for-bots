/*---
description: stage4-compartment corpus line 28 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-compartment.js line 28.
  Source: [1, 2, 3, 4].reduce(function (a, b) { return a + b; }, 0)
---*/
assert.sameValue(([1, 2, 3, 4].reduce(function (a, b) { return a + b; }, 0)), 10);
