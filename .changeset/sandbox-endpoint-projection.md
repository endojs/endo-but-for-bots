---
'@endo/exo-http-client': minor
'@endo/http-confine': minor
'@endo/daemon': minor
'@endo/agentry': minor
---

Project a single daemon-side endpoint into a `network: 'none'` sandbox slice,
and stream request bodies through the HTTP client.

`SandboxHandle.projectEndpoint(dialer)` makes exactly one daemon-side endpoint
reachable from inside a slice whose network posture is otherwise `none`, as a
real loopback TCP endpoint in the slice's own network namespace. Nothing else
becomes reachable: no other host loopback port and no egress. The target is
named by a dialer capability rather than by an address, the projection is
per-slice mintable and per-operation revocable, and every misconfiguration is a
hard error rather than an upgrade to a wider network profile.

`@endo/exo-http-client` accepts a bytes reader as a request body and streams it
in fixed-size frames, bounded by a new `maxRequestBytes` policy field. Unlike a
response, an over-limit request body fails closed rather than being truncated.

`@endo/daemon` serves the projection's Unix socket through the same listener
lifecycle its own private path uses, and exports its HTTP-client policy
validator at `@endo/daemon/http-client-policy.js`.

`EndoProvisionSpec` gains an `http` root field, so a code-mode session can be
granted a confined `HttpClient` — origin allowlist, rate and byte bounds —
through the normal provisioning path, surfaced as a proper code-mode global
rather than an opaque grant. Validation is delegated to the daemon's own
`normalizeHttpClientPolicy`.
