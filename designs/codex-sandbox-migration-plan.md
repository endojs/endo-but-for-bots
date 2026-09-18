# Migrating codex-sandbox onto the shared hosted-agent shape

Written 2026-09-15 against the PR #1248 head as deployed on `endo-tokyo`
(`7dfe61954` = `2b1ffa4a7` + three local commits). Updated 2026-09-16 after
Codex Sol was stood up and run end to end on that layering — see
"What standing Sol up actually proved" below, which turns several of the
questions here from speculation into measurement — and again the same day after
phases 1–5 were executed; each phase records what its exit actually met.

PR #1248 generalized the hosted-session layering into `@endo/hosted-agent` and
moved `claude-sandbox` and `opencode-sandbox` onto it. `codex-sandbox` was left
on its original bespoke wiring. This plan is how it catches up.

**Executed 2026-09-16 on branch `codex/codex-sandbox-hosted-migration`**
(endo) and `codex/hosted-subscription-nixos` (endo-host). Phases 0–5 are done;
Phase 6 was deliberately not attempted. Two things turned out differently from
the plan and are recorded where they belong: the native runtime opens its
*factory* facet rather than the scope service (Phase 2), and the credential
caplet still holds `@agent` because the daemon makes no delegable form of a
`SecretAdmin` (Phase 4). Neither was a choice about how much work to do; both
are properties of what the daemon and Codex's session model actually are.

Codex is **not** behind on the security property people usually mean by this —
it had broker-held credentials and a credential-free slice first, in the
2026-09-10 experiment, and that is what the shared layer was generalized *from*.
What it is behind on is **layering**: it holds `@agent`, stores its own session
state, and is configured by a different mechanism.

## Where the three packages actually stand

Imports from `@endo/hosted-agent`:

| Module | claude | opencode | codex |
|---|:--:|:--:|:--:|
| `hosted-setup.js` | ✓ | ✓ | — |
| `current-specifier.js` | ✓ | ✓ | — |
| `session-plan.js` | ✓ | ✓ | — |
| `session-storage.js` | ✓ | ✓ | — |
| `session-state-storage.js` | ✓ | ✓ | — |
| `managed-credentials{,-module}.js` | ✓ | ✓ | — |
| `mcp-bridge/socket/stdio-bridge.js` | ✓ | ✓ | — |
| `provider-broker-service.js` | ✓ | ✓ | — |
| `provider-broker.js` | ✓ | ✓ | ✓ |
| `public-network.js` | ✓ | ✓ | ✓ |
| `session-registry.js` | ✓ | ✓ | ✓ |
| `cleanup-scope.js` | — | ✓ | ✓ |
| `provider-grant-issuer.js` | — | — | ✓ |
| `provider-listener-runtime.js` | — | — | ✓ |
| `public-egress.js` | — | — | ✓ |
| `secret-rotator.js` | — | — | ✓ |

Claude and OpenCode differ from each other by exactly one entry. Codex shares
four and reaches past the service layer into the broker primitives directly.

Setup and configuration:

| | entry points | wired into `ENDO_EXTRA` | configuration | continuity |
|---|---|---|---|---|
| claude | `setup-host`, `setup-hosted`, `setup-peer` | all three | declarative `ENDO_CLAUDE_*` | `transcript` |
| opencode | `setup-host`, `setup-hosted` | both | declarative `ENDO_OPENCODE_*` | `transcript` |
| codex | `setup-hosted` only | **none** | one JSON blob in `CODEX_HOST_CONFIG` | `opaque-reconciled` |

The clearest single symptom: `codex-sandbox/src/hosted-subscription-module.js`
is minted with `powersName: '@agent'` and keeps the host agent in its closure
for the caplet's lifetime, using it to create and write a
`codex-subscription-state/<sessionId>/{entries,anchors,thread}` petstore
subtree. That is exactly the responsibility Claude and OpenCode moved out into
daemon-owned `state-provider` and `session-storage` formulas.

## A note on the Claude peer factory

`claude-sandbox/setup-peer.js` and its `claude-credentials/` factory are legacy
relative to the Secrets-backed path, but should not be removed yet. The factory
issues a per-session `IssuedCredential` whose `materialise()` is **single-shot**
and throws after revoke or rotate — a real containment property that bounds how
long a credential is usable and by whom. The `managed-credentials` path that
replaced it delegates a plain read capability with no such bound. Whatever the
renewable path above ends up looking like, it is worth checking against this
older design before the peer factory is retired.

