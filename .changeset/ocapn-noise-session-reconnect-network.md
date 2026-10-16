---
'@endo/ocapn-noise': minor
---

Sessions configured with `heartbeat` and `reconnect` now survive the loss of
their transport: the dialing side redials with a fresh Noise handshake and
the session resumes, replaying each unacknowledged frame exactly once, on the
same session objects. `getLiveness()` adds `reconnect`, `reconnecting`, and
`unackedFrames`, and `lastAckedRecvNonce` may be `undefined` while the
session is between transport instances.

Every handshake now exchanges an encrypted `op:session-hello` after the
identity exchange, even without heartbeats or reconnect configured, so this
version does not interoperate with peers that predate it.
