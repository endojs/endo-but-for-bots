/*---
description: stage3b-fundamentals-followup corpus line 50 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 50.
  Source: AggregateError([], "x").message
---*/
assert.sameValue((AggregateError([], "x").message), "x");