## What standing Sol up actually proved — 2026-09-15

The plan was written from the source. Then the backend was provisioned and run,
which is a different kind of evidence. Acceptance item 6 is now **met**: a Codex
Sol turn completed on the PR #1248 layering with no credential in the slice,
writing a WebGL scene, publishing it, and serving it publicly (133s,
`gpt-5.6-sol`). Three turns in one session, all `completed`.

### Continuity is fine, and that was worth checking

`opaque-reconciled` is a real mode, not a gap. Asked from memory with no tools,
the session recalled its opening prompt:

> You asked me to build a static webpage featuring a slowly rotating,
> snow-capped 3D mountain floating above a landscape.

So the difference from `transcript` is what Floot's tree is *for*, not whether
the conversation survives: Claude and OpenCode persist a transcript Floot
mirrors into the tree, while Codex owns the thread and the tree is display-only
with per-turn checkpoints Floot acknowledges. Design question 4 already said
continuity is backend-level and neither `session-plan.js` nor
`session-state-storage.js` encodes it; this confirms it from the outside.

### The shared listener works, unmodified

Sol runs against `localhost/endo-provider@sha256:adcc31bc…` — byte-identical to
the listener the Claude and OpenCode brokers use on this host. The
"listener images must be rebuilt from the migrating revision" hazard is real
and was paid (the 2026-09-10 digest predates the ~788-line
`provider-listener-runtime.js` rewrite), but there is no Codex-specific
listener. One image serves all three.

### The cost of being outside `ENDO_EXTRA`, measured

Acceptance item 3 remains unmet, and the price is no longer hypothetical. The
2026-09-15 user-space teardown removed every Codex formula; the credential
under `secrets/codex-subscription-auth` survived, as intended. Claude and
OpenCode came back on the next daemon start because their setups are wired into
`ENDO_EXTRA`. Codex did not come back at all, and `listBackends()` returned
`["provider","claude","opencode"]` until an operator hand-ran
`ops/provision-codex-sol-20260915.mjs`. Any teardown, host rebuild or state
restore has this same manual step until Phase 5 lands.

### A hazard the plan did not have: project IDs are a LIFETIME budget

The sharpest thing the live run surfaced, and it is Codex-only. Provisioning
succeeded and then every session failed:

```
XFS project ID space exhausted
```

`durable-volumes.js` allocates two project IDs per session, monotonically, and
never recycles them:

```js
// Never reuse project IDs: a crash or orphan cannot inherit a later
// session's quota. Empty-project limit retirement is administrative.
```

So `projectIds: { first: 42010, last: 42013 }` is not "two concurrent
sessions" — it is **two Codex sessions for the life of the host**, and the
2026-09-10 experiment had spent both. Worse, the state is sticky in two ways
that matter to anyone migrating:

- `state.exhausted` latches `true` in `volumes.json` and is checked *before*
  `projectIds.last`, so widening the range does not revive an exhausted
  registry;
- `checkRegistry` refuses a changed range outright — `Project ID range
  changed` — so the range cannot be edited in place at all.

The migration used was a **fresh registry beside the old one**: a new
`directory` with a disjoint range (`42020–43019`), leaving the old durable
records untouched rather than hand-editing them. That is the shape any
range change has to take, and Phase 5's `PROJECT_IDS` env must carry it.

The host-side half is a NixOS change, because `ops/codex-quota.py` hard-codes
`FIRST, LAST` as the privilege boundary for the quota helper; the formula
config and the helper have to move together.

**For Phase 3.** Design question 3 asked whether `session-storage.js` should own
the quota concept. The registry is the reason the answer is not simply "yes":
it holds a monotonic allocator, a latched exhaustion flag, a per-session lease,
and a range it refuses to see changed. None of that is expressible in
`session-state-storage.js` as it stands, and all of it is load-bearing. Either
Codex keeps its own volume provider beside the shared storage (the cheaper,
recommended answer), or the shared layer grows a durable allocator it currently
has no other consumer for.

### Codex extracts an image digest without checking it

`hosted-subscription.js`:

```js
const imageDigest = imageRef.slice(imageRef.indexOf('@') + 1);
```

