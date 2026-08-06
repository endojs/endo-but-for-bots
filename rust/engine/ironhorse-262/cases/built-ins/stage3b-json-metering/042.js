/*---
description: stage3b-json-metering corpus line 42 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 42.
  Source: JSON.parse("\"hello\"")
---*/
assert.sameValue((JSON.parse("\"hello\"")), "hello");
