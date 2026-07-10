---
'@endo/lal': minor
---

`@endo/lal` now ships the subscription-OAuth path under
`./providers/oauth/`: the authorization-code-with-PKCE flow (build the
consent URL, exchange the code, refresh tokens) and a per-provider
encrypted auth-storage exo that seals credentials at rest through an
injected authenticated-encryption cipher. A Node-backed
`./providers/oauth/node-crypto.js` supplies the SHA-256, randomness,
AES-256-GCM cipher, and scrypt passphrase key-derivation those surfaces
need. This lets a user authenticate against a Claude, ChatGPT, or GitHub
Copilot subscription over OAuth instead of a separate API key. Wiring the
sealed credentials into the daemon's formula-graph store and adding
verified provider presets are follow-ups.
