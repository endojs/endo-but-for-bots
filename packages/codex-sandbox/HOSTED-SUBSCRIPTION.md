# Experimental hosted Codex subscription

`setup-hosted.js` is an explicit, one-shot operator entry point.
Without `ENDO_CODEX_HOST_CONFIG` it enables nothing.
Run it through the Endo CLI with host powers, never session guest powers.
Provide nonsecret JSON configuration in that environment variable and optionally
pin `ENDO_CODEX_MODULE_PATH` to a stable, operator-owned deployment path.
Formula revival requires that code and its dependencies to remain available.

## Authentication

On a trusted machine, obtain a fresh Codex ChatGPT login and import its complete
renewal-bearing `auth.json` into general Secrets at
`secrets/codex-subscription-auth` (or the configured `secretPath`).
Do not paste credentials into chat, a command argument, repository, or log.
The one-shot setup normalizes the full login to `BrokerOAuthStateV1` using a
generation-checked replacement and pins the selected account in formula config.
The refresh token remains the renewal authority; a cached access token is only
usable until expiry and is never copied to the model slice.

Setup refuses an existing backend before reading or changing its credential.
Reconfiguration requires deliberate operator replacement, not rerunning setup
and assuming new settings took effect.
A private per-host installer lock excludes concurrent setup; a crashed installer
leaves a lock requiring verified operator recovery.
Raw-login replacement after installation needs explicit normalization before use.
Changing accounts requires deliberate replacement/migration and new session policy;
revival never silently adopts a replacement account.

## Operator configuration

The JSON record supplies:

- `directory`: private persistent host state directory.
- `imageRef`, `listenerImageRef`: independently approved immutable OCI references.
  Rebuild the listener from this revision, not an older worker bundle.
- `volumeRoot`, `filesystem`: the rootless Podman volume root and XFS mount with
  effective project-quota enforcement.
- `quotaCommand`: canonicalizable, narrow privileged quota helper.
  It must validate exact allowed paths, project IDs and quota sizes before executing
  the `xfs_io`/`xfs_quota` operations used by `volume-host.js`.
  This package does not install sudo policy or grant a general root shell.
- `sudoPath`, `flockPath`: optional explicit host executable paths.
- `projectIds`: reserved inclusive `first`/`last` range; two IDs per session.
  IDs are allocated monotonically and not recycled by session destruction, so
  this range bounds lifetime session creation, not only concurrency.
- `workspaceBytes`, `stateBytes`: decimal byte strings, positive MiB-aligned
  reductions of the default 8 GiB/4 GiB ceilings.
- `maxSessions`: bounded concurrent listener capacity.
- `models`: operator-approved Codex descriptors, including supported reasoning
  efforts; this composition does not automatically enable the full CLI catalog.
- Optional `secretPath` and `accountRef`; setup selects and pins the account once
  if it was not explicitly provided.
- Optional `diagnostics: true` enables host-only fixed broker event/count and
  transport failure stage/HTTP-status logging, never request or credential data.
  The listener also emits at most four fixed failure-stage/header-check records;
  their destination depends on the host's container logging configuration.

The backend is published under `codex-subscription-backend`, in a dedicated worker,
and bound into `floot/controller-profile/codex-backend` only after construction.
Floot resolves configured backend bindings at selection time; existing sessions
retain their current backend until their normal lifecycle ends.
Codex exposes Floot's guest JavaScript as `endo_exec`, distinct from native `exec`.
Tool-catalog identity changes force an explicit thread rotation.
Floot supplies complete historical conversation text in `send`'s
`continuityContext` option, bounded to 262144 UTF-16 characters and the adapter's
combined prompt byte limit.
Only an empty/new native thread consumes it, as labelled historical data in a
text input: previous tool calls are never dispatched as replayed tool calls.
An existing native conversation ignores the continuity copy.
If the full history cannot fit, Floot supplies `continuityContextUnavailable`;
rotation then fails visibly before altering the old thread, rather than silently
discarding context.
The user can explicitly start a new Floot session in that case.
The adapter first acknowledges or reconciles any old-thread recovery marker
under its original catalog identity before starting the replacement thread.
New-thread creation persists an empty-thread marker so a crash before first
dispatch still restores conversation context on retry.

## Evidence and limits

Tokyo acceptance used NixOS 26.05, Codex 0.152.0, a fully allocated 2 GiB XFS
image, 512 MiB workspace/256 MiB state quotas, and an observed 4.75 GiB aggregate
writable ceiling including tmpfs/shared memory.
Strict runtime admission, real subscription renewal, real Floot Sol inference,
and guest-capability execution succeeded.
The assistant and tool results were readable from a fresh client.
The full Floot-driven Sol review subsequently completed 29 provider requests and
saved a 2,924-word Markdown document. Two fresh clients read the same document
digest and all 46 session history records, including 28 review tool records and
the final assistant response. This is bounded workload acceptance, not a claim
that full restart recovery is complete.
The earlier attempt exposed implicit 100,000-character request guards; the broker
and transport now admit configured larger bodies within a finite wire envelope.

This remains a bounded experimental composition:

- A provider lease lasts one hour and admits at most 64 requests, each bounded to
  8 MiB request/16 MiB response, with 1.5 GiB cumulative conservative reservations.
  These are byte ceilings, not guaranteed payload capacities: the private pipe
  separately caps each complete encoded CapTP frame at 8 MiB, including JSON
  escaping and envelope overhead.
  This transfer budget is not memory or disk allocation or monetary billing.
  The subscription composition opts into a ten-minute absolute request deadline
  on both listener and transport, additionally bounded by independent lease expiry.
  Other issuer users retain the two-minute default unless explicitly configured.
  Credential renewal is separate from resource-lease renewal.
  Before each explicit new turn, the hosted composition automatically provisions
  a fresh bounded lease and app-server generation using the same durable session,
  workspace, thread state, and checkpoint.
  The old client's pending-tool barrier and complete process/resource cleanup
  must succeed before the successor is admitted; cleanup failure refuses the turn.
  This permits long-lived conversations without sharing one lifetime request
  budget, at the cost of container startup and thread-resume latency every turn.
  Active turns are never interrupted to renew a lease, and a dispatched prompt is
  never replayed automatically.
  A single turn still has the one-hour/64-request ceiling: expiry or exhaustion
  during that turn is an error, not permission to refill its budget indefinitely.
  The next explicitly submitted turn starts a new generation and uses the usual
  durable-checkpoint reconciliation; failed-turn side effects are not undone.
- Broker application errors preserve the listener and return a generic HTTP error.
  A retrying CLI can still require cancellation after quota exhaustion.
- Abandoned registry transactions remain fenced for explicit operator recovery.
  Reaping containers alone does not prove old privileged subprocesses have stopped.
- A shutdown blocked on an unsettled Endo tool retains ownership and refuses to
  tear down its slice; do not force-retire that worker to bypass the barrier.
- The subscription inference route is empirically tested, not advertised here as
  a stable public vendor contract. Pin and revalidate the runtime before upgrades.
