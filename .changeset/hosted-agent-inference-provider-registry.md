---
'@endo/hosted-agent': minor
---

New: `@endo/hosted-agent/inference-provider-registry.js` exports `makeInferenceProviderRegistry`, a durable, owner-scoped registry of inference providers whose keys live only in the root host's `@secrets`.
New: `@endo/hosted-agent/inference-provider-registry-module.js` is the root-private caplet that hosts the registry.
Registry records hold `@secrets` grant identifiers, which are redeemable read authority, so treat registry state as confidential.