No validation. A `CODEX_HOST_CONFIG` whose `imageRef` carries a tag instead of
a digest makes `indexOf('@')` return -1, `slice(0)` return the whole reference,
and the "digest" that reaches the broker grant and the slice policy is the
image name. Claude and OpenCode route this through
`readSliceImageReference` / `resolvePinnedImageRef`, which refuse a malformed
digest and — since 2026-09-16 — resolve a tag through Podman and strip it,
because `name:tag@digest` is a reference the native runtime rejects
(`PINNED_IMAGE_REFERENCE_PATTERN` admits a registry port and no tag).

This makes Phase 1 concretely worth doing on its own: adopting those two
helpers replaces an unchecked `slice` with the same validation the other two
adapters get, and it is a no-behaviour-change edit for an already-pinned
config.

## What must survive the move

None of this exists in the other two adapters, and none of it should be lost:

- **XFS project-quota volumes** — `durable-volumes.js`, `host-volume-provider.js`,
  `volume-host.js`, `volume-limits.js`, `volume-registry-worker.js`, plus the
  privileged `quotaCommand` helper and `projectIds` range. The shared
  `session-storage.js` has no quota concept.
- **Subscription renewal and account pinning** — `subscription-auth.js`,
  `subscription-setup.js`, `secret-rotator.js`. The refresh token is the renewal
  authority; the account is pinned in formula config and re-checked on every
  credential read including revival, and replacement fails closed.
- **The audit journal** — `audit-journal.js`, with entry/anchor size budgets. No
  shared equivalent.
- **Codex app-server protocol** — `app-server-transport.js`, `codex-client.js`,
  `codex-protocol.js`, `runtime-verifier.js`, `sandbox-policy.js`.
- **`opaque-reconciled` continuity.** Codex reconciles an opaque upstream thread
  rather than replaying a transcript. `session-plan.js` / `session-storage.js`
  were written for `transcript` adapters and this is the semantic that has to be
  proven compatible, not assumed.

## The four design questions to settle first

These are decisions, not tasks. Settle them before writing code.

### 1. Renewable credentials are the general case, not a Codex quirk — the blocker

Revised 2026-09-15 after inspecting what the three adapters actually store.
This section originally framed renewal as something Codex must not *lose* when
adopting `managed-credentials`. That was backwards.

Measured on Tokyo (shape and classification only; no token material read):

| secret | shape | generation | renewal |
|---|---|---|---|
| `secrets/openrouter-auth` | static API key | — | not needed |
| `secrets/claude-creds` | bare `sk-ant-oat…` string, 108 bytes | **1** | none possible |
| `secrets/codex-subscription-auth` | JSON `BrokerOAuthStateV1`: `accessToken`, `refreshToken`, `expiresAt`, `accountId` | **7** | working |

`sk-ant-oat…` is the long-lived subscription grant that `claude setup-token`
issues, so generation 1 is correct — it is not a short-lived token that failed
to rotate. The gap is the **exchange step**: `claude-broker.js` builds a policy
with `credentialHeader: 'bearer'` and forwards that long-lived grant straight to
`ANTHROPIC_MESSAGES_PATH`. There is no token exchange anywhere in
`claude-sandbox` — no `oauth/token`, no `grant_type`, no exchange call. Codex
does exactly that exchange, through `secret-rotator.js`, and its credential has
been renewed six times.

So the three adapters need **two** credential models, not one:

- **Static** — a key that never expires. OpenCode/OpenRouter. The existing
  read-only `managed-credentials` cap is exactly right, and this is why
  OpenCode is the one hosted backend currently working on Tokyo.
- **Renewable** — a long-lived grant exchanged for short-lived access tokens,
  written back under a generation check. Codex has it. **Claude needs it and
  does not have it**, which is the leading explanation for the uniform broker
  502 blocking every Claude session.

That inverts the migration direction on this dimension: `managed-renewable-
credentials.js` is not an accommodation for Codex, it is the shared path **two
of three adapters need**, and Claude is the one presently broken for lack of it.
Codex is the reference implementation to generalize *from*.

Revised recommendation: build the renewable path as a sibling to
`managed-credentials.js`, sharing catalog lookup and generation-checked
replacement but delegating read+rotate, and extract it from
`codex-sandbox/src/subscription-auth.js` + `hosted-agent/src/secret-rotator.js`
rather than designing it fresh. Then make Claude its second consumer.

Two caveats before anyone treats this as a Claude fix:

