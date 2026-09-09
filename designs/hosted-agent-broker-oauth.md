# Hosted Agent Broker OAuth and the Subscription Finding

| | |
|---|---|
| **Created** | 2026-09-08 |
| **Updated** | 2026-09-09 |
| **Author** | Kris Kowal (prompted) |
| **Status** | In Progress |
| **Source** | Requirements from `packages/codex-sandbox/SUBSCRIPTION-AUTH.md` |

## Status

Implemented in this pass:

- `packages/hosted-agent/src/provider-broker.js` — `authMode: 'oauth'`, a
  `BrokerOAuthStateV1` credential document, and `makeBrokerOAuthCredential`:
  one refreshing credential per secret record, shared by every lease over it,
  with proactive expiry refresh, a single-flight token exchange, a
  generation-checked write-ahead refresh intent, rotation, and account binding.
  The lease adds one bounded refresh-and-retry on a rejected credential, and
  echo screening that covers both tokens in every form, accumulated across the
  retry.
- `packages/hosted-agent/src/secret-rotator.js` — the rotate-only attenuation
  of a secret administration facet, applied by the credential itself so the
  narrow capability is minted where it is used.
- `packages/daemon/src/secret-manager.js` — `readBase64WithGeneration` returns
  the version the bytes came from, and `replaceBase64` takes an `ifGeneration`
  precondition and reports the generation it committed, so a holder deriving a
  new value from a secret can pin its write to the version it read, and a
  holder staging two writes can pin the second to what the first produced.
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

### Codex with a ChatGPT subscription: available, and this finding first got it wrong

**Correction (2026-09-09).** The first version of this document concluded that
Codex offered no such configuration.
That was wrong, and the way it was wrong is worth keeping: the search looked
only at the configuration-file surface — `requires_openai_auth`, `env_key`,
the credential helper — and concluded from their exclusivity that no path
existed.
It never examined the app-server auth protocol, even though
`SUBSCRIPTION-AUTH.md` names a method from it by name, and this repository's
own client test already answers that method.

Codex documents a mode whose entire purpose is a host application owning the
ChatGPT auth lifecycle:

