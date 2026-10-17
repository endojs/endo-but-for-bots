---
'@endo/ocapn': minor
---

Adds the proposed `op:ping` and `op:pong` session heartbeat operations to
every OCapN codec, with `readOcapnHeartbeatMessage` and
`writeOcapnHeartbeatMessage` exported from `@endo/ocapn/operations`. The
operations are pending OCapN-org review and only the OCapN-Noise network
emits them; a session that receives one treats it as liveness and nothing
more.
