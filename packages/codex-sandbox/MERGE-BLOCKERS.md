# Merge blockers and external dependencies

This branch does not cherry-pick the exploratory PR #994 hosted-management
stack.
Its shared writable Codex home, one-process-per-turn client, ambient thread
files, MCP bearer socket, token-in-environment flow, mutable images, and
cancellation replay conflict with this design.

Session staging, reverse-order rollback, retryable teardown, run/admin facet
attenuation, dynamic model discovery, direct Endo dynamic tools, checkpointed
failed-history reconciliation, durable audit primitives, and the reproducible
image recipe are implemented here.
The repository foundations below are implemented and have passed the applicable
Linux checks recorded in [deployment acceptance](./DEPLOYMENT-ACCEPTANCE.md).
The supported review scope is the gateway substrate, for API-key and for a
broker-held refreshing OAuth credential.
Subscription modes and a Claude hosted implementation remain disabled, so this
PR makes no claim that those modes satisfy the contract.
Production activation still requires the operator's approved images, storage
and reaper authorities, selected account, and vendor inference acceptance.

## Attestable sandbox enforcement

The outer half has landed.
`@endo/sandbox` now takes a `SlicePolicyRequest` at `make()` and reports a
`SlicePolicyAttestationV1` from `SandboxHandle.policy()`, derived from effective
rootless Podman and kernel state rather than from the flags it passed.
A `broker-only` network profile joins an operator-prepared namespace and is
usable only once `procfs` has shown it holds loopback and no routable
interface, which is what `network: "private"`'s NAT could never establish.
The resource ceilings are applied as cgroup and rlimit flags and read back from
the runtime's resolved view against delegated cgroup v2 controllers, which the
old per-process `limits` record never reached.
Also proved: the digest-pinned image, uid and gid inside the slice's own user
namespace, private user/PID/IPC/mount namespaces, read-only root,
`no-new-privileges`, an empty effective capability set, a loaded seccomp
filter, no devices, no host bind mounts, the exact declared mount table with
`nosuid,nodev` and a writable ceiling on every entry, and descendant reaping.
Anything absent, unreadable, or in an unrecognized shape fails `make()`, so a
slice that cannot prove its confinement never exists.
See `packages/sandbox/README.md` § "Slice policy and attestation".

`makeCodexBackendFactory` rejects a bare outer attestation and does not start
app-server without the remaining evidence, because `HostedAgentPolicyV1` also
asserts claims the outer sandbox cannot observe:

- `credentialInjection: "broker-only"` and `brokerTransport:
  "loopback-sidecar"` are the broker's claims.
  The sandbox proves the namespace holds nothing routable; it does not prove
  what the listener inside it is, that it is credential-free, or that its route
  is denied to model-launched descendants.
- `toolSandbox`, `toolCodexHomeAccess`, and `toolBrokerAccess` require the pinned
  runtime's inner `workspaceWrite` policy.
  The default runtime verifier now probes these controls using that CLI and
  the same launch policy, including direct and indirect control-state mutations.
  The pinned runtime remains trusted to apply this policy to later commands.
- The default verifier also measures the probe's effective environment and
  rejects unexpected credential or proxy settings, and looks in the session's
  `CODEX_HOME` for the `auth.json` a ChatGPT login would be cached in,
  reporting `codexHomeAuthFile: 'absent'`.
  That field claims only what the probe looked for: a keyring-backed credential
  store or an `experimental_bearer_token` in `config.toml` is neither probed nor
  asserted.
  This is a bounded preflight, not continuous observation of future processes.

`makeAttestedCodexResourceProvisioner` now provides the adapter that composes `HostedAgentPolicyV1` from
`E(slice).policy()` plus attestations the broker and the pinned runtime supply
for their own halves.
Stamping the unproved fields into the record from a configuration constant
would make `assertHostedAgentPolicyV1` accept a claim nothing established,
which is the failure the whole attestation exists to exclude.
The successful Linux preflight, strict outer-policy gate, and independent XFS
quota observations are recorded in [Linux acceptance evidence](./ACCEPTANCE-2026-09-07.md).
Production composition and authentication remain subject to the gates below.

## Provider credential broker

A separate unconfined broker must own the selected vendor-supported upstream
credential: individual ChatGPT or Claude.ai OAuth refresh state, or supported
enterprise access-token/workload-identity material.
It issues revocable, quota-bound, provider-only session endpoints.
This branch defines and validates the exact `BrokerLeaseV1` attestation at the
provisioning seam.
The inference broker, incremental HTTP adapter, pinned namespace worker,
private-pipe CapTP transport, and observed lease issuer are implemented.
Their live Linux acceptance covers streaming, revocation, crash invalidation,
and cleanup with a controlled upstream.
Stock Codex configuration and catalog admission have passed through the concrete
gateway composition without putting a bearer in the slice.
Vendor inference and subscription authentication are separate acceptance gates.
Until a provider's subscription flow is verified, that mode remains disabled.

