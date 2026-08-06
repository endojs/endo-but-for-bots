/*---
description: stage2b-exceptions corpus line 10 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 10.
  Source: var x = 0; try { throw 5 } catch (e) { x = e } finally { x = x + 1 } x
---*/
var x = 0; try { throw 5 } catch (e) { x = e } finally { x = x + 1 } x
