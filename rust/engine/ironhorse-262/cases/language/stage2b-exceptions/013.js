/*---
description: stage2b-exceptions corpus line 13 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 13.
  Source: function f(x) { if (x < 0) throw x; return x } try { f(-3) } catch (e) { -e }
---*/
function f(x) { if (x < 0) throw x; return x } try { f(-3) } catch (e) { -e }
