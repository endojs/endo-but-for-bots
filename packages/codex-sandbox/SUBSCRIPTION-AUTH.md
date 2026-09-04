# Subscription authentication requirements

The credential broker is an external dependency of this PR.
Hosted subscription mode remains disabled until the relevant stock CLI is
proven to work through this boundary using a vendor-supported configuration.

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
