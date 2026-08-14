/*---
description: stage3b-fundamentals-followup corpus line 44 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 44.
  Source: new AggregateError([]).errors.length
---*/
assert.sameValue((new AggregateError([]).errors.length), 0);
