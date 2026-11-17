---
'@endo/ocapn-noise': minor
'@endo/daemon': minor
---

`makeTcpTransport` accepts an `advertiseHost` option that replaces the bound
address in the listener's hints. The daemon's OCapN network reads an optional
`ocapn-advertise-addr` pet name (`host` or `host:port`) and advertises that
host in its connection-hint address, so a daemon that binds `0.0.0.0` hands out
locators and invitations that peers can dial. The port is always the bound
port; a stored port that differs from `ocapn-listen-addr` is rejected.
