---
'@endo/ocapn': minor
'@endo/ocapn-noise': minor
---

Adds the proposed `op:ping` and `op:pong` session heartbeat operations to
every OCapN codec, exported from `@endo/ocapn/operations`. OCapN sessions
ignore them; the OCapN-Noise network uses them for liveness.

`makeOcapnNoiseNetwork` accepts an opt-in `heartbeat` option, described in
the `@endo/ocapn-noise` README. `OcapnNoiseSession` gains a required
`getLiveness()` method, so implementers and mocks must add it.
