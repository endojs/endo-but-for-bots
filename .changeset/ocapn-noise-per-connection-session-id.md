---
'@endo/ocapn': minor
'@endo/ocapn-noise': minor
---

The `np` netlayer now binds each session's `sessionId` to the Noise
handshake hash, so every connection between the same two peers gets a
fresh id. Previously the id was derived from the two long-term keys
alone, while handoff replay state (`nextHandoffCount`,
`usedGiftHandoffs`) lived for one connection, so a `HandoffReceive`
signed in an earlier connection could pass the duplicate check in a
later one. `makeSessionId` accepts an optional third `channelBinding`
argument for this; omitting it keeps the previous derivation.
