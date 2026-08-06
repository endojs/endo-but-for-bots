/*---
description: stage3b-json-metering corpus line 28 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 28.
  Source: JSON.stringify({nested:{deep:{arr:[1,2,{k:"v"}]}}})
---*/
assert.sameValue((JSON.stringify({nested:{deep:{arr:[1,2,{k:"v"}]}}})), "{\"nested\":{\"deep\":{\"arr\":[1,2,{\"k\":\"v\"}]}}}");
