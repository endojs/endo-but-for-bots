/*---
description: stage3b-json-metering corpus line 31 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 31.
  Source: JSON.stringify({sum:1+2,txt:"a".concat("b")})
---*/
assert.sameValue((JSON.stringify({sum:1+2,txt:"a".concat("b")})), "{\"sum\":3,\"txt\":\"ab\"}");
