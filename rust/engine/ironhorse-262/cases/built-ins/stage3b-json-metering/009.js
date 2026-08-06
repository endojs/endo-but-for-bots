/*---
description: stage3b-json-metering corpus line 9 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 9.
  Source: JSON.stringify({abcdefghijklmnop:1})
---*/
assert.sameValue((JSON.stringify({abcdefghijklmnop:1})), "{\"abcdefghijklmnop\":1}");
