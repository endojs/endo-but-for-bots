/*---
description: stage4-compartment corpus line 29 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-compartment.js line 29.
  Source: [1, 2, 3].map(function (x) { return x * 2; }).length
---*/
assert.sameValue(([1, 2, 3].map(function (x) { return x * 2; }).length), 3);
