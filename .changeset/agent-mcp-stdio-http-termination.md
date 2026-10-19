---
'@endo/agent-mcp-stdio': minor
'@endo/daemon': minor
---

`@endo/agent-mcp-stdio` adds `endo-mcp-http`, the streamable-HTTP Model
Context Protocol termination of `designs/endo-gateway-mcp.md`. One listener
holds one daemon session and serves `POST /mcp` for every guest reachable from
the root host, selecting the guest per request by an
`Authorization: Bearer <formula id>` header. The transport is stateless. A
bearer that names no guest gets `401`, and failed authentications are rate
limited per client (`ENDO_MCP_HTTP_TRUST_PROXY=1` keys the limiter on the last
`X-Forwarded-For` entry behind a reverse proxy). The package also exports
`makeMcpHttpHandler`, `startMcpHttpGateway`, and `mainHttp`.

`@endo/daemon` exports its per-key rate limiter as
`@endo/daemon/rate-limiter.js` (`makeRateLimiter`), which the WebSocket gateway
and `endo-mcp-http` both use.
