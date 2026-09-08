# Hosted Agent Broker OAuth and the Subscription Finding

| | |
|---|---|
| **Created** | 2026-09-08 |
| **Updated** | 2026-09-08 |
| **Author** | Kris Kowal (prompted) |
| **Status** | In Progress |
| **Source** | Requirements from `packages/codex-sandbox/SUBSCRIPTION-AUTH.md` |

## Status

Implemented in this pass:

- `packages/hosted-agent/src/provider-broker.js` — `authMode: 'oauth'`, a
  `BrokerOAuthStateV1` credential document, proactive expiry refresh,
  single-flight token exchange, rotate-on-refresh, one bounded
  refresh-and-retry on a rejected credential, account binding, and echo
  screening that covers both tokens.
- `packages/hosted-agent/src/secret-rotator.js` — the rotate-only attenuation
  of a secret administration facet.
- `packages/hosted-agent/src/provider-transport.js` — `anthropic-beta` added to
  the header allowlist, and a credential-rejection classification so the broker
  can tell "the token is bad" from "the request is bad".
- `packages/hosted-agent/src/provider-lease-issuer.js` — threads the refresh and
  rotate authorities, binds the lease to the operator's selected account, and
  reports `authMode` in `BrokerLeaseV1`.
- `packages/codex-sandbox/src/backend-factory.js` — `BrokerLeaseV1` carries and
  validates `authMode`; an operator may pin the mode it will accept.
- `packages/codex-sandbox/src/runtime-verifier.js` — the live probe now proves
  the session's `CODEX_HOME` holds no `auth.json`, reported as
  `codexHomeCredentials: 'absent'` in `CodexRuntimeEvidenceV1`.

Not implemented, deliberately: **subscription mode remains unavailable for both
providers.** The finding below is the reason, and it is a property of the
vendors' client configuration surfaces rather than of this code.

## What is the Problem Being Solved?

A user who already pays for a ChatGPT or Claude subscription cannot use it to
drive a hosted agent. The API-key broker in `@endo/hosted-agent` keeps the
credential out of the slice but bills usage-based API credit; the Claude backend
in `@endo/claude-sandbox` accepts a subscription token but materializes it into
the slice's environment. So the secure path has no subscription and the
subscription path is not secure.

`SUBSCRIPTION-AUTH.md` states the contract both would have to meet: the broker
alone stores, rotates, and refreshes the credential; the slice receives a
revocable, provider-only, quota-bound endpoint and no reusable credential; and
the mode stays unavailable until the pinned stock CLI is proven to work through
that boundary **using a vendor-supported configuration**.

That last clause is the gate, so it was answered first.

## The feasibility finding

Sources checked 2026-09-08. Both vendors document a proxy or gateway in the
inference path, and both document it as carrying the *client's* credential. In
each case the one supported way to put a subscription behind a proxy is to leave
the subscription credential in the client — which is the posture the contract
exists to forbid.

### Codex with a ChatGPT subscription: blocked

Codex does document an LLM-proxy configuration, and it does work with a ChatGPT
sign-in. A custom provider takes a `base_url`, and

