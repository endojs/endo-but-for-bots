---
'@endo/ocapn': minor
---

Add the proposed `op:ping` and `op:pong` operations to every OCapN codec
(Syrup and CBOR), and an opt-in, experimental session heartbeat. With
`makeOcapn({ heartbeat: { intervalMs, timeoutMs } })`, each session emits
`op:ping` and `op:pong` every `intervalMs` and aborts when the peer sends no
traffic for `timeoutMs`, so an idle session to an unreachable peer is detected
as lost in seconds rather than after TCP's hours-long keepalive. Both peers must
understand the proposed operations, which are pending OCapN-org review. This is
phase 1 of `designs/ocapn-noise-session-reconnect.md`; reconnection comes later.
