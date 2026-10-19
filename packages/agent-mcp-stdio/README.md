# @endo/agent-mcp-stdio

A stdio MCP server that exposes exactly one Endo guest's tool-call surface to a
confined `claude -p`. Specification:
[designs/endo-guest-stdio-mcp.md](../../designs/endo-guest-stdio-mcp.md).

`claude` spawns the `endo-mcp-stdio` command named in its `--mcp-config`. The
server reads the guest's formula id from `ENDO_GUEST_FORMULA_ID` (never from the
MCP wire), opens a session with the ordinary Endo daemon client (honoring
`ENDO_SOCK`), resolves that one guest at the root host with `lookupById`, and
serves every `tools/list` / `tools/call` against that guest and no other.

```json
{
  "mcpServers": {
    "endo": {
      "command": "endo-mcp-stdio",
      "args": [],
      "env": { "ENDO_GUEST_FORMULA_ID": "<64-hex>" }
    }
  }
}
```

The formula id may be the bare 64-hex formula number (qualified with the local
node) or a full `<number>:<node>` identifier.

## Topologies

This command is the **single-tenant** shape: the claude-spawned process holds
the daemon connection. It does not provide structural cross-guest isolation and
must not be used where the sandbox confines `claude` against the daemon socket.
In the **confined** shape a harness-owned process outside the slice holds the
connection and binds the resolved facet with `makeGuestMcpServer`.

