---
'@endo/hosted-agent': minor
---

The inference provider registry's owner-scoped facets now manage operations. None of these methods returns key bytes or registry-assigned secret names.

- `getOperationStatus(idempotencyKey)` on the provider directory reports a provider creation as `committed`, `in-progress` (the secret is stored and no key is needed), `key-needed` (stopped at `intent` before the secret was stored), `aborted`, or `not-found`. A client uses it after it loses a creation response.
- `listPendingOperations()` lists the owner's creations still at `intent` or `secret-created`. An operation at `intent` includes its `expiresAt`.
- `cancelOperation(idempotencyKey)` aborts a creation still at `intent` and is idempotent. A creation whose secret is already stored is refused with `operation-in-progress`, and a committed one with `operation-committed`.
- `reattach({ idempotencyKey, grantId, providerId, model? })` moves an agent's grant to another of the owner's active providers of the same kind and is idempotent. It returns the new grant, its clamped caps, and its `AgentInference` facet. The agent id is unchanged, so the guest keeps its name, mail, wake state, and conversation. From the commit onward, the prior grant admits no new turns. Replace key is a `supersede` followed by a `reattach` of each selected agent. Recovery drives an interrupted reattachment to commit, or aborts it and leaves the agent on its prior grant.
- `assertUpstreamRevoked()` on the provider admin records the owner's upstream-revocation assertion once, as `upstreamRevocationAssertedAt` on the lifecycle and in provider summaries, and adds an audit entry.
- `supersede(request, confirmed?)` on the provider admin now gates a raised cap the way `setLimits` does. A cap above the superseded provider's is refused with `limit-raise-unconfirmed` unless `confirmed` is true, and caps the request omits default to the superseded provider's rather than the registry's defaults. A replay of a committed operation needs no confirmation.
