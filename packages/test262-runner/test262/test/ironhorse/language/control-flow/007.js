/*---
description: control-flow corpus line 7 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 7.
  Source: (1 && 2) ? 100 : 200
---*/
assert.sameValue(((1 && 2) ? 100 : 200), 100);
