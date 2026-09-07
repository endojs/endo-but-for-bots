# Hosted deployment acceptance

The broker core and slice adapter are implemented; this is not a declaration
that a production Codex or Claude deployment has passed confinement tests.
The default remains refusal when evidence or a supported authentication path
is missing.

## Repository components

- `@endo/hosted-agent/provider-broker.js` owns bounded inference admission and
  reads a SecretBlob outside the slice for each request.
  It enforces inference routes, models, expiration, revocation, and concurrent
  request/byte/cost reservations without exposing upstream credentials.
  Cost reservations are an operator-supplied conservative bound, not billing data.
- `@endo/hosted-agent/provider-transport.js` supplies bounded fetch transport,
  redirect rejection, cancellation, and response streaming byte limits.
  Pull-based streaming preserves deadlines, cancellation, and backpressure.
- `@endo/hosted-agent/provider-http.js` supplies a credential-free loopback
  listener for one inference capability, with bounded connections, uploads,
  responses, and absolute deadlines.
  It forwards incremental SSE and cancels upstream readers on disconnect.
  `provider-listener-runtime.js` deploys its pinned worker image in an observed
  rootless Podman namespace with no routable interface.
  Only an inherited stdin/stdout CapTP connection carries the inference facet;
  the model slice shares the network namespace, not those pipes or process mounts.
- `@endo/hosted-agent/provider-lease-issuer.js` composes the host-held secret and
  fetch authority with that worker, issuing observed session leases.
  Expiry, revocation, worker exit, identity drift, and failed cleanup retire
  admission; cleanup remains reachable for retry.
- `@endo/codex-sandbox/durable-volumes.js` owns a durable, locked session registry
  and exclusive mount leases.
  `volume-host.js` composes ordinary rootless Podman volumes with a separately
  privileged XFS allocator and independent quota observer.
  See [durable volumes](./DURABLE-VOLUMES.md) for privilege and recovery boundaries.
- `@endo/codex-sandbox/sandbox-policy.js` composes the existing resource
  provisioner with a real `SandboxFactory.make({ policy })` request.
  It binds observed physical volumes to the logical session and combines outer
  evidence with independently queried runtime and broker evidence.
  Failed rollback remains reachable through `retryCleanup()`.

The concrete volume provider supplies `volumeProvider.describe`, and the lease
issuer supplies `brokerLease.sandboxEvidence`.
These authorities remain outside the model-facing capability graph.
The slice adapter defaults to `makeCodexRuntimeVerifier`, which performs bounded
live probes of the pinned image's environment and inner sandbox.
`makeXfsVolumeQuotaObserver` reads actual host project-quota enforcement;
the storage provisioner must assign and retain those quotas before use.
Returning expected constants from replacement implementations is not verification.
The operator supplies the approved image digests, private registry directory,
exclusive XFS project-ID range, quota service authority, and selected account.

The Codex launch now targets the lease's credential-free Responses endpoint.
Effective `config/read` admission rejects inherited provider credentials and
alternate routes before model or thread requests.
Command-line overrides alone do not suffice: pinned Codex 0.152.0 merges them
with saved home configuration, including old bearer and header fields.
The slice permits only the same launch arguments supplied to the verifier.
This binds launch configuration, not the effective kernel state of the process.
The existing pre-spawn verifier interface cannot inspect the future app-server;
deployment still requires a trusted probe tied to that launch and enforcement
that remains in force for all of its descendants.

## Remaining acceptance gates

[Linux acceptance evidence](./ACCEPTANCE-2026-09-07.md) records a successful
strict outer-policy gate, actual pinned-CLI inner sandbox and environment
preflight, and independent XFS quota enforcement/readback.
Subsequent live tests also exercised the actual provider worker's private pipe,
HTTP streaming, revocation, crash, and cleanup, and the durable volume provider's
quota assignment, UID-1000 writes, reopen, and destruction.
The initial runtime fixture used bounded tmpfs mounts; the combined deployment
runner is a separate gate.
No upstream authentication or billable inference is implied by these observations.

Run on a Linux rootless Podman host with delegated `memory`, `pids`, and `cpu`
controllers, quota-backed session volumes, and a digest-pinned image.
Record the exact image and runtime versions, host configuration, and results.
Do not convert a skipped test or an expected host refusal into a pass.

1. Prepare a credential-free loopback sidecar and prove its actual namespace
   matches the lease and slice, with no routable interface.
   Prove the pinned runtime can reach it and every model-launched command,
   descendant, and escape attempt cannot.
2. Verify the runtime's effective environment and state contain no provider
   bearer, proxy credential, shared home, or login/refresh material.
   Exercise read-only control state through symlink, hardlink, rename, subprocess,
   and configuration override attempts.
3. Run `yarn workspace @endo/sandbox test:drivers` and
   `yarn workspace @endo/sandbox test:policy:acceptance`.
   The latter fails when the host, image, driver, or any policy control is
   unavailable; a refusal cannot silently count as positive acceptance.
   Resource accounting includes the policy anchor and one operation container;
   shared-memory tmpfs is charged for both.
   The runtime's fixed internal `/dev` allowance is outside the writable total,
   as documented by `@endo/sandbox`.
4. Exercise broker expiration, revocation during an active response, secret
   replacement, model/route denial, quotas, redirects, malformed HTTP, listener
   crash, and audit redaction over the real listener and provider protocol.
5. Exercise failed interrupt, failed reap, restart/orphan recovery, and retry of
   failed provisioning cleanup without reusing a poisoned backend or replaying
   an unacknowledged prompt.

## Authentication and Claude

API-key gateway traffic is not subscription traffic.
Codex's documented external ChatGPT authentication gives an access token to
app-server; that alone does not satisfy this contract's token-free slice.
Claude's documented gateway flow distinguishes gateway credentials from a
saved subscription login.
Neither establishes this project's token-free subscription broker for the pinned
runtime without further implementation and live verification.
Subscription modes therefore remain unavailable.

Sources checked 2026-09-07:
[Codex authentication](https://learn.chatgpt.com/docs/auth),
[Codex app-server](https://learn.chatgpt.com/docs/app-server),
[Claude gateways](https://code.claude.com/docs/en/llm-gateway), and
[Claude Bash sandbox scope](https://code.claude.com/docs/en/sandboxing).

Floot no longer advertises or revives the legacy `claude-cli` route, which
materializes a credential inside a normally networked slice.
A Claude implementation must be supplied as a hosted backend; adding
`claude-backend` discovery does not itself certify that implementation.
`@endo/claude-sandbox` now supplies such a backend
(`setup-hosted.js` binds it as `claude-backend`), but it materializes the
credential inside its slice and keeps a `private` network profile, so it
satisfies Floot's hosted seam and tool isolation without satisfying this
contract's token-free slice.

## Non-blocking scope

Arbitrary live mount replacement remains unsupported; no such authority is
exposed by the new adapter.
If introduced later it needs the full replacement-race contract, not a partial
mount mutation path.
Checkpoint-based history reconciliation is already implemented and tested;
it is not reopened as a missing API dependency.
