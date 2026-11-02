---
'@endo/daemon': minor
---

The daemon now registers each agent's public key with the networks in that
agent's own `@nets`, and unregisters it when the agent is cancelled or the
network leaves its `@nets`. Networks opt in by implementing the optional
`registerAgentKey(publicKey)` and `unregisterAgentKey(publicKey)` methods,
which the OCapN-Noise network implements. An agent with an empty `@nets` is
registered with no network.
