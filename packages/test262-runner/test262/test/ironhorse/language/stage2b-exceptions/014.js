/*---
description: stage2b-exceptions corpus line 14 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 14.
  Source: function f() { throw 1 } function g() { f() } try { g() } catch (e) { e + 5 }
---*/
function f() { throw 1 } function g() { f() } try { g() } catch (e) { e + 5 }
