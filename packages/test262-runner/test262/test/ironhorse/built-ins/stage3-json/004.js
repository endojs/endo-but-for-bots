/*---
description: stage3-json corpus line 4 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-json.js line 4.
  Source: JSON.stringify(3.14)
---*/
assert.sameValue((JSON.stringify(3.14)), "3.14");
