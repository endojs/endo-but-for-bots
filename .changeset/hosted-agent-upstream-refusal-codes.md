---
'@endo/hosted-agent': patch
---

The inference provider registry now reports an upstream refusal through the Anthropic API-key issuer by a fixed code: `provider-authentication-failed` for a 401, `provider-rate-limited` for a 429, and `model-not-available` for a 404. These turns previously failed as `Provider request failed`, so a real upstream 404 never reached `model-not-available`. A stream cut short now charges its full reservation as `estimated`, rather than the partial usage it had reported.
