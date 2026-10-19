---
'@endo/ocapn': patch
---

Each OCapN session now sends through a session-level outbound queue that
also tracks the session epoch (Phase 2 of the session-reconnect design).
The queue is transparent while the transport writes synchronously; when
a transport's `write` returns a pending promise, later operations wait
behind it in order and drain when it settles. The heartbeat's `op:ping`
and `op:pong` epoch now comes from the session.
