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
  `BrokerOAuthStateV1` credential document, and `makeBrokerOAuthCredential`:
  one refreshing credential per secret record, shared by every lease over it,
  with proactive expiry refresh, a single-flight token exchange, rotation, and
  account binding.
  The lease adds one bounded refresh-and-retry on a rejected credential, and
  echo screening that covers both tokens in every form, accumulated across the
  retry.
- `packages/hosted-agent/src/secret-rotator.js` — the rotate-only attenuation
  of a secret administration facet, applied by the credential itself so the
  narrow capability is minted where it is used.
- `packages/daemon/src/secret-manager.js` — `readBase64WithGeneration` returns
  the version the bytes came from, and `replaceBase64` takes an `ifGeneration`
  precondition, so a holder deriving a new value from a secret can pin its
  write to the version it read.
- `packages/hosted-agent/src/provider-transport.js` — `anthropic-beta` added to
  the header allowlist, and a 401 classification so the broker can tell "the
  token is bad" from "the request is bad".
- `packages/hosted-agent/src/provider-lease-issuer.js` — builds the shared
  credential once per record, attenuates `rotate` on the way in, binds the
  lease to the operator's selected account, and reports `authMode` in
  `BrokerLeaseV1`.
- `packages/codex-sandbox/src/backend-factory.js` — `BrokerLeaseV1` carries and
  validates `authMode`; an operator may pin the mode it will accept.
- `packages/codex-sandbox/src/runtime-verifier.js` — the live preflight probe
  now looks for `auth.json` in the session's `CODEX_HOME` and reports
  `codexHomeAuthFile: 'absent'` in `CodexRuntimeEvidenceV1`.

Not implemented, deliberately: **subscription mode remains unavailable for both
providers.**
The finding below is the reason, and it is a property of the vendors' client
configuration surfaces rather than of this code.

## What is the Problem Being Solved?

A user who already pays for a ChatGPT or Claude subscription cannot use it to
drive a hosted agent.
The API-key broker in `@endo/hosted-agent` keeps the credential out of the slice
but bills usage-based API credit.
The Claude backend in `@endo/claude-sandbox` accepts a subscription token but
materializes it into the slice's environment.
So the secure path has no subscription and the subscription path is not secure.

`SUBSCRIPTION-AUTH.md` states the contract both would have to meet: the broker
alone stores, rotates, and refreshes the credential; the slice receives a
revocable, provider-only, quota-bound endpoint and no reusable credential; and
the mode stays unavailable until the pinned stock CLI is proven to work through
that boundary **using a vendor-supported configuration**.

That last clause is the gate, so it was answered first.

## The feasibility finding

Sources checked 2026-09-08.
Both vendors document a proxy or gateway in the inference path.
Both document it as carrying the *client's* credential.
The one documented way to put a subscription behind a proxy is therefore to
leave the subscription credential in the client — the posture this contract
exists to forbid.

### Codex with a ChatGPT subscription: blocked

Codex does document an LLM-proxy configuration, and it does work with a ChatGPT
sign-in.
A custom provider takes a `base_url`, and among its authentication methods:

