# Floot and backend architecture audit and remediation tracker

| | |
|---|---|
| **Created** | 2026-09-21 |
| **Updated** | 2026-09-21 |
| **Author** | kumavis (prompted) |
| **Status** | Active — remediation and retrospective durability audit in progress |
| **Baseline** | Endo `cdccdbb88`; endo-host `73405ca` |
| **Scope** | PR #1248 and the associated endo-host deployment wiring |

## Purpose and maintenance

This records the source audit and independent subagent reviews requested by the operator.
It tracks follow-up work within the existing
[hosted-agent sandbox unification design](../../designs/hosted-agent-sandbox-unification.md),
not a separate roadmap milestone.
The baseline is reviewed source, not a claim that it has all been deployed on Tokyo.
No implementation changes were made as part of the audit.

Backward compatibility is not a requirement.
Fresh session/daemon state is acceptable when deliberately arranged with the operator.
That does not authorize deleting Secrets, retained workspaces, or native resources blindly.
Prefer deleting obsolete paths before building abstractions around them.

For every remediation commit, update the affected finding here:

- Keep its stable `FA-` identifier and original evidence.
- Change its status and record the implementing commit or identifiable change.
- Record tests, review findings, and remaining limitations.
- Distinguish implemented, tested locally, and deployed/verified on Tokyo.
- Mark resolved only when its completion criteria are met; explain intentional deferrals.
- Update the change log and the design index when the overall status changes.

Every new implementation also requires a durability audit against the Endo
daemon's formula patterns before deployment approval.
This requirement is retrospective: audit all implementation changes already
landed as part of this refactor, not merely future changes or open findings.
Existing deployed status and passing local tests do not waive this check.
Inventory each implemented change and its durable boundary, record authoritative
replay/restart evidence, and reopen findings where that evidence is missing or
contradicts correct ownership and recovery.
Review durable owners and dependencies, reconstruction and replay, cancellation
and retirement, failed-write recovery, and previously issued capabilities.
Identify deliberately ephemeral state and prove that reconstructing it cannot
duplicate side effects or revive retired authority.
Tests of local objects alone do not establish daemon restart/replay correctness;
record and test the relevant durable formula boundary.

Source locations below describe the baseline and may move as code is removed.
Repository reachability does not prove that an exported or dynamically minted module has
no retained formula referring to it.

## Findings register

### Retrospective durability audit — required, in progress

The inventory starts at the unified-sandbox design commit `3332f1928` and
includes the current branch plus associated endo-host implementation changes.
Earlier infrastructure still used by the refactor remains in scope; this seed
is not an exclusion boundary.
The ancestry range through `65e939889` contains 345 commits, including upstream
changes that still need classification rather than an assumption of relevance.
No claim of complete retrospective coverage is made yet.

| Boundary | Current evidence / defect | Required follow-up |
|---|---|---|
| Catalog reads and renewal owner | Broker integration drains admitted metadata reads. Independent tests pass, including actual formula cancellation/reconstruction with renewal held open and an independently retained old facet. | Process-loss/external renewal transaction recovery remains unverified; broader pool/Secret ownership findings below remain open. Not deployed. |
| Pool member identity | Authoritative journal now persists actual Secret/share capabilities, provider/account binding, and removed-member tombstones before credential activation. Twenty-three shared tests and one real-daemon restart test pass independently. | Integrate full owner retirement/exclusion; historical IDs and bound capabilities are deliberately not reusable yet. Not deployed. |
| Formula disposal and replacement | Corrected locally: eventual invocation of remote hooks, exact-formula cancellation/collection fences, stale in-flight read invalidation, and disposal before reclamation. Thirty-two focused tests pass independently. | Deploy and audit each resource module's actual hook/admission drain. This does not establish cross-formula exclusion or persistent cleanup proof after process loss. |
| Credential ownership and Secret rebinding | Owned pool bindings retain actual capabilities and reject mutable-name rebinding. Member retirement now fences and drains retained facets, renewals, transports, wrapped readers/endpoints, and observation writes; 179 focused and two real-daemon tests pass. | Cross-worker renewal exclusion, retirement epochs, and process-loss transaction recovery remain open. Module-local drain does not establish these. |
| Native teardown after reconstruction | Corrected locally: absent/failed scope lookup now refuses stop acknowledgement, and mount reclamation waits for sandbox close. Six injected-reconstruction tests pass independently. Runtime lookup still reads only an in-memory map. | Durable exact-owner reconciliation and actual process-loss tests required before deployment; a missing scope cannot prove that native resources stopped. |
| Native state creation | Rewritten with unique inode-bound allocations, atomic ownership publication, and durable orphan-retirement intent. Twenty-seven focused tests and four subprocess SIGKILL regressions pass independently. | Retire old native state with the old release before coordinated deployment; verify on Tokyo. Abrupt process loss is tested, not physical power loss. |
| Mount inspection | Baseline `recorded-cleanup.js` treated all socket `lstat` errors as absence. Corrected locally with ten passing tests. | Deploy and verify with native cleanup; the independent reconstruction/cleanup-proof gap remains open. |
| Private journal deletion | `private-turn-storage.js` roots values under factory-host names; `cleanupSessionResources` removes session aliases and submissions, but not the journal namespace. Failed pre-publication creation also leaves namespaces without a reclamation path. | Durable, retryable journal retirement after writer shutdown; inventory and safely reclaim orphan namespaces; test crash/uncertain removal and daemon reconstruction. |
| Daemon value publication | Corrected locally: persist before name publication; transiently pin the new formula and all marshal slots; transfer caller retention only on success. Nine persistence/GC/restart tests pass independently. | Deploy; after-write lost acknowledgements leave unnamed durable formulas requiring reclamation. Abrupt crash injection remains unverified. |
| Codex checkpoint commit | Corrected locally: sync directory ancestry when opening and sync the containing directory after rename/removal, including absent-removal retries. Thirteen tests pass. | Deploy; broader checkpoint ownership/recovery audit remains open. Filesystem flush support is verified on Tokyo, not physical power-loss recovery. |
| Model picker | `65e939889` adds deliberately transient view state; persisted session route still travels through existing creation path. | No new formula required for the search query; session creation durability remains subject to its existing boundary audit. |

