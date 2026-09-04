/*---
description: stage3b-fundamentals-followup corpus line 31 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 31.
  Source: String(Symbol("y"))
---*/
assert.sameValue((String(Symbol("y"))), "Symbol(y)");