> ChatGPT external tokens (`chatgptAuthTokens`) - experimental and intended for
> host apps that already own the user's ChatGPT auth lifecycle.
>
> — [Codex app-server](https://learn.chatgpt.com/docs/app-server),
> § Authentication modes

> Use this experimental mode only when a host application owns the user's
> ChatGPT auth lifecycle and supplies tokens directly.
>
> — [Codex app-server](https://learn.chatgpt.com/docs/app-server),
> § 3c) Log in with externally managed ChatGPT tokens (`chatgptAuthTokens`)

That is the broker, described by the vendor.
The host supplies an access token; it holds the refresh token itself; and when
the server sees a 401 it asks the host for a new one over
`account/chatgptAuthTokens/refresh` rather than performing a login.
The gate is `capabilities.experimentalApi = true` at `initialize`.

The repository had already closed this door from the wrong side.
`packages/codex-sandbox/test/codex-client.test.js` pins the client to answer
`account/chatgptAuthTokens/refresh` with JSON-RPC `-32601`, and
`SUBSCRIPTION-AUTH.md` lists that method among app-server requests not exposed
to the model-facing client.
Both are right about the *model-facing* client, which must never hold or renew
a credential.
Neither is a reason for the *broker* not to answer it — and the broker
answering it is the documented subscription path.

What remains genuinely unsettled is narrower than "no path exists", and only
the wire can settle it: whether `chatgptAuthTokens` accepts an individual
Plus/Pro grant rather than a workspace one, whether app-server persists a
host-supplied token or holds it in memory, and whether the experimental gate is
acceptable to depend on.
The slice does hold a short-lived access token in this shape, so "no reusable
credential in the slice" is satisfied only in the sense that it cannot be
renewed from inside; `SUBSCRIPTION-AUTH.md`'s literal "no `auth.json`" needs
the persistence question answered before it can be claimed.

Two adjacent shapes were also mischaracterised here, and the corrections matter
because both are closer to the goal than the original text allowed.

Workload identity federation does **not** land credential material with the
CLI:

> Codex exchanges the upstream token and keeps the OpenAI access token in
> memory. It does not write either credential to `auth.json`, the system
> keyring, or `config.toml`.
>
> — [Codex workload identity federation](https://learn.chatgpt.com/docs/enterprise/workload-identity)

with a token that "never lasts longer than one hour" and a refresh run by a
trusted host process outside Codex's control — the documented
short-lived-credential pattern, with a broker in all but name. It is a
managed-workspace path rather than an individual subscription, which is why it
does not settle the question, but the earlier claim about it was simply false.

**An earlier revision of this document attributed to that page a sentence that
does not appear on it**, about Codex rejecting `codex login` under workload
identity. It was not a quotation of anything. It has been removed, and the
quotations above were re-checked against the pages they cite. A fabricated
citation in a document whose whole purpose is to record what the vendor
actually supports is the worst failure this document can contain.

Finally, `codex login --with-access-token` is not the only access-token form:
the same page documents `CODEX_ACCESS_TOKEN` for callers that "prefer not to
persist credentials on the machine", and `cli_auth_credentials_store =
"ephemeral"` keeps credentials in memory for the current process only — a
stronger guarantee than the `codexHomeAuthFile: 'absent'` probe, and one that
also covers the keyring case that probe explicitly does not.

### Claude Code with a Claude.ai subscription: still blocked for a third-party broker

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

The original claim here — that neither vendor supports it — was wrong for Codex
and overstated for Claude. What survives is narrower and provider-specific.

**Codex has a documented path**, `chatgptAuthTokens`, and the remaining
questions are empirical rather than documentary: individual-plan acceptance,
token persistence, and whether an experimental gate is acceptable to depend on.
This is the one to pursue, and the work is a broker-side handler for
`account/chatgptAuthTokens/refresh` — a method this repository currently
answers with `-32601`.

**Claude Code has no path for a third-party broker.** That is not the same as
"no vendor supports it": Anthropic operates precisely this architecture on
individual Pro and Max plans, in Claude Code on the web and in self-hosted
environments, where the session authenticates with a short-lived,
Anthropic-issued OAuth token that a runner refreshes and pushes to the session.
The accurate statement is that no vendor exposes the broker role *to a third
party* for an individual subscription, and that stays true.
The nearest documented shape is a Claude apps gateway upstream with
`auth.oauth_token`; what blocks it is that documentation is silent on whether a
`setup-token` value is acceptable there, plus one positive obstacle — the OAuth
capability that subscription auth requires is documented as attached by the
client only on claude.ai-login sessions, so a gateway would have to synthesise
it.

Under `SUBSCRIPTION-AUTH.md`'s gate, Claude-subscription mode therefore stays
unavailable, and Codex-subscription mode moves from "refused" to "unproven":
the configuration exists, and what is missing is a live session, not a
vendor's permission.

The lesson about method is worth as much as the finding.
The first pass searched one surface — the configuration file — and generalised
its result to the whole product.
The path it missed was in the app-server protocol, named in this repository's
own requirements document, exercised by its own tests.
A conclusion of the form "no configuration exists" is a claim about every
surface, and is only as good as the least-examined one.

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
  // Absent in the steady state. Present only while a refresh this record
  // authorised has been dispatched and its outcome not recorded; see the
  // write-ahead section below.
  pendingRefresh: { startedAt: 1757375940000 },
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
Every rotation is pinned to a generation
(`SecretAdmin.replaceBase64(bytes, { ifGeneration })`), so a write that lost a
race is refused instead of overwriting a grant it never saw.
Which generation differs by write, and the write-ahead section below says why:
the mark names the generation it read, while everything after it names the
generation the mark committed.

It is worth being exact about what that pin does and does not cover, because it
is tempting to read it as a fix for the whole problem.
It covers the *record*: two holders cannot clobber each other's state.
It does **not** by itself cover the *provider*: a pin refuses a write, and a
write is refused only after the token has been presented, which is what a
provider with replay detection treats as a breach.
The write-ahead ordering below narrows that — two holders racing at the same
generation now produce one dispatch rather than two — but holders that read
different generations still serialize into two exchanges.
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

### A consumed refresh token outlives the request that lost it

An exchange that succeeds and then fails to store its result has spent the
stored refresh token without recording what it bought.
Failing that request is the obvious response and it is not sufficient: the
single-flight flag clears when the request settles, so the next one re-reads
the same record and presents the same already-consumed token.
Against a provider that invalidates a refresh token on use, that second
presentation is the replay that revokes the whole grant — the failure being
guarded against, arriving one turn later.

So the loss is fenced rather than merely reported, and the fence is in the
record rather than in the process that lost it.

The mechanism is a **generation-checked write-ahead refresh intent**.
Before the refresh token is presented, the credential writes the stored
document back with a `pendingRefresh` marker on it, conditional on the
generation it read; that write reports the generation it committed, and the
result is committed against *that* generation.
So a record whose refresh outcome was never recorded says so, and the next
holder — in this process or in one built after it — reads the mark and refuses
to exchange rather than presenting a token that may already be spent.
The mark refuses *exchanging*, not *using*: a still-valid access token keeps
serving every concurrent turn on the record, or a refresh would be an outage for
every session sharing it.
It is removed in exactly two places, and the second is much narrower than the
first: the write that stores the result, and an undo for the one failure that
proves the token was never presented.

Three properties do the work, and each is a place an earlier version was wrong.

**The write really precedes the dispatch.**
An intent that cannot be persisted means zero outbound exchanges — the token is
never presented at all, so there is nothing to lose track of.
That is the ordering inversion this design originally assumed away: the naive
reading is that the mark records what happened, whereas it has to record what is
*about* to.

**The window it covers is the whole exchange, not the write.**
A first version guarded only the write failure, which missed that the token is
spent the moment the provider answers: every check between that answer and a
committed write — the response shape, the account binding, the advanced expiry
— sits in a window where the token is gone and nothing has stored the result.
The short-lifetime check is the sharpest example, because this document already
anticipated a provider returning a lifetime shorter than the configured skew,
and that entirely ordinary case left the token unfenced for the next request to
replay.
Marking first covers all of it, including the case no check anticipates: the
process not surviving the window.

**The completion stays conditional.**
It is pinned to the generation the intent write committed, so an operator who
installed a new grant while the exchange was in flight is refused rather than
overwritten with a credential derived from the grant they replaced.
This is why `SecretAdmin.replaceBase64` now reports the generation it committed:
re-reading to learn it would reopen exactly the window the pin closes, and
computing it as one more than what was pinned would hard-code the manager's
increment into every caller that stages a write.

A rejected exchange is assumed to have consumed the token.
A lost response or a timeout may have reached the provider, and a broker that
assumed otherwise would present the token again; only an authority that can
actually distinguish a pre-dispatch failure is in a position to say so, and
`isUndispatchedRefresh` is how it says it.
The default is therefore fail-closed, at the cost that a token endpoint blip
fences a credential until an operator re-grants it — the right side to err on
when the alternative is a revoked grant, and stated here so that cost is chosen
rather than discovered.

There is one moment where a mark is known to be false and can be safely
removed: the refresh authority reported that its request never left, so the
stored refresh token is untouched and the mark is locking a live credential.
The undo names the generation the mark's own write committed, so it can only
replace the record while that mark is still the newest thing in it — an
operator's later grant is refused rather than rolled back — and it restores the
exact bytes the mark replaced rather than a re-serialization of them.
It needs no read, which matters because a read that fails would leave that live
credential locked for no reason at all.

There is a second moment that looks identical and is not, and the difference is
the sharpest thing in this design.
When the intent *write itself* fails with its outcome unknown — the secret
manager reported a backend failure, or the acknowledgement was lost — nothing
was dispatched either, so the token is equally unspent.
But the mark's generation is unknown too, which leaves only its bytes to
recognise it by, and bytes cannot establish authorship.
Two holders over one record — the invariant this credential states and cannot
enforce — write byte-identical marks: the state is the same and `startedAt` has
millisecond resolution.
A write that passes the secret manager's generation check and then fails at the
backend reports no conflict and lands nothing, so the mark such a holder finds
may be the one another holder wrote and is at that instant presenting the token
against.
Clearing it would turn a violated invariant from a failed turn into the replay
the whole protocol exists to prevent — the opposite of what the generation pin
is for.

An earlier version of this change did exactly that, and then tried to rescue it
by skipping the undo on a generation conflict.
That is necessary and not sufficient, which is worth recording because it is the
same shape of error as the two before it: a fix aimed at the case that was easy
to imagine, leaving the case that was not.
So where the mark's generation is unknown, nothing is undone and the record
stays fenced.
The cost is an operator re-grant for a token nothing ever presented, which is
the direction every other trade here errs in.

Both undos are best-effort in the sense that failing to land leaves the
conservative state, which an operator holding the record's read capability can
see as a `pendingRefresh` with the instant it was set, and which the secret
manager's audit trail records as a refused or failed write.
Nothing in the broker surfaces it: a marked record serves its still-valid access
token silently until that token expires, and only then does every request fail
at once.
Reporting it is worth doing and is not done here.

One property falls out of the ordering rather than being designed in.
Because the mark must be written before the token is presented, and only one
conditional write can land at a given generation, two holders that race now
produce at most one dispatch: the loser is refused before it reaches the token
endpoint.
That is a strictly better outcome than the pin alone gave — it does not make the
invariant unnecessary, since holders that read different generations still
serialize into two exchanges, but the simultaneous case no longer reaches the
provider twice.

What remains is a deliberate asymmetry rather than a hole.
Recovery from a genuinely lost provider response is fail-closed and needs a
fresh grant; exactly-once recovery of a response nobody received is not
something a client can have.
The in-memory fence this replaced was strictly weaker: it was cleared by exactly
the restart that a stuck refresh tends to provoke.
What is demonstrated here is that a mark survives *owner recreation* — a fresh
credential built over the same record refuses — which is what the unit suite can
show.
Durability across an actual process restart is the secret manager's property,
inherited rather than established, and broker crash remains on the live
acceptance list below.

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
- [x] Replace the in-memory consumption fence with a generation-checked
      write-ahead refresh intent, persisted before the exchange, so a restart
      during an unresolved exchange fails closed instead of replaying. If the
      intent cannot be persisted, the exchange must not happen.
- [ ] Surface a marked record. A `pendingRefresh` is visible only to a holder
      of the record's read capability, so a broker whose last exchange was lost
      serves its still-valid access token silently and then fails every request
      at once when it expires. An audit event on the first request that reads a
      marked record would make it visible when it happens.
- [ ] Reconsider discarding a refreshed credential whose expiry did not
      advance. Today the exchange has already spent the refresh token, the
      result is refused, and the record is left marked — so a provider whose
      token lifetime is shorter than `refreshSkewMs`, or a clock skew, costs an
      operator re-grant for what is a configuration error. Committing the
      credential and then failing the request would keep the recovery path at
      the price of one exchange per turn; both directions are defensible and
      the current one is chosen for stopping after a single exchange.
- [ ] Consider retrying the undo for a request that provably never left. It is
      attempted once and its failure swallowed, so a single transient write
      failure fences a token nothing presented until an operator re-grants it.
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
