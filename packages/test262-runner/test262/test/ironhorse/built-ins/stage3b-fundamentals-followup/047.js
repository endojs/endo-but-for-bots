/*---
description: stage3b-fundamentals-followup corpus line 47 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 47.
  Source: new AggregateError([]) instanceof Error
---*/
assert.sameValue((new AggregateError([]) instanceof Error), true);
