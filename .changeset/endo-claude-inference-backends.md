---
'@endo/claude': minor
---

Add `makeClaudeCliBackend` and `makeClaudeSdkBackend`, two `InferenceBackend` plugins over `@endo/inference`, each made over one `CredentialSource`.
The CLI backend runs one confined `claude -p` per turn and reaches the guest through a stdio MCP server; the Agent SDK backend hands the guest's MCP server to an injected SDK `query` in process.
Each turn first checks the binary's version against the pinned version and fails closed as `unavailable` on a mismatch, and either backend takes an optional `maxBudgetUsd` ceiling (`--max-budget-usd` for the CLI).
The wall clock and cancellation bound every wait in a turn, so a binary, credential source, guest, or SDK that never answers cannot hold it open, and a failure detail names an error by its code or class, never by a message that may quote the credential.
They share new subpath modules for the confinement options, the constructed environment, the per-turn scratch directory, the stream-json reducer, and the Claude Code response-shape table, which ships empty so that no failure is reported as `needs-auth` before its shape is captured.