> **OpenAI authentication**: Set `requires_openai_auth = true` to use OpenAI
> authentication. You can then sign in with ChatGPT or an API key. This is
> useful when you access OpenAI models through an LLM proxy server. When
> `requires_openai_auth = true`, Codex ignores `env_key`.
>
> — [Codex authentication](https://learn.chatgpt.com/docs/auth), § Alternative
> model providers

The blocker is which side holds the credential in that mode.
"OpenAI authentication" means the CLI authenticates the proxied request with
its own sign-in, and that sign-in lives where the CLI runs:

> Codex caches login details locally in a plaintext file at `~/.codex/auth.json`
> or in your OS-specific credential store.
>
> — [Codex authentication](https://learn.chatgpt.com/docs/auth)

So a broker can sit *in front of* subscription traffic, but only by being handed
the reusable access and refresh tokens it was meant to replace.
That fails both the token-free slice and this repository's explicit "with no
`auth.json`".

The configurations that would leave the slice credential-free are the ones that
are not ChatGPT-subscription mode.
`env_key` supplies a provider API key from the environment, and the same
sentence above says `requires_openai_auth` makes Codex ignore it — precedence,
not a subscription.
The command-backed credential helper is documented as exclusive with the rest
("Do not combine with `env_key`, `experimental_bearer_token`, or
`requires_openai_auth`"), so a broker-scoped bearer fetched by a helper puts
Codex in a plain bearer mode and the broker would have to *substitute* a ChatGPT
credential upstream.
No vendor document describes or sanctions that.

Two adjacent documented shapes do not change the answer.
A ChatGPT Enterprise workspace can mint an access token for non-interactive use
(`printenv CODEX_ACCESS_TOKEN | codex login --with-access-token`), which is a
login the CLI performs and therefore a credential in the slice, and it is an
Enterprise feature rather than an individual subscription.
Workload identity federation avoids storing an OpenAI credential, but it is the
process environment that authenticates — "when the process selects workload
identity, Codex rejects `codex login` and `codex logout` because the process
environment controls authentication" — so the credential material still lands
with the CLI, and it is again a managed-workspace path, not a subscription.

### Claude Code with a Claude.ai subscription: blocked

Anthropic documents the same fork and closes it from both ends.

Pointing at a gateway without a gateway credential keeps the subscription, and
keeps the credential in the client:

> Setting only that variable, without a gateway credential, doesn't replace the
> subscription. Requests still route through the gateway, but a saved claude.ai
> login remains the active credential, so its usage limits and billing apply.
>
> — [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)

Supplying a gateway credential — the shape a broker actually issues — ends the
subscription for that session:

> While a gateway credential variable or `apiKeyHelper` is active, a developer's
> claude.ai subscription isn't used: the credential replaces the subscription
> login for that session, and the subscription's usage limits don't apply. That
> traffic is billed per token to whoever owns the credential the gateway
> forwards, such as your organization's Anthropic Console account, or your
> Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry account
> when the gateway routes there.
>
> — [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)

Leaving the slice with no credential at all is not a third option:

> The CLI has no credential of its own: a reachable base URL isn't one
>
> — [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect),
> troubleshooting

And Anthropic's own first-party gateway — architecturally what this broker is,
down to holding the upstream credential on the client's behalf — is documented
as carrying organization credentials rather than subscriptions:

> They don't need a claude.ai account, an API key, or a subscription, because
> requests to the model go through the gateway using the organization's upstream
> credential.
>
> — [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)

### The one shape that comes closest, and why it still does not qualify

A portable subscription credential does exist, and it is worth naming precisely
because a reader who knows about it will otherwise think this finding overlooked
it.
`claude setup-token` mints "a one-year OAuth token" for `CLAUDE_CODE_OAUTH_TOKEN`,
and "this token authenticates with your Claude subscription and requires a Pro,
Max, Team, or Enterprise plan"
([Authentication](https://code.claude.com/docs/en/authentication)).
It is exactly what `@endo/claude-sandbox` injects into its slice today.

So the obstacle is not that a subscription credential cannot be moved.
It is that every documented use of that token puts it in the *client*: it is
described for "CI pipelines, scripts, or other environments where interactive
browser login isn't available", and it sits in the client's own credential
precedence list below `ANTHROPIC_AUTH_TOKEN`.
Nothing documents a gateway holding it and presenting it upstream on a user's
behalf.
A broker that did so would be relying on undocumented behavior, which is
precisely what the gate in `SUBSCRIPTION-AUTH.md` refuses — "an officially
supported proxy/gateway configuration" — so the mode stays closed.
This is a statement about what is documented, not a claim that the bytes would
be rejected.

### What that leaves

There is no vendor-supported configuration, for either provider, in which the
broker holds an individual subscription credential and the slice holds none.
Under `SUBSCRIPTION-AUTH.md` both subscription modes therefore stay unavailable,
and this document is the record of why rather than a silent `Fail` in a
constructor.

The gap is narrow and specific, which is worth stating because it is what a
future re-check should look for.
For Codex: a custom-provider mode that combines a `base_url` with a credential
the proxy holds and still bills the ChatGPT plan.
For Claude Code: a documented gateway credential that does not displace the
claude.ai login, or documented support for a gateway presenting a subscription
credential such as a `setup-token` upstream.
Either one turns this from a finding into an implementation.

## What was built anyway, and why it is not speculative

The half of the requirement that is blocked is *slice-side configuration*.
The half that is not blocked is the broker's own credential lifecycle, and every
requirement in `SUBSCRIPTION-AUTH.md` § "Shared broker contract" beyond API-key
storage was unimplemented: no expiry tracking, no refresh, no write-back, no
single-flight.

That machinery is needed by any OAuth-bearing upstream credential — an
enterprise access token, a workload-identity-federated token, or a subscription
grant if a vendor ever documents one — and none of it depends on the blocked
question.
So `authMode` widens to `'api-key' | 'oauth'`, and `'subscription'` stays
refused with the reason above recorded next to the refusal.

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

Refreshing rotates every field at once, so they travel together.
`accountId` travels with them because a refresh that came back naming a
different account would silently move the session's billing and quota; the
credential checks it against the account the lease issuer bound, on every read
and again on every refresh result.

A refresh response that omits `refreshToken` means "keep the one you have"
(RFC 6749 § 6), which is how a non-rotating provider answers, so the stored one
is carried forward.
Persisting the response verbatim would drop it and strand the record at its next
expiry with nothing left to exchange.
A refreshed state that is *already* spent is refused rather than written, since
the next request would otherwise refresh again, indefinitely and silently.

### Refresh does not go through the lease

The lease's route allowlist admits three inference paths and nothing else, on
one fixed origin.
A token endpoint is neither.
Refresh therefore travels on the credential's own `refresh` authority, which the
lease never sees, and its `rotate` capability.
A lease that names `oauth` without a credential bound to its account is refused
at admission — an OAuth lease that cannot refresh is an API-key lease with a
shorter life, and would fail its first turn after expiry instead of failing to
exist.

### Rotation is one narrow capability, not the admin facet

`SecretAdminInterface` carries `revoke`, `delete`, and `setDescription`
alongside `replaceBase64`.
A broker holding it could destroy the operator's credential.
`makeSecretRotator` attenuates it to `replaceBase64` alone, and the lease issuer
applies that attenuation itself rather than trusting the caller to have applied
it — so an operator who hands the issuer a full `SecretAdmin` still cannot get
one to the broker.
It is a structural attenuation rather than a daemon dependency, so anything with
that one method can back it.

### Single-flight belongs to the record, not to the lease

Concurrent turns arriving on an expiring credential share one exchange.
This is not deduplication for its own sake: a provider that invalidates a
refresh token on use reads a second redemption as a replay and revokes the whole
grant, killing the credential the first exchange just stored.

That is why `makeBrokerOAuthCredential` is built once per secret record and
handed to every lease over it, rather than being assembled inside a lease or a
lease issuer.
The refresh token belongs to the record; a guard anywhere narrower leaves two
holders on one account each redeeming it.
An earlier revision of this design placed the guard on the lease, and a later
one on the lease issuer; both were caught by review, the second in a trial
against a live secret manager.
The lesson is worth stating plainly, because the mistake was made twice: the
guard has to sit exactly where the thing it protects sits, and an issuer is not
a record any more than a lease is.
The guard also re-reads the record before exchanging, so a caller that lost the
race takes what is now stored instead of replaying the token it was holding.

Exclusive ownership cannot be *enforced* from inside the module — a second
daemon over the same record is outside its reach — so it is stated as an
invariant and backed by a mechanism that limits the damage when it is violated.
Every rotation is pinned to the generation it read
(`SecretAdmin.replaceBase64(bytes, { ifGeneration })`), so a write that lost a
race is refused instead of overwriting a grant it never saw.

It is worth being exact about what that pin does and does not cover, because it
is tempting to read it as a fix for the whole problem.
It covers the *record*: two holders cannot clobber each other's state.
It does **not** cover the *provider*: by the time a write is refused, both
holders have already presented the same refresh token upstream, and that
presentation is what a provider with replay detection treats as a breach.
Only one credential per record prevents that, and only the composer can
guarantee it.
The pin is what keeps a violated invariant from also corrupting the stored
grant; it is not what keeps the invariant.
On a refused write the exchange result is discarded rather than returned: if
the generation moved, another holder rotated and theirs is what every reader
will see; if it did not, the write itself failed and the stored credential is
the one this exchange already spent, so there is nothing safe to hand out.
That is what makes the invariant recoverable when it is broken rather than
merely asserted.

### One retry, on one classification

The transport tells the broker whether the *credential* was refused or the
*request* was.
That single bit is all that crosses: no challenge header, no error body, no
upstream wording.
On it, and only on it, the broker refreshes once and dispatches once more within
the same admission — so a token revoked or rotated elsewhere mid-session does not
cost a turn, and no other failure is retried.
A transport that does not classify degrades to the proactive expiry refresh
rather than to a failure.

The bit is 401 alone.
A 403 is the upstream refusing *this request* — an unentitled model, a region, a
content policy — and refreshing cannot fix it.
Counting it would let a slice that can reproduce one turn every admitted request
into a second dispatch, a token exchange and a secret write, none of which the
request and cost quotas meter.

The retry also does not narrow the echo screen.
The first attempt handed its token to the upstream, so the screen accumulates
across both attempts; screening the response against the second credential alone
could deliver the first one back to the slice.

### The per-request secret read stays

`perform()` re-reads the secret on every request, and every length the echo
screen derives comes from that read.
That is what lets a rotated credential of a different length be picked up with no
further change, and it is why the read is not hoisted for "efficiency".

## `CODEX_HOME` posture: what was and was not proved

`SUBSCRIPTION-AUTH.md` requires the session's `CODEX_HOME` to be session-scoped,
durable across slice replacement, destroyed at logical-session teardown, free of
`auth.json`, and readable-but-not-writable by model-launched commands.
Auditing the pinned runtime verifier against that list:

| Requirement | Where it is established | Status before | Status now |
|---|---|---|---|
| Read-only to model-launched commands | `runtime-verifier.js` `INNER`: denied write, rename, hardlink, symlink alias, and subprocess write; read of a sentinel confirmed | Proved | Proved |
| Broker route denied to those commands | `INNER` connect attempt denied; outer probe connects | Proved | Proved |
| No credential or proxy variables | `PROBE` exact-environment equality | Proved | Proved |
| Session-scoped and durable across slice replacement | `sandbox-policy.js` binds `/codex-home` to the session's durable `stateVolume` | Proved | Proved |
| Destroyed at logical-session teardown | `durable-volumes.js` `destroy()`, refusing a leased session | Proved | Proved |
| **No `auth.json`** | — | **Not probed** | `PROBE` asserts absence of `auth.json` and `auth.json.lock`; `CodexRuntimeEvidenceV1` reports `codexHomeAuthFile: 'absent'` |

The last row was the real gap, and it is the one the finding above makes load
bearing: `auth.json` is exactly what a subscription-mode deployment would have to
place there.
Because `CodexRuntimeEvidenceV1` is checked for an exact shape, the new field is
part of the attested record rather than a comment.

The field is named for exactly what ran, and the claim stops there.
It is not evidence that the home holds no credential of any kind:
`cli_auth_credentials_store` can name an OS keyring instead of a file, and
`config.toml` can carry an `experimental_bearer_token`.
Neither is probed and neither is asserted.
It is also a preflight on a volume the app-server can write, so it is an
observation about the slice at admission, not a standing property of the
session — which is the same bound every other row of this table carries.

## Dependencies

| Design | Relationship |
|---|---|
| [endoclaw-oauth](endoclaw-oauth.md) | Describes the same shape generically — host holds the credential, agent gets a proxying capability. This is that shape for one specific, heavily bounded case: inference only, on a fixed origin, with quotas. |
| [runtime-container-fs-mount](runtime-container-fs-mount.md) | Shares the attested slice policy this evidence composes into. |

## Design Decisions

1. **`'subscription'` is refused, not implemented as a stub.** A mode that
   exists but cannot be provisioned is a claim that something was built. The
   union admits what is implemented; the refusal cites the finding.
2. **`authMode` says what the lease was built with, and no more.** The value
   itself comes from the operator's policy, so the honest claim is narrow: the
   broker core refuses to exist in `oauth` mode without a refreshing credential
   bound to the lease's account, and it is constructed before the lease record,
   so a `BrokerLeaseV1` reporting `oauth` was issued by a core that had one.
   It is not evidence about the *stored secret*: the credential is read on the
   first request, not at construction, so a lease can report `oauth` over a
   record that turns out to hold something else, and fail its first turn.
   `'api-key'` carries no construction-time consequence at all.
   The field is there so an operator can pin the mode and refuse the other, not
   to attest the credential.
3. **No speculative ChatGPT binding headers.** Account-binding headers for a
   mode no vendor permits would be an unverified protocol guess.
   What is implemented is the mechanism — a credential bound to a checked
   account — plus `anthropic-beta`, which an Anthropic-format gateway is
   documented to "forward unchanged"
   ([gateway compatibility](https://code.claude.com/docs/en/llm-gateway-protocol)).
   The operator supplies the value; the broker only proves it cannot carry a
   header separator or a second header.
4. **Classification, not error forwarding.** Exposing the upstream's 401 body or
   `www-authenticate` challenge to make retry decisions would undo the
   transport's redaction.
   One boolean's worth of information is enough.

## Known Gaps and TODOs

- [ ] Re-check both vendors for a documented proxy-holds-the-subscription
      configuration; the two specific shapes to look for are named above.
- [ ] Work the `SUBSCRIPTION-AUTH.md` acceptance matrix against a live upstream
      for `oauth` mode: refresh, expiry, revocation, account switching, model
      allowlists, quota exhaustion, broker crash, redirect/header smuggling, and
      audit redaction.
      The unit suite covers refresh, expiry, account switching, refresh-token
      replay across two leases, quota accounting, and redaction; the rest need
      the live gate.
- [ ] Decide whether a persistently rejected credential deserves negative
      caching.
      Today each admitted turn costs one exchange and one secret write; the
      request quota bounds it, but the refresh and rotate authorities are not
      themselves metered.
- [ ] Move `@endo/claude-sandbox` behind the broker, or retire the exception
      recorded in its README and in `MERGE-BLOCKERS.md`.

## Prompt

> Hosted Codex landed on `llm` with subscription authentication disabled, and
> the repository now holds two inconsistent credential postures: Codex is
> brokered and attested but API-key only, while Claude supports a subscription
> by materializing `CLAUDE_CODE_OAUTH_TOKEN` into its slice — the very pattern
> `MERGE-BLOCKERS.md` says must not land underneath this feature.
>
> Start with a feasibility spike, because it gates everything else: can the
> pinned Codex CLI 0.152.0 be pointed at a broker base URL in
> ChatGPT-subscription mode using a *vendor-supported* configuration, without
> the slice receiving the real reusable credential? Do the same for Claude
> Code's supported gateway/proxy configuration. Record the finding either way;
> a documented "upstream does not support this, here is the specific blocker"
> is a legitimate and valuable outcome.
>
> If it is feasible: widen `authMode` beyond `'api-key'`, add refresh with
> single-flight and a narrow rotate-only capability over
> `SecretAdminInterface.replaceBase64` (not the whole admin facet), keep
> refresh off the lease's route allowlist, add provider-specific header and
> account binding, update the attestation records to describe what was actually
> proved, and work the acceptance matrix. Confirm the pinned runtime verifier
> actually probes the `CODEX_HOME` posture it is credited with. Separately and
> regardless of the Codex outcome, the Claude backend's materialized-token
> posture should move behind the broker or be documented as a deliberate,
> time-boxed exception.
>
> Do not re-land the PR #994 credential path. The
> `provider-broker.test.js` assertion pinning the subscription refusal is to be
> updated deliberately, not deleted.
