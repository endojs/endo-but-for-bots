/*---
description: stage3-json corpus line 14 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-json.js line 14.
  Source: JSON.stringify("plain text 123")
---*/
assert.sameValue((JSON.stringify("plain text 123")), "\"plain text 123\"");
