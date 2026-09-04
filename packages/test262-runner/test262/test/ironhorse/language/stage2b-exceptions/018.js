/*---
description: stage2b-exceptions corpus line 18 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 18.
  Source: var s = 0; var i = 0; while (i < 5) { try { if (i == 2) throw i; s = s + 1 } catch (e) { s = s + 100 } i = i + 1 } s
---*/
var s = 0; var i = 0; while (i < 5) { try { if (i == 2) throw i; s = s + 1 } catch (e) { s = s + 100 } i = i + 1 } s