- Adding the machinery does not by itself repair Tokyo. The stored Claude
  credential is a bare string with no `refreshToken`/`expiresAt` envelope, so it
  would have to be re-minted into a state record first — the equivalent of what
  Codex's one-shot setup does when it normalizes a full `auth.json` to
  `BrokerOAuthStateV1`.
- The 502 remains *unproven* as an expiry. It is consistent with a missing
  exchange step, but also with a revoked grant or a wrong beta header, and
  `claude-sandbox` has no `diagnostics` switch to tell them apart (see Hazards).
  Landing Codex-style diagnostics for Claude is the cheapest way to find out and
  should probably precede any credential work.

### 2. One-shot operator entry vs. declarative `ENDO_EXTRA`

`HOSTED-SUBSCRIPTION.md` is explicit that `setup-hosted.js` is *"an explicit,
one-shot operator entry point"* that *"without `ENDO_CODEX_HOST_CONFIG` enables
nothing"*, and that *"setup refuses an existing backend before reading or
changing its credential"*. That refusal is a security property: it stops a rerun
from silently re-pointing a pinned account.

Claude and OpenCode re-run their setups on every daemon start and are idempotent
by construction. Moving Codex to that model means finding a new home for the
refusal — probably: re-running is fine and idempotent, but a *change* to
`accountRef` or `secretPath` against an existing backend fails closed rather
than being applied.

Do not drop the guard in the name of uniformity.

### 3. Quota-backed storage under `session-storage` — ANSWERED, keep it separate

Either `session-storage.js` grows a pluggable volume provider that Codex
supplies (XFS project quota), or Codex keeps `host-volume-provider.js` beside
the shared storage and only the *state/transcript* half converges. The second is
much smaller and probably right for a first pass.

Running the registry settled it: the volume side is not a thin quota wrapper
but a durable monotonic allocator with a latched exhaustion flag, a per-session
lease and a range it refuses to see changed — see "project IDs are a LIFETIME
budget" above. Nothing else in `hosted-agent` wants any of that. Codex keeps its
own volume provider; the shared storage stays quota-agnostic and takes the
state/transcript half only.

### 4. Does `opaque-reconciled` fit the shared session plan? — ANSWERED, yes

Settled by the Phase 0 spike (`ops/phase0-codex-shared-primitives.mjs`, 9/9
against the deployed release). `opaque-reconciled` never arises: continuity is a
**backend-level** property, reported through `listBackends()`, and neither
`session-plan.js` nor `session-state-storage.js` encodes it. The plan layer is
about paths, a resource profile, and mount settings; the storage layer is about
one owned host directory per session. Both are continuity-agnostic.

The concern that `session-plan.js` might bake in transcript-replay assumptions
was unfounded, and the plan *shape* is per-adapter anyway
(`opencode-session-plan.js`, `claude-session-plan.js`), so Codex writes its own
and reuses the shared readers. No `hosted-agent` change is required before
phases 3–5.

## Phases

Each phase is independently landable and independently revertable.

### Phase 0 — spike — DONE 2026-09-15

`ops/phase0-codex-shared-primitives.mjs`, run inside the built release so
workspace deps resolve. **9 checks, 9 pass.** A Codex-shaped session record
survives every shared primitive unmodified:

- `readNativeProfile` accepts the Codex resource profile.
- `readMounterEnv` accepts the recorded rootless mount settings.
- `readRecordedPath` accepts a **quota-backed podman volume path**
  (`…/storage/volumes/codex-ws-<id>/_data`) — the shape most at risk of being
  refused, since the other two adapters only record plain directories.
- `containsPath` confirms Codex's state/workspace/mcp paths are mutually
  disjoint, which the per-adapter plan readers require.
- `makeSandboxSessionId` derives a conforming id with a `codex` fallback.
- `makeSessionStateStorage` prepares, re-prepares idempotently, and removes a
  session directory under a Codex session id.

Two early failures were spike bugs, not layer defects, and both taught
something: `readMounterEnv` requires the mount program to actually invoke
`mount` (a truncated `sudo` alone is refused), and the storage interface is
`prepareSessionDirectory`/`removeSessionDirectory`, not `prepare`/`remove`.

**Exit met.** Phases 3–5 may proceed in the order given.

**What the spike deliberately did not prove**, and which remains real work:

- That `session-state-storage.js` can *enforce* an XFS project quota. It creates
  plain directories; the spike showed only that a volume path is expressible as
  a recorded path. Design question 3 is therefore the live one.
