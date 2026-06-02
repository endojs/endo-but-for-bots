---
'@endo/gateway': minor
---

Phase 2 of `@endo/gateway` (per `designs/gateway-package.md`):
Feature 4 (UDS bootstrap for local CapTP relay registration). Adds
the `GatewayBootstrap` exo with `challenge`, `register`,
`registerRelay`, `getBindAddress`, and `getApps`; the
`Registration` handle with `publishWeblet`, `unpublishWeblet`,
`addPublicKey`, `deregister`, `listWeblets`, and `listPublicKeys`;
a domain-separated proof-of-possession nonce registry with
30-second TTL and single-use semantics; a Node-backed
`CryptoPowers` adapter; and a UDS / named-pipe path resolver
covering `/run/endo-gateway/bootstrap.sock` (system service),
`${XDG_RUNTIME_DIR}/endo-gateway/...` (user Linux), the macOS
`Library/Application Support` variant, the Windows named-pipe
`\\.\pipe\endo-gateway`, the `${TMPDIR}/...` fallback, and an
`ENDO_GATEWAY_BOOTSTRAP_SOCK` operator override. Byte-shaped wire
fields (public keys, signatures, nonces) cross the exo boundary
as immutable `ArrayBuffer` per the `@endo/bytes` convention. The
actual UDS / named-pipe listener that serves the bootstrap to
incoming CapTP connections is deferred to a follow-on PR.
