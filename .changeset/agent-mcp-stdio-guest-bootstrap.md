---
'@endo/agent-mcp-stdio': minor
'@endo/claude': minor
---

The confined turn now reaches its guest through a daemon-issued guest socket
rather than the root host. `@endo/agent-mcp-stdio` adds
`connectToGuestBootstrap({ sockPath })`, `issueGuestBootstrapPath(...)`, and
`resolveScopedGuest`; `startGuestBroker` keeps its contract and accepts either a
guest-scoped connection (checked to name itself by the configured formula
number) or a root-host connection (narrowed by `lookupById`).
`@endo/claude`'s `runConfinedTurn` takes an optional `guestSockPath` (and
`endo-claude-turn` a `--guest-socket` flag); without one it issues the socket
over the root daemon socket and closes that root session before the broker
starts.
