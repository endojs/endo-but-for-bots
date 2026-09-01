/*---
description: stage2b-exceptions corpus line 16 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 16.
  Source: var o = { a: 1 }; try { throw o.a } catch (e) { e + 1 }
---*/
var o = { a: 1 }; try { throw o.a } catch (e) { e + 1 }
