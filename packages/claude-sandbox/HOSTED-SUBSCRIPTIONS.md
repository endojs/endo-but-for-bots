# Hosted Claude subscription pools

Claude Code can use several subscription tokens through the shared provider
broker.
Tokens stay in Secrets and are injected only into upstream requests.
The sandbox and Floot receive no token or Secrets capability.

Create a separate Secrets entry for each account's `claude setup-token` token,
or import the JSON from a dedicated Claude subscription login (the full export
or its `claudeAiOauth` member).
Do not share a renewable login with a local CLI that will also renew it.
Configure the operator setup with names, not token contents:

```sh
ENDO_CLAUDE_SUBSCRIPTIONS='[{"id":"primary","label":"Primary","credsName":"claude-creds"},{"id":"secondary","label":"Secondary","credsName":"claude-subscription-2"}]'
ENDO_CLAUDE_CREDS_KIND=oauthToken
```

All members use OAuth subscription tokens; API-key pools and mixed credential
kinds are not supported.
The pool ignores environment token seeds and requires existing Secrets entries.
Duplicate names or aliases of one SecretBlob are refused.
Opaque tokens cannot establish account identity: the operator must ensure the
entries belong to different accounts, not two tokens for the same account.

Switching between single-credential and pool modes requires explicitly retiring
the broker and its sessions first.
Do not delete the Secrets entries.
The broker's namespace, refusal marks and last-served session state survive
daemon restarts.
Setup never copies token bytes or replaces an existing Secrets value.
For login JSON, the broker normalizes the entry on first use with a conditional
write, retaining only the refresh token, scopes, local account binding and any
pending-renewal marker.
Imported access tokens are discarded; newly obtained access tokens and expiry
live only in broker memory, never in a Secrets write or a sandbox.
Every broker restart obtains a fresh access token on demand.
Renewals are single-flight, generation checked, and marked durably before the
exchange; an ambiguous result requires a fresh login rather than replaying the
possibly consumed refresh token.
The provider client and token endpoint are fixed by the adapter.
The local account binding is not independent verification of the provider account.
Rotate a token by replacing its value in Secrets.
Rebinding an existing member to another SecretBlob is refused; use a new member
ID for a different account.
Even a removed member's old SecretBlob binding remains reserved.

Floot offers Auto and named subscriptions.
Auto drains the known allowance that resets soonest and stays with an account
while its prompt cache is warm (300 seconds by default, configurable through
`ENDO_CLAUDE_CACHE_LIFETIME_SECONDS`).
An exhausted request can fall through to another member before response bytes
are delivered.
A pinned session never falls through and cannot change its pin when reopened;
create a new session to change it.
Authentication failures, arbitrary 429s and other provider failures do not cause
fallback: the broker requires a recognized exhaustion signal.

Updating the declared set takes effect for new sessions; existing grants retain
their original set until reincarnation.
Setup validates the whole declaration and secret references before publishing,
but the entire hosted setup is not transactional.
Per-member account oracles expose observed provider rate-limit headers, not
credential values.
Account-oracle `refresh()` reads the provider usage endpoint without inference
or spending reset credits.
It requires `user:profile`; inference-only setup-tokens remain usable for
inference but can be refused by the usage endpoint.
Renewable credentials require `user:inference`; a missing profile scope does not
silently invalidate an otherwise working inference credential.

Local tests cover exhaustion handover, pinned refusal, setup identity guards and
session pin persistence.
The plain-token pool passed live Tokyo acceptance on 2026-09-20.
Renewable-credential live acceptance is pending deployment of this increment.
