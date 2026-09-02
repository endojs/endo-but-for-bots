/*---
description: control-flow corpus line 2 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 2.
  Source: 2 < 1 ? 10 : 20
---*/
assert.sameValue((2 < 1 ? 10 : 20), 20);
