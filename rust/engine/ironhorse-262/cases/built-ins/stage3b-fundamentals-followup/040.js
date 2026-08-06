/*---
description: stage3b-fundamentals-followup corpus line 40 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 40.
  Source: String(Symbol.for("k"))
---*/
assert.sameValue((String(Symbol.for("k"))), "Symbol(k)");
