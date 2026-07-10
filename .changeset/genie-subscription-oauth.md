---
'@endo/genie': minor
---

`@endo/genie` now wires `@earendil-works/pi-ai`'s subscription-OAuth scaffolding through Genie: a model whose provider (Anthropic Claude Pro/Max, OpenAI Codex, or GitHub Copilot) has stored OAuth credentials authenticates with the OAuth access token — refreshed and re-persisted on expiry — while key-based providers fall back to their environment API key.
The new `src/agent/oauth.js` seam exports `loginOAuthProvider`, `makeMemoryOAuthStore` (an in-process reference `OAuthStore`), `isOAuthProvider`, `listOAuthProviderIds`, `makeApiKeyResolver`, `resolveOAuthApiKey`, and `applyOAuthModelModifications`.
`makeGenieAgents` accepts an `oauthStore` and threads it into every sub-agent (main, heartbeat, observer, reflector) so one subscription authenticates them all; omit it to keep using environment API keys only.
