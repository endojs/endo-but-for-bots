---
'@endo/lal': minor
'@endo/fae': minor
'@endo/floot': minor
---

Context compaction is now configurable. `@endo/lal/providers/index.js` exports
`defaultContextCompactionSettings` and a `ContextCompactionSettings` type
alongside `planContextCompaction`, which accepts `enabled`, `reserveTokens`,
`keepRecentTokens`, and `customInstructions`. Fae and Floot read these from the
`FAE_COMPACTION_*` and `FLOOT_COMPACTION_*` variables.

The default automatic threshold changes from 70% of the window to the window
minus a 16,384-token reserve (capped at 30% of the window), and compaction now
fires only strictly above that threshold. Automatic compaction still never runs
when the window size is unknown.
