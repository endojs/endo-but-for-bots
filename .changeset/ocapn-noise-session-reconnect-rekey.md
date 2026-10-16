---
'@endo/ocapn': minor
---

Adds the proposed `op:session-hello` and `op:session-end` session-control
records, exported from `@endo/ocapn/operations` as
`readOcapnSessionControlMessage` and `writeOcapnSessionControlMessage`. The
OCapN-Noise network exchanges them to negotiate session features and to
reconnect a session on a fresh transport instance
(`designs/ocapn-noise-session-reconnect.md`). They are pending OCapN-org
review, and the network consumes them; they never reach a CapTP session.
