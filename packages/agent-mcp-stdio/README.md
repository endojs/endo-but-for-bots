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
