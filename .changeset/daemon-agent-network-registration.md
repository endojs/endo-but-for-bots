---
'@endo/daemon': minor
---

The daemon now registers each agent's public key with the networks in that
agent's own `@nets`, and unregisters it when the agent is cancelled or the
network leaves its `@nets`. Networks opt in by implementing the optional
`registerAgentKey(publicKey, agentId)` and `unregisterAgentKey(publicKey)`
methods. The OCapN-Noise network implements them and answers
`servesAgent(publicKey)` on its peer entry point. An agent with an empty
`@nets` is registered with no network, so no network discloses it.
