---
'@endo/daemon': minor
---

Enforce the gateway's remote-access policy and add a Docker self-hosting image.

The WebSocket gateway now applies the address checker documented in
`packages/daemon/README.md` § Remote access: by default only localhost
connections are admitted, and every other client IP is closed with `"Only local
connections allowed"`. Set `ENDO_GATEWAY=remote` to admit any reachable client
(authenticated by the CapTP bearer token) or `ENDO_GATEWAY_ALLOWED_CIDRS` to
admit specific ranges in addition to localhost. Remote mode logs a startup
warning that TLS termination is required. Previously `cidr.js`'s
`makeAddressChecker` was implemented and tested but never wired into the
gateway, so the gateway admitted all connections regardless of these settings.

A new `docker/` directory ships a two-stage image that bundles the daemon, its
worker, and the CLI, runs the daemon in the foreground with its state directory
on a persisted volume, exposes the gateway on `0.0.0.0:8920`, and enables remote
authentication for self-hosted deployments behind a TLS-terminating reverse
proxy.
