/*---
description: stage3b-fundamentals-followup corpus line 38 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 38.
  Source: Symbol.for("x").toString()
---*/
assert.sameValue((Symbol.for("x").toString()), "Symbol(x)");
