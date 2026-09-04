/*---
description: stage3-json corpus line 16 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-json.js line 16.
  Source: JSON.stringify(1 + 2)
---*/
assert.sameValue((JSON.stringify(1 + 2)), "3");