All rows above remain open except the classification of deliberately transient
picker state; that classification does not waive session-creation verification.
Full supervisor/storage, journal/restoration, broker/credential, publication,
network/image, and host deployment coverage is being inventoried separately.
Existing Tokyo evidence is retained: generation 159 / app `81f3428e3` passed
four-backend seed, actual daemon restart, and recall with the new private schema
and OpenCode fresh-session path.
That happy path does not prove archive-boundary recovery, unsettled effects,
torn formula/name publication, deletion/GC, or native cleanup after worker loss.
Formula-level cancellation/revival tests must also prove exactly one active
private-journal writer, rather than assuming object reconstruction over shared
Maps establishes that invariant.
Private journal retirement must occur only during terminal deletion, after the
writer and backend drain, not in generic `cleanupSessionResources`: startup also
calls that helper for incomplete creation and then reopens the existing schema.
The factory now registers and awaits its formula disposal hook before startup.
It fences retained factory/session/spawner facets, drains admitted work and
private journal/submission queues, and terminates backend admins without deleting
established sessions or persisting an operator emergency-stop flag.
Interrupted creation can still roll back its provisional session resources.
A second resource sweep and a post-acquisition fence stop late native admins.
Three real-daemon tests cover a held voice-preferences write, write-then-reject
uncertainty, and a held native creation that returns its admin during disposal.
Successful disposal permits reconstruction; failed admitted writes/creation
retain the daemon's failed-disposal barrier.
Independent unit/adjacent coverage passes 110 tests, with separate watcher tests
below. This does not establish full archived-turn/inbox process-loss recovery.
The final combined change passes all 446 Floot tests and the three real-daemon
factory lifecycle cases; scoped lint has no errors.
The clean type-build results below supersede the earlier declaration-baseline
failure reported during that slice.
Account observers now fence reconciliation after awaits, cancel retry timers,
explicitly close acquired oracle readers, and drain admitted refresh/reset calls.
Seven new watcher lifecycle tests plus eight existing projection/observation
tests pass; historical stream failure is distinguished from an independent
reader-close acknowledgement, and failed reader closure remains retryable.
A rejected watch-acquisition reply can still hide a remote reader allocation
whose capability was never received. This observer-protocol reclamation gap
remains open; no claim that every remote reader is reclaimed is made.
It does not grant the closed factory a new reader or revive its canonical writer.
Closed private-journal facades remain retained until factory disposal; terminal
journal namespace retirement and earlier facade reclamation remain open.
Source review found the separately minted account oracle ignored formula
disposal: `ensureWatching` could continue `applyObserved` journal writes after
Floot closed its own reader.
The oracle now exposes a private lifecycle kit and registers/awaits its formula
disposal hook before exposing the public account facet.
Disposal fences retained public calls and source pushes, cancels retry timers,
closes the acquired upstream reader through its explicit cleanup facet, and
drains admitted builds and journal writes before replacement.
Uncertain journal writes refuse handoff; ordinary observation/read failures
remain eligible for remembered-data fallback.
The unused facet-only constructor was removed rather than retained as a
compatibility wrapper; tests now retain and close their oracle kits.
Thirty-six oracle tests and fifteen Floot watcher tests pass, plus two
real-daemon held-journal-write tests, including write-then-reject uncertainty
and retained old-facet/source checks. Scoped lint has no errors.
This proves the tested formula-incarnation boundary, not cross-formula
same-namespace exclusion or process-loss observer reclamation.
An incarnation-local registry does not establish cross-worker exclusion.
Pooled member retirement now has a module-local admission/drain owner.
Removal fences retained account/model/reset/credential access, closes only that
member's inference transports and wrapped endpoints/status reader, drains
admitted renewals and reset outcomes, and retains failed cleanup owners.
Renewal CAS persistence already in progress remains unfenced; raw credential
failures conservatively prevent clean retirement, even for transient reads.
Provider transport close drains fetch-to-reader acquisition and body
cancellation. Independent review reproduced a response acquired after close
acknowledgement; nine deterministic microtask regressions cover the corrected
handoff. Independent status-reader close separates resource release from
historical stream errors.
Chooser observations use capability-bound v2 snapshots, never adopt v1 or
pre-identity history, and are fenced/drained on shutdown.
The final slice passes 179 focused tests and two real-daemon lifecycle tests;
independent adversarial review approved the corrected transport handoff.
These are not cross-worker exclusion or process-loss cleanup guarantees.
Durable `pendingRefresh` and identity journals remain authoritative on revival.
Failed credential/current calls, body cancellation acknowledgements, or remote
release can require operator recovery. Removed IDs/authorities remain tombstoned;
safe re-add and retirement epochs are not implemented.
Failed observation writes may lose cache hints but cannot grant authority.
An unpublished partial pool core can retain never-used transports until member
retirement; this remains a cleanup follow-up.
The daemon barrier now rejects reconstruction while exact-formula disposal is
pending or failed, including dependency cancellation.
It rejects rather than waits, so mutually dependent cleanup lookups cannot
deadlock on each other's reconstruction.
Collection sets its fence before controller withdrawal and invalidates in-flight
formula reads; stale disk bytes cannot re-enter the cache after deletion.
Controller disposal precedes storage deletion, and worker disconnection is
attempted even if reclamation fails.
Failed disposal preserves storage; failed deletion/reclamation retains a fence.
Successful collection removes its fence and in-flight read tracking is bounded
by outstanding reads, not an ever-growing successful-collection tombstone set.
Four actual cross-worker disposal tests and four manager/persistence GC fault
tests pass, alongside context, construction, and marshal tests (32 total).
Failure boundaries identified during review included remote-hook invocation, revival
during deletion, a late inspector read, and skipped cleanup after reclamation
failure. The final tests cover these boundaries.
The fences last only for the current daemon incarnation; native resources still
require independent reconciliation after process loss.
Native cleanup source review confirms that current Podman labels identify the
runtime owner and a random operation, not a durably recorded session scope.
Either missing reconstructed scope prevents native-stop acknowledgement.
Missing sandbox closure proof also prevents mount reclamation; a missing broker
scope does not prevent reclaiming the mount after the sandbox has closed.
The native supervisor now fails closed when either original scope cannot be
recovered, and awaits successful sandbox closure before recorded mount
reclamation. Failed cleanup preserves the native record and storage for retry;
already released owners are retained as such during a same-incarnation retry.
Six new injected-reconstruction tests cover missing sandbox/broker scopes,
null/rejected lookup, rejected close, storage retention, retry, and held-close
ordering.
These tests use the production session owner and supervisor, but are not an
actual process-loss or Podman reconciliation test.
Automatic reconciliation still requires recorded scope/incarnation identity
and proof that old producers can no longer create resources.
Broad container sweeps are not such proof.
Deployment of this cleanup behavior remains blocked on that reconciliation:
after a real restart even a legitimately absent scope currently lacks proof.
The operator approved a narrowly scoped privileged producer adapter, conditional
on keeping the implementation portable rather than tied to Tokyo or its OS.
The proposed owner is a host-private native-runtime resource; sessions receive
only their own incarnation-scoped producer capability.
The shared lifecycle contract must describe durable identity, command admission,
shutdown proof, and cleanup receipts without systemd or Linux-specific fields.
Tokyo's systemd adapter belongs in host wiring behind that contract; other hosts
can provide another adapter, and unsupported hosts must fail closed.
Before native effects, record the incarnation and its opaque adapter ownership
reference. Fence it durably before stopping producers, then reconcile only its
exact recorded resources and publish a durable receipt.
Model containers gain no additional privileges; shared credential/renewal owners
and retained workspaces stay outside per-session native cleanup.
Current host startup owner-marker/name-prefix sweeps must be replaced with this
exact ownership protocol before deployment. This is approved design direction,
not an implemented or verified recovery capability.
Independent host review also found port/UID-based process killing, recursive
socket deletion, and mount-prefix lazy unmounts in `modules/endo-daemon.nix`.
Daemon exit alone does not establish ownership or stop proof for these resources.
The replacement must not retain these as fallback cleanup paths or inherit the
existing unrestricted mount/umount sudo command surface.
Verify pending launches and delegated descendants are stopped, and leave unknown
resources untouched; unit inactivity alone is not a cleanup receipt.
The runtime's exclusive owner symlink also lacked directory flushes.
The local fix flushes directory ancestry before acquisition and the marker's
directory before returning an effect-producing owner.
Release now flushes its unlink and retries failed flushes without deleting a
successor's marker. A failed publication flush leaves exclusion in place and
requires explicit recovery; it does not silently treat the marker as stale.
Four new tests cover pending/failed publication flush, ancestry failure, and
release retry with a successor present; the adjacent runtime and owner suites
also pass (39 cases through the package's test configurations).
This verifies flush ordering and fail-closed behavior on supported filesystems,
not physical power-loss durability or automatic orphan reconciliation.
Mount-inspection fix: the default recorded-cleanup socket check now treats only
ENOENT as absence and propagates EACCES/EIO before unmount or directory removal.
Ten focused tests pass, including vanished-entry success and both inspection
failures; this adds no durable state or replayed effect and does not close the
separate missing-native-cleanup-proof finding.
Codex checkpoint fix: acknowledgement waits for the post-rename directory flush;
flush failures reject even when the new value is already visible.
Reopening retries ancestry flushes after incomplete preparation, and an absent
deletion retry still flushes a potentially unacknowledged unlink.
Thirteen focused tests cover these boundaries, with independent adversarial review.
Tokyo's endo user successfully opened and synced `/var/lib/endo/codex-state`
and every ancestor through `/` using the production flags; `/var/lib/endo`
is on `/dev/vdb`, ext4.
This proves filesystem/permission support, not deployment or a power-loss test.
Verified ignored generated declarations, source maps, and build-info files were
moved to recoverable temporary quarantine; checked-in declarations, source,
dependencies, and unrelated files were not moved.
The clean rebuild exposed source contract errors previously hidden by stale
declarations: subscription fields, iterator signatures, credential validation
narrowing, issuer optional authority, usage shapes, and a setup `pool` boolean
leaking into the runtime pool-capability option.
Explicit guards preserve validation behavior; missing usage remains distinct
from known-zero usage. The setup flag is now removed before runtime assembly.
With the local contract corrections and oracle lifecycle changes, the clean
repository `yarn build:types` passes. Incremental generation still reproduced
TS5055 output/input collisions and remains a separate build-system issue.
Tests for the UI/Claude/Codex contract corrections pass (59, 11, and 19 cases);
scoped lint has no errors. Independent review also passes 170 hosted-agent tests.
The root `yarn test:types` also passes all 14 opted-in package tasks.
API documentation generation against the corrected declarations completed with
3,148 errors and 152 warnings; this gate remains failing, separately from the
passing clean declaration build. Incremental generation and documentation need
further diagnosis; no repository-wide green-build claim is made.
The documentation run repeatedly compiles root-project diagnostics in several
package conversions; its error total is not a count of distinct defects.
The package-mode docs reader now selects each package's production roots using
TypeDoc's public options API, retaining explicit entrypoints and normal imported
dependency checking. Generated declarations no longer hide JavaScript roots.
Two regression tests and independent review pass; five previously missing
entrypoints now convert. The full documentation run completes with 13 errors
and 104 warnings: 12 distinct source/declaration diagnostics plus the failed
conversion summary. This supersedes the earlier repeated-root error count, but
does not establish a passing docs gate. Remaining diagnostics concern asset
server method types, OpenCode bridge/transcript annotations, exported native
controller/setup declarations, and hosted-agent pass-style dependency resolution.
Three Floot source contract corrections cover optional cached-input usage,
snapshot wire validation, and optional tool-preview truncation flags.
Independent review rejected an unchecked snapshot cast: local callbacks can
return non-passable values, and the buffer does not validate without a pattern.
Snapshots and updates now share an explicit passability check before allocation
or delivery. Validation precedes cache mutation and JSON equality checks so
invalid local data cannot poison later snapshots; detached read failures remain
retryable. The 36 focused account-tool/session-watch/tool-evidence tests pass,
including invalid initial/update data and same-JSON corrected-data recovery.
The full Floot suite passes all 449 tests; scoped ESLint has no errors.
Package TypeScript checking no longer reports Floot `src` diagnostics, but still
fails on test fixtures; this is not a passing package type gate.
The changes add no stored state, formula lifecycle, or provider effects.
Daemon publication fix: nine tests exercise pending/failed persistence with
absent and existing names, successful publication, failed-publication collection,
and an actual daemon process restart.
With collection enabled, replacing a directory's sole name with a copy record
containing its capability preserves the referenced directory and contents,
including after restart; the new marshal slot retains the original formula.
All seven deferred-publication callers were inspected; none requires names to
be published before formulation.
Independent adversarial review reproduced an additional defect: another
operation can remove the last root of a referenced capability while formula
persistence is pending, before the new dependency edges are registered.
The regression observed the referenced directory's persisted formula disappear.
The working-tree correction pins every distinct marshal slot before the first
await, retains the new formula through publication, and releases temporary pins
on both success and failure.
Independent adversarial review and the concurrent-removal regression now pass.
Failed persistence releases the temporary dependency pins, allowing collection
after the sole old root was removed.
After-write lost-acknowledgement injection preserves absent/existing names but
leaves an unnamed durable formula; its reclamation remains an open requirement.
Restart is orderly, not physical power loss between each persistence step.
Existing graph cleanup after a throwing operation runs on a subsequent graph
operation; the failed-publication collection test explicitly drains that work.
Catalog integration evidence: independent runs pass 45 shared catalog/scopes/
projection tests, three Codex adapter tests, seven OpenCode adapter tests, and
one real-daemon formula cancellation/reconstruction test.
The latter verifies renewal completion precedes close acknowledgement and
successor construction; the old in-worker facet remains fenced afterward.
No durable catalog cache or model-admission policy is introduced in this slice.
Pool identity now uses a separate authoritative `pool-identities-v1-*` journal,
not the chooser's best-effort capacity/cache state.
The broker resolves a declared Secret/share name to its actual capability and
persists that binding before constructing a credential handler.
Consumers retain that capability instead of repeatedly resolving a mutable name.
Read, schema, lookup, and write uncertainty fence the journal instance; it never
silently starts with empty authority history.
The real-daemon test persists formula-backed capabilities across restart and
checks identity, tombstones, and pet-name rebinding refusal.
An injected durable-write failure constructs zero credential handlers.
This is a prerequisite, not complete pooling: retired IDs cannot be reactivated,
and historically bound capabilities cannot be assigned another ID.
The journal retains those capability references.
Full owner draining/retirement, safe retirement epochs, and cross-formula/worker
exclusion remain open. Distinct Secrets containing copied credentials are not
detected as the same provider renewal authority.
The host-only `modelCatalog(subscriptionId?)` result reports each account
separately as current, unavailable, or unsupported; it is not a pool-wide
permission to serve a model.
Adapters use the existing credential owner and do not start a sandbox or
inference turn for discovery.
Codex derives its client version from the packaged OCI manifest; OpenRouter
projection preserves raw provider routes and only advertised reasoning efforts.
Static setup/factory/NixOS lists and Fae discovery wiring still need removal
or replacement before FA-07 can be considered complete.
Native state recovery now has operator approval for a breaking layout rewrite:
uniquely allocated directories with atomically published ownership records.
A marker-before-fixed-directory draft was rejected because crash recovery
could adopt a foreign directory; that draft was removed.
Implementation and independent adversarial review are complete locally.
Native data now lives at `native_allocations/<session>-<nonce>/data`; only that
directory enters the sandbox, while ownership and retirement records stay
host-private.
Records bind the allocation and data directory device/inode identities using
bigint strings; missing or substituted published data is not recreated or adopted.
Creation retries flush ancestry and ownership publication; deletion retries
flush prior unlinks even when the corresponding name is already absent.
Orphan cleanup first preserves proof outside the allocation, so partial recursive
deletion cannot erase the evidence needed for a later retry.
Unproven partial allocations are inventoried but left for operator investigation.
Review caught and corrected five issues: publication retry flushing, absent
deletion retry flushing, ancestry flushing, orphan proof loss during deletion,
and allocation path incompatibility with sandbox mount policy.
Seventeen shared, eight Codex, and two Claude tests pass independently.
Four additional subprocess tests stop a separate Node process with SIGKILL at
directory creation, record opening, complete record writing, and publication.
Recovery runs only after the child has closed, with no child cleanup handlers.
Unpublished allocations are not adopted; complete unreferenced ownership proof
permits scoped cleanup, while incomplete proof is preserved.
Published allocation identity survives reconstruction without directory reuse.
These tests strengthen process-loss evidence but do not simulate power loss,
filesystem write-cache loss, or native Podman lifecycle integration.
The administrative owner must serialize per-session lifecycle work and keep
the root quiescent during orphan cleanup; host paths must remain stable.
These storage operations do not establish that native consumers have stopped.
Retire affected test sessions and old native storage using the old release before
deployment, preserving Secrets, renewal credentials, and workspaces.

| ID | Priority | Finding | Evidence class | Status |
|---|---|---|---|---|
| FA-01 | High | Archived failed turns disappear from history/context | Reproduced bug | Fix deployed; bounded selection pending |
| FA-02 | High | Direct-provider context reads lossy UI previews | Reproduced bug | Fix deployed; compaction policy pending |
| FA-03 | High | Claude's old form/credential topology is still provisioned | Live legacy infrastructure | Source removed and inventoried producers retired; acceptance pending |
| FA-04 | High | OpenCode retains obsolete controller and unused state service | Obsolete path / unused allocation | Source removed, old storage/state formulas retired; acceptance pending |
| FA-05 | High | Recorded native resource profile does not drive execution | Ignored configuration | Removed; old plans retired before coordinated deployment; acceptance pending |
| FA-06 | High | Session provisioning and restart policy are triplicated | Duplication with observed drift | Open |
| FA-07 | High | Runtime, provider, account, and model route are conflated | Ontology mismatch | Open; provider-backed model discovery prioritized before further acceptance |
| FA-08 | Medium | Logical session identity is coupled to execution incarnation | Ontology mismatch | Open |
| FA-09 | Medium | Storage/environment contract lacks local development storage | Missing resource abstraction | Open |
| FA-10 | Medium | Event reduction and conversation conversion are duplicated | Duplication | Open |
| FA-11 | Medium | Floot retains migration and compatibility scaffolding | Reachable legacy branches | Positional API, usage cache, and legacy registry import removed locally; private-journal migration pending |
| FA-12 | Medium | Credential shims and obsolete API wrappers remain | Compatibility entrypoints | Broker wrapper and credential shims removed locally; deployment verification pending |
| FA-13 | High | Host image builder does not match shared-base Containerfile | Stale live integration | Shared-base images built, deployed, and restart-verified; scoped cutover matrix passed |

## FA-01 — Archived failures are missing from normal history

`agent.js`'s `getHistory()` and `getTranscript()` read `turnJournal.list()`, which
contains the retained window, rather than an archive-aware conversation view.
Older successful turns can still appear through conversation-tree nodes.
Failed turns without those nodes disappear from the projections when archived.
The underlying journal data is not deleted.

Evidence: [history/transcript reconstruction](agent.js),
[archive implementation](src/turn-journal.js), baseline lines 2175/2218 and 450 respectively.
An in-memory fake-provider experiment failed the first turn, then completed 290 turns.
The failed input disappeared from history but remained in `getArchivedTurns()`.
Archiving happens at snapshot boundaries, not exactly at the 256th turn.

Completion: an archive-aware reader preserves failed/cancelled turn evidence and branch
membership in history and restoration; regression tests cross archive boundaries.
Do not fix this by loading an unbounded lifetime history into memory without a paging or
explicit context-selection policy.

Progress: `fix(floot): restore archived turns and full provider context` merges
archived and retained records per request, deduplicates by turn ID, orders them,
and filters successful turns to the selected branch.
Reading retained records first avoids losing a turn during concurrent archival.
Tests cross the archive boundary with 290 turns and cover hosted revival.
This does not add a lifetime resident cache, but full-history requests still materialize
all records: archive pagination and explicit bounded context selection remain open.
Not deployed or tested against a long-lived Tokyo session.

## FA-02 — Model context must not be built from UI previews

The direct-provider loop reconstructs input from `getHistory()` (baseline `agent.js:1321`).
Journal fallback fields in that presentation view can be 8,192-character previews.
Hosted restoration instead hydrates full content references through
[transcript projection](src/transcript-projection.js).

Reproduction: fail a 9,014-character user input ending in `IMPORTANT-TAIL`, then inspect
the fake provider's next request.
The replayed input is 8,192 characters and the tail is absent.
Recovered long tool arguments/results use the same preview path; truncated arguments can
also cease to be valid JSON.
This is accidental loss, not deliberate compaction.

Completion: every runtime consumes a canonical full-content transcript/context projection;
UI previews remain presentation-only.
Tests cover long failed input, tool arguments/results, archives, and explicit compaction.

Progress: the direct-provider loop now hydrates the canonical transcript instead of
replaying UI previews; regression tests preserve long failed inputs and tool evidence.
Provider replay gives each call a fresh ID and labels unanswered outcomes as unknown.
Adversarial review found cross-turn native-ID reuse could misattach a later result;
the fix clears pending correlation at user boundaries while preserving same-turn parallel calls.
All 47 focused tests pass, including that regression; the independent reviewer reran 27.
The full Floot suite passes 407 tests; package ESLint has no errors; formatting passes.
Explicit compaction/context selection remains open: this converter does not implement
a compaction policy, and the full-history replay can grow without a context bound.
The full-content fix is now deployed; bounded context remains open.

## FA-03 — Retire the live Claude form topology

At the baseline, the host's `modules/endo-daemon.nix` ran `setup-host.js`, `setup-peer.js`, and
`setup-hosted.js` (baseline lines 88–91).
[setup-host.js](../claude-sandbox/setup-host.js) provisioned the old sandbox-form
factory; `setup-peer.js` provisioned credential forms.
The old factory dynamically minted `claude-client-module.js`, which materialized credentials
into the guest environment.
This was a second, live topology alongside the brokered hosted path, not dead code.

Removal cluster in `packages/claude-sandbox`:

- `factory.js`, `credentials.js`, `setup-peer.js`.
- `src/claude-sandbox-factory.js`, `src/claude-client-module.js`.
- `src/claude-credentials-factory.js`, `src/claude-credentials-module.js`.
- Legacy generic sandbox factory/shared mounter provisioning and form guests.
- Corresponding exports, scripts, form documentation, and dedicated tests.

Keep the native runtime and current state-provider parts of `setup-host.js`.
Trace `hosted-agent/src/session-powers.js` and its legacy factory consumers before removal.
Move meaningful coverage in `floot/test/container-mounts-sandbox.test.js` from the old
caplet to the current native-controller/session-owner path.

Completion: fresh setup creates only the current topology; retained legacy formulas,
containers, mounts, listeners, and credential grants are deliberately retired; current
Claude tool use, restart, and deletion pass without legacy entrypoints.

Progress: `refactor(claude-sandbox): stop provisioning legacy form topology` removes
the generic factory, shared mounter, and inbox-form producer from `setup-host.js`.
The paired endo-host change removes the automatic `setup-peer.js` hook.
Retained bindings are intentionally untouched; their resources still require explicit
retirement before deploying the remaining entrypoint removals or resetting deployment state.
The setup-host and setup-hosted suites pass 16 tests, including fresh native-only setup,
idempotent setup, distinct host ownership, and preservation of retained legacy bindings.
Independent review caught two stale test expectations; both were corrected before commit.
This initial implementation was not deployed until the coordinated cutover below.

Preparation for source deletion now preserves the generic daemon coverage in a
test-only dependency-bundle fixture rather than the legacy `session-powers` module.
The two real-daemon regressions pass: exact dependency identity across rebinding,
restart, and collection, plus remote send/adopt endowment versus a bare presence.
Short per-test names avoid macOS's socket-path limit while retaining unique suffixes.
The [coverage and retirement map](../claude-sandbox/docs/legacy-retirement.md) records
what survives and what is intentionally obsolete.
Successful arbitrary `/mnt` attachments belonged to the legacy path; the current Claude
backend refuses them, and removing legacy tests must not imply otherwise.
The permission check initially blocked the 16-file deletion; the operator explicitly
approved that exact source/test/document set before removal proceeded.
Approval does not cover deleting Tokyo data, Secrets, or workspaces.

Source removal: `refactor(claude-sandbox): remove legacy form and client topology`
deletes the approved 16 files, their dangling exports/scripts, and the shared legacy
`session-powers` entrypoint after its last production caller disappears.
The native controller, current state provider, protocol client, mount bridge, and generic
sandbox/9P infrastructure remain.
Documentation describes the current brokered topology and the required retirement gate.
Independent repository/CI/host reference searches found no current caller outside the
deleted cluster and its removed export/script entries.
The full suites pass: Floot 402 tests after removing its five legacy-path tests,
Claude 180 tests, and hosted-agent 541 tests with one skipped.
The hosted-agent typecheck still fails with 179 declaration errors (for example missing
`E`/`Passable` in exo-stream declarations); no deleted-module reference appears in that log.
Repository-wide lint stops at formatting issues in ten untouched files (asset-server,
Anthropic streaming, provider-listener runtime, OpenRouter, and usage-label tests).
The documentation build fails with 8,985 errors and 113 warnings across repository declarations
and entry-point conversion; it is not a passing gate.
The independent review approved the source/export removal and corrected documentation.
Both preserved real-daemon regressions pass after deletion.
Claude and hosted-agent ESLint pass with zero errors and 276 warnings.
This source removal is recoverable from Git and has not been deployed to Tokyo.

## FA-04 — Delete obsolete OpenCode machinery, not merely its duplication

The current native controller directly constructs `opencode-client.js`.
The 718-line old `src/opencode-client-module.js` (at the baseline)
has no current production mint/import path found in the repository, but is exported and
may still be referenced by retained formulas.
Its provisioning, cancellation, Mount facade, and cleanup topology are removal candidates.
Some current client tests import old helpers; split those tests rather than deleting their
current-client coverage.

Separately, [the native controller](../opencode-sandbox/src/opencode-native-controller.js)
prepared a persistent state directory at baseline lines 145–150 and never used the result.
The actual runtime uses `OPENCODE_DB=':memory:'` and a home on `/tmp` (lines 259–266).
The SQLite/WAL persistent-bind comment at lines 172–175 is stale.
Remove the unused state-provider dependency, setup, allocation, legacy Mount API, and
associated cleanup plumbing; retain workspace ownership and the stack's transcript.
Investigate the obsolete `opencodeSessionId` plan field: current plan creation never sets it.

Completion: fresh native OpenCode sessions allocate no unused CLI-state directory and need
no legacy client module; restoration, tools, stop, and deletion still pass.

Progress: `refactor(opencode-sandbox): remove obsolete client formula entrypoint`
deletes the old module, its export, and tests dedicated to its removed helpers.
The current protocol client, native controller, and their tests remain.
Repository and endo-host reference searches found no current producer of the old entrypoint.
The focused client/controller/conformance suites pass 60 tests; independent review
reran 53 client/controller tests and found no source-level blockers.
Package ESLint reports no errors (36 warnings).
Not deployed: retained legacy formulas must be retired with their old release available
before switching releases; source deletion alone is not runtime retirement.

Progress B: `refactor(opencode-sandbox): remove unused CLI state service` deletes the
unused state-provider modules, exports, setup, controller allocation, and dependency role.
The storage owner now receives null powers and removes only its recorded workspace and
private socket directories; Claude/Codex retain their existing optional CLI-state cleanup.
The paired endo-host change removes the unused state-directory option and environment value;
it does not delete any existing directory or data.
Retained OpenCode storage formulas have the old powers shape and must be recreated alongside
their backend/session records before this release is activated.
The shared hosted-agent suite passes 545 tests with one skipped, using loopback socket access.
Sandbox-restricted runs failed because local test listeners could not bind.
No Nix evaluation was possible locally because Nix is unavailable; host source review passed.
The OpenCode package suite passes 226 tests; the reviewer independently ran 84 focused tests
plus shared-storage and null-powers module checks.
Review caught a daemon integration fixture still minting the deleted module; it now exercises
null-powered storage and retains the daemon-owner destroy assertions.
That integration test passes after shortening its generated socket path for macOS;
the fixture retains its unique suffix and does not alter production socket placement.
Deployment is complete; native conformance and the separate `opencodeSessionId` audit remain open.

### Obsolete native-session resume removed

Current producers never set `opencodeSessionId` in session plans, and the native
runtime uses an in-memory database and temporary home.
The parser now rejects that retired field explicitly, including empty values,
before acquiring session resources.
The controller no longer supplies resume options or `OPENCODE_SESSION_ID`.
The client no longer accepts an initial native ID or skips restoration because
a previous native conversation supposedly exists.
It still learns the actual native ID from `ready` for diagnostics and keeps
once-per-incarnation canonical transcript import before the first prompt.

The bridge now creates a fresh native conversation on every startup and neither
reads nor writes `opencode-session-id` files.
It advertises `fresh-session`; the new client requires this capability before
dispatch, so an old resuming bridge cannot silently receive duplicate history.
Subprocess fixtures cover stale IDs/files, a non-directory state location,
creation refusal, and malformed creation responses.
Review also found that failed imports previously cleared the restoration flag,
allowing the next send to bypass restoration.
The corrected client fences that incarnation after failed or uncertain restoration
instead of retrying an import or sending a prompt without the required history.

This slice is not deployed.
The bridge is baked into the image: rebuild and pin the OpenCode image together
with the host client at the next coordinated cutover, and retire old session
plans using the old release first.
The fire-and-forget `initialPrompt` client path has been removed;
repository search found no production caller.
Client construction no longer has a branch that dispatches a prompt and
silently discards all events/errors.
A regression verifies construction neither spawns the bridge nor writes a
command, and only the subsequent explicit send dispatches a turn.
This removes a replayable side-effect path rather than adding durable state.
The focused client/controller suites pass 51 tests; changed-file lint has no
errors. Independent adversarial source review approved this deletion;
deployment remains pending.
The equivalent unused Claude construction-time prompt path is also removed,
including its obsolete replay-detection commentary.
Fresh and prior-conversation client tests verify that construction stays inert
and the next explicit send retains its existing resume behavior.
Fifty-one Claude client/controller tests pass; independent source review approved
the deletion and changed-file lint reports no errors. Deployment is pending.
Neither deletion introduces a new persistence mechanism or changes the
canonical transcript restoration path.
The full OpenCode suite passes 227 tests, and an independent reviewer reran
72 client, plan, controller, and subprocess startup tests successfully.
Package ESLint reports zero errors and 37 warnings; formatting and diff checks pass.
The scoped TypeDoc run fails with 895 errors in the inherited project graph,
including missing `Far` declarations; no passing docs/type gate is claimed.

## FA-05 — Remove or wire the ignored native profile

All three hosted setups require a `nativeProfile`; backend plans persist it and parsers
validate it using [session-plan.js](../hosted-agent/src/session-plan.js).
Native controllers instead build slices with
[`HOSTED_SLICE_RESOURCES`](../hosted-agent/src/hosted-agent-policy.js).
The recorded profile is not the effective execution resource policy.

Preferred cleanup: remove the unused hosted setup/plan configuration and its host callers.
If operator-configurable profiles are needed, define one explicit execution profile used
by both construction and verification, rather than preserving a nonfunctional setting.

Completion: no accepted resource setting is silently ignored; tests assert effective
limits and reject unsupported profile changes.

Progress: the paired endo-host change `be0803e` removes the three profile options,
their environment exports, and the shared host value.
All three changed Nix files pass `nix-instantiate --parse` on Tokyo; no configuration
was evaluated, built, or activated.
The app removal must land with this host change: old setup scripts require the removed
environment variables, while new plan parsers reject the obsolete `nativeProfile` field.
Existing native session records therefore require retirement/recreation using the old release
before activation; do not switch first and expect the new parser to clean up old plans.
The effective hosted slice-resource policy and generic sandbox profiles are unchanged.
The app change `refactor(hosted-agent): remove ignored native resource profiles` removes
profile input from the three hosted setups/backends, plans, and the shared parser helper.
Adversarial review caught that merely deleting the field left old plans silently accepted;
all three parsers now explicitly reject an obsolete `nativeProfile` field before acquisition.
Regression coverage asserts new plans omit it and effective runtime limits remain enforced.
Focused tests pass: OpenCode 86, Claude 43, Codex 48, shared plan 3, daemon integration 2.
The reviewer independently ran 80 focused tests and 33 updated parser tests.
Changed-JavaScript lint has no errors; formatting passes.
The daemon fixture uses a short unique name for macOS socket limits; native Linux execution
has not been exercised by these macOS owner/storage lifecycle tests.
This is now deployed after old-plan retirement; native conformance remains open.

## FA-06 — One session provisioner and execution envelope

The three `*-backend-module.js` implementations repeat service resolution, placement,
foreign-workspace validation, record inspection, immutable-field checks, stop/revise,
directory creation, and activation.
The three backend factories also repeat serialization and admin-handle lifecycle rules.

Observed drift:

- Codex protects state, runtime, and broker roots on activation; Claude/OpenCode compare
  foreign workspaces against a narrower root set.
  This is policy drift, not a demonstrated unprivileged exploit.
- Claude refuses subscription changes without destroying the session; Codex permits revision.
- Subscription discovery/error handling differs; Claude drops `pinnedOnly` while Codex keeps it.
- Codex verifies raw slice placement before normalized evidence; the others use narrower checks.

Keep the shared [session supervisor](../hosted-agent/src/session-supervisor.js).
Extract a provisioner for durable ownership/placement and a narrow execution-envelope
builder/verifier for common mounts, resources, and network evidence.
Adapters should declare differences, not copy the lifecycle algorithm.

Completion: one implementation owns each common invariant; conformance tests run all
three adapters through partial acquisition failure, stop/retry, restart, and deletion.

## FA-07 — Separate runtime, provider, account, and route

Implementation review gate: every new implementation must be audited against
the Endo daemon's durable formula patterns, not only its in-memory behavior.
Identify the durable formula owner and dependencies, what is replayed on daemon
restart, which state is intentionally reconstructible, and how cancellation,
retirement, and failed writes affect previously issued capabilities.
For model discovery, catalog snapshots may be reconstructed, but account/member
identity and renewal ownership must not silently change or duplicate on replay.
Add restart/replay coverage for durable claims and explicitly record any missing
evidence before treating an implementation as ready for deployment.

Floot owns the direct-provider inference loop in `agent.js`, while hosted runtimes implement
a separate backend interface.
The direct runtime is represented internally by the absence of a hosted backend ID and
externally as `provider`/Fae.
OpenRouter catalogs are separately declared in Floot and OpenCode.
[Account views](src/account-watch.js) use backend-based identities.

Additional operator finding (2026-09-21): Tokyo's Codex menu is restricted to
`services.endo.codexSandbox.models` in endo-host `hosts/common.nix`.
`modules/endo-daemon.nix` passes the JSON as `ENDO_CODEX_MODELS`.
Codex setup copies its IDs into the retained broker configuration as well as the
backend catalog, so adding a UI model currently changes retained service policy
and requires deployment/retirement instead of ordinary discovery.
Only Sol was configured; Luna was therefore absent from the menu.
The temporary, uncommitted NixOS Luna addition was withdrawn at the operator's request.

Required in this remediation session, before resuming model-dependent acceptance:

- Remove deployment-specified model lists; NixOS must not enumerate UI models.
- Obtain model options and available thinking/capability metadata from the
  provider's supported discovery interface, using the configured account through
  the appropriate runtime adapter where necessary (for example Codex app-server).
- Share provider discovery between Fae and OpenCode instead of separate static
  OpenRouter lists; project only routes supported by the selected runtime/account.
- Make the new-session model selector searchable within the selected backend.
  Match display names and exact model IDs case-insensitively, show a clear
  no-results state, and preserve keyboard selection and the exact selected route.
  Verify this with a large discovered OpenRouter catalog; do not truncate the
  available choices to make an unsearchable selector manageable.
- Keep discovery distinct from session execution and credential ownership:
  listing models must not create a conversation or start an inference turn.
- Expose unavailable/failed/stale discovery honestly; do not silently substitute
  another model or restore a deployment-owned static catalog on failure.
- Verify the new-session UI receives the discovered choices, including Luna and
  OpenRouter's free auto route, without editing NixOS or replacing a broker to
  change those choices. Preserve exact session route pinning and broker authority.

Acceptance cost policy is separate from discovery: test Codex with `gpt-5.6-luna`,
Fae with `openrouter/free`, and OpenCode with `openrouter/openrouter/free`.

End-to-end discovery/admission implementation sequence:

1. Establish durable account/Secret bindings and exclusive credential ownership.
   Authority records must fail closed on read/write errors; the chooser's
   best-effort warm/refusal snapshots cannot carry authority tombstones.
   Secret generation changes during renewal are not identity changes.
2. Project account catalogs without adding a second cache or credential owner.
   Pinned subscriptions use only that account; automatic routing excludes
   pinned-only accounts and retains model/effort-specific eligibility.
3. Replace global `policy.models` admission with account-bound checks before
   sending inference, including failover and subscription/share restrictions.
   Missing discovery never becomes wildcard permission or a static fallback.
4. Wire factory and session model listings to the same provider catalog.
   Preserve exact model/effort pins in durable plans and on restoration;
   unavailable models must not be replaced with a new default.
   OpenCode's current send path rejects nonempty reasoning effort, so provider
   effort metadata alone does not justify exposing that runtime control.
5. Remove Nix/setup model enumeration and Floot's hardcoded OpenRouter lists.
   Add OpenCode's route prefix only at its adapter boundary; Fae and OpenCode
   must share provider discovery rather than separate model authorities.

Required regressions include disjoint account catalogs, different effort sets,
partial failure, all-unavailable/empty catalogs, removed accounts during reads,
pinned-account refusal without fallback, share restrictions, and exact route
roundtrips through picker, persisted plan, CLI adapter, and broker.
The host test drivers must refuse missing routes and existing paid-route manifests
before inference, while still allowing inspection and cleanup.
This is required work, not a future deferral or a claim of completed discovery.

Implementation progress: standalone host-only Codex and OpenRouter catalog readers
now use the existing credential owner and fixed provider metadata endpoints.
They bound response bodies and descriptors, reject incomplete/duplicate catalogs,
sanitize failures, and retain provider-advertised reasoning metadata.
Independent review covered both readers and caught a cross-provider timestamp
mismatch; both now report epoch milliseconds.
The initial focused suite passes 24 tests; these are mocked metadata reads, not
live discovery or inference acceptance.
An additional one-shot metadata-only probe on Tokyo successfully read 443
account-filtered OpenRouter models, including 375 text-output/tool-capable models.
The requested `openrouter/free` route advertised text/image input, text output,
tools, a 200000-token context, and no concrete reasoning-effort metadata.
No inference or credential writes were performed; this does not test Codex discovery.
The new-session picker now searches names and IDs within its selected backend,
retains all choices, and preserves exact routes and existing thinking selections.
Independent review and component tests cover a 150-model catalog and no-results
handling; all 52 Floot component tests pass after correcting an outdated quota-label
assertion to match the existing label formatter and its unit test.
This is not a live-browser accessibility or deployed picker acceptance result.
Broker/account-generation binding, account-specific route admission and failover,
static configuration removal, live searchable-UI verification, and deployment
remain pending.
Pool review found that editing a member's account or secret binding under an
existing ID reused its cached credential handler and could mix old credentials
with new account metadata.
A reviewed per-incarnation guard now pins each accepted ID's authority tuple,
including removed-ID tombstones, and rejects rebinding before changing live state.
Labels, weights, and pinned-only metadata remain editable; 12 diagnostics tests pass.
This is not complete ownership retirement: same-authority removal/re-add can
still create another credential handler while old grants exist, unchanged secret
pet names can resolve to replaced capabilities, and identity pins do not yet
survive restart alongside persisted chooser state.
Resolve those lifecycle/generation cases before claiming account-bound discovery
and safe renewal ownership complete.
The root documentation gate failed with 9035 errors and 113 warnings in the
project graph; no passing documentation/type gate is claimed.

Model these independently:

| Concept | Responsibility |
|---|---|
| Runtime | Fae loop, Claude Code, Codex app-server, OpenCode |
| Provider | Inference endpoint/protocol |
| Account or pool | Credential, renewal, billing and selection authority |
| Model route | Explicit model or router such as `openrouter/free` |
| Execution profile | Image, mounts, network support and effective resources |
| Logical session | Conversation and workspace |
| Incarnation | One live execution of the session |

Make the direct loop another runner behind the session-facing contract, not another sandbox.
Model choices should intersect provider routes, account authorization, and runtime support.
The UI need not expose every axis just because the implementation distinguishes them.

Completion: no absent-backend special case in session orchestration; account identity does
not depend on runtime; route selection and model capabilities have a single projection path.

## FA-08 — Separate durable identity from incarnation pins

Broker configuration pins the guest image along with provider authority.
Backend plans derive the image from that broker and treat several image/account fields
as immutable for the recorded session.
Binding grants to the exact image of an incarnation is valuable.
Making conversation identity inseparable from that image or billing configuration is not.

Completion: replacing an execution incarnation can update explicitly authorized image or
provider bindings while preserving conversation/workspace, with old authority fenced before
replacement and explicit handling of failed transitions.
Do not weaken per-incarnation image/grant checks to accomplish this.

## FA-09 — Give local development storage an explicit role

The projected 9P workspace is a capability filesystem, not a promise of ordinary local
filesystem behavior for toolchains, package caches, SQLite, and build output.
Small temporary RAM-backed directories are not durable toolchain storage either.
The Lean installation experiment exposed this gap; it was not an end-to-end Lean audit.

Define persistent per-session local tools/cache/build storage separately from the workspace,
with byte/inode enforcement, ownership, deletion, and restart semantics.
Describe those facts in the agent's environment contract and generated prompt.
A larger host disk alone does not enforce per-session limits.

Completion: the agent can install and reuse a toolchain on suitable local storage, knows
which paths are projected/temporary/persistent, and cannot exhaust the host through an
unbounded per-session storage grant.

## FA-10 — Share representations without erasing authority distinctions

Deduplication targets:

- Reply-event folding in `floot/src/session-turn.js:110` and
  `chat/floot-component.js:218` at the baseline.
- Segment conversion in completed and partial hosted-turn commits in `agent.js`.
- Reconciliation duplicated between history and native-restoration projections.

Use pure reducers/converters with explicit correlation IDs.
Host-recorded tool intent/outcomes and guest-reported tool activity are different evidence.
Keep them distinguishable, even when one action is shown once in the UI.

Completion: daemon snapshots and browser deltas converge under the same fixture corpus;
success, failure, cancellation, and restoration share record conversion without inventing
guest-reported effects or dropping host-observed uncertainty.

## FA-11 — Remove compatibility scaffolding after cutover

Reachable legacy branches, not intrinsically dead functions:

- [Private journal migration](src/private-turn-storage.js): import manifests,
  acknowledgements, synthetic `legacy-import`, and related agent plumbing.
- Old registry/backup migration and legacy prompt-context fallback.
- Redundant `floot-usage` cache, alongside existing tree/journal accounting.
- Positional session creation and encoded/flattened model-selection compatibility.
- Stale `ClaudeClientConfig` constructor typing for a path Floot already rejects.

Update current callers before deleting compatibility APIs.
Keep private effects storage itself and required crash recovery for the current schema.
Completion: fresh-state fixtures need no legacy migration branches; accounting and session
selection work through one current API and schema.

### Positional session creation removed

`createSession` now requires one options record.
The factory's sole positional production caller now supplies
`{ title: 'New chat', spoken: true }`, preserving its voice behavior explicitly.
The current UI already supplies a record.
Public delegation-field stripping and current model/network/subscription options
remain unchanged; model-selection aliases are not removed in this slice.
Thirty focused factory tests pass, including rejection of missing, string, null,
array, and extra arguments before provisioning.
The full Floot suite also passes all 403 tests with local socket permissions.
Changed-file ESLint has no errors; formatting passes.
Independent review approved the code; deployment is pending.
The repository documentation gate was run and failed with 8,985 reported errors,
including missing `Far` declarations and unresolved entrypoints in unrelated
packages; this is not a claim of green repository-wide type/docs checks.

### Redundant usage cache removed

Completed usage now has one durable source: metadata committed with conversation
nodes and recovered from the current leaf.
The separate `floot-usage` fallback and serialized writes are removed.
Incomplete and archived-turn accounting remain in the turn journal unchanged.
Existing legacy cache blobs are left untouched but are never consulted;
historical totals held only in that cache are deliberately not migrated.
Provider and hosted restart tests seed a poisoned legacy cache, verify no cache
access or mutation, and check recovered totals and subsequent accumulation.
All 39 focused journal, hosted, evidence, and continuity tests pass; independent
review approved the change and changed-file lint has no errors.
Deployment remains pending.

### Legacy registry import removed

Only the current versioned lifecycle snapshots are loaded.
The canonical-array and backup-array import paths, and automatic backup removal,
are removed; existing legacy roots remain inert beside a valid modern snapshot.
Legacy-only state is rejected explicitly rather than exposed as an empty factory.
A corrupt newest snapshot still fails closed instead of falling back to an older
snapshot and resurrecting deleted sessions.
Sequence reservation before writes, serialized saves after rejected acknowledgements,
and bounded trimming after successful publication remain unchanged.
Fixtures now use current snapshots, with fault-injection coverage retained for
deletion recovery and uncertain writes.
All 414 Floot tests pass, including 52 focused registry/factory tests; changed-file
lint, formatting, and diff checks pass.
Read-only Tokyo inspection found a valid version-1 snapshot at sequence 1085,
four retained snapshots, one session, and neither legacy registry root.
No live state was modified; deployment and post-deploy verification remain pending.

### Private journal removal: creation and revival boundary

Implemented and tested locally; deployment is pending.
The code no longer imports guest journals.
The replacement must distinguish a newly authorized session from revival of an
existing registry entry, rather than inferring freshness from missing guest names.
Guest handle and controlling-agent bindings can be published separately, so even
checking only the controlling-agent name misclassifies interrupted provisioning.

Use separate strict creation and read-only opening operations for the private
storage schema, with a host-owned marker containing `{ version: 1, sessionId }`.
Validate its exact shape and identity, and reject old migration markers even if
a new marker is also present.
Creation requires an unused registry ID, both guest aliases absent, and an empty
length-delimited private namespace; an existing marker is not a creation retry.
The factory reserves the candidate ID synchronously before asynchronous admission
checks and appends a per-incarnation bigint ordinal to the time/random prefix.
Concurrent IDs therefore remain distinct even if the clock/random prefix repeats;
durable namespace checks still protect against collisions across incarnations.
Name checks followed by `storeValue` are not an atomic cross-factory claim.
After request validation, `provisionSession` publishes the schema before publishing
the creating registry entry or provisioning the guest.
`getAgent` only opens an existing valid schema, before guest provisioning or backend
execution; missing schema on revival is an explicit reset-required error.
It must never read guest journal values to establish trusted history.

A lost schema-write acknowledgement fails that creation attempt.
It may leave an orphan marker, but must not create a guest, run a backend, overwrite
the marker, or automatically remove uncertain state.
A later new-session request uses a fresh ID.
A crash after registry publication can reopen the valid schema under the existing
interrupted-creation cleanup/recovery, without importing history or manufacturing
a second schema; this does not promise retention of a partially provisioned guest.
Initial registry publication now has a dispatch fence: `saveRegistry` exposes its
in-memory entry before acknowledgement, so lifecycle alone is insufficient.
Concurrent callers must not provision or dispatch through that entry while its
initial save is pending or has failed; schema existence alone is not proof of
durable registry publication.
This includes observe-only paths that can call `getAgent`, inbox dispatch, and
network changes that trigger provisioning; retain the fence after an uncertain
save for that incarnation.
Rename and delete also reject while publication is fenced, preventing overlap
between deletion and creation rollback.
Revival requires a loaded durable registry snapshot as well as a valid schema.
This retains the existing single-factory-writer requirement; it does not provide
cross-process compare-and-swap or authorize concurrent independent factories.

Delete migration manifests, copy/acknowledgement/resolution logic, synthetic
`legacy-import` records, and migration-specific factory/journal plumbing together.
Keep the narrow host-only storage facet, immutable values, serialized operations,
uncertain-write poisoning, snapshot-covered removal behavior, and ordinary
unresolved-effect recovery.
Keep standalone cooperative agents' explicit storage behavior separate from
factory-owned private storage.

Required tests cover strict creation, missing/malformed/wrong-session schema,
old markers, orphan values, handle-only interrupted provisioning, marker-write
acknowledgement loss, registry-publication failure, revival after guest failure,
concurrent ID collisions and access during initial publication, and guest journal
tampering that cannot alter authoritative history.
Retain event-gap, archive, snapshot, immutable-write, poisoning, and normal
uncertain-effect resolution coverage.
Before deploying this incompatible schema, retire remaining old sessions using
the old release and preserve their workspace roots and all credential authority;
the earlier cutover does not cover sessions created since then.

The full Floot suite passes all 430 tests, including 14 private-storage tests,
11 factory-boundary tests, and 11 inbox/delegation tests.
Fault injection persists schema/registry/dispatch values before rejecting their
acknowledgements; revival and same-incarnation refusal are checked separately.
The obsolete mail migration wait is removed: a poisoned journal keeps mail
undismissed until shutdown, and ordinary effect resolution cannot unpoison it.
Independent reviewers approved both the storage and factory boundaries.
Package ESLint reports zero errors; repository-wide docs/type success is not claimed.
The documentation run reported 9,085 errors and 113 warnings, including five new
fixture callback/barrier typing errors repeated across package conversions.
Those fixture errors were corrected and the 11 factory-boundary tests rerun.
The targeted Floot type check confirms those diagnostics are gone but still fails
on missing `Far` declarations and other outstanding package errors.
The full documentation gate has not been rerun after that typing correction.

## FA-12 — Retire compatibility-only entrypoints

Claude/OpenCode `src/managed-credentials-module.js` wrappers previously preserved
old formula specifiers; both wrappers and the OpenCode package export are removed.
Current construction already uses the shared hosted-agent entrypoint.
A fresh read-only Tokyo inventory found two shared managed-credential and five
shared renewable-credential formulas, with no wrapper specifiers in the inspected
graph.
This is a non-atomic, root-reachable/static dependency inventory, not proof about
every stored formula or dynamic guest namespace.
No credentials or formulas were replaced: Secret identities and single renewal
ownership are untouched.
The OpenCode credential tests now import the shared module and explicitly require
newly minted URLs to select its shared entrypoint.
All 27 focused OpenCode credential/setup tests pass; changed-file lint is clean.
Deployment verification of the removal remains pending.

The OpenCode `src/opencode-broker-service.js` wrapper and its package export are removed.
The current broker agent already uses the shared service kit directly.
All seven lifecycle/authority regression tests now exercise that shared kit with
the explicit OpenCode policy, account, and label; no replacement wrapper was added.
Repository search found no remaining production callers of the removed export.
Thirteen focused service/entrypoint tests and all 218 OpenCode package tests pass
locally with Unix-socket permissions; restricted execution hit three `EPERM`
socket failures before the unrestricted rerun passed.
Package ESLint reports zero errors and 36 warnings; deployment is pending.
Do not infer deadness for all wrappers: current controllers still use `parse-rootfs.js`.

Completion: retained formulas and current callers reference current entrypoints, and removed
exports/tests no longer suggest a supported second topology.

## FA-13 — Align host image provisioning with the new builder

In endo-host, `modules/endo-daemon.nix:309` builds the Claude image directly with Podman.
It does not pass the `ENDO_DEV_IMAGE` argument required by the new
`packages/claude-sandbox/oci/Containerfile`.
An existing `localhost/claude-code:latest` skips the command, hiding the incompatibility.
This was a source-level integration finding, not a new observed Tokyo outage.

Host commit `2bfebce` removes that builder and checks every enabled harness/listener digest
on each daemon start, without pulling or building at startup.
The explicit storage-admitted builder reuses one immutable shared base, builds all three
overlays plus the listener, and publishes a complete candidate manifest atomically.
A validated 24-hour candidate lease protects pending pins, including reused image IDs
whose first-observed cleanup grace has already expired.
Invalid lease evidence skips image pruning; expired valid leases do not retain images.
Adversarial review caught and removed a residual Tokyo service dependency and tested
candidate protection against an old first-observed ledger.
Seven image tests and thirteen storage tests pass; changed module syntax was checked
with Tokyo's Nix parser.
At this implementation stage, actual OCI builds, full Nix evaluation, missing-image
runtime behavior, and activation remained deployment gates; later results follow.

Host commit `7402350` adds an expanded one-shot retirement inventory with five passing
safety tests and independent review.
It verifies immutable directory/blob identities before lookup, so inventory does not
revive unexpected backend or credential services.
It emits only formula metadata, reference IDs, whitelisted native paths/status, and
Secrets names/IDs; no secret values, prompts, full plans, or environments.
The graph is non-atomic and host-root-reachable, not proof that native cleanup occurred.
The first live run observed six Claude native records in `ready`, each with the retired
`nativeProfile` field and an operator-supplied `workspaceHostPath`, plus six Secret bindings.
Six running Claude containers and six 9P mounts were independently observed.
The graph snapshot does not cover all directory members or Floot child-host roots:
its lack of retired module matches does not override the earlier named-binding inventory.
This initial inventory still required workspace capability-root mapping before deletion.
The recursive follow-up (`endo-host` commit `e0233ec`, nine safety tests) traverses
verified built-in directories independently of the incomplete static graph, with identity
deduplication, an explicit completeness budget, and Secrets alias exclusions.
Its live run found 438 bindings, 97 unconfined module formulas, and the three expected
legacy modules: Claude credentials factory, Claude sandbox factory, and OpenCode state provider.
Floot's `controller-profile` is a separate built-in host; at this stage its session guest
bindings still needed explicit inspection and preservation.

The reviewed baseline was pushed to both existing GitHub PR branches and Forgejo mirrors
(app `056310a75`, host `7402350`).
Tokyo's existing prebuild service completed app `056310a75` successfully, with a matching
nonce/status and `.deploy-complete` marker; at that staging point the active release
remained `21bcb3d0`, before resource retirement and activation.
Host runbook `ops/hosted-cutover.md` (`9d8f4a7`) records the first-deployment lease-consumer
gap, temporary stopped image holders, lock ordering, preservation gates, and explicit cleanup.
The explicit Floot-host inspection (`8d4e918`, four tests) mapped all six native sessions
to six guest roots without resolving guests or custom services.
It may revive the built-in host's two workers; it is not a no-process diagnostic.
The reviewed archive-only helper (`0b0715f`, five tests) then retained those exact guest IDs
under `retired-floot-workspaces-20260921`, with source and destination identity checks.
This preserves capability references, not a content backup or native cleanup acknowledgement.
Secrets and original session bindings remain unchanged.

First-cutover image-holder tooling (`f8b8589`, six initial tests) is committed.
The first live build stopped before image construction because its deployment-directory
permission check rejected Tokyo's existing `0770 endo:endo` layout.
No live permissions were changed.
The reviewed exclusive-group correction (`11ed01d`, eight holder tests) also refused the
live layout before construction: `getent group endo` revealed `caddy` is a group member.
The final correction (`e2e6f65`) separates private holder recovery records from the
intentionally shared deployment spool. All 29 image/holder/storage tests passed.
The shared base, three CLI overlays, and provider listener subsequently built successfully on Tokyo.
The real startup image checker accepted the four immutable pins and rejected a
deliberately missing digest; this was a checker test, not a failed systemd start.
Five stopped image-holder containers retain these artifacts until the new consumer
and cleanup configuration are active. They must be removed by exact ID afterward.

Host `a180f0a` stages app `056310a757cf3724c7a12bde7b33b4a9835eddb8`
with the candidate image pins. App prebuild and the full Nix system build completed;
activation followed later as recorded below. Later app commits only update this audit.

Completion: replace/remove the obsolete builder in favor of the shared image pipeline;
verify the missing-image path, pinned artifacts, storage admission, and all runner overlays.

## Preserve these boundaries

Do not mechanically merge protocol-specific code:

- Claude stream-json, Codex app-server, and OpenCode bridge protocols.
- MCP transport versus Codex dynamic tools.
- Native transcript import formats and supported continuity semantics.
- Codex checkpoint ledger, which is active and not a duplicate effects journal.
- Provider authentication/renewal translation and single credential renewal ownership.
- Host-private evidence versus guest-writable native state.

## Execution order and retirement gate

### Tokyo inventory — 2026-09-21

A one-shot, read-only `endo-host/ops/inspect-hosted-retirement.mjs` inspection
confirmed Tokyo was then on release `21bcb3d04438ae313a172c9b691a7a8f4f5b17d5`.
The `endo-daemon` unit was active, with six running sandbox containers observed.
These initial inventory facts did not establish ownership of those containers.
No runtime was stopped or removed during this inspection, and no Secrets were read.

Retained legacy names include:

- `claude-sandbox/sandbox-factory`, `fs-mounter`, `service`, `profile`, and `handle`.
  The service points at `claude-sandbox-factory.js` under the current release.
- `claude-credentials/service`, `profile`, and `handle`.
  The service points at `claude-credentials-factory.js`.
- `opencode-sandbox/state-provider`, plus the old `session-storage` and backend formulas.

Current Claude/Codex state providers are also present and must be preserved: unlike
OpenCode's retired allocation, they back active native CLI state.
This named-binding inventory does not enumerate every formula, reference, grant, or listener.
Complete resource/reference inventory and cleanup acknowledgement were deployment gates.
The old automatic setup hooks could recreate legacy producers after a restart;
retirement was therefore coordinated with the release and host-hook changes.

### Sequence

The following cutover gates take priority over further abstraction or deletion work.
FA-01/FA-02 regression fixes and local legacy source removals above are already committed;
their remaining work is not implied complete by this deployment sequence.

1. **Fix FA-13 image provisioning.** Replace the incompatible host builder with the shared
   base/overlay pipeline, require storage admission and immutable pins, and test a missing-image
   start explicitly: cached images must not hide an incomplete provisioning path.
2. **Prepare retirement/reset using the old release.** Inventory retained formula specifiers,
   native records, containers, mounts, listeners, grants, and workspace capability roots.
   Stop old resources and verify cleanup acknowledgements before removing retained formulas
   or disposable session records.
   Preserve Secrets, renewal credentials and their single-owner identities, workspace data,
   and the capability references needed to reach that data.
   Preserve original plans before any workspace-preserving revision; deleting a Floot session
   also drops guest/publication bindings and is not by itself a safe workspace archive.
3. **Push and deploy both repositories as one coordinated cutover.** Record the app revision,
   host revision, and image pins together.
   Retire incompatible old session plans before activating the new parsers; never activate
   only one half and rely on backward compatibility.
4. **Run cross-backend acceptance on Tokyo.** For each configured backend, record create,
   actual tool use, cancel, restart/restore, network-policy change, and delete results.
   Verify cleanup and preserved workspace/credential identity, not just UI success.
   Record failures and unavailable accounts explicitly rather than counting them as passes.
5. Resume FA-11/FA-12 legacy retirement/deletion, then FA-06/FA-10 extraction, FA-07/FA-08,
   FA-09 storage, and remaining bounded-context/compaction and resource-failure acceptance.

### Cutover progress — 2026-09-21

Caddy ingress was stopped for exclusive maintenance and restored by activation.
Six workspace guest
roots were retained in `retired-floot-workspaces-20260921` before session deletion.
This preserves capability reachability, not an independent content backup.

The first stop attempt encountered an already-failed old main worker. A daemon-only
restart on the old release recovered it after verifying old persistent test helpers
were inert. The restart rebound the Floot controller to the same old module; a new
exact snapshot was accepted only after checking all other preserved identities.

The reviewed retirement helper (`9e062aa`, six tests) then stopped all six sessions
with durable acknowledgements. Independent checks found no native containers, 9p
mounts, or Claude MCP listeners remaining (only five stopped image holders).
The helper subsequently removed all six disposable Floot/native records through
supported APIs and verified the archived guest roots and six Secret identities were
unchanged.

Broker dependency inventory (`1fa90d9`, seven tests) traced scalar and marshaled
references without resolving custom services or Secret values.
The reviewed cleanup (`88c5114`, five tests) detached 22 exact broker-dependent
bindings and requested cancellation of all three old brokers, preserving credential
formulas, pool journals, account identities, Secrets, and archived roots.
Independent checks again found no native containers, 9p mounts, or matching listeners.
The two legacy guest namespaces contained only built-in bindings and `host-agent`.
The reviewed four-formula cleanup (`e303296`, four tests) retired the two obsolete
Claude producers and OpenCode's old storage/state-provider formulas.
It did not remove profiles, generic factories, mounters, or filesystem data.
The old daemon then stopped before new setup ran; cancellation alone was not treated
as durable revocation or proof that renewal owners could not overlap.

Coordinated activation completed at NixOS generation 157: host `e303296` and app
`056310a757cf3724c7a12bde7b33b4a9835eddb8`.
The daemon and Caddy are running, setup completed, three replacement brokers were
minted, and OpenCode storage was recreated by the null-powered setup path.
Post-start inventory confirmed all six Secret identities and all six archived guest
roots unchanged, zero native sessions before testing, and no retired modules in the
inventoried graph (not a claim of global capability revocation).

Cross-backend acceptance is in progress; image evidence remains `candidate`.
Restoration driver coverage (`f502c87`, eight tests) now rejects empty, partial, or
mismatched backend results.
Fresh Claude/Codex/OpenCode restoration tests use a dedicated manifest.
Claude and OpenCode completed their seed turns; Codex session creation failed with
`Codex runtime verification failed` and is under investigation.
Image inspection confirmed the Codex verifier still expected Node `22.19.0` and
the old source epoch, whereas the new shared image carries Node `22.23.2`, the
updated epoch, and locale/time-zone metadata.
The correction retains exact environment admission and adds an image-contract
regression plus fixed diagnostic categories without exposing raw probe output.
The corrected release `b8a785561` is active at generation 158 with host `f48d95d`.
Codex now passes runtime verification and inference.
All four configured backends (Claude, Codex, OpenCode, direct Fae) passed explicit
daemon-restart recall with exactly two completed turns and four transcript records.
After correcting the driver's nonexistent tool request and exact Codex shell
wrapper normalization, all three hosted backends passed native shell write/read,
Endo tool calls, and off → public internet → off network-policy checks.
Public HTTPS succeeded and a private-address request was rejected.
Claude's final off-policy turn recorded activity with earlier check labels but
new IDs and changed output, favoring fresh native activity over plain replay.
Exact arguments and raw events were not retained, so this remains a follow-up:
trace imported call IDs, fresh CLI events, and native execution across a harmless
policy-change fixture rather than assuming flawless instruction following.
Direct Fae also passed a real capability-description tool call.
Hosted cancellation reached idle with `reportedState: cancelled`, while the
journal correctly retained `outcome-unknown` for unsettled native calls.
Read-only revalidation passed without resolving or erasing that uncertainty.
Fae's configured OpenRouter adapter buffers responses, so its first test's
streaming prerequisite timed out without sending cancellation.
A separately labelled exact pending-turn cancellation check then passed.
All disposable diagnostic, rerun, and restoration sessions have been removed.
Final checks found zero containers, hosted native records, or Endo mounts and no
processes retaining their recorded network namespaces.
All six Secret identities and six archived original workspace guest identities
remain unchanged; externally owned workspace backing directories remain.
Temporary image holders and the build-input binary were removed, while evidence
and one-shot helpers were archived privately outside deployment staging.
Detailed evidence and remaining gates are in endo-host's
`ops/hosted-cutover-acceptance-20260921.md`.
The requested cutover matrix passed within those evidence limits.
Forced native-store corruption recovery, immediate process termination at cancel,
and remote provider computation/billing cancellation are not established.
The broader audit remains open; resume deletion before abstraction next.

Deleting a source file or pet name does not prove that a running resource stopped.
Do not erase generic sandbox functionality just because the retired hosted path used it.
New abstractions should serve the remaining current topology, not preserve both systems.

## Change log

| Date | Change | Verification / deployment |
|---|---|---|
| 2026-09-21 | Scope API documentation checking to each package's production roots | Two regression tests and independent review pass; imported dependency errors remain visible; five missing entrypoints recovered; full docs still fails with 13 errors and 104 warnings |
| 2026-09-21 | Correct Floot source contracts and validate watch events before caching; expand host cleanup audit | 36 focused tests pass; review found unchecked snapshot typing and invalid-data cache poisoning, both corrected; test fixture type errors remain; native recovery integration and deployment pending |
| 2026-09-21 | Correct cross-package type contracts and separate the setup pool flag from runtime authority | Clean root declaration build passes; 170 hosted-agent tests independently pass plus 59 UI, 11 Claude, and 19 Codex tests; scoped lint and independent source review pass; docs and incremental declaration generation remain failing; not deployed |
| 2026-09-21 | Durable pool identity prerequisite: bind actual capabilities before credential activation | 23 shared and one real-daemon restart test pass independently; read/write uncertainty fenced; full retirement/exclusion and deployment pending |
| 2026-09-21 | Daemon durability: disposal/collection fences and stale-read invalidation | 32 tests and independent review pass; disposal precedes reclamation; module-specific drains and Tokyo deployment pending |
| 2026-09-21 | Native-state durability: subprocess SIGKILL recovery at four creation boundaries | Four tests pass; exact child handles and temporary roots only; power-loss and Tokyo lifecycle verification remain pending |
| 2026-09-21 | Remove obsolete Claude construction prompt dispatch; record disposal and account-admission prerequisites | 51 client/controller tests, independent source review and lint pass; explicit restoration unchanged; not deployed |
| 2026-09-21 | Retrospective durability: uniquely allocated native state and durable ownership/retirement records | 27 focused tests and independent review pass; breaking storage layout approved; old-release retirement and Tokyo verification pending |
| 2026-09-21 | FA-04: remove obsolete OpenCode construction prompt dispatch | 51 client/controller tests pass; independent source review and lint pass; no new durable state; not deployed |
| 2026-09-21 | FA-07: expose account-scoped broker model catalogs using existing credential owners | 45 shared, three Codex, seven OpenCode, and one real-daemon lifecycle test pass independently; static catalog removal/admission wiring pending; not deployed |
| 2026-09-21 | Retrospective durability: checkpoint directory flushes (`c645f567f`) | 13 tests and independent review pass; Tokyo filesystem supports required flushes; pushed, not deployed |
| 2026-09-21 | Retrospective durability: persist marshal formula before name publication and retain pending slot dependencies | Nine manager/persistence tests including concurrent-root removal, lost acknowledgement, and real daemon restart pass; independent review; not deployed |
| 2026-09-21 | Initial audit and FA-01–FA-13 register | Source review plus two in-memory reproductions; no remediation or deployment claimed |
| 2026-09-21 | FA-03: stop creating legacy Claude form topology | 16 setup tests passed; independent review; retained resources untouched; not deployed |
| 2026-09-21 | FA-04 A: delete obsolete OpenCode client formula | 60 focused tests passed, 53 independently rerun; legacy formula retirement pending; not deployed |
| 2026-09-21 | FA-01/02: archive-aware history and hydrated direct-provider replay | 407 package tests passed, 27 independently rerun; tool-ID collision caught and fixed during review; bounded context/compaction pending; not deployed |
| 2026-09-21 | FA-04 B: delete unused OpenCode CLI state service | OpenCode: 226 passed; shared runtime: 545 passed, one skipped; adversarial source review; runtime retirement and deployment pending |
| 2026-09-21 | Tokyo retirement inventory (`575b45f68`, host helper `d68f72c`) | Read-only named-binding inspection on release `21bcb3d0`; legacy producers remain; no runtime retirement or deployment |
| 2026-09-21 | FA-03: preserve generic daemon coverage before legacy deletion | Two real-daemon tests passed; lint/format passed; actual 16-file source removal awaits explicit permission; no deployment |
| 2026-09-21 | FA-05: remove ignored hosted native profiles | 182 focused tests passed; explicit stale-plan rejection added after review; host Nix syntax passed; coordinated retirement/activation pending |
| 2026-09-21 | FA-03: remove the approved 16-file legacy Claude topology | Full Floot/Claude/hosted-agent suites: 402/180/541 passed, one skipped; daemon regressions: two passed; package ESLint: zero errors; source/docs reviewed; global lint/type/docs failures recorded above; runtime retirement and deployment still pending |
| 2026-09-21 | Prioritize FA-13, preservation-safe old-release retirement, coordinated two-repo deployment, and cross-backend acceptance | User-requested cutover gates recorded; FA-13 implementation under review; no deployment claimed |
| 2026-09-21 | FA-13 host pipeline (`2bfebce`) and safe expanded inventory (`7402350`) | 20 image/storage tests and five inventory tests passed; adversarial corrections included; live build/activation and resource retirement pending |
| 2026-09-21 | Recursive retirement inventory (`e0233ec`) and coordinated cutover runbook (`9d8f4a7`) | Nine safety tests; independent review; three legacy modules confirmed on Tokyo; baseline pushed to both remotes; app prebuild completed, old release still active |
| 2026-09-21 | Floot root mapping (`8d4e918`), capability archive (`0b0715f`), first-cutover holders (`f8b8589`) | Six workspace guest roots retained on Tokyo; four mapping/five archive/six initial holder tests; image build safely stopped on directory-permission mismatch before construction; no retirement or activation |
| 2026-09-21 | Private holder recovery (`e2e6f65`) and coordinated pins (`a180f0a`) | 29 focused tests; actual Tokyo shared-base/overlay build and missing-digest rejection; app and full Nix system built, not activated |
| 2026-09-21 | Gated old-session retirement (`9e062aa`) | Six helper tests and adversarial review; recovered failed old worker; six stops acknowledged, external resources absent, six records removed; archived roots and Secret identities unchanged; broker retirement/activation/acceptance pending |
| 2026-09-21 | Broker and legacy retirement (`88c5114`, `e303296`) and coordinated generation 157 | Reviewed helpers: five/four tests; 22 broker bindings and four obsolete formulas retired; old daemon stopped; app `056310a75` plus host `e303296` activated; six Secrets/archive roots preserved; cross-backend acceptance in progress |
| 2026-09-21 | Reject incomplete restoration coverage (`f502c87`) | Eight tests and adversarial review; fresh three-backend live acceptance started, results pending |
| 2026-09-21 | FA-12: remove unused OpenCode broker-service wrapper/export | Seven authority/lifecycle tests retained against shared kit; 218 package tests pass with socket permissions; ESLint zero errors/36 warnings; no broker or credential identity changes; not yet deployed |
| 2026-09-21 | FA-11: require record-only session creation | Setup caller and help updated; voice/delegation/model/network/subscription behavior preserved; 403 package tests and independent review pass; repository docs gate remains failing; not yet deployed |
| 2026-09-21 | FA-12: remove obsolete credential-entrypoint shims | Fresh inspected Tokyo graph uses shared entrypoints only; 27 credential/setup tests pass; no Secret/formula mutations; deployment pending |
| 2026-09-21 | FA-11: remove redundant usage-cache persistence | Conversation metadata and incomplete journal accounting retained; 39 focused tests pass; no legacy cache access/mutation; deployment pending |
| 2026-09-21 | FA-11: remove legacy registry import and backup cleanup | Current snapshot crash recovery retained; legacy-only state rejected; 414 Floot tests pass; Tokyo already uses modern snapshots; deployment pending |
| 2026-09-21 | FA-11: specify private-journal creation/revival boundary | Source analysis and adversarial design review identified ID-reservation and initial-publication races; implementation and fault-injection tests pending; no runtime changes |
| 2026-09-21 | FA-11: remove private-journal imports and migration acknowledgements | Strict host schema creation/opening, creation fences, and poisoned-mail preservation; 430 Floot tests pass; adversarial review approved; old-release session retirement and coordinated deployment pending |
| 2026-09-21 | FA-04: remove obsolete native-session resume and fence failed restoration | 227 OpenCode tests pass; 72 independently rerun; old bridge images rejected before prompts; image rebuild/pinning and coordinated deployment pending |
| 2026-09-21 | FA-07: prioritize provider-backed model discovery and remove NixOS model enumeration | Operator requirement recorded; NixOS Luna workaround withdrawn; implementation, UI verification, and Luna/free-route acceptance pending |

## Request

> Analyze the current Floot/backend architecture for duplication, ontological mismatches,
> and dead code left by repeated rewrites in PR #1248. Use independent subagent reviews.
> Backward compatibility is not important; identify legacy infrastructure and analyze its
> removal. Record the analysis in a committed document and update it as issues are addressed.
