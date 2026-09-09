# Subscription authentication requirements

The inference broker and isolated listener are implemented, for API-key and for
a broker-held refreshing OAuth credential.
Subscription authentication is a separate requirement.
Codex now has an explicitly enabled experimental host composition, described
below; this does not change the Claude conclusions in this document.

## Live Codex experiment (2026-09-10; supersedes earlier Codex status)

The pinned Codex 0.152.0 custom-provider configuration completed real Floot
Codex Sol turns through the strict attested sandbox with no slice credential.
The host broker held the renewable ChatGPT credential in general Secrets,
successfully renewed it, and mapped only the permitted Responses inference route.
This is empirical acceptance of the fixed subscription route, not a claim that
OpenAI promises a stable public third-party subscription proxy API.
The model-facing app-server does not receive even a short-lived bearer token;
the external `chatgptAuthTokens` login mode is therefore not used in the slice.

The account is pinned in formula configuration and checked against every credential
read, including revival; replacement with another account fails closed.
The long-lived refresh token, not the cached access token, drives renewal.
Uncertain refresh intents require operator recovery rather than unsafe replay.
See [HOSTED-SUBSCRIPTION.md](./HOSTED-SUBSCRIPTION.md) for the explicit operator
entry point and limits that remain before general-purpose deployment.

The findings below are retained as historical research, not current enablement status.

## Finding: Codex has a documented path; Claude does not (revised 2026-09-09)

**The 2026-09-08 finding below was wrong for Codex and is retained, corrected,
because how it was wrong matters.**
It searched the configuration-file surface only, and generalised "no
configuration here" into "no configuration anywhere".
Codex documents `chatgptAuthTokens`, an app-server login mode "intended for
host apps that already own the user's ChatGPT auth lifecycle", in which the
host supplies an access token, keeps the refresh token, and answers
`account/chatgptAuthTokens/refresh` when the server sees a 401.
That is this broker, described by the vendor — and this document already named
that method, while `test/codex-client.test.js` already answers it with `-32601`.
Refusing it for the *model-facing* client is right; nothing about that is a
reason for the *broker* not to answer it.

What is unresolved for Codex is now empirical, not documentary: whether an
individual Plus/Pro grant is accepted, whether app-server persists a
host-supplied token, and whether an experimental capability gate is acceptable
to depend on. Those need a live session, not more reading.

For Claude Code the original conclusion holds, in a narrower form: no vendor
exposes the broker role *to a third party* for an individual subscription.
Anthropic itself runs this architecture on Pro and Max plans in its own hosted
and self-hosted environments, so it is not that the shape is unsupported —
only that the role is not offered outward.

## Superseded finding: both subscription modes remain unavailable (2026-09-08)

The gate above was answered against current vendor documentation, and the
answer is no for both providers.
Each vendor documents a proxy or gateway in the inference path, and each
documents it as carrying the *client's* credential: the one supported way to
put a subscription behind a proxy is to leave the subscription credential in
the client, which is the posture this contract exists to forbid.

- **Codex.** *(Superseded: this examined only the configuration file. See the
  revised finding above.)*
  A custom provider takes a `base_url`, and setting
  `requires_openai_auth = true` is documented as "useful when you access OpenAI
  models through an LLM proxy server" with a ChatGPT sign-in.
  But in that mode the CLI authenticates with its own login, which is cached
  "in a plaintext file at `~/.codex/auth.json` or in your OS-specific credential
  store" — the reusable access and refresh tokens, inside the slice, and the
  `auth.json` this document forbids.
  The configurations that would leave the slice credential-free are not
  ChatGPT-subscription mode: the same sentence says Codex ignores `env_key`
  when `requires_openai_auth` is set, and the command-backed credential helper
  is documented as not to be combined with it.
- **Claude Code.** `ANTHROPIC_BASE_URL` alone "doesn't replace the
  subscription", but then "a saved claude.ai login remains the active
  credential" — again in the client.
  Supplying the gateway credential the broker actually issues ends the
  subscription: "the credential replaces the subscription login for that
  session, and the subscription's usage limits don't apply."
  Anthropic's own first-party gateway, which holds the upstream credential
  exactly as this broker does, is documented as carrying organization
  credentials rather than subscriptions.

A portable subscription credential does exist on the Claude side —
`claude setup-token` mints a one-year OAuth token that "authenticates with your
Claude subscription" — so the obstacle is not that such a credential cannot be
moved.
It is that every documented use of it puts it in the client, and nothing
documents a gateway holding one and presenting it upstream.

The refusal is therefore recorded rather than silent: the broker admits
`api-key` and `oauth`, and refuses `subscription` citing this section.
A future re-check should look for one specific thing — a documented way for a
proxy or gateway to supply the subscription credential *itself*.

