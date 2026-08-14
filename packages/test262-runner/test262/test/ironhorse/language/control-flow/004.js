/*---
description: control-flow corpus line 4 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 4.
  Source: 1 ? 1 : 2
---*/
assert.sameValue((1 ? 1 : 2), 1);
