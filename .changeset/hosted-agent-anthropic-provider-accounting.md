---
'@endo/hosted-agent': minor
---

Add Anthropic provider accounting to the inference provider registry, with new `@endo/hosted-agent/anthropic-api-key-issuer.js` (Anthropic API-key grants) and `@endo/hosted-agent/inference-provider-policy.js` (request and limit validation) exports.
The registry now refuses requests that fail the Anthropic Messages request policy and enforces per-agent, per-provider, and per-owner token and dollar limits.
Upgrade note: limits now apply by default, so calls past them are refused. Each provider and owner gets 2 concurrent turns, 20 requests per minute, and $5 per day; each agent gets 1 concurrent turn, 10 requests per minute, and $2 per day (`DEFAULT_PROVIDER_LIMITS`, `DEFAULT_AGENT_LIMITS`). Raise them with `limits` at provider creation, `setLimits` on the provider admin, `setOwnerLimits` on the directory, or `setGrantLimits` on the provider use facet.
