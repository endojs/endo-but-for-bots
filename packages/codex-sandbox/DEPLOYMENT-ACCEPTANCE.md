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
  It currently buffers the bounded response; incremental SSE forwarding through
  a stock-CLI listener is still required before claiming that integration.
- `@endo/codex-sandbox/sandbox-policy.js` composes the existing resource
  provisioner with a real `SandboxFactory.make({ policy })` request.
  It binds observed physical volumes to the logical session and combines outer
  evidence with independently queried runtime and broker evidence.
  Failed rollback remains reachable through `retryCleanup()`.

The operator must supply trusted implementations of `volumeProvider.describe`,
`brokerLease.sandboxEvidence`, and `runtimeVerifier.attest`.
These are not model-facing capabilities.
Returning expected constants from those methods is not verification.
In particular, the broker core does not create a Linux namespace listener or
issue a `BrokerLeaseV1` attestation.

## Remaining acceptance gates

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
3. Run `yarn workspace @endo/sandbox test:drivers` and require the positive
   attestation case to pass, as well as negative/refusal cases.
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
A Claude implementation must be supplied as a verified hosted backend; adding
`claude-backend` discovery does not itself certify that implementation.
The standalone legacy `@endo/claude-sandbox` remains separate and is not an
implementation of this hosted contract.

## Non-blocking scope

Arbitrary live mount replacement remains unsupported; no such authority is
exposed by the new adapter.
If introduced later it needs the full replacement-race contract, not a partial
mount mutation path.
Checkpoint-based history reconciliation is already implemented and tested;
it is not reopened as a missing API dependency.
