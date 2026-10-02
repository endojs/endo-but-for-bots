---
'@endo/claude': minor
---

Add `makeClaudeCliBackend` and `makeClaudeSdkBackend`, two `InferenceBackend` plugins over `@endo/inference`, each made over one `CredentialSource`.
The CLI backend runs one confined `claude -p` per turn and reaches the guest through a stdio MCP server; the Agent SDK backend hands the guest's MCP server to an injected SDK `query` in process.
They share new subpath modules for the confinement options, the constructed environment, the stream-json reducer, and the Claude Code response-shape table, which ships empty so that no failure is reported as `needs-auth` before its shape is captured.
