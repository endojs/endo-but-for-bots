---
'@endo/hosted-agent': minor
---

New: Anthropic provider accounting in the inference provider registry. The `@endo/hosted-agent/anthropic-api-key-issuer.js` export grants Anthropic API keys, and `@endo/hosted-agent/inference-provider-policy.js` exports the request and limit validation. The registry enforces per-agent, per-provider, and per-owner token and dollar limits, and the `INFERENCE_PROVIDER_MODEL_PRICES` environment variable of its module entry point supplies per-model prices as JSON. `INFERENCE_PATHS` now includes `/v1/messages/count_tokens`. An upstream 404 for the granted model is reported as `model-not-available`.

Breaking (pre-1.0) migration:

1. Default limits now apply to every provider, owner, and grant, including those restored from persisted state, so calls past them are refused (`DEFAULT_PROVIDER_LIMITS`, `DEFAULT_AGENT_LIMITS`, `DEFAULT_OWNER_INFERENCE_LIMITS`).
2. Raising a limit through `setLimits`, `setOwnerLimits`, or `setGrantLimits` is refused with `limit-raise-unconfirmed` unless the final `confirmed` argument is `true`.
3. Requests to `/v1/messages` must name the granted `model`, give a positive integer `max_tokens` within the grant's `maxOutputTokens`, and use only allowlisted body fields and no credential headers. Anything else, including the bare `{}` body the registry used to forward, is refused with `inference-request-refused`. The registry forwards its own serialization of the validated body.
4. A model with no `INFERENCE_PROVIDER_MODEL_PRICES` entry is refused with `unpriced-model` by every scope that budgets in dollars. To use one, give both the provider and the owner a `dailyTokens` budget; an agent on that provider then inherits the provider's token budget.
