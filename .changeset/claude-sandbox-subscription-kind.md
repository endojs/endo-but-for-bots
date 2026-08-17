---
'@endo/claude-sandbox': minor
---

Extend the exported `ClaudeCredentials` caplet with a third credential kind,
`subscription`, for `@endo/claude`: a Max/Pro subscription value presented to
`claude --bare` through an `apiKeyHelper` (the only credential path `--bare`
honors — it never reads `CLAUDE_CODE_OAUTH_TOKEN`, and `apiKey` is the metered
path the subscription premise excludes). The kind is added at all three sites
that previously fixed `harden(['apiKey', 'oauthToken'])`:
`claude-credentials-factory.js` and `claude-credentials-module.js` admit it so a
subscription credential can be minted and issued, and
`claude-client-module.js` — which routes a credential kind to an environment
variable inside the podman slice — now *explicitly refuses* it, because a
subscription is settings-file-shaped (consumed by `@endo/claude`'s
`renderApiKeyHelperSettings`), not env-var-shaped. Extending only the factory
without the client-module refusal would fall through to a misleading
"unknown kind" error for a kind that is in fact known.
