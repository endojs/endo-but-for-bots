/*---
description: stage4-generators corpus line 11 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-generators.js line 11.
  Source: function* g(){ yield 10; yield 20; } var r=[]; for (var v of g()) r.push(v); r.join(",");
---*/
function* g(){ yield 10; yield 20; } var r=[]; for (var v of g()) r.push(v); r.join(",");
