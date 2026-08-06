/*---
description: stage3b-fundamentals-followup corpus line 52 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 52.
  Source: new AggregateError([], "boom").name
---*/
assert.sameValue((new AggregateError([], "boom").name), "AggregateError");
