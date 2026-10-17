---
'@endo/ocapn-noise': minor
---

Sessions configured with `heartbeat` and `reconnect` now survive the loss of
their transport: the dialing side redials with a fresh Noise handshake and
the session resumes, replaying each unacknowledged frame exactly once, on the
same session objects. `getLiveness()` adds `reconnect`, `reconnecting`, and
`unackedFrames`, and `lastAckedRecvNonce` may be `undefined` while the
session is between transport instances.

The new `reconnect` option takes `true` or an object with `backoffInitialMs`,
`backoffMaxMs`, and `hardTimeoutMs`, each at most 2³¹−1 ms. A session not
reconnected within `hardTimeoutMs` (default 10 minutes) aborts, and writes
fail fast near the end of that budget. A responder holds at most one
unproven resume handshake per peer, so a replayed handshake cannot fill the
inbound handshake budget.

Every handshake now exchanges an encrypted `op:session-hello` after the
identity exchange, even without heartbeats or reconnect configured, so this
version does not interoperate with peers that predate it: upgrade both ends
of a connection together.
