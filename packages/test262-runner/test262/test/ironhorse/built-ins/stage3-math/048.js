/*---
description: stage3-math corpus line 48 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 48.
  Source: Math.acos(0.3)
---*/
var result = Math.acos(0.3);
assert.sameValue(result > 1.2661036727794988 && result < 1.2661036727794994, true);
