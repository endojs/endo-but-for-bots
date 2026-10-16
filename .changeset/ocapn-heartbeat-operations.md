---
'@endo/ocapn': minor
'@endo/ocapn-noise': minor
---

Adds the proposed `op:ping` and `op:pong` session heartbeat operations to
every OCapN codec, with `OcapnHeartbeatOperationsCodecs`,
`readOcapnHeartbeatMessage`, and `writeOcapnHeartbeatMessage` exported
from `@endo/ocapn/operations`. The operations are pending OCapN-org review
and only the OCapN-Noise network emits them; a session that receives one
treats it as liveness and nothing more.

`makeOcapnNoiseNetwork` accepts a `heartbeat` option (`HeartbeatOptions`:
`intervalMs`, `sessionTimeoutMs`). With it, each session sends `op:ping`
and `op:pong` inside the Noise channel and closes with an error once the
peer has been silent for `sessionTimeoutMs`. Every `OcapnNoiseSession`
gains a `getLiveness()` method returning a `SessionLiveness` snapshot;
implementers and mocks of that interface must add it.
