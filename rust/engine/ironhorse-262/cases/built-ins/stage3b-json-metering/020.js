/*---
description: stage3b-json-metering corpus line 20 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 20.
  Source: JSON.stringify({a:[]})
---*/
assert.sameValue((JSON.stringify({a:[]})), "{\"a\":[]}");