The complete Codex and Claude Code requirements are in
[SUBSCRIPTION-AUTH.md](./SUBSCRIPTION-AUTH.md).
The old `codex-auth-seeder`, shared `CODEX_HOME`,
`CLAUDE_CODE_OAUTH_TOKEN` environment injection, and credential materialization
from PR #994 must not land underneath this feature.

Subscription mode is disabled for a recorded reason rather than for want of an
implementation, and as of 2026-09-09 that reason differs by provider.
Codex *does* document a path — `chatgptAuthTokens`, an app-server login mode
for host apps that own the user's ChatGPT auth lifecycle, with the host
answering `account/chatgptAuthTokens/refresh`.
It is unproven here rather than unavailable: what is missing is a live session
establishing individual-plan acceptance and token persistence, plus a
broker-side handler for a method this branch currently answers with `-32601`.
For Claude Code no vendor exposes the broker role to a third party for an
individual subscription, so that mode stays closed.
The finding, with quoted sources, is in
[SUBSCRIPTION-AUTH.md](./SUBSCRIPTION-AUTH.md) § "Finding" and
[`designs/hosted-agent-broker-oauth.md`](../../designs/hosted-agent-broker-oauth.md).
The broker's own credential lifecycle no longer waits on that question: it
tracks expiry, refreshes under a single-flight guard, rotates the stored state
through a rotate-only capability that carries no `revoke`, `delete`, or
`setDescription`, and retries a rejected credential exactly once.
The guard excludes only the holders that share one credential object, which the
composer must make one per secret record; that is an invariant it states, not a
property the code enforces.
What the code does enforce is the write: every rotation is pinned to a
generation, so a refresh that races an operator's replacement is refused rather
than overwriting it.
That bounds the damage of a violated invariant to a failed turn rather than a
corrupted grant — it does not stop two holders presenting the same refresh
token upstream.
A refresh is also write-ahead: the record is marked before the token is
presented and the result is committed against the generation that mark
produced, so an exchange whose outcome was never recorded leaves the record
saying so and the next holder refuses rather than replaying.
An intent that cannot be persisted means no exchange is dispatched at all.
That refusal is fail-closed by design: recovering a provider response nobody
received is not possible, so a lost exchange needs a fresh grant.
`BrokerLeaseV1` now carries `authMode`, so an operator can pin the mode it
accepts and refuse a lease issued in the other.
The claim it carries is narrow: the broker core refuses to exist in `oauth` mode
without a refreshing credential bound to the lease's account, and it is
constructed before the lease record, so a lease reporting `oauth` was issued by a
core that had one.
It is not evidence about the stored secret, which is first read on the first
request.

`@endo/claude-sandbox` still injects `CLAUDE_CODE_OAUTH_TOKEN` into its own
slice, which this section otherwise rules out.
That is now a recorded, time-boxed exception scoped to that package, with a
2026-12-08 review date, rather than an unremarked inconsistency: for Claude Code
the token-free and subscription-backed postures are mutually exclusive, because
a gateway credential displaces the claude.ai login.
See [`@endo/claude-sandbox`'s README](../claude-sandbox/README.md) §
"A deliberate, time-boxed exception".
Nothing in that exception may be reused for the Codex hosted path.

The daemon secret manager (`@secrets`) now supplies the *storage* half of this
requirement: durable envelope-encrypted bytes, a delegable read capability
separate from the administration facet, replacement without re-delegation,
revocation, and a complete audit trail.
Floot's own API-provider token already moves through it.
That is not the broker.
A `SecretBlob` hands its holder the bytes on request by design, so it cannot
bound a credential to a provider origin, model allowlist, quota, or session
lease, and it cannot refresh OAuth state.
The broker core now implements inference admission, fresh SecretBlob reads,
quotas, revocation, redaction, and bounded incremental transport.
The credential-free HTTP listener limits connections, uploads, and slow consumers.
The concrete namespace runtime keeps process state and private pipes separate
from the model slice while sharing only the isolated network namespace.
Subscription refresh and actual vendor authentication remain deployment gates;
the broker must hold the upstream credential itself.
The secret manager is where its durable material belongs, not a way to put a
bearer token inside the slice.

## Runtime mount replacement

Endo APIs are exposed to Codex now as app-server dynamic tools through a pinned
`EndoToolSet`; this does not depend on MCP or `/mnt`.
Arbitrary live filesystem-capability attachment is a separate authority and
lifecycle feature.
If it is later required, it must semantically include the complete race-fix
chain from PR #994: serialized replacement, exact path/mode validation,
possession checks, stale-bridge cleanup, full slice recreation, and no prompt
replay.

## History reconciliation

Codex CLI 0.152.0 provides stable `thread/turns/list` and
`thread/revert({ threadId, beforeTurnId })` methods.
This branch pins and tests the write-ahead, commit-acknowledged reconciliation
protocol against those checkpoint-addressed methods; there is no deprecated
history API merge blocker.
