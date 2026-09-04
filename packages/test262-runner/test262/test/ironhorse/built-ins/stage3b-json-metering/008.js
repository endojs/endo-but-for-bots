/*---
description: stage3b-json-metering corpus line 8 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 8.
  Source: JSON.stringify({abcdefgh:1})
---*/
assert.sameValue((JSON.stringify({abcdefgh:1})), "{\"abcdefgh\":1}");
