/*---
description: stage3b-fundamentals-followup corpus line 34 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 34.
  Source: Symbol.for("k")===Symbol.for("k")
---*/
assert.sameValue((Symbol.for("k")===Symbol.for("k")), true);
