/*---
description: stage4-compartment corpus line 6 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run]
info: |
  Converted from corpora/stage4-compartment.js line 6.
  Source: 1 < 2 ? "a" : "b"
---*/
assert.sameValue((1 < 2 ? "a" : "b"), "a");
