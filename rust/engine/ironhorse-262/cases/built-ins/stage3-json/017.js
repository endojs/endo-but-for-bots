/*---
description: stage3-json corpus line 17 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-json.js line 17.
  Source: JSON.stringify("a".concat("b"))
---*/
assert.sameValue((JSON.stringify("a".concat("b"))), "\"ab\"");
