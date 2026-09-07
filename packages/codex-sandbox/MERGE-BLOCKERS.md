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

`makeCodexBackendFactory` still rejects the policy and app-server still does not
start, because `HostedAgentPolicyV1` also asserts claims the outer sandbox
cannot observe:

- `credentialInjection: "broker-only"` and `brokerTransport:
  "loopback-sidecar"` are the broker's claims.
  The sandbox proves the namespace holds nothing routable; it does not prove
  what the listener inside it is, that it is credential-free, or that its route
  is denied to model-launched descendants.
- `toolSandbox`, `toolCodexHomeAccess`, and `toolBrokerAccess` are the pinned
  app-server's claims about the inner `workspaceWrite` policy it applies before
  starting untrusted commands.
- The slice environment is still not attested, so an operator's `makeSlice` must
  still place no credential or proxy setting there.

An operator's `makeSlice` must therefore compose `HostedAgentPolicyV1` from
`E(slice).policy()` plus attestations the broker and the pinned runtime supply
for their own halves.
Stamping the unproved fields into the record from a configuration constant
would make `assertHostedAgentPolicyV1` accept a claim nothing established,
which is the failure the whole attestation exists to exclude.
The remaining halves are the two sections below.

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
