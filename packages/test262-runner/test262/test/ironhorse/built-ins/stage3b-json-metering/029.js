/*---
description: stage3b-json-metering corpus line 29 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 29.
  Source: JSON.stringify({s:"a\"b",t:"tab\there"})
---*/
assert.sameValue((JSON.stringify({s:"a\"b",t:"tab\there"})), "{\"s\":\"a\\\"b\",\"t\":\"tab\\there\"}");