- That Codex's petstore-backed audit journal, with its anchors and byte budgets,
  can move onto a filesystem-backed store. That is Phase 3 work with its own
  design question, and nothing in the plan layer blocks it.

### Phase 1 — adopt the leaf utilities — DONE 2026-09-16

`current-specifier.js` and `cleanup-scope.js` (already used), then
`hosted-setup.js` for `readRuntimeConfig` / `providePrivateDirectory` /
`assertNoRuntimeLeftovers`. Replace ad-hoc directory creation in
`hosted-subscription-module.js`.

Also `readSliceImageReference` / `resolvePinnedImageRef`, replacing the
unchecked `imageRef.slice(imageRef.indexOf('@') + 1)` in
`hosted-subscription.js`. This is the one part of Phase 1 that fixes something
rather than merely sharing it: today a tagged `imageRef` in `CODEX_HOST_CONFIG`
silently yields the image name as the digest.

No behaviour change for an already-pinned config; `CODEX_HOST_CONFIG` still
drives everything. **Exit:** existing Codex acceptance still passes, and a
tagged `imageRef` is either resolved or refused rather than accepted as a
digest.

**Exit met.** `src/hosted-runtime-setup.js` binds the shared helpers to this
package's label, as opencode's does, and `readPinnedSliceImage` refuses an
unpinned tag, a malformed digest, and `name:tag@digest` — the last being valid
reference syntax Podman accepts and the native runtime refuses. Two adoptions
came with it: `sandbox-policy.js` now tests the runtime's exported pattern
instead of a transcription made before that pattern was exported, and the
configured host directory goes through `providePrivateDirectory` instead of
being `mkdir -p`'d blind by both the volume registry and the listener lock.

### Phase 2 — split the module in two — DONE 2026-09-16

Mirror the claude/opencode shape: a `setup-host.js` that mints host-side
infrastructure (native runtime, state provider, volume provider) and a
`setup-hosted.js` that mints the credential, broker, and backend. Keep the
one-shot semantics for now.

**Exit:** `codex-sandbox/{native-sandbox,state-provider}` exist as formulas and
the backend resolves them by verified entrypoint, as claude's does.

**Exit met, with one deliberate difference.** `codex-native-agent.js` opens the
runtime's **factory** facet, not the scope service `@endo/sandbox/native-agent.js`
returns. Codex's attested provisioner builds each slice with `make`; Claude's and
OpenCode's daemon-owned session controllers acquire a scope and call
`makeResolved`. Moving Codex to scopes is a change to its *session model* —
slice admission, cleanup, and the attested provisioner — not to where its runtime
is constructed, and the two are worth doing separately. A `null` scratch provider
is what makes the factory host-only, which is exactly what the hand-written
`noScratch` exo the backend used to pass was for.

The shared entry point could not serve Codex at all: the Podman driver admits a
durable volume mount only on evidence from a trusted kernel-quota observer, and
`native-agent.js` takes slot-free `null` powers with no slot for one. So
`makeSandboxRuntime` gained an optional `volumeQuota` power (three lines in
`@endo/sandbox`), and Codex's entry point builds its observer from configuration
— a volume root, a filesystem, and the operator-installed bridge. Nothing
capability-shaped crosses the formula boundary.

The observer is passed as a *promise*, because resolving the quota executable is
async and the runtime must be constructed synchronously: a runtime created inside
an `await` in `open()` could be created after a cancellation had already run
`close()`, stranding its ownership marker — finding 10's failure mode. `open()`
awaits it before the runtime claims its marker, so a misconfigured bridge is
refused at construction rather than at a session's first mount.

`codex-host-config.js` also landed here: the first reader of `CODEX_HOST_CONFIG`.
Nothing parsed it before — `JSON.parse(env.CODEX_HOST_CONFIG || '{}')` handed
whatever came out straight to the composition — which is how a stale
`publicInternet` survived into a configuration and made revival throw `Invalid
public network configuration`. It refuses unknown keys outright.

### Phase 3 — move session state off `@agent` — DONE 2026-09-16

The largest phase, and the point of the exercise. Replace the petstore subtree
with `session-storage.js` + `session-state-storage.js` owned by the daemon.
Port `audit-journal.js` onto the shared storage rather than `storeValue` on the
host agent.

**Exit:** `hosted-subscription-module.js` no longer needs `@agent`; it is minted
with an attenuated powers object — the secret, its admin, and its storage —
and `makeHostedCodexSubscription` keeps receiving no host agent at all.

