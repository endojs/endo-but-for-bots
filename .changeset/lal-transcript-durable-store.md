---
'@endo/lal': minor
---

Extract the transcript-node store from the agent into a dedicated `transcript-store.js` module that durably persists every node under `transcript-<messageId>` in the agent's pet store. The store survives both inbox-message dismissal and a cold restart: a fresh `makeTranscriptStore(powers)` resolves nodes that an earlier instance committed. Adds `walkParents` and `assembleTranscriptStrict` so callers can report broken chains instead of silently truncating. First phase of the lal-transcript-memory-management design.
