---
'@endo/gateway': minor
---

Implement `@endo/gateway` Feature 2 (virtual hosting) Phase 1: the
content-tree resolution and static-serving path on top of the `AppsNameHub`
routing skeleton. A new `WebletFormula` type (`type`, `contentRoot`,
optional `mimeTypes`, `ssrHandler`, `virtualHosts`) and a
powers-injected `GatewayContentResolver` (`resolveWebletFormula`,
`fetchContentTree`) let `makeWebletResolver({ apps, content })` resolve an
inbound `(Host, path)` request through the `@apps` table to a weblet
formula, resolve the request path (defaulting to `index.html`) against the
formula's content-addressed `readable-tree` `contentRoot`, and serve the
bytes with `mimeTypes` overrides applied and otherwise inferred. A CAS
read-through cache keyed by the content-address root fetches each content
tree at most once. `makeGateway` exposes the resolver via
`getWebletResolver()` when `powers.content` is supplied. The path is
daemon-free and unit-tested against an in-memory fake (hit, cache populate,
MIME override vs. inference, unknown-Host 404, missing-file and directory
404, traversal 404, and the SSR seam). The SSR dynamic-fallback handler
(`ssrHandler` → `UserDaemon.handleHttp`, Feature 4 / Phase 2), the
`/ocapn-cbor-np` subprotocol (Feature 8), and wiring the daemon's `@apps`
formula to import `@endo/gateway` are left as named follow-on seams: a
static miss on an SSR-capable weblet returns a `501 ssr-not-wired` result
rather than forwarding.
