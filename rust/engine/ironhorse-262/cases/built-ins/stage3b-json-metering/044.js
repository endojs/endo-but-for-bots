/*---
description: stage3b-json-metering corpus line 44 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 44.
  Source: JSON.parse("\"tab\\tnl\\nq\\\"\"")
---*/
assert.sameValue((JSON.parse("\"tab\\tnl\\nq\\\"\"")), "tab\tnl\nq\"");
