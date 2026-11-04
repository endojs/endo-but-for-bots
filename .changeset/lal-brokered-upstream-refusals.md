---
'@endo/lal': patch
---

The brokered Messages provider now reports a provider's authentication and rate-limit refusals as `Anthropic authentication failed` and `Anthropic rate limit reached` when they arrive as registry refusal codes.
