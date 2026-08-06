/*---
description: stage3-json corpus line 18 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-json.js line 18.
  Source: JSON.stringify(Math.max(3, 7))
---*/
assert.sameValue((JSON.stringify(Math.max(3, 7))), "7");
