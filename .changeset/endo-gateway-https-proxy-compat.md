---
'@endo/gateway': minor
---

`@endo/gateway` Feature 9 (Phase 10): HTTPS terminating proxy
compatibility. The gateway never terminates TLS itself; an
external reverse proxy (nginx, Caddy, ALB, etc.) terminates TLS
in front. A new `src/x-forwarded.js` module exports
`parseForwardedRequest` returning the recovered `{ callerIp,
scheme, host, trusted }` shape, plus the lower-level `parseCidr`
and `matchTrustedProxy` predicates. The parser is gated on the
configured `trustedProxyCidrs` CIDR allowlist (default empty,
fail-closed) and the `maxProxyHops` budget (default 1) so a
forged `X-Forwarded-For` from an untrusted peer is ignored.

The Git smart-HTTP handler (`src/git-http.js`) invokes the parser
when the embedder supplies a `peerAddress` on the request and
forwards the recovered `ForwardedRequest` shape to the daemon
repo capability's `infoRefs`, `gitUploadPack`, and
`gitReceivePack` calls, so a downstream daemon implementation
can key per-caller rate limits or audit logs by the original
client IP.

The gateway emits a startup warning when bound to a non-loopback
address with no trusted-proxy CIDR list:

```
[Gateway] Bound to 0.0.0.0:3469 with no trusted proxy configured.
Browser-facing endpoints transmit bearer tokens; ensure TLS
termination if this gateway is reachable from the internet.
```

The warning sink is the new optional `powers.logWarning` field,
falling back to `console.error`. The warning is informational,
not blocking; operators may suppress it by binding loopback,
configuring `trustedProxyCidrs`, or accepting it when TLS
termination is arranged some other way.

`packages/gateway/docs/https-proxy.md` documents the deployment
shape with reverse-proxy examples (nginx, Caddy, AWS ALB,
Cloudflare) and the security reasoning behind the trust gate.
