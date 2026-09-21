# Floot and backend architecture audit and remediation tracker

| | |
|---|---|
| **Created** | 2026-09-21 |
| **Updated** | 2026-09-21 |
| **Author** | kumavis (prompted) |
| **Status** | Active — audit complete; remediation open |
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

Source locations below describe the baseline and may move as code is removed.
Repository reachability does not prove that an exported or dynamically minted module has
no retained formula referring to it.

## Findings register

| ID | Priority | Finding | Evidence class | Status |
|---|---|---|---|---|
| FA-01 | High | Archived failed turns disappear from history/context | Reproduced bug | Fixed locally; bounded selection pending |
| FA-02 | High | Direct-provider context reads lossy UI previews | Reproduced bug | Fixed locally; compaction policy pending |
| FA-03 | High | Claude's old form/credential topology is still provisioned | Live legacy infrastructure | In progress — fresh setup disabled |
| FA-04 | High | OpenCode retains obsolete controller and unused state service | Obsolete path / unused allocation | Removed locally; runtime retirement pending |
| FA-05 | High | Recorded native resource profile does not drive execution | Ignored configuration | Open |
| FA-06 | High | Session provisioning and restart policy are triplicated | Duplication with observed drift | Open |
| FA-07 | Medium | Runtime, provider, account, and model route are conflated | Ontology mismatch | Open |
| FA-08 | Medium | Logical session identity is coupled to execution incarnation | Ontology mismatch | Open |
| FA-09 | Medium | Storage/environment contract lacks local development storage | Missing resource abstraction | Open |
| FA-10 | Medium | Event reduction and conversation conversion are duplicated | Duplication | Open |
| FA-11 | Medium | Floot retains migration and compatibility scaffolding | Reachable legacy branches | Open |
| FA-12 | Medium | Credential shims and obsolete API wrappers remain | Compatibility entrypoints | Open |
| FA-13 | High | Host image builder does not match shared-base Containerfile | Stale live integration | Open |

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
The full-content bug is fixed locally, not deployed.

## FA-03 — Retire the live Claude form topology

The host's `modules/endo-daemon.nix` still runs `setup-host.js`, `setup-peer.js`, and
`setup-hosted.js` (baseline lines 88–91).
[setup-host.js](../claude-sandbox/setup-host.js) still provisions the old sandbox-form
factory; [setup-peer.js](../claude-sandbox/setup-peer.js) provisions credential forms.
The old factory dynamically mints `claude-client-module.js`, which materializes credentials
into the guest environment.
This is a second, live topology alongside the brokered hosted path, not dead code.

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
retirement before deleting the remaining entrypoints or resetting deployment state.
The setup-host and setup-hosted suites pass 16 tests, including fresh native-only setup,
idempotent setup, distinct host ownership, and preservation of retained legacy bindings.
Independent review caught two stale test expectations; both were corrected before commit.
Not deployed; native conformance and resource retirement remain pending.

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
Deployment and native conformance remain pending, as does the separate `opencodeSessionId` audit.

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

Floot owns the direct-provider inference loop in `agent.js`, while hosted runtimes implement
a separate backend interface.
The direct runtime is represented internally by the absence of a hosted backend ID and
externally as `provider`/Fae.
OpenRouter catalogs are separately declared in Floot and OpenCode.
[Account views](src/account-watch.js) use backend-based identities.

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

## FA-12 — Retire compatibility-only entrypoints

Claude/OpenCode `src/managed-credentials-module.js` wrappers preserve old formula specifiers.
Current construction uses the shared hosted-agent entrypoint.
Recreate retained formulas against that entrypoint before deleting the wrappers.
Preserve the underlying Secrets blobs and single renewal ownership.

The OpenCode `src/opencode-broker-service.js` wrapper is also a removal candidate:
the current broker agent uses the shared service kit directly; the wrapper remains exported
and tested independently.
Do not infer deadness for all wrappers: current controllers still use `parse-rootfs.js`.

Completion: retained formulas and current callers reference current entrypoints, and removed
exports/tests no longer suggest a supported second topology.

## FA-13 — Align host image provisioning with the new builder

In endo-host, `modules/endo-daemon.nix:309` builds the Claude image directly with Podman.
It does not pass the `ENDO_DEV_IMAGE` argument required by the new
`packages/claude-sandbox/oci/Containerfile`.
An existing `localhost/claude-code:latest` skips the command, hiding the incompatibility.
This is a source-level integration finding, not a new observed Tokyo outage.

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
confirmed Tokyo is still on release `21bcb3d04438ae313a172c9b691a7a8f4f5b17d5`.
The `endo-daemon` unit is active, with six running sandbox containers observed.
These are live inventory facts, not evidence that those containers belong to legacy clients.
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
Complete resource/reference inventory and cleanup acknowledgement remain deployment gates.
The currently deployed automatic setup hooks could recreate legacy producers after a restart;
retirement must be coordinated with the release and host-hook changes, not performed blindly.

### Sequence

1. Fix FA-01/FA-02 and add regression fixtures before changing transcript architecture.
2. Disable legacy setup producers and inventory retained formula specifiers/native resources.
3. Stop legacy clients; verify containers, mounts, listeners, and grants are retired.
4. Remove retained legacy formulas/aliases, recreate credential formulas against shared entrypoints,
   and deliberately reset disposable state without deleting Secrets or retained workspaces.
5. Delete FA-03/FA-04/FA-05/FA-11/FA-12 source, exports, tests, and stale documentation together.
6. Repair FA-13 before relying on a fresh shared-image deployment.
7. Extract FA-06/FA-10, then address FA-07/FA-08 and the explicit storage contract FA-09.
8. Run common conformance on Tokyo: create, tool use, cancel, restart, restore, policy change,
   resource failure, and delete; record deployed revisions and evidence here.

Deleting a source file or pet name does not prove that a running resource stopped.
Do not erase generic sandbox functionality just because the retired hosted path used it.
New abstractions should serve the remaining current topology, not preserve both systems.

## Change log

| Date | Change | Verification / deployment |
|---|---|---|
| 2026-09-21 | Initial audit and FA-01–FA-13 register | Source review plus two in-memory reproductions; no remediation or deployment claimed |
| 2026-09-21 | FA-03: stop creating legacy Claude form topology | 16 setup tests passed; independent review; retained resources untouched; not deployed |
| 2026-09-21 | FA-04 A: delete obsolete OpenCode client formula | 60 focused tests passed, 53 independently rerun; legacy formula retirement pending; not deployed |
| 2026-09-21 | FA-01/02: archive-aware history and hydrated direct-provider replay | 407 package tests passed, 27 independently rerun; tool-ID collision caught and fixed during review; bounded context/compaction pending; not deployed |
| 2026-09-21 | FA-04 B: delete unused OpenCode CLI state service | OpenCode: 226 passed; shared runtime: 545 passed, one skipped; adversarial source review; runtime retirement and deployment pending |

## Request

> Analyze the current Floot/backend architecture for duplication, ontological mismatches,
> and dead code left by repeated rewrites in PR #1248. Use independent subagent reviews.
> Backward compatibility is not important; identify legacy infrastructure and analyze its
> removal. Record the analysis in a committed document and update it as issues are addressed.
