/*---
description: stage3-fundamentals corpus line 57 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-fundamentals.js line 57.
  Source: function P(x) { this.x = x }; function mk() { return new P(9).x }; mk()
---*/
function P(x) { this.x = x }; function mk() { return new P(9).x }; mk()