The broker-side half of the contract below does not depend on that question and
is now implemented: expiry tracking, single-flight refresh, a
generation-checked write-ahead refresh intent recorded in the secret record
itself, rotation through a narrow write-back capability, one bounded
refresh-and-retry on a rejected credential, and account binding.
The unit suite shows the intent surviving owner recreation; durability across an
actual process restart is the secret manager's and is not exercised there, so
broker crash stays on the live acceptance list below.
See [`designs/hosted-agent-broker-oauth.md`](../../designs/hosted-agent-broker-oauth.md)
for the sourced finding, the quoted vendor text, and what was built.

## Shared broker contract

The broker runs outside every model/tool process boundary and alone stores,
rotates, refreshes when applicable, and revokes the selected supported upstream
credential.
It issues one revocable endpoint capability per session and injects upstream
authorization only after validating the fixed provider origin, method, path,
model allowlist, expiration, and quota.
It exposes no account, billing, organization, login, logout, token, session
administration, remote-control, or arbitrary proxy operations.

The broker's own durable material — refresh tokens, enterprise access tokens,
signing keys — belongs in the daemon secret manager (`@secrets`), which gives it
envelope-encrypted storage, a read capability delegable separately from the
administration facet, in-place replacement, revocation, and an audit trail.
That covers storage and lifecycle only.
A `SecretBlob` hands its holder the bytes by design, so it is not itself a
lease: origin, method, path, model allowlist, expiry, and quota enforcement are
the broker's, and none of them can be expressed as a secret record.

The real bearer or refresh token cannot be exported through the endpoint.
Provider reachability is process-scoped: the app-server process can use the
lease, but model-launched commands and descendants cannot connect to the broker
route even though stock CLIs launch tools under their own UID.
Production must verify this separation from effective cgroup/network state; an
environment-variable convention or an undisclosed loopback port is not an
authority boundary.

## Codex with a ChatGPT subscription

Codex local clients support signing in with ChatGPT, which uses the user's
ChatGPT subscription, or with an API key, which uses usage-based API billing.
See the official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth)
and [app-server integration documentation](https://learn.chatgpt.com/docs/app-server).
For an individual ChatGPT subscription, the broker owns the ChatGPT OAuth
access/refresh state, refreshes it outside the slice, binds the selected account
and plan to the lease, and proxies only the inference protocol needed by the
pinned Codex CLI.
Enterprise deployments may instead use a Codex access token or workload
identity federation to mint short-lived credentials, where supported by the
operator's plan and the pinned CLI; the broker still owns rotation, revocation,
audience restriction, and the provider-only lease.

The slice receives a session-scoped `CODEX_HOME` that is durable across slice
replacement and destroyed at logical-session teardown, with no `auth.json`.
The pinned runtime verifier now probes that absence directly and reports
`codexHomeAuthFile: 'absent'` in `CodexRuntimeEvidenceV1`; the session
scoping, durability, and teardown are established by the durable `stateVolume`
bound at `/codex-home`.
App-server can write it, but the pinned `workspaceWrite` tool sandbox permits
model-launched commands to read and not modify it.
App-server requests for `account/chatgptAuthTokens/refresh`, account login,
logout, rate-limit-credit consumption, and account/session management are not
exposed to the model-facing client.
If Codex CLI 0.152.0 cannot target the broker without receiving the real
reusable credential, that auth mode must remain unavailable; an API-key
deployment does not satisfy the individual ChatGPT-subscription requirement.

## Claude Code with a Claude subscription

Claude Code supports signing in with a Claude.ai account on an eligible Pro or
Max subscription; Anthropic Console/API-key billing is a separate mode.
See Anthropic's official [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started)
and [LLM gateway](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)
documentation.
The broker must own Claude.ai OAuth refresh state and proxy only the pinned
Claude Code inference protocol, with hooks, plugins, user MCP configuration,
and shared Claude home state disabled unless separately endowed.

No `CLAUDE_CODE_OAUTH_TOKEN`, API key, reusable credential file, or shared
Claude configuration may enter the slice.
If the pinned Claude Code release cannot target the broker using an officially
supported proxy/gateway configuration without receiving the real subscription
token, Claude-subscription mode must remain unavailable.

Before enabling either provider, deployment tests must cover refresh, expiry,
revocation, account switching, model allowlists, quota exhaustion, broker crash,
redirect/header smuggling, and audit redaction.
The `@endo/hosted-agent` unit suite covers refresh, expiry, account switching,
quota accounting, and redaction for `oauth` mode against a controlled upstream;
the remainder still require the live gate, and none of it enables a
subscription mode the finding above holds closed.