`startGuestBroker({ connection, formulaId, version })` is that harness-owned
process's half. Over a daemon connection the caller already holds, it resolves
the one guest, then serves the static catalog as newline-delimited JSON-RPC on
a `0600` Unix socket in a `0700` per-inference directory, with a fresh MCP
session per connection. Its `transport()` names the claude-spawned half:
`src/relay.mjs`, a plain-Node byte pipe between stdio and that socket, launched
as `env -i <node> relay.mjs <socket>`. The relay never sees the daemon socket,
a daemon descriptor, or the formula id, and it starts with an **empty**
environment. Claude Code merges its own environment into a stdio server's
(endojs/endo-but-for-bots#1369 gap 2), so without `env -i` a credential in
`claude`'s environment would reach the MCP child. `@endo/claude`'s
`runConfinedTurn` composes the two.

## Streamable HTTP (`endo-mcp-http`)

`endo-mcp-http` is the multi-tenant shape, the Model Context Protocol
termination of [designs/endo-gateway-mcp.md](../../designs/endo-gateway-mcp.md).
It holds one daemon connection and serves `POST /mcp` for every guest reachable
from the root host, selecting the guest per request by its bearer:

```json
{
  "mcpServers": {
    "<agent-pet-name>": {
      "url": "https://<gateway-host>/mcp",
      "headers": { "Authorization": "Bearer <64-hex formula id>" }
    }
  }
}
```

The bearer is the guest's formula id, in the same forms
`ENDO_GUEST_FORMULA_ID` accepts. Knowledge of it is the authorization: treat it
like an SSH key. The bearer resolves through `resolveGuest`, so a formula that
is not a guest facet (a host in particular) is refused exactly as an unknown
one, with `401`. Failed authentications advance a rate limiter of the
listener's own, made by the daemon gateway's `makeRateLimiter`
(`@endo/daemon/rate-limiter.js`) but not shared with it. Each failure delays
that client's next attempt by one second, and a limited client gets `429` with
`Retry-After`, even with a good bearer.

The limiter keys on the socket's peer address. Behind a reverse proxy that is
the proxy's address, so one failing client would hold back every client of the
proxy. When every request arrives through a proxy that appends the client to
`X-Forwarded-For`, set `ENDO_MCP_HTTP_TRUST_PROXY=1` to key on that header's
last entry instead. Do not set it when clients can reach the listener directly,
since they could then name any address they like.

The transport is stateless. Each `POST` carries one JSON-RPC message, and no
`Mcp-Session-Id` is issued. The replies are:

- `200` with an `application/json` JSON-RPC reply, including a JSON-RPC error
  for a well-formed request;
- `202` with no body for a notification or a response;
- `400` with a JSON-RPC error for a body that does not parse or is not a
  request;
- `401` for a missing, malformed, or unknown bearer;
- `403` for a request whose `Origin` is not listed in
  `ENDO_MCP_HTTP_ALLOWED_ORIGINS` (a request with no `Origin` is accepted);
- `404` for any path but `/mcp`;
- `405` for any method but `POST`, `GET` included;
- `413` with `Connection: close` for a body over 4 MiB;
- `415` for a `Content-Type` other than `application/json`;
- `429` with `Retry-After` for a rate-limited client.

To run it, start the daemon (`endo start`), then run `endo-mcp-http` as the
same user. It finds the daemon the way `endo` does, honoring `ENDO_SOCK`, and
exits `1` when it cannot connect or when the daemon connection drops. It
listens on `ENDO_MCP_HTTP_HOST` (default `127.0.0.1`) and `ENDO_MCP_HTTP_PORT`
(default `8921`), and stops on `SIGINT` or `SIGTERM`. The listener speaks
plaintext HTTP. Put a TLS-terminating reverse proxy in front of it before
exposing it beyond loopback. `makeMcpHttpHandler` is the same route as a
`(request, response) => Promise<boolean>` handler, for mounting beside other
routes.

## Tool catalog

The catalog is static: `makeAgentTools()` in `src/agent-interface.js` declares
it, and each server gets its own copy (with its own follower table). The tool
families are:

- names: `help`, `has`, `list`, `remove`, `move`, `copy`, `identify`,
  `reverseIdentify`, `listIdentifiers`, `storeIdentifier`;
- locators: `locate`, `listLocators`, `reverseLocate`, `storeLocator` (adopt a
  locator under a pet name), the content-locator family (`locateContent`,
  `listContent`, `storeContent`, `reverseLocateContent`,
  `internalizeContentLocator`, `loadContent`), `invite`, and `accept`;
- files: `makeDirectory`, `makePath` (creates only the missing intermediate
  directories), `readText`, `maybeReadText`, `writeText`, `storeValue`;
- search over a mount the guest holds: `glob`, `grep`, `glorp`;
- evaluation, deliberately present: `evaluate` and `define`;
- mail: `listMessages`, `send`, `reply`, `editMessage`, `messageHistory`,
  `adopt`, `dismiss`, `dismissAll`, `request`, `resolve`, `reject`,
  `sendValue`, `form`, `submit`;
- following: `followMessages`, `followNameChanges`,
  `followLocatorNameChanges`, and `followStream` (a reader stored under a pet
  name) each return a follower handle. MCP calls are request/response, so
  `readFollower` pulls at most `maxItems` items, waiting at most
  `waitMilliseconds` in all, and `closeFollower` releases the handle.

The harness renders the same declaration into `--allowedTools` with
`renderGuestAllowedTools()` (`mcp__endo__<tool>`) and the config entry with
`makeMcpConfig({ formulaId })`.

## Failure shapes

Construction failures are written to stderr as one JSON record, and the process
exits with status 1 before answering `initialize`:

```json
{ "reason": "invalid-formula-id", "level": "error", "message": "..." }
```

The reasons are `invalid-formula-id`, `daemon-unreachable`, `empty-interface`,
`malformed-name`, and `catalog-name-conflict`. At request time, a name or an
argument outside the catalog is `-32001 tool-not-permitted`, a lost daemon
connection is `-32010 bridge-down`, and a guest method that throws is a
successful `tools/call` result with `isError: true`.

## Harness signals

`parseClaudeStreamJson(stdout)` parses the `--output-format stream-json
--verbose` output of one `claude -p` run into a tagged outcome (`ok`,
`rate-limited`, `policy-refusal`, `api-error`, `unavailable`, `error`, or
`parse-error`) with usage fields and the last `rate_limit_event` quota record.
