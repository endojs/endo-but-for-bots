/*---
description: stage3b-json-metering corpus line 30 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-json-metering.js line 30.
  Source: JSON.stringify(["line\nbreak","ret\rurn"])
---*/
assert.sameValue((JSON.stringify(["line\nbreak","ret\rurn"])), "[\"line\\nbreak\",\"ret\\rurn\"]");