This is also the phase that answers the question "what does it use `@agent`
for?" with "it doesn't any more."

**Exit met.** The journal asked its powers for four methods — `list`, `has`,
`lookup`, `storeValue` — which a directory answers as well as a petstore does,
so `codex-session-store.js` is that directory and `makeStoredAuditJournal`
(renamed from `makePetstoreAuditJournal`) did not change. A test runs the real
journal over real directories, appends, reopens, and verifies the chain.

Values are stored in the journal's own canonical encoding rather than JSON,
for two reasons: an entry's `sequence` is a bigint, which JSON cannot carry,
and the canonical form is the form the hash chain is computed over — so a file
on disk is verifiable against the chain exactly as written.
`parseCanonicalAuditJson` is its exact inverse and refuses anything the encoder
would not have produced, including a record whose keys are unsorted or repeated,
since such a document could re-encode to a different hash. Writes go to an
exclusive temporary and are renamed into place: an append-only chain has no way
to repair a half-written entry.

`codex-sandbox/state-provider` is `makeStateStorageOperations` from the shared
`session-state-storage.js` with one added method. `locateSessionDirectory`
answers without creating: Codex reads a thread checkpoint before it provisions
anything, and `prepareSessionDirectory` would leave a state directory behind for
a session that never started. Floot session ids are mixed-case, so the directory
name comes from the shared `makeSandboxSessionId` — slug plus a digest of the
original, so two sessions cannot collide into one directory.

The backend's powers is now a stored marshal record of exactly three
capabilities. One formula still holds `@agent`; see Phase 4.

### Phase 4 — credential convergence — DONE 2026-09-16, one exit unverified

`@endo/hosted-agent/managed-renewable-credentials{,-module}.js`, extracted from
`codex-sandbox/src/subscription-auth.js` and `hosted-agent/src/secret-rotator.js`
as design question 1 recommended. Account pinning and generation-checked
replacement are preserved exactly; `secret-rotator.js` now *names* its
`replaceBase64` guard so both facets share one rather than a transcription — a
transcription that dropped the closed rest would let a misspelled
`{ ifGeneraton }` through as `undefined` and turn a conditional write into a
blind overwrite, which is the exact failure that guard exists to prevent.

**The finding this phase produced, which the plan did not have: a renewable
credential cannot be delegated on the current daemon.** A renewing holder needs
two authorities over one record, and the daemon makes exactly one of them
delegable:

- `secrets/<name>` is a `lookup` formula (`@secrets/use/<grantId>` on the root
  host), so a read facet has a formula identifier and can be another formula's
  `powersName`. That is why `managed-credentials.js` works.
- A `SecretAdmin` is created inside the secret manager by `makeAdmin` and vended
  only by `@secrets/catalog`. It never passes through `evaluateFormula`, so
  `idForRef` has no entry for it: it cannot be named as powers, and
  `storeValue({admin})` fails with `No corresponding formula`.
- `@secrets` is not a smaller capability to mint with — `specialNames['@secrets']
  = hostId`, so it resolves to the host formula itself.

So the caplet takes `@agent` and gives back exactly one pinned record's
`readBase64`, `readBase64WithGeneration` and conditional `replaceBase64`.
`revoke`, `delete` and `setDescription` are not on the facet. It resolves its
path once, at construction, so re-creating a secret under the same name cannot
silently re-point a live credential. It is deliberately the smallest thing that
can hold `@agent`, and it is the only Codex formula that still does.

Closing it needs a daemon change: a way for the catalog to bind an
administration facet at a pet name, the way `bindGrant` binds a read facet.
`secret-manager.js`'s own comment on `lookup` explains why the obvious spelling
(`admin/<secretId>`) is refused — a secretId is published on three surfaces —
which is exactly why this wants designing rather than adding. Keying it on the
grantId instead would silently upgrade every existing read grant into an admin
grant, so that is not the answer either.

**Exit:** replacing the account still fails closed — covered by tests, in three
places now (the credential's pinned record, the backend's pinned account, and
the owner label the native runtime runs as). **A renewal cycle through the new
path is NOT yet verified live**; that needs a deployed Sol session whose access
token expires, which is the one acceptance item no unit test can stand in for.

### Phase 5 — declarative configuration — DONE 2026-09-16, not yet enabled