> When you define a custom model provider in your configuration file, you can
> use OpenAI authentication by setting `requires_openai_auth = true`. You can
> then sign in with ChatGPT or an API key. This is useful when you access OpenAI
> models through an LLM proxy server.
>
> — [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

The blocker is *which side holds the credential* in that mode. `requires_openai_auth`
means the CLI authenticates the proxied request with its own ChatGPT login, and
that login lives in the slice:

> Codex caches login details locally in a plaintext file at `~/.codex/auth.json`
> or in your OS-specific credential store. […] Treat `~/.codex/auth.json` like a
> password: it contains access tokens.
>
> — [Codex authentication](https://learn.chatgpt.com/docs/auth)

So a broker can sit *in front of* subscription traffic, but only by being handed
the reusable access and refresh tokens it was supposed to replace. That fails
both the token-free slice and `SUBSCRIPTION-AUTH.md`'s explicit "with no
`auth.json`".

The configurations that *would* leave the slice credential-free —
`env_key`, `experimental_bearer_token`, and the command-backed
`[model_providers.<id>.auth]` credential helper — are documented as mutually
exclusive with it ("Do not combine command-backed bearer token configuration
with `env_key`, `experimental_bearer_token`, or `requires_openai_auth`"). In
those modes Codex is not in ChatGPT-subscription mode at all: it presents an
opaque bearer, and a broker would have to *substitute* a ChatGPT OAuth
credential upstream. No vendor document describes or sanctions that, so it is
not the vendor-supported configuration the gate asks for.

The enterprise path (`printenv CODEX_ACCESS_TOKEN | codex login
--with-access-token`) is real and vendor-supported, but it is a ChatGPT
Enterprise feature and it also lands the credential in the CLI's own credential
store. It is a different deployment shape, not this one.

### Claude Code with a Claude.ai subscription: blocked

Anthropic documents the same fork more explicitly, and closes it from both ends.

Pointing at a gateway without a gateway credential keeps the subscription — and
keeps the credential in the client:

> Setting only that variable, without a gateway credential, doesn't replace the
> subscription. Requests still route through the gateway, but a saved claude.ai
> login remains the active credential, so its usage limits and billing apply.
>
> — [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)

Supplying a gateway credential — the shape the broker actually issues — ends the
subscription for that session:

> While a gateway credential variable or `apiKeyHelper` is active, a developer's
> claude.ai subscription isn't used: the credential replaces the subscription
> login for that session, and the subscription's usage limits don't apply. That
> traffic is billed per token to whoever owns the credential the gateway
> forwards.
>
> — [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)

And Anthropic's own first-party gateway — architecturally the same thing this
broker is, down to holding the upstream credential on the client's behalf — is
documented as carrying organization credentials rather than subscriptions:

> They don't need a claude.ai account, an API key, or a subscription, because
> requests to the model go through the gateway using the organization's upstream
> credential.
>
> — [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)

A slice with no credential at all is not an option either: Claude Code with a
reachable base URL and nothing else opens its login screen ("The CLI has no
credential of its own: a reachable base URL isn't one").

### What that leaves

There is no vendor-supported configuration, for either provider, in which the
broker holds an individual subscription credential and the slice holds none.
Under `SUBSCRIPTION-AUTH.md` that means both subscription modes stay
unavailable, and this document is the record of why rather than a silent
`Fail` in a constructor.

The gap is narrow and specific, which is worth stating precisely because it is
what a future re-check should look for: **a documented way for a proxy or
gateway to supply the subscription credential itself.** Codex would need a
custom-provider mode that combines a `base_url` with a credential the proxy
holds and still bills the ChatGPT plan. Claude Code would need a gateway
credential that does not displace the claude.ai login, or a documented way for a
gateway to present a subscription credential upstream. Either one turns this
from a finding into an implementation.

## What was built anyway, and why it is not speculative

The half of the requirement that is blocked is *slice-side configuration*. The
half that is not blocked is the broker's own credential lifecycle, and every
requirement in `SUBSCRIPTION-AUTH.md` § "Shared broker contract" beyond
API-key storage was unimplemented: no expiry tracking, no refresh, no
write-back, no single-flight.

That machinery is needed by any OAuth-bearing upstream credential — an
enterprise access token, a workload-identity-federated token, or a subscription
grant if a vendor ever documents one — and none of it depends on the blocked
question. So `authMode` widens to `'api-key' | 'oauth'`, and `'subscription'`
stays refused with the reason above recorded next to the refusal.

### The credential is a document, not a bearer string

`authMode: 'oauth'` reads a `BrokerOAuthStateV1` record from the secret manager:

```js
harden({
  version: 'BrokerOAuthStateV1',
  accessToken: '…',
  refreshToken: '…',
  expiresAt: 1757376000000,
  accountId: 'account-1',
});
```

Refreshing rotates every field at once, so they travel together. `accountId`
travels with them because a refresh that came back naming a different account
would silently move the session's billing and quota; the broker checks it
against the account the lease issuer bound, on every read and again on every
refresh result.

### Refresh does not go through the lease

The lease's route allowlist admits three inference paths and nothing else, on
one fixed origin. A token endpoint is neither. Refresh therefore travels on
`powers.refresh`, a separate outbound authority the broker holds and the lease
never sees, and `powers.rotate`, a rotate-only capability. A lease that names
`oauth` without both is refused at admission — an OAuth lease that cannot
refresh is an API-key lease with a shorter life, and would fail its first turn
after expiry instead of failing to exist.

### Rotation is one narrow capability, not the admin facet

`SecretAdminInterface` carries `revoke`, `delete`, and `setDescription`
alongside `replaceBase64`. A broker holding it could destroy the operator's
credential. `makeSecretRotator` attenuates it to `replaceBase64` alone. It is a
structural attenuation rather than a daemon dependency, so anything with that
one method can back it.

### Single-flight, and why it is a correctness property

Concurrent turns arriving on an expiring credential share one exchange. This is
not deduplication for its own sake: a provider that invalidates a refresh token
on use turns a concurrent second exchange into a revoked session, and the two
write-backs would race each other regardless.

### One retry, on one classification

The transport tells the broker whether the *credential* was refused (401/403)
or the *request* was. That single bit is all that crosses: no challenge header,
no error body, no upstream wording. On it, and only on it, the broker refreshes
once and dispatches once more within the same admission — so a token revoked or
rotated elsewhere mid-session does not cost a turn, and no other failure is
retried. A transport that does not classify degrades to the proactive expiry
refresh rather than to a failure.

### The per-request secret read stays

`perform()` re-reads the secret on every request, and every length the echo
screen derives comes from that read. That is what lets a rotated credential of a
different length be picked up with no further change, and it is why the read is
not hoisted for "efficiency".

## `CODEX_HOME` posture: what was and was not proved

`SUBSCRIPTION-AUTH.md` requires the session's `CODEX_HOME` to be session-scoped,
durable across slice replacement, destroyed at logical-session teardown, free of
`auth.json`, and readable-but-not-writable by model-launched commands. Auditing
the pinned runtime verifier against that list:

| Requirement | Where it is established | Status before | Status now |
|---|---|---|---|
| Read-only to model-launched commands | `runtime-verifier.js` `INNER`: denied write, rename, hardlink, symlink alias, and subprocess write; read of a sentinel confirmed | Proved | Proved |
| Broker route denied to those commands | `INNER` connect attempt denied; outer probe connects | Proved | Proved |
| No credential or proxy variables | `PROBE` exact-environment equality | Proved | Proved |
| Session-scoped and durable across slice replacement | `sandbox-policy.js` binds `/codex-home` to the session's durable `stateVolume` | Proved | Proved |
| Destroyed at logical-session teardown | `durable-volumes.js` `destroy()`, refusing a leased session | Proved | Proved |
| **No `auth.json`** | — | **Not probed** | `PROBE` asserts absence; `CodexRuntimeEvidenceV1` reports `codexHomeCredentials: 'absent'` |

The last row was the real gap, and it is the one the finding above makes load
bearing: `auth.json` is exactly what a subscription-mode deployment would have
to place there, so its absence is what distinguishes a broker-fronted slice from
one simply handed the operator's credential. Because
`CodexRuntimeEvidenceV1` is checked for an exact shape, the new field is part of
the attested record rather than a comment.

## Dependencies

| Design | Relationship |
|---|---|
| [endoclaw-oauth](endoclaw-oauth.md) | Describes the same shape generically — host holds the credential, agent gets a proxying capability. This is that shape for one specific, heavily bounded case: inference only, on a fixed origin, with quotas. |
| [runtime-container-fs-mount](runtime-container-fs-mount.md) | Shares the attested slice policy this evidence composes into. |

## Design Decisions

1. **`'subscription'` is refused, not implemented as a stub.** A mode that
   exists but cannot be provisioned is a claim that something was built. The
   union admits what is implemented; the refusal cites the finding.
2. **`authMode` is proved by construction, not declared.** The broker core
   refuses to exist in `oauth` mode without both capabilities, so a
   `BrokerLeaseV1` reporting `oauth` has them. Stamping the field from a
   configuration constant is the failure the attestation exists to exclude.
3. **No speculative ChatGPT binding headers.** Account-binding headers for a
   mode no vendor permits would be an unverified protocol guess. What is
   implemented is the mechanism — a credential bound to a checked account — plus
   `anthropic-beta`, which is documented ("Gateways that pass this traffic on to
   Anthropic must forward the OAuth capability in `anthropic-beta`"). The
   operator supplies the sourced value; the broker only proves it cannot carry a
   header separator.
4. **Classification, not error forwarding.** Exposing the upstream's 401 body or
   `www-authenticate` challenge to make retry decisions would undo the
   transport's redaction. One boolean's worth of information is enough.

## Known Gaps and TODOs

- [ ] Re-check both vendors for a documented proxy-holds-the-subscription
      configuration; the two specific shapes to look for are named above.
- [ ] Work the `SUBSCRIPTION-AUTH.md` acceptance matrix against a live upstream
      for `oauth` mode: refresh, expiry, revocation, account switching, model
      allowlists, quota exhaustion, broker crash, redirect/header smuggling, and
      audit redaction. The unit suite covers refresh, expiry, account switching,
      quota accounting, and redaction; the rest need the live gate.
- [ ] Move `@endo/claude-sandbox` behind the broker, or retire the exception
      recorded in its README and in `MERGE-BLOCKERS.md`.
