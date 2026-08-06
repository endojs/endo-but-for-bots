/*---
description: control-flow corpus line 3 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 3.
  Source: 0 ? 1 : 2
---*/
assert.sameValue((0 ? 1 : 2), 2);
