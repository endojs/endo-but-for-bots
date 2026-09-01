/*---
description: stage3-json corpus line 5 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-json.js line 5.
  Source: JSON.stringify(true)
---*/
assert.sameValue((JSON.stringify(true)), "true");
