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
session per connection. It serves only the **confined allow-list**
(`confinedToolNames`, in `src/confined.js`), never the full catalog: a withheld
name is absent from `tools/list`, so the confined `claude` never sees it, and a
`tools/call` naming one is refused with the error message `tool-not-permitted`
(`error.data.reason` `name-scope`). The allow-list withholds code evaluation
(`evaluate`, `define`) and the identifier and formula-locator tools
(`identify`, `reverseIdentify`, `listIdentifiers`, `storeIdentifier`,
`locate`, `listLocators`, `reverseLocate`, `storeLocator`, `invite`, `accept`,
`followLocatorNameChanges`), which take or mint a designation and so would turn
one in the prompt into authority. Served results are not scrubbed:
`listMessages`, `followMessages`, and `followNameChanges` still disclose
locators and identifiers, which grant nothing without the withheld tools.
Being an allow-list, it also withholds any tool added to the catalog later
until that tool is named in it. Pass `allowedToolNames` to
replace it; the option is not intersected with the default, so a caller can
widen the served set as well as narrow it. Its `transport()` names the
claude-spawned half:
`src/relay.mjs`, a plain-Node byte pipe between stdio and that socket, launched
as `env -i <node> relay.mjs <socket>`. The relay never sees the daemon socket,
a daemon descriptor, or the formula id, and it starts with an **empty**
environment. Claude Code merges its own environment into a stdio server's
(endojs/endo-but-for-bots#1369 gap 2), so without `env -i` a credential in
`claude`'s environment would reach the MCP child. `@endo/claude`'s
`runConfinedTurn` composes the two.

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
- evaluation, deliberately present: `evaluate` and `define` (withheld by the
  confined broker);
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
