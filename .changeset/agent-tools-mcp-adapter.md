---
'@endo/agent-tools': minor
'@endo/daemon': minor
'@endo/agent-mcp-stdio': major
---

Implement the MCP adapter at `@endo/agent-tools/adapters/mcp.js`, previously a declared stub.
`makeToolCatalog` validates a static tool declaration and fails closed with a discriminated construction error (`empty-interface`, `malformed-name`, `catalog-name-conflict`).
A caller may pass the names it reserves for its own purposes as `advisoryReservedNames`; a collision with them is reported as an advisory warning, not a construction failure.
`makeMcpToolServer` answers JSON-RPC 2.0 MCP messages against one bound target.
`tools/list` serves the static catalog.
`tools/call` rejects any name or argument outside it with `-32001 tool-not-permitted` (`data.reason` `name-scope` or `argument-scope`), reports a lost connection as `-32010 bridge-down`, and returns a target-method throw as an `isError` result.
It also exposes an MCP logging facet.
The module adds no MCP runtime dependency.

`@endo/daemon` now exports its formula-identifier helpers (`isValidNumber`, `assertValidId`, `parseId`, `formatId`, and kin) as `@endo/daemon/formula-identifier.js`, so clients validate and qualify formula identifiers against the daemon's own definition.

The new `@endo/agent-mcp-stdio` package provides the `endo-mcp-stdio` binary, a stdio MCP server that exposes exactly one Endo guest's static tool-call surface to a confined `claude -p`.
It learns which guest from `ENDO_GUEST_FORMULA_ID` at startup, never over the MCP wire, and fails closed with `invalid-formula-id` or `daemon-unreachable` before answering any frame.
Every tool call dispatches to that one guest facet, so the model reaches no authority the guest does not already hold.
