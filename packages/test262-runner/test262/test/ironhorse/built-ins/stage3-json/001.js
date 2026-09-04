/*---
description: stage3-json corpus line 1 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-json.js line 1.
  Source: JSON.stringify(42)
---*/
assert.sameValue((JSON.stringify(42)), "42");
