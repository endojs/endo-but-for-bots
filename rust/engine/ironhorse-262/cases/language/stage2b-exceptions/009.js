/*---
description: stage2b-exceptions corpus line 9 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 9.
  Source: var r = 0; try { throw 3 } catch (e) { r = e } finally { r = r + 10 } r
---*/
var r = 0; try { throw 3 } catch (e) { r = e } finally { r = r + 10 } r
