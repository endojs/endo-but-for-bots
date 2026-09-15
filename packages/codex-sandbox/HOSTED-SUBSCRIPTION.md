# Experimental hosted Codex subscription

Provisioning is two idempotent scripts, mirroring the other CLI adapters, both
run through the Endo CLI with host powers and never session guest powers:

- `setup-host.js` mints the host-side formulas under `codex-sandbox/` — the
  owned native Podman runtime with its XFS quota observer, and the session state
  provider. They are constructed with slot-free `null` powers and are not
  re-created on a rerun, because an ownership marker and durable session state
  must survive one.
- `setup-hosted.js` mints the renewable credential and the backend caplet, and
  binds it into Floot's controller profile. Without `ENDO_CODEX_ENABLE=1` it
  enables nothing. Its configuration is `ENDO_CODEX_*` environment variables,
  from which it composes the backend's formula configuration; the header of the
  script lists them.

Both are intended for `ENDO_EXTRA`, so a clean daemon provisions Codex with no
operator script. This replaces an explicit one-shot entry point that refused an
existing backend outright, and which therefore had to be re-run by hand after
every teardown, host rebuild or state restore.

Formula revival requires that code and its dependencies to remain available.

## Authentication

On a trusted machine, obtain a fresh Codex ChatGPT login and import its complete
renewal-bearing `auth.json` into general Secrets at
`secrets/codex-subscription-auth` (or the configured `secretPath`).
Do not paste credentials into chat, a command argument, repository, or log.
Normalize that login to `BrokerOAuthStateV1` before setup; `setup-hosted.js`
refuses a record that is not one rather than converting it, because converting a
credential is not something a script that runs on every daemon start should do.
It pins the selected account in formula configuration.
The refresh token remains the renewal authority; a cached access token is only
usable until expiry and is never copied to the model slice.

Setup is idempotent but not silently so. The refusals that mattered in the
one-shot entry point are kept, and are now about what changed rather than about
setup having run before:

- A credential pinned to a different Secrets record fails closed
  (`provideManagedRenewableCredentials`).
- An existing backend pinned to a different account, or running under a
  different owner label, is refused before anything is minted.
- The volume registry records one owner and refuses a changed project-ID range
  outright, so setup checks the owner against the native runtime's first.

What is gone is the per-host installer lock: setup no longer performs a
one-time installation, so there is no installation to exclude. Two operators
running it concurrently is now the same exposure the other two adapters have.
Changing accounts still requires deliberate replacement/migration and new
session policy; revival never silently adopts a replacement account.

## Operator configuration

`setup-hosted.js` composes the backend's `CODEX_HOST_CONFIG` from `ENDO_CODEX_*`
variables and validates it before any mint; an unknown key is refused rather
than ignored. The record it composes supplies:

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
- `ownerId`: the Podman reconciliation label, the volume registry's recorded
  owner and the listener's lock name, derived from the host identity at setup.
  The registry refuses a change, so this is effectively immutable once a
  deployment has run one session.
- Optional `secretPath` and `accountRef`; setup defaults the account to the one
  the stored credential names, and refuses a value that disagrees with it.
- Optional `diagnostics: true` enables host-only fixed broker event/count and
  transport failure stage/HTTP-status logging, never request or credential data.
  The listener also emits at most four fixed failure-stage/header-check records;
  their destination depends on the host's container logging configuration.

The backend is published under `codex-sandbox/backend` and bound into
`floot/controller-profile/codex-backend` only after construction. It is minted
under a temporary name first, so a failed mint leaves the live backend and
Floot's binding to it working.

Its powers is a stored record of exactly three capabilities — the renewable
credential, the native sandbox runtime, and the state provider — rather than
`@agent`. The credential caplet is the one formula in this adapter still minted
with `@agent`, because the daemon vends a `SecretAdmin` only from
`@secrets/catalog` and makes no delegable form of it; see the module comment in
`@endo/hosted-agent/managed-renewable-credentials-module.js`.

Per-session audit entries, journal anchors and the thread checkpoint live in
host files under the state provider's root, not in the host agent's petstore.
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

- Inference uses a revocable session grant with four simultaneous request slots.
  There is no cumulative request, byte, cost, or one-hour lifetime budget.
  Requests retain the 8 MiB request/16 MiB response bounds; the private pipe also
  caps complete encoded CapTP frames at 8 MiB, including envelope overhead.
  These distinct transport envelopes still need consolidation.
  The subscription composition uses a ten-minute request deadline on listener
  and transport; other issuer users default to two minutes.
  Credential refresh is independent of grant and container lifetime.
  Successive turns retain the same app-server, workspace, and inference grant.
  Stop/restart still requires cleanup and native-checkpoint reconciliation;
  dispatched prompts are never replayed automatically.
- Broker application errors preserve the listener and return a generic HTTP error.
  A retrying CLI can still require cancellation after an inference failure.
- Abandoned registry transactions remain fenced for explicit operator recovery.
  Reaping containers alone does not prove old privileged subprocesses have stopped.
- A shutdown blocked on an unsettled Endo tool retains ownership and refuses to
  tear down its slice; do not force-retire that worker to bypass the barrier.
- The subscription inference route is empirically tested, not advertised here as
  a stable public vendor contract. Pin and revalidate the runtime before upgrades.
