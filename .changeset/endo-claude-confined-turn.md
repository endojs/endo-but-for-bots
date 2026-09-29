---
'@endo/claude': minor
---

Add the confined shape of the guest stdio MCP server
(`designs/endo-guest-stdio-mcp.md`). `runConfinedTurn({ formulaId, credential,
prompt, model, claudePath })` and the `endo-claude-turn` bin run one confined
`claude -p --bare` turn against one guest's tools. The daemon connection is
held in the harness process by `@endo/agent-mcp-stdio`'s new
`startGuestBroker`, and the confined side gets only a guest-pinned broker socket
and a relay started under `env -i`. Credentials in `claude`'s environment
therefore never reach the MCP child. The launch seam now requests and parses the
`stream-json` transcript.
