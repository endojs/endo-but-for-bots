/*---
description: stage3b-fundamentals-followup corpus line 36 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 36.
  Source: Symbol.keyFor(Symbol.for("registered"))
---*/
assert.sameValue((Symbol.keyFor(Symbol.for("registered"))), "registered");
