/*---
description: control-flow corpus line 13 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 13.
  Source: (1 < 2 && 2 < 3) ? 42 : 0
---*/
assert.sameValue(((1 < 2 && 2 < 3) ? 42 : 0), 42);
