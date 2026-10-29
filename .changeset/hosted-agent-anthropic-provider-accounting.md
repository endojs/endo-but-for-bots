---
'@endo/hosted-agent': minor
---

Add Anthropic provider accounting to the inference provider registry, with new `@endo/hosted-agent/anthropic-api-key-issuer.js` (Anthropic API-key grants) and `@endo/hosted-agent/inference-provider-policy.js` (request and limit validation) exports.
The registry now refuses requests that fail the Anthropic Messages request policy and enforces per-agent, per-provider, and per-owner token and dollar limits.
`INFERENCE_PATHS` now includes `/v1/messages/count_tokens`.
The registry module's `make` env accepts `discoverModels` and `modelPrices`, and the `INFERENCE_PROVIDER_MODEL_PRICES` environment variable supplies per-model prices as JSON.
`@endo/base64` and `@endo/utf8` are now runtime dependencies.
This is a `minor` bump because `@endo/hosted-agent` is pre-1.0 (`0.0.0`) and the inference provider registry is experimental; the breaking changes below are called out instead of reserved for a major release.
Upgrade note: limits now apply by default, including to existing providers, owners, and grants restored from persisted state, so calls past them are refused (`DEFAULT_PROVIDER_LIMITS`, `DEFAULT_AGENT_LIMITS`). Raising a limit through `setLimits`, `setOwnerLimits`, or `setGrantLimits` is refused with `limit-raise-unconfirmed` unless the final `confirmed` argument is `true`.
Requests to `/v1/messages` must now name the granted `model`, give a positive integer `max_tokens` within the grant's `maxOutputTokens`, and use only allowlisted body fields and no credential headers; anything else, including the bare `{}` body the registry used to forward, is refused with `inference-request-refused`. The registry forwards its own serialization of the validated body.
A model with no `INFERENCE_PROVIDER_MODEL_PRICES` entry cannot pass the default dollar budget, so give such a provider or owner a `dailyTokens` budget instead. An upstream 404 for the granted model is reported as `model-not-available`.
