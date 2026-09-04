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
The following foundations remain external blockers before a production hosted
deployment can satisfy the asserted contract.

## Attestable sandbox enforcement

`@endo/sandbox` must enforce and report `HostedAgentPolicyV1` from effective
rootless Podman/container state.
Today its Podman `network: "private"` is NAT rather than filtered isolation, and
its `limits` record is not translated into cgroup/resource flags.
The required changes and negative production tests belong in an independently
reviewed sandbox PR.
Until it lands, `makeCodexBackendFactory` rejects the policy and app-server does
not start.

This dependency includes a broker-only network namespace and concrete
credential-free sidecar transport with process-scoped routing that excludes
model-launched descendants, cgroup and storage enforcement, private
namespaces, read-only root, the exact workspace/state/tmpfs mount table, and
the pinned Codex `workspaceWrite` child policy that makes control state
read-only to model-launched commands, plus descendant reap/orphan reconciliation
exactly as specified in
[SANDBOX-CONTRACT.md](./SANDBOX-CONTRACT.md).

## Provider credential broker

A separate unconfined broker must own the selected vendor-supported upstream
credential: individual ChatGPT or Claude.ai OAuth refresh state, or supported
enterprise access-token/workload-identity material.
It issues revocable, quota-bound, provider-only session endpoints.
This branch defines and validates the exact `BrokerLeaseV1` attestation at the
provisioning seam; the broker and sidecar implementation remain external.
The stock pinned CLIs must be verified against vendor-supported proxy or gateway
configuration without putting a real bearer in the slice.
If that is impossible for a provider, its subscription mode remains disabled.

The complete Codex and Claude Code requirements are in
[SUBSCRIPTION-AUTH.md](./SUBSCRIPTION-AUTH.md).
The old `codex-auth-seeder`, shared `CODEX_HOME`,
`CLAUDE_CODE_OAUTH_TOKEN` environment injection, and credential materialization
from PR #994 must not land underneath this feature.

The daemon secret manager (`@secrets`) now supplies the *storage* half of this
requirement: durable envelope-encrypted bytes, a delegable read capability
separate from the administration facet, replacement without re-delegation,
revocation, and a complete audit trail.
Floot's own API-provider token already moves through it.
That is not the broker.
A `SecretBlob` hands its holder the bytes on request by design, so it cannot
bound a credential to a provider origin, model allowlist, quota, or session
lease, and it cannot refresh OAuth state.
The broker remains external and must hold the upstream credential itself; the
secret manager is where the broker's own durable material belongs, not a way to
put a bearer token inside the slice.

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
