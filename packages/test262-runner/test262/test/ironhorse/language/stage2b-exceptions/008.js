/*---
description: stage2b-exceptions corpus line 8 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage2b-exceptions.js line 8.
  Source: var r = 0; try { r = 1 } catch (e) { r = 2 } finally { r = r + 10 } r
---*/
var r = 0; try { r = 1 } catch (e) { r = 2 } finally { r = r + 10 } r
