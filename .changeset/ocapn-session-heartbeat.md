---
'@endo/ocapn': minor
---

`@endo/ocapn` now carries the tentative `op:ping` and `op:pong`
session-liveness operations in every codec, and `makeOcapn` accepts a
`heartbeat` option.
With `heartbeat: true` (or an object tuning `intervalMs`, `timeoutMs`,
and an injectable `timer`), each session emits a heartbeat every 5 s and
aborts once the peer has been silent for 30 s, instead of waiting hours
for TCP to notice a dead peer.
The option is off by default; a session that runs no heartbeat still
accepts `op:ping` and `op:pong` from a peer that does.
