/*---
description: stage3b-fundamentals-followup corpus line 43 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 43.
  Source: new AggregateError([], "oops").message
---*/
assert.sameValue((new AggregateError([], "oops").message), "oops");