`ENDO_CODEX_*` env mirroring `ENDO_CLAUDE_*` / `ENDO_OPENCODE_*`:
`NATIVE_PROFILE`, `STATE_DIR`, `WORKSPACE_DIR`, `MCP_DIR`, `BROKER_DIR`,
`BROKER_LISTENER_IMAGE`, `BROKER_OWNER_ID`, `CREDS_NAME`, `PUBLIC_INTERNET`,
`SANDBOX_IMAGE`, plus codex-only `VOLUME_ROOT`, `QUOTA_COMMAND`, `PROJECT_IDS`,
`ACCOUNT_REF`. Add `codexSandbox.*` options to `modules/endo.nix` and wire both
setups into `ENDO_EXTRA`.

`PROJECT_IDS` needs care the others do not: the range is a lifetime budget, it
cannot be changed in place, and its host-side half lives in `ops/codex-quota.py`
as the quota helper's privilege boundary. The Nix option and the helper must
move together, and a range change means a fresh registry directory.

**Exit:** `codexSandbox.enable = true` provisions Codex from a clean daemon with
no operator script, and `listBackends()` returns `codex` alongside the rest —
the step that was hand-run as `ops/provision-codex-sol-20260915.mjs` on
2026-09-15.

**Built, evaluated, not enabled.** `services.endo.codexSandbox` is re-cut for
this stack; its old options (`mountDir`, `workspaceDir`, `homeDir`,
`sessionStateDir`, `ninepSudo`) belonged to a Codex CLI sandbox that no longer
exists in the package and produced environment variables nothing read. Hosted
Codex mounts nothing over 9P, so the mount-cleanup unit and codex's term in the
9P sudo rule went with them, and the image-build unit too: the slice image is
built out of band and digest-pinned, like OpenCode's.

The `PROJECT_IDS` hazard is closed rather than documented: `codex-storage.nix`
substitutes the privileged helper's `FIRST, LAST` **and** `ROOT` from the same
NixOS options the allocator is configured with, and an assertion requires the
allocator's range to sit inside the helper's. An id the allocator hands out and
the helper refuses is a session that dies at its first volume mount, and the id
is spent either way.

Verified by evaluating the tokyo configuration with the flag both off and forced
on: the toplevel derivation resolves, the daemon's `ENDO_CODEX_*` environment is
what `setup-hosted.js` reads, `ENDO_EXTRA` carries both setup scripts, the helper
builds with the substituted range, and the assertion fails with a legible message
when the ranges disagree.

`enable` stays **false**. Turning it on requires an `endo.rev` containing this
migration — enabling it against an older revision points `ENDO_EXTRA` at a
`setup-host.js` the release does not have — so the flip is a separate deploy,
and `hosts/common.nix` carries the ordered steps and the values a live Sol
session was provisioned with.

### Phase 6 — MCP convergence (optional) — NOT ATTEMPTED

Adopt `mcp-bridge.js` / `mcp-socket.js` / `mcp-stdio-bridge.js` if `endo-tools.js`
can be expressed through them. Lowest value; do last or not at all.

## Hazards

- **Do not migrate a live deployment in place.** Codex pins an account against a
  renewable credential. Stand the new shape up beside the old, verify a renewal,
  then retire the old formula.
- **The `@agent` grant persists across deploys.** The formula's module path is
  `/var/lib/endo/current/...`, so a release swap changes the code behind an
  existing grant without re-minting. Until phase 3 lands, every deploy re-trusts
  that module.
- **Ownership markers are not released on cancel.** Any migration that mints a
  second native runtime under a new owner label will strand
  `<ownerId>.owner` / `<ownerId>.files` in the runtime directory. See finding 10
  in `PR1248-TOKYO-TRIAL-2026-09-15.md`.
- **Listener images must be rebuilt from the migrating revision.**
  `provider-listener-runtime.js` changed across ~788 lines in this PR; the digest
  recorded by the 2026-09-10 Codex experiment predates it.
- **XFS project IDs are spent permanently.** Two per session, never recycled,
  with a latched `exhausted` flag and a range `checkRegistry` refuses to see
  changed. Size the range as a host-lifetime budget, and migrate by standing up
  a fresh registry with a disjoint range rather than editing the old one. This
  is what made a freshly provisioned Sol fail every session on 2026-09-15.
