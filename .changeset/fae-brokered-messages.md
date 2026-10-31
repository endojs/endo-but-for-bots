---
'@endo/fae': minor
---

Fae's provider owner accepts a `{ kind: 'brokered-messages', inference, model, maxTokens? }` recipe, where `inference` is an `@endo/hosted-agent` inference-provider registry grant, so Anthropic calls through `@endo/lal` need no `LAL_AUTH_TOKEN`.
