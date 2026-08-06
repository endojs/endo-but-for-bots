/*---
description: stage3b-fundamentals-followup corpus line 35 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3b-fundamentals-followup.js line 35.
  Source: Symbol.for("a")===Symbol.for("b")
---*/
assert.sameValue((Symbol.for("a")===Symbol.for("b")), false);
