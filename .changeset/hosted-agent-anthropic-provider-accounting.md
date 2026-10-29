---
'@endo/hosted-agent': minor
---

Add Anthropic provider accounting to the inference provider registry.
The new `@endo/hosted-agent/anthropic-api-key-issuer.js` export issues Anthropic API-key grants, and `@endo/hosted-agent/inference-provider-policy.js` validates inference requests and limits.
The registry now refuses requests that fail the Anthropic Messages request policy, and reserves and settles per-turn token and dollar usage against agent, provider, and owner limits.
Providers, owners, and agents receive default daily dollar budgets, concurrency, and rate caps unless configured otherwise.
Reservations left by a restart are settled as estimated, and settled turns from earlier days are pruned from the durable ledger.
`@endo/base64` and `@endo/utf8` are now runtime dependencies.
