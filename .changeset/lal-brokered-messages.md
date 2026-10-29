---
'@endo/lal': minor
---

Lal can now call Anthropic through a brokered provider stream (`@endo/lal/providers/brokered-messages.js`), so the agent holds no API key or provider URL. Set `LAL_INFERENCE` to an inference-provider registry grant to select it; `LAL_HOST` and `LAL_AUTH_TOKEN` are refused alongside `LAL_INFERENCE`. The package now publishes its `providers/` directory.
