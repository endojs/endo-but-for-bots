/*---
description: control-flow corpus line 1 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/control-flow.js line 1.
  Source: 1 < 2 ? 10 : 20
---*/
assert.sameValue((1 < 2 ? 10 : 20), 10);
