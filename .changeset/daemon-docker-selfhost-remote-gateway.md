---
'@endo/daemon': minor
---

Gate the daemon's WebSocket gateway by remote address so a self-hosted
container can bind the gateway to a public interface without exposing it to
every caller. The gateway now admits only localhost by default, even when bound
to `0.0.0.0`, and an operator opts in to remote access with two environment
variables read at daemon start:

- `ENDO_GATEWAY_REMOTE=true` (or `1`) admits every remote address.
- `ENDO_GATEWAY_ALLOWED_CIDRS` admits localhost plus a comma-separated CIDR
  allowlist.

Bearer-token authentication (`fetch(token)`) is unchanged and applies
independently of this address gate. This is the daemon-side half of the
`daemon-docker-selfhost` design; the accompanying `docker/` image binds
`ENDO_ADDR=0.0.0.0:8920` and publishes the port.
