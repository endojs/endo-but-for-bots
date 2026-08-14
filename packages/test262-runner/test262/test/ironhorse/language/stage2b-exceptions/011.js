/*---
description: stage2b-exceptions corpus line 11 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 11.
  Source: var s = 0; try { s = 1; throw 9 } catch (e) { s = s + e } finally { s = s + 100 } s
---*/
var s = 0; try { s = 1; throw 9 } catch (e) { s = s + e } finally { s = s + 100 } s
