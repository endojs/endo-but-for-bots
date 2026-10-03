---
'@endo/agent-mcp-stdio': minor
'@endo/claude': minor
---

The confined turn now reaches its guest through a daemon-issued guest socket rather than the root host.
`@endo/agent-mcp-stdio` adds `connectToGuestBootstrap({ socketPath })`, `issueGuestBootstrapPath(...)`, and `resolveScopedGuest`; `startGuestBroker` keeps its contract and accepts either a guest-scoped connection (checked to name itself by the configured formula number) or a root-host connection (narrowed by `lookupById`).
`@endo/claude`'s `runConfinedTurn` takes an optional `guestSocketPath` (and `endo-claude-turn` a `--guest-socket` flag); without one it issues the socket over the root daemon socket and closes that root session before the broker starts.
`@endo/claude` also exports `makeGuestConnect`, the default harness connection.
Without a guest socket path, the turn falls back to the root connection, which holds full host authority, only when the daemon serves no guest sockets.
`issueGuestBootstrapPath` then resolves to `undefined`: either the daemon's bootstrap lacks `guestBootstrapPath` in its `__getMethodNames__()` (it predates this change) or the daemon answers `undefined` (it serves no Unix sockets).
Any other failure is reported, never answered with the root connection.
