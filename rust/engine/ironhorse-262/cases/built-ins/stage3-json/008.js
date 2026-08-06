/*---
description: stage3-json corpus line 8 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-json.js line 8.
  Source: JSON.stringify("hi")
---*/
assert.sameValue((JSON.stringify("hi")), "\"hi\"");
