---
'@endo/hosted-agent': minor
---

Add an agent factory for API-key guest agents (`@endo/hosted-agent/agent-factory.js`, with a daemon caplet at `agent-factory-module.js`). It offers Lal and Fae from a server-supplied catalog, creates each agent idempotently under a per-owner directory, and reconciles interrupted creation, wake, limit, reattachment, and deletion operations. Harnesses receive only the guest methods their powers profile lists (`agent-guest-powers.js`). The inference provider registry gains `listGrants`, and `InferenceProviderUse` gains `describe`, so the factory can compare a provider's owner with an agent's binding.