- **Codex's image digest is unvalidated.** `imageRef.slice(imageRef.indexOf('@')
  + 1)` returns the whole reference when there is no `@`. Until Phase 1 adopts
  the shared readers, a tagged `imageRef` in `CODEX_HOST_CONFIG` puts an image
  *name* where the broker grant and slice policy expect a digest.
- **Diagnostics asymmetry is worth keeping.** Codex's config supports
  `diagnostics: true`, wiring `onDiagnostic` to log the real upstream failure.
  Claude has no such switch, which is why its 502s are undiagnosable. Converging
  should raise Claude to Codex's level, not the reverse.

## Acceptance

1. `codex-sandbox` imports the same `@endo/hosted-agent` modules as
   `opencode-sandbox`, except for its deliberate volume/subscription extras.
   **MET 2026-09-16.** `hosted-setup.js`, `current-specifier.js`,
   `session-plan.js`, `session-state-storage.js`, `managed-renewable-
   credentials.js`, `secret-rotator.js`, plus the four it already shared. The
   remaining divergence is the deliberate extras: XFS project-quota volumes,
   subscription renewal, the audit journal, and the Codex app-server protocol.
2. No Codex formula is minted with `@agent`.
   **MET for the backend; one formula remains.** The backend's powers is a
   stored record of `{credential, sandbox, stateProvider}`. The credential
   caplet still holds `@agent` because the daemon vends a `SecretAdmin` only
   from `@secrets/catalog` and `@secrets` resolves to the host formula itself —
   see Phase 4 for the exact reason and the daemon change that would close it.
   It is the smallest thing that can hold `@agent`: one pinned record, three
   methods out, resolved once at construction.
3. A clean daemon provisions Codex from `ENDO_EXTRA` with no operator script.
   **BUILT, NOT YET EXERCISED.** Both setups are idempotent and wired; the NixOS
   flag is off pending an `endo.rev` that contains the migration.
4. A subscription renewal completes through the shared credential path.
   **NOT VERIFIED.** The path is built and unit-tested; a real renewal needs a
   deployed session whose access token expires.
5. Replacing the pinned account still fails closed.
   **MET 2026-09-16**, in three places: the credential's pinned Secrets record,
   the backend's pinned account, and the owner label the native runtime runs as.
   Each refuses before anything is minted.
6. A Codex Sol turn completes with no credential in the slice — the property the
   2026-09-10 experiment established, re-verified on the new layering.
   **MET 2026-09-15**, before any migration phase: 133s, `gpt-5.6-sol`, scene
   written, published and served, three turns with continuity intact. The
   layering change is therefore not a prerequisite for Codex working — it is
   about `@agent`, provisioning and configuration, which items 2, 3 and 5 cover
   and which remain open.

## Open questions for the PR author

1. Was leaving Codex out of #1248 deliberate scope control, or an oversight? The
   `feat(hosted)!` title reads as covering all three.
2. Is the read-only `managed-credentials` cap a deliberate ceiling, or simply
   untested against a renewable credential?
3. Should `session-storage.js` own the quota concept, or stay quota-agnostic
   with Codex supplying its own volume provider? **Recommendation, after seeing
   the registry run:** stay quota-agnostic. The durable allocator, the latched
   exhaustion flag, the per-session lease and the immutable range are real and
   Codex-only; the shared layer has no other consumer for them.
4. Is the project-ID range meant to be a host-lifetime budget? Four IDs is two
   sessions, ever. If that is deliberate, Phase 5 should say so loudly in the
   Nix option's description; if not, the allocator needs a retirement path
   rather than a bigger number. **Phase 5 says so loudly, and closes the
   helper/allocator drift; the question of whether a retirement path should
   exist is still open, and is the one thing that would make this a budget an
   operator can actually manage.**
5. New, from Phase 4: should a `SecretAdmin` be delegable at all? Two of three
   adapters need read-plus-conditional-replace over one record, and there is no
   way to hand that to a formula without handing it `@agent`. `bindGrant`
   already binds a read facet at a pet name; an administration counterpart is
   the missing half. `secret-manager.js`'s comment rules out keying it on a
   secretId, and keying it on a grantId would upgrade every existing read grant,
   so it needs a third answer.
6. New, from Phase 2: Codex's provisioner builds slices with the factory's
   `make`, not a native scope's `makeResolved`. Should it move to daemon-owned
   session controllers like the other two, and is `opaque-reconciled` continuity
   compatible with the session-records model that comes with them?
