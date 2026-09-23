# Floot and backend architecture audit and remediation tracker

| | |
|---|---|
| **Created** | 2026-09-21 |
| **Updated** | 2026-09-24 |
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

### Native recovery — separate research follow-up

The dedicated [investigation and scope decision](../../designs/hosted-native-recovery-investigation.md)
records discovery, evidence, alternatives, commit disposition, and research gates.
Automatic per-session crash recovery and the proposed producer service are deferred
from PR #1248; no producer architecture is selected or required to finish this PR.
Retain the landed fail-closed ownership/disposal fixes, with their documented
availability costs. Preserve Secrets, renewal owners, and workspaces.

Continue the bounded refactor and normal-operation acceptance; use an explicit,
verified operator cutover for old native resources. If exact safe retirement cannot
be established, stop deployment rather than clearing markers or pretending cleanup
succeeded. A ready-to-run recovery procedure remains a bounded deployment gate,
not an instruction to finish the new producer architecture.
Keep process-loss recovery and cross-worker cleanup proof open in the audit and
tracked follow-up; do not count them as completed by deferral.
The producer prototypes are isolated on `codex/native-recovery-research` in
[draft tracking PR #1323](https://github.com/endojs/endo-but-for-bots/pull/1323),
not in the current refactor branch and not ready to merge.
Public declaration fixes and independently useful landed lifecycle corrections
remain on the main working branch. No runtime changes accompany this scope decision.

### Retrospective durability audit — required, in progress

The inventory starts at the unified-sandbox design commit `3332f1928` and
includes the current branch plus associated endo-host implementation changes.
Earlier infrastructure still used by the refactor remains in scope; this seed
is not an exclusion boundary.
The [commit-by-commit coverage ledger](DURABILITY-INVENTORY.md) now enumerates
all 479 commits in `3332f1928..a3a239f80` and all 93 associated host commits in
`73405ca..5959fbf` (excluding the seeds). It includes upstream changes and reverts,
with conservative path-based triage rather than an assumption of relevance or
correctness. Enumeration is complete for those exact ranges; semantic review is
not. The newest 15 and earliest 22 application changes, plus the first 20 host
changes, have individual owner/evidence/limitation entries based on source and
test-diff review; other entries still need mapping to
the evidence recorded here. Independent Git verification found exact unique SHA
coverage and matching triage counts in both repositories.
Earlier retained infrastructure and subsequent changes remain in scope.
No claim of complete retrospective durability coverage is made yet.

Generated-file ownership mapping (2026-09-24): three additional implementation
diffs are traced to current literal validation, exclusive private staging, and
Podman teardown ownership. All 74 focused sandbox tests pass.
Failed removal retains files and reservations; existing roots are not reused.
This is local filesystem/injected-process evidence, not live kernel isolation or
daemon-loss recovery. The remaining crash-reconciliation boundary stays in #1323.
Three adjacent Podman/bwrap/factory cleanup changes also have explicit owner and
limitation mappings; their focused suites pass 107 tests after an authorized
cache-write rerun. Their retryable ownership registries remain process-local.
Five subsequent factory/control-command/local-engine changes are also mapped;
131 focused tests pass, including direct Node closure and injected Podman cases.
Unavailable optional native checks are not live acceptance evidence.
An uncertain producer can remain retained even after container removal succeeds;
this deliberate refusal is not automatic recovery or proof of quiescence.

Legacy detachment follow-up (2026-09-24): host `c98eb5d` removes cancellation from
the four-formula legacy helper. Host cancellation calls `provideController`, so
the old implementation could construct dormant legacy modules during retirement.
The helper now detaches only exact approved names, preserves existing identity
checks, and explicitly requires old-daemon shutdown after effectful success or
failure. Tests forbid cancellation and exercise actual removal failure/retry,
reappearance and the entrypoint error instructions; three fail before the fix.
All 44 related host helper tests pass after independent review. Pushed, not run on
Tokyo. Name detachment is not global revocation or proof that native producers
stopped. Historical completed retries can still fail safely after metadata GC.

Old restoration acceptance runner — identified boundary (2026-09-24):
`endo-host/ops/verify-restoration.mjs` verified requested backend coverage, but its
old seed path created a session and obtained its ID before writing the manifest with
ordinary `writeFile`. A lost create response can leave an unrecorded session;
replacement writes can truncate; retry replaces unfinished session IDs, losing
their cleanup references. `run-cutover4-restoration.sh` invoked this seed path.
Coverage tests alone did not establish a durable acquisition/cleanup ledger.
Existing historical acceptance observations are not erased, but do not prove this
failure boundary safe. This is separate from native #1323.

Restoration acceptance remediation (host `f922568`, 2026-09-24, not deployed):
the host runner now records version-two intent before create, seed, and recall;
uncertain acknowledgements stop the phase without replacing IDs or retrying sends.
Private manifests use exclusive locks and file-sync/rename/parent-sync publication.
Cleanup holds both locks in stable order through deletion and requires exact
model/title identity and the completed seed/recall pair; extra turns prevent cleanup.
Unknown-ID creation attempts remain inspectable by their unique recorded title.
All 53 focused tests pass, independently rerun during adversarial review, including
reopened-state publication failures and actual-filesystem lock exclusion.
Four inert shell-wrapper tests pass; this is not live inference or power-loss proof.
Old manifests require manual inspection, not automatic migration or replay.
Locks exclude cooperating runners, not UI activity or hostile same-UID processes;
exclusive operator use and trusted private directory ancestry remain prerequisites.
The local runner defect is addressed; deployment/live acceptance remain open.

Claude diagnostic-read follow-up (2026-09-24, local, not deployed):
the stderr excerpt reader limited decoded characters but could wait forever for
the next chunk or iterator closure, withholding the turn's abort. It now uses a
one-second total asynchronous-read deadline, retains diagnostics collected so
far, fences late results from further decoding/pulls, and requests iterator
closure without awaiting it. Invalid deadline options are refused at client
construction before diagnostic work can start. Limits are documented as UTF-16
code units, matching the existing decoder/string implementation rather than
claiming a byte limit. This is ephemeral diagnostic handling with no new formula,
durable state, renewal owner, or retry behavior. It does not cancel a hung remote
operation, preempt synchronous adapter code, or prove process retirement.
Six regression tests cover invalid deadlines, stalled initial/partial reads,
late rejection/resolution, and stalled iterator closure. All 225 Claude sandbox
tests pass; package lint has zero errors (56 warnings), formatting passes, and
root documentation generation has zero errors (176 warnings). Independent adversarial
review approved after constructor validation and test teardown corrections.

Claude exit-observation follow-up (2026-09-24, local, not deployed):
the raw client swallowed a rejected process `wait()` and reported `end`, allowing
an unverified outcome to be recorded as a successful turn. The rejection now
reaches the existing abort path, which attempts a kill before reading stderr and
preserves partial streamed events and diagnostics. Three regressions reproduce
the old false success with Error, false, and undefined rejections and require
exactly the partial event followed by an abort after the fix. All 219 Claude
sandbox tests pass, package lint has zero errors (57 warnings), formatting passes,
and root documentation generation has zero errors (176 warnings).
Independent adversarial review approved the narrow change.
This changes outcome reporting, not durable schemas, credential ownership, or
retry policy. A rejected exit observation does not prove process retirement;
the existing best-effort kill and native process-loss limitations remain open.

Adjacent OpenCode terminal audit (2026-09-24): source review found no analogous
host-side checkpoint settlement latch. Uncertain transcript import fences later
sends; native checkpoint publication failure shuts down the bridge before idle.
The existing client and actual-bridge compaction suites were rerun: 35 tests pass,
including native-error, conflict, malformed checkpoint, EOF, timeout, interruption,
and lost import acknowledgement. The bridge blocks native dispatch during fatal
shutdown, although the client can still write a queued prompt before observing EOF.
These injected transport/bridge checks are not live-provider or daemon-crash evidence.
No OpenCode production change was needed for this bounded comparison.

Session-watcher retirement follow-up (2026-09-24, local, not deployed):
`makeSessionWatch.end()` previously ended existing streams but still allowed
late subscriptions to read sources, and held reads could publish/cache values
or schedule retries after termination. Watchers now reject late subscriptions,
fence queued source invocations and late results, cancel scheduled retry timers,
and release the cached transcript on end. Existing streams still receive their
terminal event. Eight new regressions cover held success/failure across
transcript/network/usage, scheduled retries, and end before source microtasks.
The existing late-subscription test now requires rejection rather than a fresh
snapshot from the ended watcher.

Durability classification: these watchers are deliberately ephemeral, owned by
the factory incarnation/session; deletion and factory disposal already end them.
No formula, durable record, inference request, or replay policy is added.
The factory's existing admission checks remain authoritative; this change makes
the local watcher obey its own lifecycle rather than relying on those outer
checks. Consumer deadlines do not cancel underlying reads: already-started hung
source operations may remain retained. Local race tests establish no late
publication or retry, not reclamation of those operations or process-loss proof.
Validation: all 671 Floot tests pass, including 34 watcher tests; three adjacent
real-daemon factory-disposal tests pass. Those daemon tests cover the enclosing
owner's disposal/admission boundary, not these exact held-read races.
Floot lint has zero errors (245 warnings); adversarial source/test review approved.

Codex checkpoint-failure notification follow-up (2026-09-24, local, not deployed):
the ledger latches a terminal outcome before persisting it. A rejected completed
checkpoint write previously left the event reader open: the fallback failure
settlement lost the latch and never delivered a terminal event. The client now
emits one abort for the exact active turn, synchronously fences further sends,
retains the persistence error for shutdown, and rethrows it. It does not retry
the uncertain publication, rewrite the ledger winner, or report success.
Review found a second timing path: completion replayed before the turn-start
reply could deliver an abort but let shutdown report success. The error is now
retained at settlement itself, independently of the transport message pump.
Non-Error rejections are normalized before retention, so falsy rejection reasons
cannot make shutdown appear successful. Regressions cover Error, false, and
undefined in both timing paths.

Durability classification: existing checkpoint owner, schema, first-winner latch,
and write ordering are unchanged. A failed write remains uncertain and the
session remains fenced; transient reader closure is not a durable commit claim.
Early/late completion regressions inject checkpoint-save failure, duplicate the
notification, and require one abort, no success event, one completed write,
refusal of another send, and a shutdown rejection carrying the persistence error.
This tests normal-operation storage failure through the real client with an
injected persistence boundary, not daemon/process-loss or physical-disk recovery.
All 322 Codex sandbox tests pass, including 94 client tests; scoped lint has
zero errors (10 warnings), and formatting passes. Independent adversarial review
approved after the early-notification and falsy-rejection corrections.
At that checkpoint, full-package lint failed on 32 TypeScript errors in six unchanged test
fixtures (broker-service-agent, native-controller, owned-backend, state-provider,
subscription-profile, and setup-hosted).

Follow-up (2026-09-24): those six fixtures now satisfy their current contracts.
The subscription profile fixture uses `policy.accountRef`, instead of overwriting
that binding with a removed top-level field; the catalog credential returns the
complete OAuth observation shape. Directory, environment, object, and namespace
lookups are narrowed with runtime assertions, and the namespace mock declares its
existing removal log. No production code, formula, persisted schema, or credential
owner changes. All 322 Codex tests and full package lint pass (zero errors,
63 warnings); formatting and root documentation generation pass (zero errors,
176 warnings). Independent adversarial review found no blockers.
These are local checks, not Tokyo deployment or live acceptance.

| Boundary | Current evidence / defect | Required follow-up |
|---|---|---|
| Catalog reads and renewal owner | Broker integration drains admitted metadata reads. Independent tests pass, including actual formula cancellation/reconstruction with renewal held open and an independently retained old facet. | Process-loss/external renewal transaction recovery remains unverified; broader pool/Secret ownership findings below remain open. Deployed since generation 157 (2026-09-21). |
| Pool member identity | Authoritative journal now persists actual Secret/share capabilities, provider/account binding, and removed-member tombstones before credential activation. Twenty-three shared tests and one real-daemon restart test pass independently. | Integrate full owner retirement/exclusion; historical IDs and bound capabilities are deliberately not reusable yet. Deployed since generation 157 (2026-09-21). |
| Formula disposal and replacement | Corrected locally: eventual invocation of remote hooks, exact-formula cancellation/collection fences, stale in-flight read invalidation, and disposal before reclamation. Thirty-two focused tests pass independently. | Deploy and audit each resource module's actual hook/admission drain. This does not establish cross-formula exclusion or persistent cleanup proof after process loss. |
| Credential ownership and Secret rebinding | Owned pool bindings retain actual capabilities and reject mutable-name rebinding. Member retirement now fences and drains retained facets, renewals, transports, wrapped readers/endpoints, and observation writes; 179 focused and two real-daemon tests pass. | Cross-worker renewal exclusion, retirement epochs, and process-loss transaction recovery remain open. Module-local drain does not establish these. |
| Native teardown after reconstruction | The fail-closed teardown (`0d66bd945`: absent/failed scope lookup refuses stop acknowledgement; mount reclamation waits for sandbox close) was deployed on 2026-09-22 in generation 160 and observed: after a graceful `endo-daemon` restart every ready hosted session failed to reopen and to delete with `Original native cleanup proof is unavailable`, and six records were stranded with their listener containers and 9p mounts. **Reverted from this branch the same day and moved to #1323**: `session-supervisor.js` again treats absent/failed scope lookup as diagnostic and reclaims the recorded mount, as the release that passed the second pass's restart/restore did; runtime lookup still reads only an in-memory map. | Automatic reconciliation/process-loss proof stays with the dedicated investigation (#1323), where the fail-closed teardown now lives with its six injected-reconstruction tests. A missing scope still cannot prove that native resources stopped. |
| Native state creation | Rewritten with unique inode-bound allocations, atomic ownership publication, and durable orphan-retirement intent. Twenty-seven focused tests and four subprocess SIGKILL regressions pass independently. | Retire old native state with the old release before coordinated deployment; verify on Tokyo. Abrupt process loss is tested, not physical power loss. |
| Mount inspection | Baseline `recorded-cleanup.js` treated all socket `lstat` errors as absence. Corrected locally with ten passing tests. | Deploy and verify with native cleanup; the independent reconstruction/cleanup-proof gap remains open. |
| Private journal deletion | Terminal deletion now durably records `deleting`, stops the agent/backend, closes and drains its retained journal facets, validates the exact namespace, and removes value names before schema. Normal incarnation/incomplete-creation cleanup preserves the namespace. | Real-daemon restart recovery verified locally, including GC interruption; smooth deletion with GC is NOT verified: guest collection kills retaining workers (see below). Tokyo verification remains required. Pre-publication orphan namespaces still require inventory/reclamation; unbinding names alone does not prove physical GC. |
| Daemon value publication | Corrected locally: persist before name publication; transiently pin the new formula and all marshal slots; transfer caller retention only on success. Nine persistence/GC/restart tests pass independently. | Deploy; after-write lost acknowledgements leave unnamed durable formulas requiring reclamation. Abrupt crash injection remains unverified. |
| Codex checkpoint commit | Corrected locally: sync directory ancestry when opening and sync the containing directory after rename/removal, including absent-removal retries. Thirteen tests pass. | Deploy; broader checkpoint ownership/recovery audit remains open. Filesystem flush support is verified on Tokyo, not physical power-loss recovery. |
| Model picker | `65e939889` adds deliberately transient view state; persisted session route still travels through existing creation path. | No new formula required for the search query; session creation durability remains subject to its existing boundary audit. |
| Model admission and account catalogs | Implemented: each pool member's catalog owner is per incarnation and deliberately ephemeral (`model-catalog.js`); admission and `modelCatalog()` read it through the member's fenced lifecycle with a non-sticky credential facet; retirement closes it after draining a read in flight, and a far share's read has a deadline; a retained broker configuration carrying an operator `models` list is refused with the retirement instruction. Twenty-four new focused tests, 656 hosted-agent tests and the real-daemon catalog reconstruction test pass. | Reconstruction re-reads the provider under the same credential owner and cannot revive retired authority or spend; the durable pin stays in the session plan. Retire and re-mint the three brokers at cutover; observe live Codex, Claude and OpenRouter catalog reads on Tokyo. Done: deployed as generation 160 (2026-09-22), the three brokers re-minted and the discovery gate reading every account's live catalog. |
| Backend catalogs and pin admission | Implemented: no new durable state. Session plan schemas are unchanged; a new pin is admitted against the catalog before the plan is recorded and a refused pin records nothing; a reopen that names the recorded pin, or nothing, keeps it without reading the provider (each of the Codex, Claude and OpenCode provisioner suites runs a reopen through a scripted catalog outage, and a changed pin is refused then without another model taking its place); Floot's registry entry pins a direct-provider model only after it was listed; the direct provider's catalog owner is per factory incarnation and ephemeral, and is let go when the provider config is refreshed. A request naming no model takes only a default the catalog marks; an effort changed on its own keeps the recorded model; an OpenCode record without a model is a new pin, refused clearly rather than run without one. Floot 451, chat 58, space-floot 49, Claude 183, Codex 287, OpenCode 231 and hosted-agent 663 tests pass. | Reconstruction re-reads providers under existing credential owners and cannot revive retired authority. Deployed as generation 160 (2026-09-22). |
| Session provisioning and factory (FA-06) | Implemented: no new durable state and no new formula. The plan record stays the durable boundary; its reader is tightened (sandbox id derivation, known fields only), so rejected old plans must be retired through their old owner before activation. A reopen keeps the recorded pin and revises policy, subscription and persona in place; a failed start or revision leaves the stopped record for retry. Twenty shared conformance cases per adapter and the four package suites pass. | Reconstruction is unchanged: the controller activates the recorded plan. Historically deployed as generation 165 on 2026-09-22 under the wipe model. Current cutovers preserve Secrets, renewal owners and workspace roots; no database wipe or Secret re-import is authorized. |
| Execution envelope (FA-06) | Implemented: no new durable state. Activation acquires the same scopes in the same order under the supervisor's owner, and the exact grant, evidence and raw attestation checks now refuse for every runtime what Codex alone refused; a refused activation releases what it acquired through the supervisor's ordinary cleanup. Ten envelope cases and the three controller suites pass. | Reconstruction is unchanged: recorded scope identities and mount reclamation, never replacement acquisitions. Deployed as generation 165 on 2026-09-22 under the wipe model; restart/restore, cancel and deletion passed on every backend. |
| Reply fold, turn messages, transcript delta, turn evidence (FA-10) | Implemented: no new durable state. The converter changes what a completed hosted turn commits only in a case that cannot occur (an unsettled call) and what a mirrored turn commits not at all; the fold changes what a view holds only where the two copies disagreed, on the rule the daemon already applied; the delta's wire format is unchanged and the daemon still hardens what it publishes. The shared reconciliation reads the tree and the journal as before and writes neither; it changes what a restored transcript contains only where the history rule was looser than the restoration rule (a look-alike observation under another id is evidence of its own, and a settled execution answers a mirrored call the tree left unanswered), and what the projection emits only for a result no open call in its turn can take, which no writer produces. Floot 475, chat 935, space-floot 52 and hosted-agent 675 pass. | Nothing replayed or reconstructed changes for a well-formed tree; tree nodes and journal records are written as before. Deployed as generation 165 on 2026-09-22 under the wipe model; restart/restore, cancel and deletion passed on every backend. |
| Rebindable session bindings (FA-08) | Implemented: one new record entry, `revision`, under which the store's `revise` stages a revision's rebound edges and then its plan before any published write; a staging without a plan is discarded by the next mutation, one with a plan is intent that snapshots show applied and that every mutation and the owner's `start` and `remove` finish first, so the record is never used between two bindings; a plan-only revision stays one entry write. The first design (each edge written in turn, then the plan, the mixed state left to the execution envelope) was found not crash-safe by the operator's reviewer on 2026-09-22: the envelope cannot tell a replacement service reporting the same image and account from the original and does not check storage. A failed stop leaves the record `stopping` and unrevisable, as before. Daemon session suites (79) pass. | The pet store overwrites a name in one entry write; a crash between staged writes leaves no intent, between published writes a durable intent finished before the next activation or removal. The first design deployed as generation 165 on 2026-09-22; the one-transition revision is not deployed. |
| Account authority in plans, profiles, catalogs and grants (FA-07, FA-08) | Implemented: no new formula. Every session plan records `accountRef`, the operator-declared account authority id, read and validated by the shared placement reader; each broker's persisted profile records it as `accountAuthority` (a new required field of all three profiles; Codex's `accountRef` stays the verified provider account and only for a single credential, the `pool` label is gone); a pool's stored subscription set records it as `id`; the grant attestation reports it and admission compares it, decoupled from the policy's provider account; the catalog snapshot carries it as `authority`. Plans and profiles from before are refused, not migrated: a plan without `accountRef` fails its reader, a profile without `accountAuthority` fails its shape check at the next start, and a retained Claude or OpenCode broker whose profile names another authority is refused by setup. hosted-agent 680, Codex 311, Claude 207, OpenCode 255 pass. | Profile fields and set ids are written once at mint and compared, never rewritten in place; the pool identity journal's pool-level account binding takes the authority id for a newly minted pool. Not deployed: needs the three host values and the three brokers retired first, since their profiles change. The pool identity journal binds a share member (somebody else's subscription) under the pool-level id, `pool` or `anthropic` before and the authority id now, and refuses a changed binding: a pool with share members minted before this release, or whose authority is later renamed, fences until those members get new ids; Tokyo's two pools have credential members only, bound under their own accounts, so nothing changes for them. |

Current preservation rule supersedes historical wipe-model language above:
retire incompatible session plans with their old owner before activation.
Never erase Secrets or require their re-import, and preserve renewal owners,
workspace data, and the capabilities needed to reach it.
Historical deployment rows are not authorization for a new database wipe.

All rows above remain open except the classification of deliberately transient
picker state; that classification does not waive session-creation verification.
Deployment reconciliation (generation 166, 2026-09-23): the atomic revision,
account-authority vocabulary, provider-ownership checks and immutable state-root
plans are now deployed. Their earlier "not deployed" evidence below describes
the pre-cutover checkpoint, not the current host. This does not close the broader
durability audit or substitute for live authorized rebind acceptance.
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
Terminal journal retirement implemented locally on 2026-09-23. The factory
tracks each journal facet's session and drops it only after successful close
during terminal deletion. Failed/uncertain close retains its owner and blocks
retirement. Network-policy changes and explicit rebind now close and drop old
journal facets after agent/backend drain, before opening the replacement.
The existing incarnation-change fence excludes new acquisitions throughout;
failed closure retains the stopped agent and failed facet, blocking a new writer.
This is in-memory handle reclamation, not durable namespace retirement.
Resume now reconstructs/retains a stopped records-only observer, shuts it down,
and closes its journal facets before publishing permission to run.
Both execution and records-only acquisition are fenced during that transition.
Failed close leaves the stopped observer cached; failed running-state publication
keeps the stop fence because the write may have committed.
An emergency stop can supersede resume; exact token checks and a fixed snapshot
of old facets prevent stale cleanup from closing a later incarnation.
Factory disposal also prevents resume from publishing running after closure.
Failed setup now retains its cached construction through rollback, shuts down
any returned agent, drains the mount and backend admin, then closes only its
captured journal facet. Successful rollback releases the cache for retry.
Failed rollback keeps the rejected construction and exact owners; ordinary
reads, resume and rebind cannot use that rejection to install another writer.
A weak, incarnation-local registry distinguishes known construction rejection
from agent shutdown failure. Terminal deletion, emergency stop and factory
disposal can retry the captured agent/resource cleanup without swallowing a
real shutdown error. Explicit deletion is the recovery path for a retained
failed construction; emergency stop alone does not reopen it.
Source inspection did not identify an ordinary open-factory post-acquisition
failure seam; disposal-raced failures have an independent admission fence.
Regression coverage uses real guest-lookup failure and disposal-raced late
creation/termination failures, not an artificial returned-agent failure hook.
An already-admitted deletion also retries the failed construction's exact native
owner; concurrent disposal then closes submissions, so deletion deliberately
refuses, keeps the schema, and records lifecycle error. That regression proves
safe partial cleanup, not successful retirement or bypass of failed disposal.
Exact-facet reclamation and ordinary acquisition fencing are also source-reviewed;
the disposal regression alone does not prove the latter because disposal has
its own fence. No measured heap bound or fabricated reachable overlap is claimed.
Durability boundary for replacement: the schema and all recorded values stay
unchanged, and the fresh facet reconstructs its name inventory from the host.
Only ephemeral capabilities are closed; no new persistent owner, migration,
replay action, or native process-loss recovery protocol is introduced.
The failed-construction registry is likewise ephemeral: successful formula
disposal still drains native owners and journals; failed admitted work retains
the existing daemon disposal barrier. It is not cross-worker exclusion or
permission to reconstruct a formula after failed disposal.
This change is local and not activated on Tokyo.
The held-read regression verifies drain, rejection rather than truncated old
history, and complete history/new turns across repeated rebinds.
A poisoned-storage regression verifies repeated replacement attempts cannot
acquire another writer. These are factory/storage lifecycle tests, not a heap
measurement or new process-loss recovery evidence.
Six additional resume regressions cover held reads/history restoration,
uncertain close, superseding emergency stop with an overlapping successor
resume, factory disposal, a fresh stopped factory without a UI observer, and
failed running-state publication followed by explicit stop/retry.
The persisted state remains stopped until old handles close; this changes the
ordering of the existing execution-state write, not its schema or replay policy.
`finishSessionDeletion` requires acknowledged terminal intent before namespace
retirement, including creation rollback after an earlier failed registry write.
It attempts that write before ordinary cleanup; a failed acknowledgement does
not skip stopping live work, but it prevents journal retirement. Only after agent/backend
cleanup and journal close does it unbind the journal's exact known value names,
with the matching v1 schema last. Missing empty namespaces are complete; orphan,
foreign-schema and unknown-name namespaces are preserved, not guessed at.
Partially applied deletions keep the registry entry for retry. Generic
`cleanupSessionResources` does not remove the namespace needed by an interrupted
creation that will resume. A central `getAgent` lifecycle/existence check also
fences delayed observe-only calls: they cannot recreate resources while or after
terminal cleanup removes the old incarnation.

Durability evidence: local tests cover removed-but-unacknowledged content and
schema names, refused terminal-intent writes (including creation rollback whose
durable registry still says `creating`), factory reconstruction after
partial removal, malformed namespace refusal before any removal, unrelated
namespace preservation, and an account read held across deletion. The existing
private-facet tests cover admitted write draining and poisoned close refusal.
Those tests use an in-memory host. Added real-daemon tests on 2026-09-23
(`packages/daemon/test/floot-journal-retirement.test.js`) cover failed removal,
removed-but-unacknowledged content, and removed-but-unacknowledged schema. These
three fault cases explicitly disable GC to isolate storage acknowledgement
semantics. A fourth case enables real GC and captures the interruption below.
All four verify the durable terminal registry before restart, poll the latest
persisted registry for completion after restart, and verify durable absence
after a second cold start. Unrelated host data remains intact. They do not
exercise native producers or abrupt OS/process death.

**Pre-merge review item: session deletion can terminate its own factory.** With
GC enabled, removing the guest's final name in `cleanupSessionResources`
collects the guest. `residence.js`'s `disconnectRetainersHolding` deliberately
terminates workers retaining that formula, including the Floot factory that
imported it. The test powers-forwarding worker is also affected; it is not the
only retainer. The delete call rejects before private-journal retirement. A
fresh daemon/worker resumes the durable terminal intent and completes cleanup,
but this is recovery evidence, not normal deletion availability. A two-session
regression now proves collateral interruption: the unrelated session's held
facet rejects with the same collection error. Its durable registry entry and
history survive restart, and a new turn succeeds after reacquiring the facet. The
GC-enabled test intentionally characterizes this failure and must change when
the conflict is fixed. Resolve the deletion/worker-ownership boundary before
claiming GC-safe deletion; do not silently disable production GC, weaken daemon
revocation semantics, or retain tombstone aliases indefinitely. This is separate
from #1323's native-producer shutdown design and does not select its adapter.

Reference-lifecycle investigation: CapTP defaults `gcImports` to false and the
daemon does not override it. Its `releaseSlot`/`CTP_DROP` machinery is internal,
not a supported application release API. Dropping JavaScript references or
forcing JavaScript GC cannot provide a deterministic release acknowledgement.
The guest exo has no universal revocation gate, so exempting guests from worker
termination is not a safe substitute. A per-session worker by itself also fails:
if the factory imports that worker's collected formula, the same propagation
reaches the factory. Candidate designs need separate review:

- A daemon-side scoped operation facade that keeps raw guest references out of
  the factory. Capability results, streams and tool references must also be
  wrapped; a shallow forwarding object does not suffice.
- Per-session workers behind a stable control service that never imports the
  doomed formula or its descendants into the shared factory.
- Deterministic revocable imports, covering aliases and in-flight calls before
  acknowledging release. This is a transport/security design, not a local fix.
- Coordinated factory shutdown before deletion from a separate controller.
  This still interrupts other sessions, so it does not meet isolated deletion.

Do not choose a larger lifecycle redesign implicitly during this refactor.
The required acceptance gate for a remedy is successful deletion with GC on,
continued use of another session's existing facet, and durable recovery without
leaking tombstone names or leaving stale authority callable.

Pre-registry-publication orphan namespaces remain outside automatic retirement;
native process-loss producer exclusion remains with #1323. Unbinding names
releases roots for GC; it does not prove the underlying formulas or disk blocks
have been collected. All 493 Floot tests pass, including terminal-intent writes
rejected with falsy reasons. Scoped lint has zero errors; docs has zero errors
and 176 warnings. Full Floot typechecking still has baseline test-file errors;
none are reported in the changed implementation or test files. Final
adversarial review found no blocking issue. Not deployed.
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
Revalidated the three real-daemon factory-disposal cases on 2026-09-23.
The late-native fixture still exposed removed `listModels`, so current model
admission failed before backend creation and the gate wait timed out.
Updated it to `modelCatalog` and made the gate wait propagate early creation
failure instead of hiding it behind the timeout. All three cases now pass:
admitted write drain, lost-write-acknowledgement fencing, and late backend admin
termination before failed disposal settles. The late-native case deliberately
uses fake guests to isolate factory disposal; it does not prove real guest-GC
deletion safety. No production behavior or persisted format changed.
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
Partial pool-core construction cleanup corrected 2026-09-23: member construction
now runs inside the same rollback boundary as core construction. A later member
failing its lifecycle check previously bypassed rollback and retained earlier
members' unused transport/endpoint cleanup handles until member retirement.
Two regressions cover direct and wrapped members, verify release without
retiring the surviving member, and assert no credential read, fetch or remote
endpoint acquisition. This adds no durable state or formula: these cores are
ephemeral and unpublished, and wrapped endpoints open only on first use. Existing
member ownership still retains failed cleanup; this does not establish
process-loss cleanup or cross-worker exclusion. All 684 hosted-agent tests pass
(one skipped), including 35 issuer cases; package types pass, scoped lint has
zero errors, and docs has zero errors/176 warnings. Final adversarial review
found no blocking issue. Not deployed.
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
Automatic recovery remains blocked on that reconciliation: after a real restart
even a legitimately absent scope currently lacks proof. For the current PR,
use the bounded, verified operator-retirement cutover described in the separate
investigation; do not require completion of the proposed producer architecture.
If safe retirement cannot be established, retain the records and stop deployment.
A privileged producer adapter was explored after conditional operator approval,
but the expanded architecture was subsequently stopped for scope review.
That proposed protocol is superseded as a current-PR direction by the separate
native recovery investigation; it is not required before this PR can proceed.
Existing broad host cleanup is not proven safe by this deferral. A bounded
operator cutover must establish exact ownership and stopped producers before
reclaiming recorded resources, preserving shared renewal owners and workspaces.
Neither a particular new adapter nor replacement of all cleanup with its draft
journal is prescribed. Unknown resources and uncertain stop outcomes stay intact.
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
The OpenCode subset is corrected: bridge option JSDoc now names the actual
options object, and transcript input has an explicit record type supported by
its existing JSON object/non-array check. Six input shapes are covered without
changing normalization behavior. Twenty-six focused tests pass independently,
scoped lint has no errors, and actual OpenCode documentation conversion passes.
Other packages' documentation diagnostics remain open.
The subsequent declaration correction clears those remaining errors: native
controllers explicitly import types referenced by their emitted signatures,
the platform HTTP factory exposes its actual exo methods instead of `object`,
asset-server introspection types its existing optional capability probe, and
hosted-agent directly declares its pass-style dependency.
The ignored declaration/map pair for deleted `setup-peer.js` was quarantined,
not restored as compatibility code; it remains recoverable outside the checkout.
Verified generated outputs were quarantined before rebuilding, without moving
checked-in declarations. The clean root declaration build and full documentation
run now pass; documentation reports zero errors and 175 warnings.
Seven HTTP and 44 asset-server tests pass, including the package's daemon tests.
All 14 opted-in root type-contract tasks also pass.
These changes alter type surfaces, not native cleanup or credential behavior;
incremental generation and the package test-fixture diagnostics remain separate
open checks. No Tokyo deployment is implied by local documentation success.
This declaration correction is committed separately from the deferred producer
research. Its one-line dependency lock update follows in a dedicated lockfile
commit; no producer prototype or deployment change is included.
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
| FA-03 | High | Claude's old form/credential topology is still provisioned | Live legacy infrastructure | Source removed and inventoried producers retired; cross-backend acceptance passed on generation 158 (2026-09-21), across generations 160 and 161, and on generation 165 (2026-09-22) |
| FA-04 | High | OpenCode retains obsolete controller and unused state service | Obsolete path / unused allocation | Source removed, old storage/state formulas retired; cross-backend acceptance including OpenCode restart/restore passed on generation 158 (2026-09-21), across generations 160 and 161, and on generation 165 (2026-09-22) |
| FA-05 | High | Recorded native resource profile does not drive execution | Ignored configuration | Removed; old plans retired before coordinated deployment; cross-backend acceptance passed on generation 158 (2026-09-21), across generations 160 and 161, and on generation 165 (2026-09-22) |
| FA-06 | High | Session provisioning and restart policy are triplicated | Duplication with observed drift | One provisioner, one factory and one execution envelope own the shared lifecycle and the three adapters declare their differences; a shared conformance suite runs all three through creation, reopen through a catalog outage, refused placement, failed start and failed revision, stop retention, restart and deletion, and the exact grant, evidence and raw placement checks Codex alone applied now hold for every runtime (2026-09-22); completion criteria met, deployed as generation 165 on 2026-09-22 with the full acceptance matrix passed (endo-host `ops/hosted-cutover4-20260922.md`) |
| FA-07 | High | Runtime, provider, account, and model route are conflated | Ontology mismatch | Provider-backed discovery and account-bound admission deployed and accepted. Generation 166 adds operator-declared account authority in plans, profiles, catalogs and grants. Explicit durable backend/model identity and discriminated runtime configuration are pushed (`7275afa72`, `25e264f90`), tested locally, not deployed. Claude failure diagnostics are improved locally; the cause of the discovered-model failure and live runtime support remain unverified. Coordinated retirement/deployment and acceptance remain open. |
| FA-08 | Medium | Logical session identity is coupled to execution incarnation | Ontology mismatch | Generation 166 deploys atomic revision intent, the shared `image`/`account`/`provider` vocabulary, recorded/proposed binding inspection and returned binding snapshots, exact state-provider ownership checks, and immutable Claude/Codex state-root placement. Local crash/reconstruction and adapter conformance evidence is recorded below. Generations 167 and 168 pass live provider-only and image-plus-provider authorized rebind with history/workspace preservation, respectively |
| FA-09 | Medium | Storage/environment contract lacks local development storage | Missing resource abstraction | Open; scoped 2026-09-22 (host facts, two enforceable mechanisms, the app-side contract common to both); the operator deferred it on 2026-09-22 and will choose the mechanism and default bound later |
| FA-10 | Medium | Event reduction and conversation conversion are duplicated | Duplication | One reply-event fold shared by the daemon's turn and the browser's component, one hosted-turn message converter, one transcript-delta applier, one reconciliation of a turn's tool evidence for history and restoration, one tool-pairing rule (2026-09-22); completion criteria met, deployed as generation 165 on 2026-09-22 with the full acceptance matrix passed (endo-host `ops/hosted-cutover4-20260922.md`) |
| FA-11 | Medium | Floot retains migration and compatibility scaffolding | Reachable legacy branches | Positional API, usage cache, legacy registry import and private-journal migration removed; deployed since generation 159 and verified against Tokyo's inventory (2026-09-22); Tokyo's persisted one-shot helper formulas and stale state retired 2026-09-22 (see "Legacy retirement — 2026-09-22") |
| FA-12 | Medium | Credential shims and obsolete API wrappers remain | Compatibility entrypoints | Broker wrapper and credential shims removed; deployed since generation 159; the 2026-09-22 inventory finds only shared entrypoints in the host-root-reachable graph; two dormant direct-provider formulas pinned to a pruned release remain for a decision |
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
all records: bounded context selection remains open; local archive paging is
recorded below.
Deployed since generation 157 (2026-09-21); not yet tested against a long-lived
Tokyo session.

Archive paging slice (2026-09-23, local, not deployed):
`getArchivedTurnsPage(cursor?)` reads one committed archive chunk, returning
`{ records, next }`; the continuation pins the archive boundary across appends
and daemon reconstruction.
Pages are in publication order, not global turn-ID order: a late-resolved old
turn can be archived after newer settled turns.
Journal readers capture retained records and the archive boundary in one
serialized read, so turns moved into a newer archive during paging are not lost.
Usage tallying folds pages instead of materializing the full archive, retaining
only the aggregate cached for that captured boundary.
Full-history/transcript APIs still materialize all requested records, and
unresolved retained records can grow; this does not close bounded model context
or compaction, nor promise a byte bound for a chunk's tool evidence.

Durability: no new stored value, formula, renewal owner, or schema migration.
The cursor is inert copy data interpreted only by the already-authorized journal;
it has no storage path or independent authority and does not survive journal
replacement/deletion.
Only committed chunks are visible; an uncertain snapshot write poisons reads
until reconstruction from stored evidence.
Tests cover fixed-boundary paging during archive growth, reconstruction,
late resolution, invalid/future cursors, oversized chunks, and an uncounted
archive left by a failed snapshot write.
The full Floot suite passes 496 tests; bounded context selection remains open.
Package ESLint has zero errors; type checking still reports pre-existing test
errors, with no errors in changed production files.

### Bounded-context storage obstacle and deletion sequence (2026-09-24)

The conversation-tree mirror adds a second unbounded read independently of the
journal. `conversation-tree/src/endopetstore-backend.js`'s `load()` fetches all
`ct-` values with `Promise.all` and retains their full messages in a `Map`.
Even `getNode(id)` invokes that load. Floot's first `getOrCreateLeaf()` calls
`getRoots()` and scans children, while `findRecordedUsage()` and both transcript
projections also depend on this backend. The earlier "no lifetime resident
cache" statement describes only the journal; it does not apply to the full
streaming agent. Journal suffix selection alone cannot establish bounded memory.

Read-only reproduction at app `0e2fefc44`: create 128 independent test nodes,
each with 8192 characters, then request only `node-127` from a fresh production
petstore backend. It performs 128 lookups and reads 1,048,576 content characters.
A subsequent request for `node-0` performs zero further lookups, consistent with
the source's retained full-node cache. This is a deterministic access-count
probe, not a process heap measurement or a live Tokyo load test.

Now that Fae and hosted paths both journal ordered dialogue, prefer retiring
Floot's tree mirror over adding another durable leaf/index authority. This is
a proposed sequence, not a claim that the tree is already redundant or safe to
delete. Independent source review identified these responsibilities that still
depend on the tree:

| Responsibility | Preservation requirement before deletion |
|---|---|
| Incoming mail | Record typed receipt identity and sender metadata before readiness/acknowledgement tools; preserve deduplication across restart. |
| Thinking and UI ordering | Keep typed presentation records and timing separate from model-visible canonical context; never elevate reasoning into model instructions. |
| Usage and successful settlement | Persist reported usage and successful finish under one journal authority; do not treat transcript sealing alone as success. |
| Codex checkpoint acknowledgement | Persist the native checkpoint before acknowledging it, retain it for the next send after a lost acknowledgement. |
| History and branch membership | Preserve full ordered history/status; the deepest-branch fallback is not permission to silently discard tree-only sessions. |

The bounded implementation sequence is:

1. Add only the missing typed mail/presentation/checkpoint facts to the existing
   journal contracts, with bounded validation and before/after-write fault tests.
   Do not add an arbitrary metadata bag, a second owner, or a new credential path.
2. Make new-format history, usage, context and checkpoint recovery projections
   read that journal. Successful `finish`, not `transcriptComplete`, becomes the
   single completion authority; acknowledge the native checkpoint afterward.
3. Remove Floot's tree creation, writes, leaf/branch discovery and node-ID
   dependency. Explicitly retire affected disposable sessions with the old
   release; preserve Secrets, host, workspace access and renewal owners. Any
   session retained for its history must be exported or explicitly handled,
   never reopened as an empty conversation. Do not change generic tree users.
4. Add a journal-owned compaction position/read view and paged active-context
   selection. Archive publication order is not turn order; unresolved effects
   and late settlements must remain visible after any selected boundary.
5. Verify bounded startup and context assembly with large superseded content,
   exact active tool pairs, cold restart, interrupted publication and archive
   growth. Keep full-history UI APIs separate from bounded inference reads.

This remains open work. Automatic summarization additionally requires its
cost/trigger/unknown-window policy; neither a byte cutoff nor a tree-cache
optimization substitutes for that policy. Native producer recovery stays in
#1323 and is not part of this storage deletion sequence.

Real-daemon archive verification gap (2026-09-24): the existing direct-journal
restart regression contains only two turns, so it proves retained-record and
externalized-content recovery, not archived checkpoint selection or archived
tool-evidence certificates.
A dedicated regression now uses the production retention threshold
and real formula-backed private storage, without an external provider request or changed
production limits.
It seeds a checkpoint plus an older tool settled after that checkpoint, forcing
archive publication order to differ from turn order before cold reconstruction.
It verifies the actual archived checkpoint index and tool-evidence certificate,
then constructs the production streaming agent after a graceful daemon restart.
The summary and retained tail appear once, and the late tool result remains
explicit; superseded prose and already summarized tool output do not enter
context.
A wrapper counting reads from real private storage observes no externalized
content reads during construction or recall in this fixture; requesting full
history afterward reads both the old prose and large certified tool arguments.
This is selective content-loading evidence, not a heap bound or constant-time
archive scan.
The focused regression passes through two graceful cold restarts; the second
also preserves the recall's completed turn and the original effect marker.
New-test lint and formatting pass; documentation has zero errors (180 warnings).
All six adjacent real-daemon tests pass in one serial run, including private
journal retirement and the existing direct-provider restart case.
Final adversarial review approved the fixture, assertions and scope.
No production implementation or storage contract changes accompany this test;
abrupt process loss, native compaction capture and Tokyo acceptance remain open.

Checkpoint prerequisite (2026-09-24, local, not deployed): successful hosted
`finish` records now retain `backendCheckpoint` before native acknowledgement.
The opaque text token is validated before the tree write and bounded to 8192
characters as a journal storage profile, not as a provider protocol limit.
Token-bearing events, snapshots and archives require a terminal completed turn
and settled host/observed tool evidence. A failed or unacknowledged journal write
never permits the native acknowledgement; a lost acknowledgement preserves the
completed token. This prerequisite initially left tree-based checkpoint recovery
in place; the local projection change below replaces that source, not the tree.
No new formula or credential owner is introduced, and old records lacking the
optional token do not acquire an invented checkpoint.
Tests cover replay, snapshot/archive reconstruction, lost write replies, invalid
tokens/states, corrupted unsettled checkpoint records, and actual hosted ordering
including token rejection before tree publication. All 559 Floot tests pass.
Scoped lint has zero errors (76 warnings), formatting/diff checks pass, and
root documentation has zero errors (179 warnings). Independent adversarial
review approved after the loaded-record validation gap was fixed.

Checkpoint recovery projection (2026-09-24, local, not deployed): native send now
receives only a token from a terminal completed journal turn. Selection uses the
greatest dispatch ID across one pinned retained/archive view, never tree metadata
or archive publication order. A tree write followed by a refused journal finish
cannot authorize acknowledgement; a lost reply after successful journal storage
can recover the committed token. Later partial nodes no longer hide a prior token.
New tree nodes, including typed mail receipts, no longer copy or store checkpoints;
the successful journal finish is their sole durable authority.

Until tree removal, a temporary retirement guard inspects checkpoint-bearing
ancestors and refuses legacy successful/tree-only tokens lacking journal proof,
unless superseded by a newer proven checkpoint. Failed/unknown journal turns do
not promote their tree tokens to success. This is refusal, not migration:
retire/reprovision affected disposable legacy sessions before deployment.
The existing full-tree traversal and archive scanning are not bounded-startup
completion; no durable index, compatibility owner or retry policy is added.
All 579 Floot tests pass, including actual follow-up sends after before/after
finish-publication failures, lost acknowledgement, hidden legacy/proven tokens
behind partial nodes, and archived tokens published out of dispatch order.
Scoped lint has zero errors (57 warnings), root docs zero errors (179 warnings),
and formatting/diff checks pass. Adversarial re-review approved after checking
ancestors and removing redundant tree token writes.

Usage recovery projection (2026-09-24, local, not deployed): all token counts and
completed/incomplete turn counts now derive from terminal journal records.
Tree `usageTotals` reads/writes and the mutable completed-total cache are removed.
Transcript sealing or a successful tree write without journal finish is not
counted as completion; a lost reply after a stored finish recovers its usage.
The private usage reader keeps only an immutable archived aggregate keyed to
the captured archive frontier, combining retained turns from the same read view.
Each nonzero context field is selected by greatest dispatch ID, so a late-settled
old turn cannot overwrite a newer archived reading, even when only one context
field was reported. Token arithmetic and public usage fields remain unchanged.

Aggregation is now optional display work after settlement, not a prerequisite
for saving billed usage. On reporting failure/timeout the display update is
skipped instead of substituting guessed or incomplete totals; the completed
turn remains durable. The cache is not a formula or a second accounting owner.
Archive scanning still grows with history on cache misses; bounded startup and
the journal compaction/read index remain open work.

Deployment gate: retire affected disposable legacy sessions before this cutover.
If any history is retained, export it first and explicitly account for any
tree-only totals; this implementation does not migrate or trust those totals.
Secrets, host, renewal owners and workspace references remain outside retirement.
All 588 Floot tests pass. Coverage includes fabricated tree totals, both backends'
tree/finish write failures and lost replies, late archived context readings,
successful settlement despite reporting failure, and overlapping captured views
completed out of order with cache invalidation/reuse. Scoped lint has zero errors
(60 warnings), root docs zero errors (179 warnings), and formatting/diff checks
pass. Adversarial review approved the private projection and concurrency tests.

Journal-only history cutover (2026-09-24, locally verified, not deployed):
the current implementation removes Floot's conversation-tree reads and writes,
leaf cache, and obsolete hosted turn-message converter.
Model context and UI history now project the private turn journal; thinking,
mail metadata, tool evidence, checkpoint recovery and usage retain that same
durable authority.
An existing `ct-*` name refuses session construction before journal recovery or
backend startup: retire/export affected sessions, not migrate them implicitly.
Removing those names manually is not a supported migration or completeness proof.
Secrets, host, renewal owners and workspace references remain outside retirement.
Repeated typed receipts hide only the repeated display input, not execution;
automatic mail retry policy is unchanged pending its separate decision.
Recovered effects and interrupted reply text with unprovable ordering are marked
explicitly unordered rather than silently discarded or presented as new effects.
All 587 Floot tests and four real-daemon journal restart/lifecycle tests pass.
Scoped lint has zero errors (79 warnings before the final regression addition;
the final helper/test check has two warnings), root docs zero errors (179 warnings),
and formatting/diff checks pass. Adversarial re-review approved after the
interrupted reply evidence fix and receipt continuation regression.
The unused Floot dependency on `@endo/conversation-tree` is removed as a follow-up;
composite configuration regeneration produces no tracked changes, and lockfile
regeneration removes only that dependency edge. Generic conversation-tree users
remain unchanged. Bounded context reads and archive indexing remain open;
this deletion alone does not establish bounded recovery memory.

Compaction-selection prerequisite (2026-09-24, local, not deployed): each
transcript entry carries a required kind index derived internally from canonical
content and published in the same event as its payload/reference.
Replay, snapshot and archive metadata reads validate both the kind and its match
to the canonical payload preview without loading large externalized content.
Full hydration still validates the canonical content and index together.
No new formula, mutable index owner or separate publication is introduced.
Legacy records without this field are refused, not eagerly migrated; archives
are checked when read, so successful retained-state startup does not prove all
legacy archives are compatible. Retire affected disposable sessions before deploy.
The index alone does not select context or bound archive metadata scanning.
The next context reader must preserve unresolved and late tool evidence across
compaction boundaries, including older turns archived after newer turns.
Full-history UI APIs remain separate from this upcoming inference read path.
All 590 Floot tests and four real-daemon journal/lifecycle tests pass.
Tests cover missing, invalid and conflicting kinds in events, snapshots and
archives, large-payload metadata reads without hydration, and lost-write replies.
Scoped lint has zero errors (19 warnings), root docs zero errors (179 warnings),
and formatting/diff checks pass; independent adversarial review found no
durability blocker.

Active-context projection (2026-09-24, locally verified, not deployed):
Fae and hosted sends use a separate model-context projection; public transcript
and UI history APIs retain full-history semantics. Shared recovery also preserves
an unresolved canonical call before a checkpoint in the same turn.
The selector uses the latest compaction in numeric dispatch/ordinal order from
the pinned journal view, excluding pending/current turns, never archive order.
Superseded dialogue payloads and the boundary turn's input are not hydrated.
Tool payloads still undergo exact reconciliation before context selection.
Prior-turn unmatched evidence, unresolved calls, host-recovered answers and
results published after the checkpoint remain labeled exceptions after the
active context, with collision-safe paired IDs; they are not new executions.
Late-result comparisons use the checkpoint's global event sequence, not its
turn ID. A summary alone is not evidence that an unmatched effect was observed
or an uncertain outcome resolved.
This stage still reads all archive metadata and historical tool payloads.
It is not bounded-startup or bounded-archive completion; durable coverage/index
work and automatic compaction policy remain separate open tasks.
All 599 Floot tests and four real-daemon journal/lifecycle tests pass.
Dedicated regressions cover skipped superseded payload reads, retained-tail
expansion, excluded/pending checkpoints, mixed settled/unresolved pairs, late
archived results across revival, repeated native IDs, exception ID collisions,
and same-turn unresolved calls across a checkpoint.
Scoped lint has zero errors (59 warnings), root docs zero errors (179 warnings),
and formatting/diff checks pass. Independent adversarial review approved.

Paged context metadata (2026-09-24, locally verified, not deployed):
inference no longer calls the full-history metadata collector.
It captures one immutable journal read view and makes two sequential page passes:
select the checkpoint tuple, then recover each turn's required output.
Both passes reuse the same retained snapshot and committed archive end; later
settlements/publications belong to the next read, not half of the current read.
The selected checkpoint's identity is checked again before projection.
Only nonempty active/exception output groups are retained and sorted by dispatch
ID, so late archive publication cannot reorder the model's context.
Either-pass failures reject the whole read rather than return partial context.
This removes whole-history archive-metadata materialization from inference, not all
unbounded costs: there are still two full metadata scans and historical tool
payload reads. One archive page, the retained window plus unresolved records,
and selected active/exception output remain resident. The output and unresolved
sets are not bounded merely by paging; context compaction and coverage/index
work remain open. Public full-history readers retain their separate contract.
All 606 Floot tests and four real-daemon journal/lifecycle tests pass.
Dedicated tests pin the same cursor and retained state across concurrent archive
publication and late settlement, verify the next read sees those updates, reject
either-pass read failures and changed/missing checkpoints, and compare the paged
reader with real journal archive/revival projection.
Scoped lint has zero errors (57 warnings), root docs zero errors (179 warnings),
and formatting/diff checks pass. Independent adversarial review approved,
including the explicit optional-checkpoint narrowing fix caught by docs.

Archived checkpoint lookup (2026-09-24, locally verified, not deployed):
snapshots now retain a constant-size derived archived checkpoint index (or null).
The writer selects the maximum numeric dispatch/ordinal while archiving, so an
old checkpoint archived late cannot replace a newer checkpoint.
Archive storage precedes the snapshot that publishes its counter and index
together; ambiguous writes poison the incarnation before another read can expose
an uncommitted candidate. No second formula or independently published owner exists.
Startup validates index shape/ranges and the referenced chunk/entry using metadata
only. This proves the referenced checkpoint is valid; maximality comes from the
writer's derivation, not a startup rescan of all archives.
Context selection compares this candidate with the pinned retained snapshot,
normally removing the first full archive scan. If the caller excludes the indexed
archived turn, selection falls back to the paged scan for the previous candidate.
Projection still verifies the selected tuple and scans history for exceptions.
Snapshot/archive version 2 refuses older snapshot/archive formats; event-only
journals with current transcript fields can still replay. Retire affected sessions
before deploy rather than relying on this as a universal legacy-format detector.
Historical tool hydration and the remaining archive pass are still open costs.
All 614 Floot tests and four real-daemon journal/lifecycle tests pass.
Coverage includes exact before/after archive and snapshot failure cuts, poisoned
writer reads, recovery after orphan publication, late archival ordering, excluded
maximum fallback, malformed/mismatched pointers, and a large external checkpoint
whose startup validation reads one archive page and no content values.
Scoped lint has zero errors (25 warnings), root docs zero errors (179 warnings),
and formatting/diff checks pass. Independent adversarial review approved.

Archived tool-evidence reuse (2026-09-24, locally verified, not deployed):
before publishing an immutable archive chunk, the writer uses exact existing
tool reconciliation to derive an optional `no-tool-exceptions` certificate.
It refuses certification for unresolved raw effects, missing sequence provenance,
unmatched observations/executions, unknown placeholders, or host-only recovered
answers. Repeated calls retain the existing one-to-one pairing rules.
The certificate records the exact maximum canonical-tool and raw intent/result
sequence. It belongs only to a detached archive copy and shares that chunk's
snapshot publication; certification read failure poisons the writer.
Retained snapshot records reject certificates. Context skips tool hydration only
for archive-origin turns strictly before the selected checkpoint whose recorded
frontier is no later than that checkpoint. Boundary/retained turns, missing
certificates and late evidence use full reconciliation.
Archive reads validate certificate shape, exact metadata frontier and raw
settlement; semantic absence of exceptions is the writer's derivation, not a
new proof obtained without payload reads. This does not certify dialogue
completeness or knowledge of unobserved native execution.
The change moves ordinary old-tool hydration to archive publication; it does not
eliminate the archive metadata scan, exceptional evidence growth, or the need
for a compaction policy. No new formula, publication owner or migration is added.
All 629 Floot tests and four real-daemon journal/lifecycle tests pass.
Dedicated tests cover repeated calls, every exception/provenance disqualifier,
late frontiers, malformed certificates, archive-only skipping, 12,000-character
arguments/results with zero context-time content reads, and certification-read
failure poisoning before archive publication with recovery of the original turn.
The archive/snapshot before/after-publication fault matrix also passes.
Scoped lint has zero errors (26 warnings), root docs zero errors (179 warnings),
and formatting/diff checks pass. Independent adversarial review approved.

Recovery input cleanup (2026-09-24, locally verified, not deployed):
`recoverTurnTranscript` no longer accepts an alternate provider-message/tree
input. All production callers already supplied an empty list after the journal
cutover; removing it leaves the journal as the sole restoration authority.
Matching tests now create canonical journal fixtures with sequence provenance,
preserving repeated-ID, one-to-one matching and host-result replacement checks.
Recovery without transcript entries remains supported for failure before the
first canonical publication, including full input/output and tool content refs.
The direct-provider message converter remains used for new replies; it is not
another durable transcript owner. No storage format or retirement change.
All 630 Floot tests and four real-daemon journal/lifecycle tests pass.
Scoped lint has zero errors (62 warnings), root docs zero errors (179 warnings),
and formatting/diff checks pass. Independent adversarial review approved.

FA-07 next implementation sequence, confirmed by source review (2026-09-24):
public APIs use `provider` for Fae, but registry entries still encode it by an
absent backend ID and a separate `model` field. Normalize durable session identity
to required `backendId`/`modelId` first, preserving the public `provider` identity;
replace truthiness-based sandbox capability checks explicitly so direct sessions
do not acquire hosted stop/mount/rebind semantics accidentally.
Then replace optional-field inference in streaming configuration with explicit
direct, hosted and records-only variants. Keep provider lookup per turn so
credential refresh reaches existing direct sessions; do not create another
sandbox lifecycle or credential owner.

FA-07 durable identity slice (2026-09-24, locally verified, not deployed): the factory
now creates every registry entry with explicit `backendId` and `modelId`.
Fae uses `backendId: 'provider'`; its exact empty model ID follows the configured
default, while a nonempty ID remains pinned. Hosted entries require a model.
Registry loading refuses absent identity and the legacy `model` property before
session resource acquisition; retire incompatible sessions with the old release.
Hosted stop, network, bindings, mounts and cleanup now use explicit classification,
not backend-ID truthiness. Delegates inherit the parent's explicit identity.
The existing append-only registry remains the durability authority: no new formula
or credential owner is added, and provider credentials are still resolved per turn.
All 640 Floot tests and five real-daemon journal restart/retirement tests pass.
Focused tests cover default/pinned identity, restoration, colon-containing provider
routes, hosted-only operation refusal, and legacy rejection without migration.
Adversarial review approved after tightening whitespace validation and removing
the delegation fallback. Follow-up direct-provider delegation regressions now
exercise the real provider tool loop with mocked HTTP responses, including a
colon-containing pinned route and an unpinned configured default. They dispose
the prior factory through its lifecycle hook before reconstruction over preserved
guest stores. After changing the default, actual restored-child requests follow
the new default only when unpinned; pinned children retain their exact route.
Parent history, child identity and absence of hosted acquisition are checked.
All 645 Floot tests pass; scoped fixture lint/formatting and the documentation gate
pass (zero documentation errors, 180 warnings). This is in-memory reconstruction
coverage, not a new claim of live daemon or crash-loss acceptance.
Scoped lint has no errors; documentation generation has no errors (179 warnings).
Tokyo still runs the previous release.

FA-07 runtime discrimination slice (2026-09-24, locally verified, not deployed):
streaming-agent construction now requires exactly one explicit runtime variant:
`provider` with a provider thunk, `hosted` with a tool-catalog-aware client thunk,
or `records-only` with no constructor. Static injected objects and raw provider
credentials are no longer alternative constructor shapes. Ambiguous, unknown,
inherited-discriminant and legacy configurations fail before guest access.
Provider lookup remains dynamic for credential rotation; hosted construction still
follows journal validation and tool catalog construction. Records-only instances
can inspect history but refuse turns before dispatch and never start inbox work.
This is incarnation-local configuration, not new persisted state or a new owner.
All 643 Floot tests and the real-daemon two-cold-start direct journal test pass.
Runtime boundary tests cover invalid shapes and records-only non-execution; the
existing credential-rotation regression passes with the new provider variant.
Adversarial review approved after the own-discriminant correction; the final
14-test boundary/hosted/rotation rerun passes. Scoped lint has no errors
(53 warnings), and documentation generation has no errors (180 warnings,
including the internal runtime type referenced by the public constructor).

Mail metadata prerequisite (2026-09-24, local, not deployed): dispatch now
preserves existing `meta.mail` as typed optional `{from, messageNumber}` fields
in the private journal before receipt-tree writes or inference. At least one
field is required when mail metadata is present; unknown fields are refused.
Sender text is bounded to 8192 characters and opaque mailbox-local message
identity to 128 characters as storage profiles. Sender text is presentation,
not authority. Replay, snapshots and archive reads validate the same shape.
The existing hardened-data boundary freezes admitted metadata; stored/recovered
records remain detached copies. A refused receipt-tree write still leaves the
journal's original sender, message number and input available after reconstruction.

This does **not** change mail retry/deduplication policy. Ordinary mail currently
carries sender metadata only; typed requests/forms also carry the message number.
The tree currently deduplicates typed receipt text, not automatic execution:
unfinished inbox tasks can be dispatched again after restart because the inbox
handled set is incarnation-local. At-most-once automatic admission would leave
uncertain requests/forms and lost replies for explicit recovery, rather than
rerunning inference or resending an uncertain reply. That behavior change is
awaiting an operator decision; no journal receipt cache or new policy is added
by this metadata prerequisite. Missing historical receipts are not dedup proof.

All 564 Floot tests pass, including malformed snapshot/archive rejection and
receipt recovery after a failed tree write. Scoped lint has zero errors (77
warnings), and root documentation has zero errors (179 warnings).
Formatting and diff checks pass; adversarial review approved the source, tests
and scope after the metadata immutability test and type narrowing were corrected.

Thinking presentation prerequisite (2026-09-24, local, not deployed): hosted
turns publish a finalized, typed thinking snapshot in the same private journal
before the successful tree mirror/finish or the partial-turn mirror.
Delivered failed/cancelled turns retain presentation independently of whether
their backend retains its own transcript. This is settlement-time durability,
not a claim that every streamed thinking delta survives abrupt process loss.
The existing preview limits remain 64 blocks and 65,536 total text characters;
large encoded payloads use the journal's content-before-event references.
Each block records its identity, timing, truncation and a canonical transcript
ordinal anchor. Flushing text before a new thinking block and ending thinking
at tool/compaction boundaries preserves placement without putting reasoning
into model context. An omitted end time is allowed; neither presentation nor
transcript sealing asserts successful settlement.
Exact duplicate publication is idempotent; conflicting snapshots and malformed
identity, timing, bounds or anchors are refused. Replay, snapshots and archive
reads validate presentation. No formula, credential owner or second journal is
introduced. UI history still reads the tree until the planned projection cutover.
All 575 Floot tests pass, including sparse/malformed payloads, archive/snapshot
corruption, exact thinking/tool/compaction ordering, before/after-publication
failures, failed tree writes, and cancellation after the interruption barrier.
Restored canonical context excludes reasoning in every integration fault case.
Scoped lint has zero errors (92 warnings); root documentation has zero errors
(179 warnings). Formatting/diff checks pass. Adversarial re-review approved
after sparse-array validation and the tool-result thinking boundary were fixed.

## FA-02 — Model context must not be built from UI previews

Deployment reconciliation (generation 169, 2026-09-23): app `819aa18c8` now
runs the archive read-view/paging, Fae/OpenCode recorded-compaction replay,
and failed-response usage/retry fixes described below.
Four-backend seed, actual daemon restart, recall and scoped deletion passed
on OpenCode/Fae automatic free routes, Codex Luna, and Claude Haiku.
Reconstructed session facets all expose the new archive-page method; empty
terminal pages were checked, not a live archive boundary.
All six Secret identities, controller host and credential namespace bindings
were preserved; two unrelated sessions remain, with zero native records,
containers or 9p mounts after test cleanup.
The host evidence is `endo-host/ops/hosted-cutover5-20260923.md`, generation 169.
This supersedes the earlier local/not-deployed checkpoints below, but does not
prove native compaction capture, large archives, provider-error fault injection
on Tokyo, or process-loss recovery.

OpenCode import correction (2026-09-23, not deployed): the pinned fork
`kumavis/opencode@870a58b973a2892d93c04e5db6e49757ad8237b9` uses
`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` for
`POST /session/:id/message/import`.
It writes legacy message/part tables and represents imported compaction as
synthetic user text, not a native boundary.
The parallel core history implementation is not the context reader for this route.
The adapter now selects the latest compaction and active span before import;
Floot's full transcript remains unchanged.
The payload round-trip decoder no longer filters its input, which previously
hid the adapter's transmission of superseded history.
Tests assert the exact submitted payload, repeated tool IDs, and refusal of a
result whose call lies before the boundary.
This is a pure replay transformation: no new durable state or formula schema.
Native compaction capture remains open: the legacy CLI can retain a recent tail
outside the summary, and interrupted-turn persistence must preserve the correct
boundary and tail rather than recording a summary alone.
Payload conformance does not prove native database/model-context behavior;
live acceptance remains pending.
Verification: 259 OpenCode tests pass; package lint has zero errors (37 warnings),
documentation generation has zero errors (176 warnings), and formatting passes.
Independent adversarial review verified the pinned route and reran all 11
transcript conformance tests with no blockers.

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

Direct-provider journal prerequisite (2026-09-23, local, not deployed):
Fae's assistant/tool dialogue previously remained in `stagedMessages` until the
final tree write. A later provider failure could lose earlier assistant prose;
putting a future summary only there would also lose its context boundary.
The current implementation uses the existing ordered turn journal for input,
completed model replies/calls before tool execution, tool results, and the
acknowledged prefix before the final tree mirror. A rejected provider stream's
available text is retained as an unsealed prefix, not claimed complete.
No new formula, journal schema, or automatic summarization policy is introduced.
Initial full Floot coverage passed 531 tests. Adversarial review then identified
cancellation during transcript/intent publication as an execution-admission gap;
new checks refuse execution after cancellation while preserving settled evidence.
Expanded coverage also verifies malformed arguments and synthetic IDs, identical
parallel calls settling in reverse order, and failed/lost acknowledgements at
call, result, seal, tree, and finish publication. Model calls and external tools
are not replayed during reconstruction. A further review check fences cancellation
before and after sealing: complete dialogue is not necessarily a successful turn.
Cancellation before admission of the final tree write leaves a cancelled turn,
possibly with a complete transcript; once that immutable write is admitted, its
completion wins the race. No implicit cancellation of already-admitted effects.
In-memory reconstruction is not real-daemon durability acceptance, and process
loss during a live stream can still lose its unacknowledged text. Usage whose
terminal journal write cannot be acknowledged has no new independent durable
owner in this slice. Real-daemon/live acceptance remains required.
Final local validation: all 547 Floot tests pass, formatting and diff checks
pass, scoped ESLint has zero errors (56 warnings), and root documentation has
zero errors (179 warnings). Independent adversarial review approved the changes
after both cancellation gaps were fixed and regression-tested.

Real-daemon reconstruction evidence (2026-09-23, local):
`packages/daemon/test/floot-direct-journal.test.js` runs the production streaming
agent and private journal in a persisted module formula with real daemon storage
and GC enabled. Inert inference creates a failed tool turn with a long assistant
message stored by content reference, one durable test effect, and partial reply.
After orderly shutdown and cold restart, the exact transcript and turn records
match and reconstruction makes zero provider calls. A follow-up provider request
receives the full long text and settled tool result; its completed sealed turn
survives a second cold start. The durable effect proof remains unchanged.
This tests the streaming-agent/private-journal boundary, not the full Floot
factory provisioning path, native producers, abrupt process death, or Tokyo.
The restart test and three adjacent factory lifecycle tests pass together;
scoped lint has zero errors (three warnings), formatting/diff checks pass, and
root documentation has zero errors (179 warnings). Independent review requested
full expected-text and exact turn-count assertions; both are now verified.

Next sequence: finish direct-provider ordered durability, then bounded active
context admission and journal-owned suffix selection, then automatic summaries.
Checking final request size alone does not bound assembly: `getTranscript()`
currently hydrates all archive pages before selecting the last compaction.
Keep full-history APIs separate from bounded model-context reads, and retain
unresolved execution evidence. Automatic summarization still needs an explicit
cost/trigger/headroom and unknown-window policy; do not silently truncate history
or introduce a separate context authority to bypass those decisions.

Recorded-compaction replay correction (2026-09-23, local, not deployed):
the direct-provider converter ignored canonical compaction records, replaying
superseded messages and omitting the summary.
It now uses the shared last-compaction split, emits the summary as an assistant
message (never a system instruction), and pairs tool evidence only in the active
span.
A result whose call lies before the boundary is refused as malformed context,
not silently dropped or paired to a different effect.
Original transcript records remain unchanged and readable.
Tests cover multiple boundaries, repeated tool IDs, unknown outcomes, malformed
cross-boundary results, and a hosted compaction persisted through reconstruction
into an actual direct-provider dispatch.
No new persisted state, summarization call, or compaction trigger is introduced.

Native capture remains open: the current OpenCode bridge explicitly suppresses
summary-message text and emits no `compaction` event from those records
(`makeMessageRegistry`/`mapSseEvent` in `opencode-bridge.mjs`).
The existing synthetic compaction round-trip tests prove representation and
restoration, not that this bridge captures a live CLI boundary.
Complete capture and interrupted-turn durability must be verified before
claiming end-to-end compaction; bounded context selection and automatic
summarization policy remain open as well.

Retained-context contract (2026-09-23, local, not deployed): source inspection
of pinned fork `870a58b973a2892d93c04e5db6e49757ad8237b9` established that
`packages/opencode/src/session/message-v2.ts:filterCompacted` reorders a
completed summary ahead of older retained messages selected by `tail_start_id`.
`session/compaction.ts:prune` separately marks old tool results, and
`message-v2.ts:toModelMessages` substitutes `[Old tool result content cleared]`.
Therefore neither a summary alone nor an offset into Floot's original history
faithfully describes native active context.

The shared canonical compaction record now accepts `retainedTail`, an ordered
snapshot of ordinary message/tool records, never nested compactions, capabilities
or native storage identifiers. Its nested records receive the same strict
validation and canonical field ordering as top-level records.
The shared last-compaction selector expands summary, retained tail, then later
records exactly once; its returned summary carries no tail to expand again.
Original historical records are untouched. Pruned outputs can be preserved in
the context snapshot without replacing full historical tool evidence.
Shared conformance covers the three hosted adapters; direct-provider replay
has a separate exact-message regression.

Tree/event propagation now carries this field through successful turns and
failed-stream partial segments, without expanding it into displayed history,
tool activity or execution accounting (local, not deployed).
The complete encoded checkpoint counts against the retained-turn memory bound.
A reconstruction test restores the exact pruned context into a direct provider.
Admission currently requires a self-contained tail with settled tool pairs;
incomplete calls or orphan results are refused, not silently dropped.
The canonical format remains more general, but supporting results arriving
after a checkpoint requires the ordered-journal reconciliation below.
The ordered journal wiring below now covers interruption before tree publication
in synthetic storage/stream tests. The native producer and bridge wiring below
are now implemented locally; Tokyo still runs the earlier image.
No formula is created and no existing stored record is rewritten.
Native capture implementation/acceptance sequence (the first three are now
implemented locally; deployment and live acceptance in the fourth remain open):

1. Carry checkpoints through tree messages and protocol events without adding
   retained-tail copies to display history or usage/execution accounting.
2. Persist full checkpoint content before its ordered journal reference, and
   preserve surrounding text ordering. The former tool-only observations and a
   concatenated terminal output cannot locate a recovered compaction safely.
   Failed publication must fence; repeated identical boundary delivery must be
   idempotent and a changed payload under the same identity must be refused.
3. Capture the completed native summary and exact retained context with an
   explicit event frontier. A history fetch can race later SSE events; never
   splice a snapshot and replay those same events a second time.
4. Test interruption at content/journal publication, cancellation, duplicate
   delivery, restart/replay and tool-pair preservation, then live compaction.

This transcript work is separate from native-process crash recovery in #1323.

Ordered journal storage foundation (2026-09-23, local, not deployed):
`recordTranscript` stores canonical context records at contiguous per-turn
ordinals, preserving their journal sequence as well as their transcript order.
Full large content is stored before the referring event, using the existing
uncertain-write fencing. Identical ordinal retries compare full content and
are no-ops, including after settlement/reconstruction; conflicting content,
gaps, new records on recovered/terminal turns and unknown turns are refused.
The profile limits one turn to 65,536 records and 16 Mi UTF-16 content units;
snapshot reconstruction validates ordering, references and aggregate bounds.
It does not hydrate every retained payload: full canonical content is checked
when read or compared for a retry. Aggregate counts are maintained per append
and recomputed once on reconstruction, not scanned on every write.
Older records without this stream have an empty stream, not inferred ordering.
Hosted streaming now writes ordered entries, coalescing ordinary answer text up
to a 64 Ki character flush threshold and flushing before tools and checkpoints.
An explicit completion event seals the acknowledged ordinal frontier.
Failed publication stops the producer and leaves that journal incarnation fenced;
cancellation flushes the last text only after the producer acknowledges shutdown.
An interrupted stream may lose unflushed text; reconstruction labels its durable
prefix rather than filling it out with concatenated terminal output.
Tool observations and execution entries retain independent call/result positions.
Recovery uses the ordered journal for model context, not duplicate tree copies.
Unmatched effects remain supplemental after active context: journal chronology
does not prove that a native summary included them. A newly recovered completion
of a pre-boundary call is also surfaced as explicitly recovered evidence after the
boundary, including when replacing an old unknown-result placeholder.
Synthetic tests cover tree-free restoration, failure before/after event publication,
cancellation barriers, delayed call observations and compaction-crossing effects.
The stream refuses checkpoints crossing an unsettled reported tool call rather
than creating an orphan result after the context boundary.
Stream/recovery validation: 529 Floot tests pass; touched lint and docs pass with
warnings, and source typechecking reports no errors. Adversarial review approved.
The native bridge wiring below supersedes the earlier disabled-capture status;
live compaction and real-daemon restart acceptance remain open.

Native checkpoint producer preparation (2026-09-23, local fork, not deployed):
the pinned OpenCode fork's import endpoint inserts legacy message/part rows
directly without publishing their corresponding events.
An SSE-only context mirror would therefore omit imported retained history.
The isolated `kumavis/opencode` branch `codex/compaction-checkpoint`
(producer commit `f6492ac3f9`), based on
`870a58b973a2892d93c04e5db6e49757ad8237b9`, instead reads the authoritative
store and applies native `filterCompacted` when publishing `session.compacted`.
Its optional version-1 checkpoint includes the summary identity and ordered
native messages, after continuation creation and before the normal prompt loop
can start another model step.
This is not an atomic snapshot against unrelated concurrent native writers.
The checkpoint is bounded to 16 MiB of encoded UTF-8; overflow stops processing
rather than silently truncating context or continuing without the checkpoint.
The size check bounds publication, not the preceding database read or encoding
allocation, and is separate from Floot's aggregate retained-turn profile.
Native message records still need canonical conversion, including ignored text,
pruned tool output, and explicit refusal of unsupported media.
The bridge must align its frame bounds, validate boundary identity and duplicate
payloads, and prove actual SSE ordering before this producer is enabled.
Checkpoint preparation failure publishes a sanitized session error before
returning `stop`; relying on the outer HTTP error handler would allow the
runner's earlier idle event to incorrectly seal a successful Floot turn.
The service-level regression verifies error publication before process return.
Stopping this turn does not undo native compaction or prevent later prompts.
Before enabling capture, the bridge must fence continuity after checkpoint
failure, or reconcile the same authoritative boundary before accepting a prompt.
Focused validation: 58 native compaction tests pass (one skip), three schema
tests pass, and both package typechecks pass; legacy SDK generation completed.
The existing event-manifest suite also fails on fixed inventory counts/order;
no new event type was added, and this is not counted as a passing gate.
There is no app image pin change, daemon deployment, or live compaction claim.

Native checkpoint projection preparation (2026-09-23, local, not enabled):
the standalone bridge now has a pure converter for the version-1 native snapshot.
It validates message/part ownership and uniqueness, the completed summary and
its leading compaction request, then preserves the retained dialogue/tool order.
The native request scaffold maps to the canonical summary; the synthetic
continuation remains context, unlike its suppression in the live UI stream.
User ignored text, failed assistant omission, interrupted partial tool output
and pruned tool placeholders follow the inspected native rules.
Unsettled calls, provider-executed tools, media attachments, nested boundaries
and unknown context-bearing parts fail explicitly.
Tool-call identifiers may repeat across user turns, not within one turn.
Native reasoning and provider metadata remain outside the existing canonical
text/tool contract: this is not exact provider-prompt equivalence, including
signed-reasoning replay. Supporting that requires a separate contract extension.
At this preparation checkpoint the converter was not called by event handling;
transport bounds, duplicate-boundary reconciliation, continuity fencing, and
actual SSE ordering remained gates, addressed by the wiring below.
It adds no durable formula or stored schema.
Validation: all 268 OpenCode sandbox tests pass, including eight projection
regressions and canonical import round-trips. Scoped lint has no errors and
seven pre-existing warnings. Adversarial review caught and corrected the
cross-turn tool-ID restriction; re-review approved the supported subset.

Native bridge wiring (2026-09-23, local, not deployed): `session.compacted`
now projects and emits the checkpoint at its SSE position, without a later
history fetch. A repeated native summary identity with identical encoded content
is a no-op; conflicting content under that identity fails closed.
Only a digest is retained per boundary, bounded to 65,536 identities per bridge.
The producer's 16 MiB checkpoint profile has 17 MiB SSE envelope capacity and
34 MiB host JSONL capacity (tool JSON inputs are encoded again as argument strings).
Framing limits count UTF-8 bytes per frame rather than per coalesced network chunk.
Malformed/truncated frames, missing checkpoints, unsupported context, identity
conflicts and native checkpoint-publication failures stop the entire incarnation.
No later prompt is accepted from its queue; restoration must use Endo's transcript.
Timeout or expired cancellation grace also stops the bridge, since neither is
proof that the old native turn ended. This prevents late old-turn checkpoints
from being assigned to a queued new turn.
Output delivery waits for pipe backpressure and bounded shutdown flushing, after
a process test exposed truncation of a large checkpoint during immediate exit.
Compaction summary model usage is reported once per native step, not hidden with
the summary's live UI text; snapshot projection itself adds no usage or tool events.
The source-build default now selects `kumavis/opencode` branch
`codex/compaction-checkpoint`, containing producer `f6492ac3f9`.
Seven actual bridge-process tests use a fixture HTTP/SSE server, including a
2 MiB checkpoint before later answer text, duplicate delivery, conflict/native
failure, malformed data, stream loss, and queued-send/late-checkpoint fencing
on timeout and cancellation. These are not a live native model compaction test.
An image rebuild, paired deployment and native compaction/restart acceptance
are still required; this does not claim native process-loss recovery from #1323.
Validation: all 280 OpenCode sandbox and 529 Floot tests pass.
Root documentation/type validation has zero errors and 178 warnings.
Scoped ESLint has no errors
and nine warnings. The existing standalone fixture lacks an ESLint project
mapping; its syntax check and process tests pass, but that lint invocation is
not counted as passing. Adversarial review found the unconfirmed-stop race;
the fix, queued-send regression and stdout-drain correction were re-reviewed.

Additional native-context parity finding: when `compaction.prune` is enabled,
native `prompt.ts:1338` forks pruning without awaiting it; `compaction.ts:286-330`
sets old tool parts' `time.compacted` flags through ordinary part updates,
without a new summary checkpoint. The bridge suppresses repeated completed-tool
updates, so a later restoration could reintroduce output pruned after the last
checkpoint. Pruning normally stops at the latest summary, but an older background
prune can race a newer snapshot. The pinned fork defaults pruning to false.
The hosted bridge now additionally sets `OPENCODE_DISABLE_PRUNE=1` on its child;
the pinned native config applies this override after merging configuration sources.
Process fixtures require that override through the normal bridge startup path.
This disables an optional unrecorded mutation, not summary compaction.
Supporting this optional mutation needs a separately identified context revision
and safe publication boundary, not a changed payload under the existing summary ID.
The current summary-checkpoint wiring does not claim to capture these revisions.

Historical live acceptance preparation (2026-09-23): native producer `f6492ac3f9` and app
`347c31dee` have built successfully on Tokyo. Host `3978754` pins the candidate
OpenCode image and has passed NixOS preparation, but generation 169 remains
active. The scoped broker cutover is waiting for explicit permission to copy
Tokyo's metadata-only preservation snapshot back to Tokyo; no broker aliases
have been removed. See endo-host
`ops/native-checkpoint-deployment-20260923.md` for exact hashes and gates.
The native Claude runtime was stopped with cleanup acknowledgement, while all
three Floot sessions, workspace roots, Secrets and credential owners remain.

Superseding preparation (2026-09-24): app `5f784fb91` is prebuilt, and the guarded
all-overlay build published a matching manifest with native producer `f6492ac3f9`.
The new OpenCode image is
`sha256:a553a9a94e74f2bab261fb70f0ff508a2e4c1fbf86d80099730739613213d584`;
the other three image pins are unchanged. Host `bc3fa5a` prepared the paired
NixOS system successfully; `2945ed9` records that result in the host runbook.
The old narrow OpenCode-only detachment is insufficient for this candidate:
journal-only recovery and explicit session identity require retirement of
incompatible Floot state using the old release, preserving host, Secrets,
renewal owners and workspace roots. Generation 169/app `819aa18c8` remain active;
no activation or live acceptance is claimed. Fresh retirement checks and the
pending preservation approval are still required. See the same host runbook
for the exact binary digest, system path, protection expiry, and preservation gates.

Latest preparation: app `2deaf4f55` and paired host `6ecef6e` built successfully;
host `5f46dde` records completion and `9dd03ff` records a fresh read-only preflight.
The four immutable image pins remain unchanged: only Floot agent/tests/audit
changed since their actual `5f784fb91` build, whose provenance is preserved.
Preflight found two direct-provider sessions and one Claude session, one stopped
Claude native record with cleanup acknowledged, no containers or 9p mounts,
and six Secrets whose values were not read.
This is not an archive or retirement proof.
Approval for a fresh private on-Tokyo retirement snapshot and workspace-root
archive is pending, replacing the obsolete historical snapshot-transfer request.
No candidate has been activated; live acceptance remains open.

The next live compaction test must use ordinary owned Floot turns on the free
route, seed identifiable facts and real tool evidence, and observe reported
token usage while adding bounded context. Then verify an actual checkpoint,
continuation, recall, and daemon-restart recall. Set explicit request, time and
token budgets; a provider limit/rate error or an unreachable threshold is
unverified, not a passing test. Do not call native HTTP summarization outside
the hosted turn frontier or concurrently with its prompt loop. Artificially
lowered test-only model limits establish neither normal production timing nor
provider-window correctness. The FA-07 limit-plumbing finding below affects
predictability of this acceptance, independently of checkpoint transport.

Validation at the storage-foundation checkpoint: 515 Floot tests passed,
including snapshot corruption, canonical payload
checks, conflicting duplicate suffixes and failed content/event acknowledgement.
Touched-file lint and docs pass with warnings; package typechecking still reports
existing test-fixture errors but no source errors. Adversarial review completed.

Generation 166 acceptance found a separate direct-provider failure: after a
daemon restart the seed history survived, but OpenRouter's free route returned
an empty recall answer recorded as completed. The three hosted recall cases
passed. Empty-response validation now rejects absent, null, empty or whitespace
answers without tool calls, without replaying a potentially billed request.
Valid tool-only replies are preserved; sanitized finish/model/provider fields
identify the failure without exposing response bodies or reasoning.
No new durable state or formula is introduced: the existing failed-turn journal
path records the error. A reconstruction regression preserves that failure and
its history without another request. This uses an in-memory persistent-powers
fixture, not process-loss proof.
Failed-response usage correction (2026-09-23, not deployed): OpenRouter now
notifies Floot of validated, normalized usage before validating the assistant
answer. Empty, filtered, malformed, or truncated replies can therefore retain
their reported counts in the existing failed-turn finish record.
The optional provider notification carries increments before settlement;
Floot uses returned usage only when no notification was sent, avoiding double
counting. Tests cover failed-turn reconstruction, invalid usage refusal,
observer failure without replay, and multiple increments plus a returned total.
No formula or persisted schema changes: notification state is ephemeral until
the existing finish write; abrupt loss before that write is not covered.
Error-response accounting correction (2026-09-23, not deployed): parsed HTTP,
API and finish-error responses now report validated usage through the same
notification before failure. A response reporting positive token consumption
is never automatically retried, even without an observer; free models also
consume tokens, so this is not a claim about billing.
Transient errors with absent or zero usage retain the existing retry policy.
Non-2xx bodies use the shared bounded JSON reader (64 KiB maximum, under the
request abort signal); unreadable/oversized bodies retain the HTTP diagnosis.
Malformed token totals are refused, including fractional counts that could
otherwise round to zero and incorrectly permit replay.
Missing, invalid, unreadable, or unreported usage cannot be inferred; exact
accounting across transport failures and process loss remains open.
The empty-answer fix is deployed as generation 167; one fresh live Fae
seed/restart/recall case passed on the free route. The original failed case
remains recorded. This is not proof that every free-route model answers, nor
live evidence of the new negative-response path (covered by local tests).

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
This source removal is recoverable from Git; it shipped in the coordinated cutover
of 2026-09-21 (generation 157) after the retirement below.

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
It shipped in generation 157 (2026-09-21) after the retained legacy formulas were
retired with their old release available; source deletion alone is not runtime
retirement.

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
Deployment is complete; the `opencodeSessionId` audit is the next subsection
(shipped as generation 159). On-host native conformance was not re-recorded,
though restart/restore passed on generations 159, 161 and 165.

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

This slice shipped as generation 159 on 2026-09-21 (app `81f3428e3`), after
the OpenCode image was rebuilt and pinned with the host client and the old
session plans were retired; four-backend restart/restore passed on that
generation, on generation 161 and on generation 165 (2026-09-22).
The fire-and-forget `initialPrompt` client path has been removed;
repository search found no production caller.
Client construction no longer has a branch that dispatches a prompt and
silently discards all events/errors.
A regression verifies construction neither spawns the bridge nor writes a
command, and only the subsequent explicit send dispatches a turn.
This removes a replayable side-effect path rather than adding durable state.
The focused client/controller suites pass 51 tests; changed-file lint has no
errors. Independent adversarial source review approved this deletion;
it shipped in generation 160 and has been live since.
The equivalent unused Claude construction-time prompt path is also removed,
including its obsolete replay-detection commentary.
Fresh and prior-conversation client tests verify that construction stays inert
and the next explicit send retains its existing resume behavior.
Fifty-one Claude client/controller tests pass; independent source review approved
the deletion and changed-file lint reports no errors. It shipped in generation 160.
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
This is now deployed after old-plan retirement; the cross-backend acceptance on
Tokyo (generations 158, 160 to 161 and 165) exercised native Linux execution
these macOS tests could not. Still open on the host: no Tokyo run asserted a
slice's effective limits, and the obsolete field was never presented to the
parsers because old plans were retired before activation.

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
- Subscription discovery/error handling differs: Codex caches the broker's list for
  thirty seconds, believes a broker without the method and serves the last answer
  through an outage; Claude asks the broker on every request; OpenCode has no
  subscriptions. (The earlier claim that Claude dropped `pinnedOnly` was stale: both
  preserve it end to end.)
- Codex verifies raw slice placement before normalized evidence; the others use narrower checks.

Keep the shared [session supervisor](../hosted-agent/src/session-supervisor.js).
Extract a provisioner for durable ownership/placement and a narrow execution-envelope
builder/verifier for common mounts, resources, and network evidence.
Adapters should declare differences, not copy the lifecycle algorithm.

Completion: one implementation owns each common invariant; conformance tests run all
three adapters through partial acquisition failure, stop/retry, restart, and deletion.

### One session provisioner and factory — 2026-09-22

Implemented, reviewed and deployed as generation 165 on 2026-09-22 with the
full acceptance matrix passed.
`@endo/hosted-agent/session-provisioner.js` owns the lifecycle every adapter
copied: inspect the record, settle the pin, compose the plan, refuse a
placement the controller or the storage owner would refuse, create or reopen
in place, stop, heal the recorded directories, start.
`backend-factory-kit.js` owns the Floot-facing factory: request validation,
per-session serialization, the retained terminate closure, the run and admin
exos and the descriptor's subscription mapping.
`session-plan.js` gains the one placement reader under the three plan parsers,
and Codex's subscription lister moved to `subscription-lister.js`.
Each adapter now declares its differences and copies none of the algorithm:
Claude the pinned image, the credential kind, an MCP directory and a
runtime-default pin checked against its own effort table; Codex the pinned
image, the account, the operator's container mounts and a working directory;
OpenCode the pinned image, an MCP directory and no effort axis.
The three backend modules and factories fell from 1,912 to 1060 lines
against 655 shared lines.

Where the copies had drifted, the stricter rule now holds for all three:
protected roots (the state, runtime and broker directories) are refused at
construction and on every provision, with the canonical placement check run
for owned workspaces too; a subscription pin is revisable on reopen (Codex's
rule, and the FA-07 follow-up: Floot already downgrades an undeclared pin to
auto, which Claude refused, leaving such a session unrunnable); sandbox ids
must derive from the session id and a plan reader carries no unknown field
(Codex's rules); session ids are bounded lowercase path components everywhere;
a record without a model is a new pin unless the runtime runs its own default
unpinned (OpenCode's rule, now Codex's too for a pre-discovery record); the
immutable-field check precedes the existence check on reopen; request
validation happens inside the per-session region and the request carries only
the named fields; the subscription list is cached and outage-tolerant for
Claude as it was for Codex.
Claude and OpenCode setup now refuse a non-normalized broker directory and a
layout whose guest roots overlap the protected directories, as Codex's setup
did; Tokyo's directories are siblings under `/var/lib/endo` and are unaffected.

A shared `hosted-agent/test/provisioning-conformance.js` runs each adapter
through creation with exact dependencies, reopen through a catalog outage,
refused placement, foreign-workspace and protected-root refusal, a failed
start and a failed revision left for retry, an incomplete record, directory
healing, policy and subscription revision, each adapter's own immutable
bindings, and the factory over the provisioner end to end with stop
retention, restart and idempotent deletion (20 Claude, 20 Codex and 19
OpenCode cases).
Claude 203, Codex 306, OpenCode 250 and hosted-agent 664 tests pass; each
package's ESLint gate has no errors; the hosted-agent type check passes and
Codex's fails only in pre-existing test fixtures.
Independent adversarial review found the setup gap above and a request-field
spread an adapter reader could have overridden, both fixed, and named the
Codex model-less-record change, recorded here as intended; it confirmed the
deliberate unifications and the placement checks.
Not extracted yet: the native controllers' execution envelope (scope
acquisition, image and network evidence, the mount table, slice construction
and post-handoff verification, where Codex alone verifies raw placement); that
is the next FA-06 slice.
A pre-existing Codex controller test that still expected the CLI home path
from before the allocation rewrite was corrected in its own commit.

### One execution envelope — 2026-09-22

Implemented, reviewed and deployed as generation 165 on 2026-09-22 with the
full acceptance matrix passed.
`@endo/hosted-agent/execution-envelope.js` owns what the three native
controllers did in the same order with the same checks: acquire the sandbox
scope and the broker scope, hold the grant and the broker's evidence to the
recorded image, account, model and network policy, prepare the runtime's
state, project the recorded workspace through the session's own 9P mounter,
stand up the runtime's tools, compose the attested mount table (resolver row
first when the policy is public, workspace, the runtime's binds, the
temporary mounts, the session's declared attaches), ask for the slice, and
check the slice twice, raw placement and then the hosted contract.
Each controller now declares its broker scope request, its pinned image, its
state, its tools, its binds and their roots, its attaches, its slice
environment and its policy binding, then builds its client; Codex runs its
runtime verifier and audit event after the envelope returns.
The three controllers fell from 1,155 to 756 lines against
424 shared lines, and the provider-grant check and the canonical JSON
encoder moved from Codex into hosted-agent (`provider-grant.js`,
`canonical-json.js`, with Codex re-exporting both under its old names), as
did a copy-data assertion (`copy-data.js`) the plan reader and the envelope
use without depending on the daemon package.

Where the three had drifted, the stricter rule now holds for all: the exact
provider-grant check, the exact evidence check and the raw slice attestation
check, each previously Codex-only, apply to Claude and OpenCode too. The
review verified against the shared grant issuer and the sandbox's attestation
builder that a real grant, evidence record and slice for each adapter satisfy
them (the issuer reports the same nine evidence fields for every adapter; the
attestation reports the mount options in the order the check expects and the
limits the resources request). The review found one defect, fixed: the first
draft required an OAuth grant for every Claude session recorded with a
subscription token, but the broker reports OAuth only in pool mode, so a
single-token subscription session would have failed activation; the grant's
mode is now held to the broker's own, and the test fixture reports what the
issuer does. Restored from Codex: the evidence's network must equal the
grant's, not merely be well formed. Added: the sidecar container the evidence
names is checked in shape before use.
Tests: a hosted-agent suite drives the envelope with a fake resolver through
the acquisition order, the mount table, the slice options, and refusals of
another image, missing public evidence, evidence naming another grant or
proxy, a grant for another account or model, and a slice whose raw
attestation differs (10 cases); the three controller suites pass unchanged in
their expectations once their fixtures report the full grant and evidence
records and the attestation shape a runtime reports. hosted-agent 674, Claude
203, Codex 306 and OpenCode 250 tests pass; ESLint gates clean; hosted-agent
types pass.
FA-06's completion criteria are met: one implementation owns each
common invariant of provisioning, the factory and the envelope, and the
conformance suite runs all three adapters through partial acquisition
failure, stop and retry, restart and deletion. Deployment and acceptance on
Tokyo followed the wipe model (generation 165).

## FA-07 — Separate runtime, provider, account, and route

Additional open finding (2026-09-23): provider model limits do not reach the
OpenCode runtime. `openrouter-model-read.js` preserves `context_length` as
`contextLength` in the shared descriptor, but
`opencode-native-controller.js` calls `makeOpencodeConfig()` without `models`.
`opencode-agent-config.js` consequently supplies every selected route with
`DEFAULT_LIMITS = { context: 128_000, output: 8192 }`.
The native child also has model fetching disabled. In pinned native source
`f6492ac3f9`, `session/overflow.ts` calculates a 119,808-token usable window
with no inherited separate input limit and an effective 8,192-token output cap.
Native catalog merging can retain an existing model's input limit, and runtime
output overrides can change the cap. Inspect the effective native model before
asserting a live threshold; disabling fetch does not remove the bundled catalog.
`prompt.ts` checks
the last finished assistant's reported usage before proactive compaction.
A large first prompt can fail before that check has useful usage evidence.
These are fabricated runtime limits, not just display defaults: they can cause
early compaction, late compaction/provider rejection, and output-budget mismatch.

Required follow-up: carry validated provider context/output metadata into the
selected runtime model configuration without restoring NixOS model lists or
duplicating credential owners. Model identity remains pinned; account catalog
observations remain explicitly ephemeral unless a distinct durable execution
policy is designed. Define honest unknown-limit and dynamic auto-route behavior:
the free route can change underlying models, so a route-level observation alone
does not prove every selected provider's effective window. Provider-limit reads
must obey existing owner retirement/fencing and failure semantics. Verify the
actual native model limits, compaction trigger, output behavior, catalog outage,
and daemon reconstruction rather than testing only the picker descriptor.
No implementation or provider-window correctness is claimed by this finding.

Context-plumbing remediation (2026-09-23, local, not deployed): OpenCode native
activation now reads the existing broker's normalized single-account catalog
and passes only the exact selected route's observed context length into its
CLI configuration. Current and usable stale observations are accepted;
unavailable/unsupported/missing metadata supplies no invented limit. Invalid
catalogs and owner/transport exceptions abort activation, rather than being
silently converted into unknown data. The supervisor checks cancellation after
the catalog await and releases already-owned scopes on failure.
The shared envelope passes its existing `prepared` result to `sliceEnv` without
changing acquisition order or any other adapter's behavior.

The fabricated 128,000-context/8,192-output model descriptor is removed.
The prior 8,192 output ceiling is retained explicitly as the native runtime's
`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` execution budget, not a provider fact;
known smaller native model limits can reduce it. Removing the descriptor alone
would otherwise cause unknown-model requests to use the native 32,000 default.
Absent context overrides leave native bundled metadata available; when native
context is also unknown, proactive threshold compaction is disabled. Native
merging can still retain a separate bundled input limit, and auto-route limits
remain observations rather than guarantees. These limitations remain open.

Durability: no new formula, credential owner, or durable session-plan field.
Context observations are reconstructed per native activation through the same
broker owner, while the durable exact model/account pin is unchanged. Local
tests cover changed observations on a fresh activation, exact-model matching,
missing context, malformed/unexpected accounts, all catalog states, retirement
errors, and late completion after termination producing no slice/client/tools.
This is native-controller reconstruction coverage, not real-daemon acceptance.
Deployment and the ordinary-turn live compaction/restart gate remain pending.

Validation: OpenCode 286, shared catalog/envelope 30, Claude controller 17, and
Codex controller 8 tests pass. Scoped ESLint has no errors; formatting passes.
The hosted-agent declaration build and root documentation gate pass after
quarantining stale generated declarations (the old envelope declaration omitted
`prepared`). Native request preparation, without inference, produces output
budgets of 8192, 4096, and 8192 for model output limits of 0, 4096, and 64000
respectively with the explicit 8192 runtime budget. Independent adversarial
review approved the source, tests, and durability classification.

Output-metadata and native compatibility remediation (2026-09-24, local, not
deployed): the account-filtered OpenRouter reader now preserves optional
`top_provider.max_completion_tokens` as `maxOutputTokens` in the shared model
descriptor. The selected route's context and output observations independently
reach OpenCode configuration; absent/null metadata stays unknown rather than
becoming an invented default. These fields are positive uint32 token counts in
this configuration profile, not a claim about the provider protocol's maximum.
The [OpenRouter account-filtered model API](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails)
documents the field. A top-provider observation is not a guarantee for every
endpoint selected by the free auto route. The explicit 8192 runtime output
budget remains unchanged; observed smaller limits can reduce it.

Native validation exposed a compatibility bug in the preceding context-only
slice: pinned OpenCode required both limit fields even though model merging
defaults them independently. Native commit `9c41a9e8650fff42d22a0ba8f8aaef64094438a3`
on `kumavis/opencode` branch `codex/compaction-checkpoint` is committed and pushed.
It accepts partial limits, preserves absent fields through V1-to-V2 migration,
and merges partial remote overrides without dropping existing limits.
The Endo image builder and source Containerfile pin that commit.
Deployment requires a newly built native binary with its digest recorded:
the prebuilt-binary wrapper cannot prove that an arbitrary supplied binary came
from its source pin. The previous `f6492ac3f9` image is not sufficient.
Raw Containerfile callers overriding the repository/ref must also override the
commit; the wrapper resolves an explicitly different repository/ref as before.

Durability remains reconstructible catalog observation under the existing
broker owner, re-read on native activation; no new formula, credential owner,
renewal operation, durable policy, or model/account pin is introduced.
Tests cover changed observations on reconstruction, current/stale/unknown
catalogs, malformed metadata, output-only configuration, independent limits,
and preservation of the execution budget. Full hosted-agent tests pass (697,
one skipped), as do all 289 OpenCode sandbox tests. Both package lints have
zero errors. All 663 Floot regressions and formatting pass.
The root documentation gate passes after quarantining stale ignored generated
hosted-agent declarations and rebuilding them from source.
Native schema/migration/merge tests pass (47), and both native
core and OpenCode typechecks pass. Independent adversarial review approved
the source, tests, pins, and durability classification.
Actual native effective input limits, dynamic-route guarantees, live compaction,
and coordinated deployment/restart acceptance remain open.

Tokyo preparation (2026-09-24, not activated): app `ab8d804ae` and native
`9c41a9e865` were rebuilt successfully; host `9636e419` pins the resulting
OpenCode image `sha256:21d529895cd3e68faee9d773cf5ae7039c5b3d02be92969f606284441daa94ce`.
The source-build and extraction logs agree with the manifest's binary digest.
All four exact candidate image pins are available as Linux amd64, the temporary
source-export container is gone, and paired NixOS preparation passed.
The restoration ledger correctly remains `candidate`, not verified.
Generation 169/app `819aa18c8` still runs; no session, workspace, Secret, or
renewal owner was retired or migrated. Fresh preservation/retirement approval
and cross-backend live acceptance remain pending. Full provenance, build times,
and the 24-hour candidate lease are recorded in endo-host's
`ops/native-checkpoint-deployment-20260923.md`; revalidate protection before
delayed activation.

Native-window follow-up (2026-09-24): an offline probe of the actual candidate
CLI using `models openrouter --verbose`, the free route, no network, no mounts,
zero capabilities, and a dummy credential confirmed that context-only
configuration now passes native startup. It also reproduced the remaining
input-limit mismatch: context `123456` retained bundled input `200000` and
output `8000`. The native compaction helper therefore used `192000`, ignoring
the smaller context observation; the correct context/output bound is `115456`.
The disposable probe container was removed; no inference or Secret access took
place. This is compiled-CLI configuration evidence plus source-level threshold
analysis, not a live compaction test.

Native fix `af032b9fbc293cd19283e16f6a7f8effe296c065` is committed and pushed.
The helper now takes the stricter of context-minus-effective-output-budget and
input-minus-reservation, clamped at zero. Smaller input windows still constrain
the result; no input limit is fabricated or removed. Unknown context and disabled
automatic compaction retain their existing behavior. No new durable state,
credential authority, or policy is introduced. All 62 native compaction tests
pass (one skipped), including four new regressions for exact boundaries,
independent windows, custom/zero reservation, unknown output, and zero-clamping.
Native typechecking and formatting pass; scoped lint has zero errors (14 warnings).
Adversarial review approved the fix. Both Endo source-build pins now name it.
The prepared `9c41a9e865` candidate above is superseded for deployment: rebuild
the native binary/images and prepare the matching host pins before activation.
Live compaction/restart and dynamic-route guarantees remain open.

Corrected candidate preparation (2026-09-24): app `d5d943d33`, native `af032b9fbc`,
and host `95e0d881` are pushed and prepared on Tokyo. The source-built OpenCode
image is `sha256:890dfa961da8f1f2555ec956e927340a1e634a803c02d9565528ab8bcae48ef0`;
manifest and extraction/overlay logs agree on binary SHA256
`387d4eda7026092b318a479ba316d3253ea60803f4d79ecd76b098abe2c759ef`.
All four image pins are available as Linux amd64, the container inventory is
empty, and paired Nix preparation passed. The corrected image remains an
unverified restoration candidate; no activation, retirement, or inference was
performed. The prior `9c41a9e865` candidate is not the intended deployment target.
See the host deployment record for exact build evidence and lease expiry;
preservation approval and live cross-backend acceptance remain pending.

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
At the audit baseline the direct runtime was represented internally by the absence
of a hosted backend ID and externally as `provider`/Fae.
The September 24 identity and runtime slices remove that ambiguity locally;
deployment is still pending.
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
remained pending at this point; the cutover subsections below record what
followed through the generation 160 and 161 deployment, except the deployed
picker's visual state, which those runs did not verify.
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

Implementation progress (2026-09-22, admission): the broker's operator model
list `policy.models` is removed from the grant, the issuer, the three adapter
broker configurations, their policy builders and setup scripts.
Admission is bound to each account's own catalog: a new per-account owner
(`hosted-agent/src/model-catalog.js`) reads the provider through the member's
existing credential owner and lifecycle, holds one observation per incarnation,
and answers `admits(model)` for every request and every scope that pins a model.
The grant asks each member the pool orders, serves only members whose account
lists the model, and refuses (`Model denied`) before any slot or secret read
when none does; a pinned session's one member refusing is not a fall-through.
The issuer refuses a scope whose pinned model no eligible account lists, with
`auto` excluding lanes set aside and an id asking only that member.
Attestations replace `modelAllowlist` with the model the scope was issued for
(`model`) and `modelAdmission: 'account-catalog'`; Codex's grant verifier
requires that pin.
The grant does not hold every request to that pin: each request is admitted by
the serving account's catalog, so a runtime's side requests on other listed
models (Claude Code's Haiku calls beside a session on Opus) are served.
Catalog states are honest: current within a fifteen-minute lifetime, stale after
a failed or overdue read (still admitting for a day), unavailable past that,
unsupported without discovery; failed reads retry after a minute, not per request.
Admission answers from the held observation and refreshes behind it, so a turn
is not held behind the provider's catalog endpoint once one observation exists.
Claude gains discovery through Anthropic's model list under the broker's own
credential (`anthropic-model-read.js`, bearer with the OAuth beta or `x-api-key`).
Wrapped pool members list what their share describes.
Twenty-four new focused tests cover disjoint account catalogs, pinned refusal
without fall-through, an account that cannot answer, all-unavailable catalogs,
removed accounts, share attestation, the owner's lifetimes, close draining and
the Anthropic reader's sanitization; the full hosted-agent suite passes 647,
Claude 180, Codex 287 and OpenCode 229 tests.
Two Claude pool tests were found already failing at the branch head because
their fake namespace predates the identity journal's `has`/`list` use; the
fixtures were corrected rather than the journal.
Independent adversarial review found fifteen issues; all were addressed.
The substantive ones: a far share's catalog read had no deadline and could
wedge member retirement and service close, so it has one and its answer is
bounded and shaped before it is believed; admission asked accounts one after
another, multiplying a provider's catalog timeout across the issuer's queue,
so all are asked at once; catalog reads went through the sticky credential
wrapper, so a picker opening after a restart could have retired every account
on one transient refresh failure, so they now use a fenced but non-sticky
credential facet; a far share's holder answered the union of its accounts and
its own refusal ended the request, so that refusal now hands the request to
the next member; the recheck for a member removed mid-read covered only
current snapshots, not stale ones; a policy carrying a model list is refused
rather than ignored; the audit trail distinguishes `catalog-unavailable` from
`model-denied`; and a retained broker configuration that names models is
refused with the retirement instruction rather than as a shape error.
Missing regressions were added: a far member skipped when its holder lists
nothing, served when it does, and handed on when it refuses; a retired
member's catalog admitting nothing to a grant that still holds it; and a
share's narrowing reflected in its wrapped catalog.
Retained broker configurations carrying `models` are now refused, so the three
brokers must be retired and re-minted at the next cutover.
Static backend catalogs, Floot's lists, NixOS enumeration and the picker
remain for the next slice; nothing is deployed.

Implementation progress (2026-09-22, discovery end to end): every static or
deployment-owned model list is gone.
`CLAUDE_CLI_MODELS`, `OPENCODE_MODELS`, Floot's Anthropic and OpenRouter
lists, `ENDO_CODEX_MODELS`, `CODEX_MODELS` and the NixOS
`services.endo.codexSandbox.models` option are removed; the OpenCode config
builder names no fallback model either.
A shared backend-side helper (`hosted-agent/src/backend-catalog.js`) projects
the broker's per-account catalog through each runtime's own rules and admits a
new session's pin: Codex passes the provider's reasoning levels through, Claude
attaches the efforts the pinned Claude Code runtime drives each model at
(`claudeEffortsFor`, a runtime axis the provider does not publish), and
OpenCode spells routes under its `openrouter/` provider prefix with no effort.
The factory interface's `listModels()` is replaced by `modelCatalog(id?)`,
answering per account with label, lane marking, state, read time and models.
A new pin is admitted in the provisioner when the plan is recorded, against
the accounts the session may be served from; a reopen that names the recorded
pin, or nothing, keeps it without asking the provider, so a catalog outage
does not stop recorded sessions and no other model is put in their place.
Floot's direct provider reads its own account's catalog under Floot's
credential with the same OpenRouter and Anthropic readers a broker uses; a
provider kind without discovery is reported unsupported and offers nothing.
Floot's `listModels(backendId?)` rows carry the accounts listing each model,
and `listModelCatalogs()` reports each account's discovery state; creation
refuses a pin no eligible account lists, or one whose discovery is unavailable,
with distinct messages.
The picker offers, per chosen subscription, only what that account lists,
shows a backend with nothing to offer together with why, and says when an
account's catalog is stale or unavailable; the searchable selection is kept.
The delegated runner answers its lane's account under a name of its own.
Tests: 450 Floot, 53 chat, 49 space-floot, 181 Claude, 287 Codex, 229 OpenCode
and 656 hosted-agent tests pass; new cases cover the backend catalog helper,
the OpenRouter-backed direct provider listing and its refusals, the picker's
discovery note and subscription scoping, Codex provisioning that admits a new
pin and keeps a recorded one through a catalog outage, and the runner's view.
Live verification of the Codex and Anthropic catalog reads, of Luna appearing
in the Codex menu, and of the free OpenRouter routes remains a deployment gate;
nothing is deployed.

Independent adversarial review of that slice found eighteen issues; the
substantive ones were that an effort changed on its own replaced the recorded
model with the catalog's default (`revisedPin` now keeps the recorded model
unless another is named), that a request naming no model was pinned to "the
first listed" (only a default the catalog marks is taken now: the Codex
reader marks the account's top-priority visible model, OpenRouter and
Anthropic mark none, so an OpenCode session must name its route
and a Claude session without one runs the runtime's own default unpinned, as
before discovery), that an OpenCode record from before pins were required
would have started without a model (it is a new pin, refused clearly), that
one provider id opencode could not spell took the whole catalog down (it is
left out), that the picker could preselect a model only a lane set aside
lists and left the preset cards enabled with nothing listed, that a direct
provider without discovery could not be started from the UI (it is offered
unpinned), that discovery was read once, ahead of the session list, and never
again (it is read beside the list and each time the picker opens), that hosted
catalog failures were swallowed without a diagnostic (logged once per change),
that a pin to an undeclared account was reported as an outage (refused as
unknown), and that a pinned session's `models()` listed the `auto` union.
Regressions were added for each, and for the runner's answer crossing the
holder's validation, Floot's hosted admission and the picker's behaviour.
A second review of those fixes found that the picker's selection did not
follow a list refreshed under it (it does now, and a pick sends what the
select shows), that lane marking came only from the declared set so a
backend that could not list it would have offered an `auto` session a
lane's model (the broker's answer now says which accounts are lanes), and
that both listings each asked every backend again (one in-flight read serves
both); discovery trouble is said in the picker rather than over the status
line; a lint error and four type errors in added test lines were fixed.
Its verification passed and left three small items, fixed in the same
commit: the selection is derived from what the select shows (the search's
matches), not from all the account offers; a thinking level the refreshed
model no longer offers is replaced by its highest; the shared read keys the
"every backend" ask apart from an empty backend name.
Committed as `64176d7d5` and published; the host pin `84a6b90` removes the
NixOS model option. With the operator's approval the cutover ran on
2026-09-22 (endo-host `ops/hosted-cutover3-20260922.md`): the three
pre-catalog brokers were retired on the old release after the second pass's
acceptance sessions and one empty auto-created chat were archived and
removed, generation 160 activated app `64176d7d5`, and the discovery gate
passed live: every account current, Luna listed by both Codex accounts, the
free routes by Fae and OpenCode, eleven Claude models per account, with no
inference. Create, native tool use, network-policy transitions, cancellation
and deletion passed on Luna, Haiku 4.5 and the free routes. Two findings
from the run: Anthropic lists `claude-fable-5-1` first and the pinned Claude
Code runtime exits on it, so a picker or driver that takes "the first
listed" for Claude pins a model the runtime cannot drive (the acceptance
policy now pins Haiku 4.5; whether the Claude projection should leave out
models the runtime cannot run is open); and Luna's `/bin/bash -c` wrapper
and a free-route model's URL quoting defeated the driver's exact-string
command check, which now also accepts a command that reads the same once
quoting is taken out.
Restart/restore first passed for Fae and failed for every hosted backend on
generation 160: commit `0d66bd945` (fail-closed native teardown) shipped on
the branch tip, not discovery. The operator chose to evict it: `2cfcfeb02`
reverts it on this branch and `b3f7bb1e0` re-applies it on the #1323
research branch; generation 161 activated the reverted release, the three
stranded sessions reopened and were deleted, a fresh restoration run passed
on all four backends after a graceful daemon restart, and Tokyo ended with
zero native records, containers and mounts.
Recorded, not changed: a backend may answer up to sixteen accounts of 4096
descriptors each; a subagent delegated during a catalog outage is a new pin
and is refused then; the direct provider's `lal` OpenRouter adapter still reads
the public model list itself for context windows; retired-catalog subscription
ids reach `resolve` only through a factory's own thirty-second listing cache.
Follow-up discovered outside this slice: Floot reopened a session pinned to a subscription
the backend no longer declares by dropping the pin, but the Claude module's
subscription-immutability check refuses that reopen, so such a Claude session
never runs again until it is recreated (pre-existing; Codex has no such
check). The silent fallback is removed by the 2026-09-23 correction below.
The root type build passed after quarantining stale generated declarations
(which had also produced the earlier documentation-gate errors); the
documentation gate's result is recorded in the change log.

### Preserve subscription selection on restoration — 2026-09-23

Floot no longer drops a saved subscription pin when a backend descriptor stops
listing it. The original pin always reaches backend admission; missing catalog
membership cannot authorize automatic selection of another account. The shared
backend factory refuses unknown subscriptions before provisioning, and the pool
chooser never falls through from an explicit pin. Sessions intentionally created
with `auto` remain automatic. Changing or removing a pin still requires an
explicit operator operation; no automatic migration is added.

Durability: no new formula or storage schema, and no mutation of the saved
registry entry. Reconstruction reads the same persisted `subscription` and
forwards it rather than changing its meaning according to transient discovery.
Factory regressions rebuild over stored registry data, exercise removed-member
and no-subscription descriptors, and require the backend refusal to reach the
turn status while session metadata keeps the original pin. These are in-memory
host reconstruction tests, not proof of real daemon process-loss recovery.
Verification: all 481 Floot tests pass, including admission succeeding despite
an incomplete discovery descriptor. Scoped lint has zero errors; docs has zero
errors and 176 warnings. Full Floot typechecking remains failing on test-file
errors, including unchanged optional `find()` results in this fixture; it is
not claimed clean. Independent adversarial review found no production blocker.
Deployed as generation 166. The focused live removed-subscription refusal case
is still unverified; general acceptance does not prove that case.

The separate Claude runtime-model concern remains unproven: the live record
contains exit code 1 and a stdin warning, not a diagnostic establishing that
`claude-fable-5-1` is unsupported. Do not invent a runtime allowlist from this
single failure. Inspect structured CLI errors and compare pinned runtime
capabilities before filtering provider-discovered routes.

Diagnostic follow-up (2026-09-24, local, not deployed): Tokyo still reports active
app `819aa18c8`; the daemon journal since September 22 contains no matching
model-specific diagnostic. This limited search does not establish runtime support
or explain the earlier failure. Source inspection found that the Claude hosted
translator discarded the CLI result's `errors` string array and that a later
process abort replaced the retained result error. The translator now preserves
result text and string diagnostics alongside process, transport or EOF failure.
Non-string error objects are not serialized. The
[official SDK error handling](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_errors.py)
confirms the CLI's structured error-list contract. This is an observability fix,
not grounds for filtering discovered models or claiming the live cause is known.
Failures use the existing hosted abort and private turn journal path; no new
formula, stored schema, credential access, or renewal owner is introduced.
All 216 Claude tests and ten Floot hosted integration tests pass, including
structured-error preservation across normal termination, nonzero process exit
and producer EOF. Scoped lint has no errors (four warnings); the documentation
gate has no errors (180 warnings) after correcting the translator signature.
Adversarial review approved the implementation and EOF regression.
A fresh failing runtime turn remains a deployment gate.

### Direct-provider refresh boundary — 2026-09-24

Independent review found that a provider lookup admitted before credential refresh
could finish afterward and repopulate the cleared cache with its old configuration.
When the token and model cache key were unchanged, later turns reused the old
configured default despite refresh.
An ephemeral cache incarnation now fences both reuse and publication; already
admitted reads may finish with their captured configuration but cannot populate
the replacement cache.
Configuration and provider rejection handlers clear only their exact promise,
never a replacement installed while the old request was pending.
This introduces no durable record, formula, credential owner, or renewal operation.
Reconstruction creates a fresh empty cache under the existing factory boundary.

Two actual-factory regressions hold a Secret read across refresh with an unchanged
token, and reject an old configuration lookup after a replacement is installed.
The full Floot suite passes 647 tests; the focused factory suite passes 17.
Adversarial source review approved the refresh boundary and regressions; its
failure-cleanup correction releases test-held gates before factory disposal.
The documentation gate passes with no errors (180 warnings).
Package ESLint passes with no errors (242 warnings); changed-source formatting passes.
Changes are not deployed.
Catalog promise invalidation and draining catalog owners at factory disposal are
a separate remaining lifecycle check; this fix does not claim to close them.

### Direct-provider catalog refresh and disposal — 2026-09-24

Follow-up source review found that a listing started after refresh still joined
the old in-flight listing, and an old catalog-construction rejection could clear
a newer cached owner.
The local fix invalidates only provider-inclusive coalescing keys at refresh;
completion handlers clear only their own pending read or owner.
Hosted-only catalog reads retain their existing coalescing behavior.
Refresh stays nonblocking: the old owner closes immediately when available, but
its construction/retirement promise remains tracked until close settles.
Factory disposal fences acquisition, drains admitted operations, and closes
remaining current or retiring owners before acknowledging disposal.
Construction awaiting configuration checks the factory fence again before
creating an owner.

These caches and their ownership set are deliberately ephemeral, not new formulas
or saved state; reconstruction re-reads catalog metadata through existing
credential authority.
Floot uses awaited catalog snapshots, not background admission reads, so no claim
is made that existing catalog reads escaped the factory's operation drain.
The correction establishes explicit owner retirement and refresh isolation.
Five actual-factory regressions cover refreshed reads, stale constructor failure,
old completion versus a pending replacement, disposal during construction, and
disposal while a retired owner's read is held.
The focused factory suite passes 22 tests; all 652 Floot tests pass.
Package ESLint has no errors (245 warnings), formatting passes, and documentation
has no errors (180 warnings).
Adversarial review approved source, failure cleanup, and regressions.
Not deployed; draining waits for upstream completion rather than cancelling it.

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

### Rebindable bindings — 2026-09-22

Implemented, reviewed and deployed as generation 165 on 2026-09-22 with the
full acceptance matrix passed; completion criteria met. That matrix has no
`rebind` case (no re-minted broker to rebind to), so the verb's
evidence is the conformance and module suites.
What was already true: a session's durable identity is incarnation-free.
Everything keyed by a session id alone (the derived sandbox id, the owned
workspace, the private directories, the conversation tree, the private
journal, the guest names) survives any restart, and the model, effort,
subscription, network policy and persona were revisable between
incarnations through the shared provisioner. What was not: the record's
plan copied the broker's pinned image, account and credential kind at
creation and treated them as immutable, so a broker re-minted with any of
them changed refused every session it had served ("destroy the session
first"); and the record's references (the broker, sandbox and state service
formulas and the storage owner) were written once at creation and never
revisable, so a backend re-minted over other services orphaned every
session even when nothing visible changed.
Now: the provisioner takes a `rebindable` set beside `immutable` (the three
adapters declare their image, account and credential-kind fields there;
placement stays immutable), and a reopen whose proposed plan differs in a
rebindable field, or whose backend dependencies differ from the record's
references (the binding named `provider`), is refused by name unless the
request's `rebind` list names that binding; an unknown name is refused
rather than ignored, and a creation takes no authorization. An authorized
reopen stops the record through the owner, then revises it, passing the
backend's dependencies when they differ, then starts it.
Old authority is fenced before replacement by construction: the owner's
`stop` does not resolve until the controller acknowledges native cleanup
(the supervisor fences admission, closes the client, fences the grant,
closes MCP admission and reaps the sandbox), and the owner's `revise`
refuses while a client or worker reference remains or the record is not
`planned`/`stopped`; a failed stop leaves the record `stopping` and
unrevisable.
The daemon's record store gains `revise`, one transition that replaces
the plan and the stable dependency roles named, refuses the incarnation's
own `client` and `worker`, requires a complete plan, allows a role the
record was created without, and keeps a role's identity when named with
it; the owner's `revise` takes the references to rebind, refuses `tools`
and the incarnation roles, and hands both to the store.
Failed transitions (revised 2026-09-22, below): a revision refused or
failed before its intent is durable leaves the stopped record on its
previous plan and references, and a retry completes it (conformance tests
against a fake owner, and the store's retry cases below); one interrupted
after is a durable intent the record finishes before anything else uses it; a failed start after a successful
revision leaves the rebound record `stopped` for a retry, as any failed
start does.
Floot's session facet exposes the operator's `rebind(bindings)`: hosted
sessions only, no active turn, the names checked against the bindings the
session's own backend declares (its descriptor's `rebindableBindings`,
which the factory kit reads from the provisioner's declaration) before
the incarnation is touched; it stops the
incarnation and releases the mount client, admin and agent (the network
policy change's two halves, now shared), stores a one-shot authorization,
and the re-provisioning that follows the change carries it in the backend
request, so a refusal surfaces at the verb. The authorization is spent by
the first request built from it (a later container-mount recreate never
carries it) and voided with the verb when no request was built, so it
cannot be consumed by an unrelated later reopen; deletion clears it too.
The hosted backend factory validates the list's shape; which names exist
is the provisioner's. The verb is not a model tool. The review found the
first draft leaving an authorization behind when the verb failed before
the request was built, re-sending it on every mount recreate, tearing the
incarnation down before validating the names, and the second draft
validating against a vocabulary copied by hand into Floot rather than
the backend's own declaration, and the third the hosted-agent workspace
type check failing on a helper that detached the factory's JSDoc and on
array checks the checker cannot narrow; all are corrected, and the
per-workspace type checks CI runs (hosted-agent, daemon, Codex) are clean
for the change, with the pre-existing test-file errors untouched.
Tests: daemon store cases (superseded by those under "One transition"
below) and owner cases (refused while
a client is held, `tools`/`client`/`worker` refused, rebound edges read by
a reconstructed owner and kept by a later plain revision); conformance
cases for each adapter's rebindable bindings (refused by name, another
binding's authorization refused, an unknown name refused, the authorized
rebind revising after a stop with the record then answering the rebound
broker and refusing the original) and for the `provider` binding (refused,
a failed revision leaving the old binding, the retry rebinding the
references without touching the plan, a creation refusing an
authorization); the Claude and OpenCode module tests rebind an image
through the real modules; the native owner test rebinds a dependency
after a native stop and proves the next start resolves it; the factory
kit refuses a malformed list before provisioning; the descriptor validator
refuses a malformed declaration; the Claude and OpenCode module tests read
the declared bindings from the real descriptors; Floot
factory tests rebind through the verb, refuse a name the backend does not
declare, an empty list and a turn in flight, prove a refused rebind
leaves no authorization behind, and that a refusal before the incarnation
is touched leaves it running.
Not covered: the verb failing after the incarnation is replaced but
before any request is built (the authorization is voided by construction;
the path is hard to stage), and a crash inside the pet store's own
single-entry write, assumed atomic as every other record write here is.

### One transition — 2026-09-22

The operator's reviewer (Astra) found the first design not crash-safe:
`rebind` wrote each dependency edge in turn and the owner then wrote the
plan, so a daemon crash between writes left a stopped record with mixed
old and new references, which `start` accepts, and the section above
argued the execution envelope would refuse such a record on mismatched
evidence, which it cannot rely on: a replacement service can report the
same image and account as the one it replaces, and the envelope does not
check the storage dependency at all.
Now the store publishes a revision as one transition. `revise` stages the
rebound edges and then the plan under the record's `revision` entry before
any published write, so each new identity is retained by an edge before it
is intent; a staging without a plan never became intent and the next
mutation discards it; one with a plan is intent, which every snapshot
shows as applied (`revising: true`, the plan and references as they will
be) and which every mutation of the record (`retain`, `revise`, `release`,
`remove`) and the owner's `start` and `remove` finish first, by
re-applying each staged write, each idempotent, and dropping the staging,
before reading or changing anything else. A crash at any write therefore
leaves either the previous record or a durable intent the next activation
or removal completes before it constructs or cleans anything, never a
record between two bindings; while the intent cannot be finished (a
staged edge's publication keeps failing), start and removal fail with that
write's error and touch nothing, not even the lifecycle, and no
incarnation is constructed. A plan-only revision stays one entry write and
is not staged, since each staging leaves directory formulas behind while
collection is off. `rebind` is gone: the store's `revise` is the only
writer of a record's plan after creation. The fix is not retroactive: a
record the first design left mixed has no staging to finish, and none
should exist, since no rebind has run on Tokyo.
Tests: store cases (the plan and edges replaced as one transition, a role
added, the incarnation roles refused, a plan-only revision keeping every
edge and staging nothing; an interruption after intent, shown whole by
this and a reconstructed store, refusing `retain` and `remove` while a
staged edge's publication still fails, finished by `settle`, idempotent; a
retry that cannot finish the intent leaving it untouched, one that can
finishing it before staging its own, and a staging that never became
intent discarded by the next revision; `release` finishing the intent
before comparing its expected identities; an interruption at the plan
publication finished before removal's cleanup reads the record; an
interruption before intent leaving the record as it was and its staging
discarded by the next mutation); an owner case (an interrupted revision
shown by a reconstructed owner, removal refused until it can finish it,
then removing under the revised plan); native owner cases (an interrupted
revision refusing the next start without constructing anything until it
can finish, then activating the revised plan and resolving the rebound
dependency, never the old one; removal refused without a native call or a
lifecycle change until it can finish, then removing). Deployed as generation 166.
Historical findings from that review, addressed by the account-authority,
binding-inspection and immutable-state-root changes below: a `provider` rebind moved the state provider and
storage owner without checking that they serve the recorded session's
state root, which the plan does not record (the roots are host
configuration under the wipe-and-recreate deployment model, so a re-rooted
state provider is a host change, not a broker re-mint; recording the state
root as placement would refuse it); for Claude and OpenCode the account is
the broker's own rather than a plan field, so a broker re-minted over
another Secret is a `provider` change, which the verb's help says; and the
verb reports the names it authorized, not what the record now carries, so
the operator authorizes a value they cannot inspect first.

### Revision persistence verification — 2026-09-23

Review of `c3669475f` found a lower-level violation of its retry assumption:
`pet-store.js` changed its in-memory name mapping before the synchronous
database write. If publishing a staged edge failed, retry could take the
same-identifier no-op path without persisting that edge. Settlement could then
publish the plan and discard the revision intent, leaving the old edge on
reconstruction. The directory interruption mock failed before updating its
mapping and did not expose this case.

Corrected: `storeIdentifier` now writes the database before changing either
mapping or publishing notifications. Two regressions exercise the real pet
store with an injected database failure, for initial and replacement writes;
they verify unchanged forward/reverse mappings, no phantom notification,
successful same-ID retry, fresh-store reconstruction, and successful-write
idempotence. Both fail against the previous implementation. Together with
subscription cancellation and the four session suites, 82 tests pass.

This is local failure-injection and reconstruction evidence, not a physical
power-loss test or a live Tokyo rebind acceptance test. The staged protocol
still assumes atomic individual database entries. Native producer cleanup
after process loss remains the separate #1323 investigation. Not deployed.

### Binding inspection — 2026-09-23

The operator can now call a hosted session's `getBindings()` before granting
a rebind. It reads the provisioner's recorded plan and dependency identities
alongside its proposed image/account/provider values and changed binding names.
A successful `rebind()` returns this snapshot as `bindings` beside the list
of authorized names. It does not imply that every authorized name changed.
The help now uses the shared account-authority vocabulary, including Claude's
credential kind under `account`, rather than the obsolete Codex-only account
description. Delegated runners explicitly refuse this inspection: their holders
must not learn the operator's account authority or dependency identities.

Durability: no new formula, stored authorization, or durable state. Inspection
reads the owner's current snapshot (including staged revision intent) and
selects only declared binding fields and stable dependency roles; it does not
settle an intent, acquire a client, query model catalogs, or start an incarnation.
Reconstruction reads the same durable record again. Recorded bindings describe
logical committed intent, which may still await publication; they are not proof
of a live runtime using those bindings. The snapshot is diagnostic,
not a reservation: another operation can change bindings afterward, and the
existing rebind checks still run against current state. A result-inspection
failure after rebind does not roll back a completed revision; the help tells the
operator to inspect again before retrying. It does not fix the separate missing
state-root placement check or establish live Tokyo rebind acceptance.

Local evidence: shared conformance on Claude, Codex and OpenCode checks a
missing record, an existing record without mutation or activation, image/account
differences before rebind, and matching recorded/proposed values afterward.
Floot checks read-only inspection and the returned result snapshot; delegated
runner coverage checks refusal without forwarding. Hosted-agent: 681 passed,
one skipped; adapter conformance: 23 per backend; Floot: 479 passed.
Hosted-agent type checking passes, scoped ESLint has no errors. Floot's type
check still reports errors in unchanged test files. The first documentation
run failed with ten errors; the source defects and stale local declarations
were corrected as recorded below. Passing inspection tests are not whole-branch
type-checking proof.
Not deployed.

### Public type verification — 2026-09-23

Corrected two source defects introduced during binding vocabulary work:
`ClaudeBrokerOptions` placed explanatory prose inside its JSDoc type expression,
so its required `accountAuthority` declaration did not parse; the shared
execution envelope widened its literal OCI kind to `string`, incompatible with
the controller's parsed-rootfs type. The JSDoc expression is now well formed
and the actual literal is narrowed with a const annotation, not a broader cast.
No runtime behavior, formula schema, persistent state, or replay changes.

The worktree also held ignored generated Claude broker-service and runtime-setup
declarations embedding the old profile without `accountAuthority`. Those two
declarations and their source maps were moved to a recoverable temporary backup;
no checked-in declaration was removed. This repairs local source validation,
not repository-wide stale-build hygiene. Afterward `yarn docs` passes with zero
errors (176 warnings), Claude production and hosted-agent type checks pass,
scoped lint has no errors, and 25 Claude broker/controller plus ten shared
execution-envelope tests pass. Full test-file type cleanup remains open.

### State provider ownership check — 2026-09-23

Tracing the open re-rooting issue found a second necessary invariant: Claude
and Codex activation resolve the record's `stateProvider`, but deletion runs
through the storage owner's captured powers. Previously backend construction
checked workspace/private roots, not that captured provider identity. A retained
storage owner could therefore delete through a different provider than the one
used to prepare the new incarnation. Codex setup checked this only at setup;
Claude retained existing storage without the equivalent check.

Corrected locally: the verified-formula reader can require an exact powers
reference, checked on the same immutable formula whose environment it reads.
Both backends capture the selected state-provider identity and require their
storage owner to hold it before requesting a daemon session owner. Claude setup
does the same before retaining storage. Missing powers, literal look-alikes and
other reference identities are refused; there is no lookup or invocation of the
captured capability. Twenty shared setup tests, 23 Claude module/setup tests and
nine Codex owned-backend tests pass, including refusal before owner creation.
Full backend suites also pass: Claude 209, Codex 313. Hosted-agent types and
both adapters' production types pass; scoped lint has no errors.

Durability: no schema or stored-state change. Each backend reconstruction repeats
the exact-formula check; existing records keep their own captured dependencies.
No native resources or credentials are acquired by the check. This does not
prove old resources have stopped and does not retire mismatched owners itself.
Deployed as generation 166. The root-placement follow-up is implemented below. OpenCode has no
separate durable native state provider; its private placement is already recorded.

### Immutable native state root — 2026-09-23

Claude and Codex plans now require `stateRoot`, read from the verified state
provider formula's environment, not from a guest request. Both parsers require
an absolute normalized non-root path. The shared provisioner treats this as
immutable placement and the adapters always protect it from workspace/private
directory overlap. Even an authorized provider rebind refuses a changed root
before stopping or revising the session; same-root provider replacement remains
supported. No new provider API or native recovery mechanism is introduced.

Durability: the root is part of the existing plan persisted before activation.
Reconstruction compares the stored plan against the current provider root; it
does not infer placement from current configuration alone. Shared adapter tests
exercise changed-root refusal, same-root replacement, and reconstruction over a
recording owner. These are not live daemon-restart or physical filesystem-identity
proofs; live cross-backend rebind acceptance remains open under FA-08.

Verification: Claude 211 and Codex 315 tests pass; the strengthened adapter
conformance fixtures also pass all 24 cases each with no caller-supplied root
protection. Both production type checks and hosted-agent types pass. Scoped
lint has zero errors (14 existing warnings). Final adversarial review found no
blocking issue.

Breaking deployment gate: retire affected old Claude/Codex sessions using the
old release before switching parsers. Old plans without `stateRoot` are refused,
including by storage deletion. Preserve Secrets, renewal credentials and
workspaces. Deployed as generation 166 after verifying no old native session
records or Floot sessions remained; this is retirement evidence, not migration
compatibility or live rebind proof.

### Live rebind acceptance harness — 2026-09-23

Prepared in endo-host `ops/verify-rebind.mjs`, with the operator procedure in
`ops/rebind-acceptance.md`. Separate disposable OpenCode runs test provider-only
and image-plus-provider replacement, always using the free auto route. The
driver requires exact recorded/proposed changes, a normal unauthorized reopen
refusal, explicit authorization, matching returned/read-back bindings, preserved
seed history, and a native shell read of a workspace marker after rebind. It
deletes only a verified run's exact session identity. Native cleanup inspection
remains a separate operator gate, not inferred from Floot deletion.

Durability: this is a one-shot operator harness, never a persistent formula.
Private manifests record pending phases before effects, flush file and parent
directory updates, and refuse automatic replay of uncertain phases. An exclusive
local manifest lock prevents overlapping invocations; it is not a distributed
lease. No credential or daemon-state schema changes. Adversarial review caught
and corrected an API mismatch: `whenFinished()` resolves on failure, so the
driver also reads the final turn status. Fake-facet regressions validate the
harness, not daemon restart or real inference. SSH connectivity is restored and
generation 167 is deployed.
The provider-only case passed on Tokyo using OpenCode's automatic free route:
normal reopen refused the replacement, explicit provider authorization matched
the inspected proposal and returned/read-back bindings, and native shell evidence
proved the original workspace marker survived with the seed transcript intact.
The disposable session was deleted; separate inspection found zero native records,
containers and 9p mounts, with all six Secret identities and the controller-host
identity unchanged.
The retirement helper initially rejected normal stop's release of transient
client/worker references; reviewed correction requires their absence plus the
native-closed acknowledgement while preserving stable references.
Stop was not replayed.
See endo-host `ops/hosted-cutover5-20260923.md` for the run and evidence.
Generation 168 also passed the separate image-plus-provider case after a guarded
rebuild changed only the OpenCode overlay digest among the configured images.
Normal reopen refused exactly those two changed axes; explicit authorization
matched the inspected proposal and read-back bindings, and Podman confirmed
the new image was running.
Native shell evidence verified the original workspace marker with seed history
intact; guarded cleanup deleted the test session.
These close the two live rebind cases, not process-loss recovery or universal
revocation of old capabilities.
The new image also passed independent restart/recall conformance on the automatic
free route: two completed turns and four transcript messages after daemon restart.
The exact verified session was deleted; separate inspection found no containers
or 9p mounts remaining.

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

### Scoping — 2026-09-22

Not implemented; scoped, with the host facts that decide the mechanism, and
deferred by the operator on 2026-09-22 (deploy first; mechanism and bound later).
What exists: every hosted slice gets the projected workspace at `/workspace`
(9P, a capability filesystem), a 1 GiB tmpfs at `/tmp` and a 256 MiB tmpfs
at `/run` (`TEMPORARY_MOUNTS` in `execution-envelope.js`), the runtime's own
state directory under the state provider's root, and, for Codex,
operator-declared container mounts recorded in the plan. Nothing is both
durable and local: a toolchain installed under `/tmp` is gone at the next
incarnation, and one installed in the workspace is projected through 9P,
which promises no ordinary filesystem behaviour for package caches, SQLite
or build output. The only storage bound in the app is the delegated
runner's `storageBoundBytes`, a declaration a runner passes down and no
backend enforces (`enforcesStorageBound` is declared by none, so the runner
refuses a bounded session outright). The prompt describes `/workspace` and
attached `/mnt/` disks; it does not say which paths are projected,
temporary or persistent.
Host facts (Tokyo, read 2026-09-22): `/var/lib/endo` is its own 100 GB
ext4 volume (`/dev/vdb`, 27 GB used) beside a 50 GB ext4 root; `losetup`
and `mkfs.ext4` are installed, no quota tools (`xfs_quota`, `setquota`) and
no `prjquota` mount option; the daemon runs as `endo` and Podman is
rootless.
Mechanisms that bound bytes and inodes durably; each needs host privileges
the daemon does not hold, so each is an endo-host (NixOS) change with a
small root-owned helper the daemon speaks to, a new privileged surface to
review:
1. A per-session ext4 image: a sparse file of the bound's size, `mkfs.ext4`,
   loop-mounted on the host and bind-mounted into the slice. Bytes and
   inodes are bound by construction, removal is unmount and unlink, restart
   is remount, and the image lives with the session's state root;
   `losetup` and `mount` need root. Userspace `fuse2fs` would avoid root,
   but a FUSE mount bound into a rootless container is fragile.
2. ext4 project quotas on `/dev/vdb`: `tune2fs -O project,quota` on the
   unmounted volume (a maintenance stop the wipe-and-recreate model already
   takes), a project id per session directory and a `setquota -P` per
   bound; `chattr -p` and `setquota` need root; no images to manage.
3. A tmpfs of the bound's size: bounded and simple, RAM-backed and lost at
   restart, which this finding rules out for toolchains.
App-side contract, the same under 1 or 2: the plan records a local storage
allocation (a host path under a `localRoot` beside the workspace and
private roots, the byte and inode bounds) as placement; the envelope adds
a `local` mount role at `/local`, or at the slice user's home so toolchains
land there without instruction, with the bound in the attestation and in
the hosted policy's mount accounting; the storage owner removes it with the
session; the prompt names the three classes of path, projected
`/workspace`, temporary `/tmp` and `/run`, persistent `/local`, with their
bounds; the descriptor declares `enforcesStorageBound`, so a delegated
runner's bound is honoured; a session at its bound sees `ENOSPC`, never the
host. The operator decides the mechanism (1 or 2) and the default bound.

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

### One fold, one converter, one delta — 2026-09-22

Implemented, reviewed and deployed as generation 165 on 2026-09-22 with the
full acceptance matrix passed.
Three of the duplications are gone.
The two hosted-turn commits in `agent.js` (the completed turn and the turn
mirrored after a stop or a failure) were byte-identical converters apart from
two rules; both now call `src/turn-messages.js`, which records an unsettled
call's result as `UNSETTLED_TOOL_RESULT` in both cases (a completed turn has
no unsettled call: the journal's tools are asserted settled first, and the
hosted turn throws at its end when a reported call is still unsettled, so
only the mirrored path ever sees one) and takes whether an empty reply is
recorded (a completed turn's is; a mirrored turn's is not).
The reply-event fold that turns a turn's events into the messages a view
renders existed once in the daemon's turn (`src/session-turn.js`, the source
of snapshots) and once in the browser's component
(`chat/floot-component.js`, which adopts a snapshot and applies the events
after it); both now run `src/reply-fold.js`, exported from Floot and a
runtime dependency of chat, so a view repainted from a snapshot and one that
applied every event converge on the same messages. Seven differences between
the copies were resolved on one rule each: a thinking block's end time is
omitted while it is undefined; a snapshot's pending tools are the calls
without a result, so an empty result is a result; usage is projected by the
caller (the daemon keeps it as reported, the browser projects its counts,
now from a snapshot as well as from an event); the trailing text is flushed
in `finally` on both sides, so text streamed before a failed channel is kept;
emission order stays each side's own (the daemon forwards an event before
folding it, the browser notifies after); terminal handling stays the
caller's.
The transcript delta (`diffTranscript`, `applyTranscript`) moved into
`src/transcript-delta.js`, pure and unhardened so the browser bundle runs it;
`session-watch.js` re-exports and hardens what it publishes, and chat's
documented mirror is deleted.
The authority distinction the finding guards is untouched: neither the fold
nor the converter reads the journal's host-recorded tools or guest-reported
activity, which stay separate lists with separate provenance.
Tests: `test/reply-fold.test.js` folds a corpus with text around a tool round
whose calls settle out of order, a growing thinking block, usage and an end,
and proves that a viewer adopting a snapshot at every cut of that corpus
converges with one that applied every event; `test/turn-messages.test.js`
covers ordered segments, the one-round fallback and the empty-reply rule.
Floot 462, chat 935 and space-floot 52 tests pass; the Floot and chat ESLint
gates have no errors from this change (Floot's gate had one pre-existing
shadowed variable in `test/factory-subscription.test.js`, corrected in its
own commit); chat's type gate fails only in its own test files
(`test/component/floot.test.js` on variables declared without a type,
`test/helpers/fake-floot.js` on passable typing), both untouched here and
failing before this change.
The reconciliation of host and guest tool evidence and the tool-pairing rule
followed the same day, below.

### One reconciliation, one pairing — 2026-09-22

Implemented, reviewed and deployed as generation 165 on 2026-09-22 with the
full acceptance matrix passed.
The last two duplications the finding names are gone, and its completion
criteria are met: snapshots and deltas converge under one corpus
(above), and success, failure, cancellation and restoration now share record
conversion and evidence reconciliation.
A turn's tool calls are recorded up to three times: mirrored into the tree
as the provider sent them, journaled as what the backend reported (guest
activity, observed after the fact) and journaled as what Endo executed (host
tools, written before execution).
The history a view renders (`getHistory` in `agent.js`) and the transcript a
restored session is given (`recoverTurnTranscript` in
`src/transcript-projection.js`) each reduced those three views to one row per
call, on rules that had drifted: history matched an observation by name,
arguments and result, so a look-alike call under another native id was
folded into a mirrored one; restoration matched it by native id alone.
History compared journal previews as previews; restoration hydrated whole
content first.
History never settled a mirrored call the tree left unanswered; restoration
did.
Both now run `src/turn-evidence.js`, `reconcileTurnEvidence`, on the
restoration path's rules, the stricter of the two: an observation matches a
mirrored call by native id alone; an execution matches by name and
arguments, the call whose settled result it reproduces first, else a call
still waiting for a result, else, when the execution itself never settled,
any call it could be, and executions that settled are matched before those
that did not, so the order the journal started them in cannot let an
execution that hung take the call its retry answered (the review found the
first draft pairing an unsettled execution with a settled look-alike, so
that a settled execution then answered the wrong call, and the second draft
letting journal order decide the same; history at the baseline got the
first right and restoration did not); every match is one to one, so repeated identical
executions stay visible as repeats; a match settles a call the tree
recorded without a result or with a placeholder for one, and the row
records what settled it; what matches nothing is evidence of its own, an
observation under its native id and an execution under an id namespaced to
the turn so it cannot alias a native one.
A settled result reaches the tree's message or record by position, since
the rows the tree contributed come first in the tree's order, rather than
by id: a provider id repeated within a turn, or a mirrored call without
one, would otherwise have the wrong answer replaced or the evidence dropped
(the restoration path replaced by id at the baseline and overwrote a
repeated id's other answer; it no longer does).
How a journal entry's text is read stays the caller's: history compares
previews and marks what was cut, restoration hydrates whole content.
The two renderings stay their own: history shows a recovered host execution
behind the "durable Endo execution evidence" notice only when the turn also
has backend observations, and splices recovered rows before the turn's last
message; restoration emits the recovery notice once, then the recovered
calls and their settled results, and recognizes the notice by identity
rather than by prefix.
History's tool rows now carry the provider's call id, which is what lets an
observation reconcile by identity; chat renders rows with or without one.
The authority distinction is kept in the rows themselves: each says whether
it came from the tree, a guest observation or a host execution, whether an
observation and an execution matched it, and which of them settled it.
The tool-pairing rule (a result answers the earliest unanswered call of its
id) was written in `projectHistory`, `transcriptToProviderMessages`,
`recoverTurnTranscript` and hosted-agent's `transcript-records.js`; the
latter's `pairToolCalls` now takes `perTurn`, on which the provider replay
and the restoration path both rely, and `projectHistory` keeps its own walk
over tree messages rather than records.
Because that shared pairing refuses a result that answers no call, the
projection from tree messages to records (`projectTranscript`) now emits a
result only when an open call of its id in the same turn can take it,
dropping a doubled result or one under an earlier turn's id as it already
dropped one under an id never announced; the provider replay and the
restoration path silently ignored such a result before, and a tree that
somehow holds one still replays and restores.
Tests: `test/turn-evidence.test.js` (eleven cases: one-to-one matching of
observations and executions against mirrored calls; identity over
resemblance for observations; reordered observations settling native
identities; recovered ids namespaced to the turn and re-prefixed while they
collide; an unsettled execution answering the waiting call rather than a
settled look-alike; a settled execution winning its call whatever order
the journal started them in; an execution answering an observation the tree never
mirrored, with the cut of a preview kept; an execution settling an
unanswered mirrored call, a null result unanswered, and a journal entry
without a call id refused; the Claude MCP alias and preview-to-whole
comparison; a different result staying a second row; and an unmirrored
turn's rows in source order); a projection case for the doubled and late
results; a restoration case where a repeated id's other answer is kept;
hosted-agent's pairing suite covers `perTurn`; the continuity suite's
expected history rows carry the ids. Not covered at the history level: the
settle-by-position loop in `getHistory`, since the fixtures' tree mirror
and journal activity come from the same events and cannot disagree.
Floot 475, chat 935, space-floot 52 and hosted-agent 675
tests pass; the Floot and hosted-agent ESLint gates have no errors from this
change; the pre-existing type failures in chat's and Floot's own test files
are unchanged.

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
Independent review approved the code; it shipped in generation 159 (2026-09-21).
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
It shipped in generation 159 (2026-09-21).

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
No live state was modified; it shipped in generation 159 and Tokyo's inventory was
verified on 2026-09-22 (see "Deployment verified; Tokyo's legacy state retired").

### Private journal removal: creation and revival boundary

Implemented and tested; shipped in generation 159 (2026-09-21).
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

### Deployment verified; Tokyo's legacy state retired

Every FA-11 code removal (`db12c4af4`, `c24d84d1c`, `a0911be55`, `162b9d6ef`)
is an ancestor of the revision Tokyo has run since generation 159, and the
2026-09-21 and 2026-09-22 acceptance matrices exercised session creation,
restart/restore and deletion on that code.
A read-only inventory on 2026-09-22 (endo-host
`ops/hosted-retirement-fa11-20260922.md`) found neither legacy registry root nor
migration marker in the host-root-reachable graph.
What remained was state on Tokyo, not code: twenty-six persisted one-shot
`make-unconfined` formulas from the 2026-09-16/17 experiments bound at the host
root (their module files were stubbed on 2026-09-21 but the names were never
unbound), the pre-shared Codex audit subtree `codex-subscription-state`, thirteen
empty per-session scaffolds under the live Codex host directory and sixty-six
one-shot module files at the state root.
All of that was retired on 2026-09-22 through two reviewed one-shot helpers
(endo-host `ops/retire-legacy-helper-formulas.mjs`, `ops/retire-legacy-state-files.sh`;
four adversarial review rounds; results in the same note): the twenty-six names
unbound without cancelling, resolving or looking up a formula (`cancel` would
have evaluated the dormant module first, and collection is disabled on Tokyo,
so the records stay in storage unreachable by name from the host root), the
audit subtree renamed to `retired-codex-subscription-state-20260922` with all
171 entries intact, and 79 filesystem entries moved, never deleted, into a
root-only archive. The final inventory differs from the pre-run one only by
those names; Secrets, pins, the four workspace archives and the operator's live
session are unchanged, and the discovery gate passed afterwards.
Final migration UI removal (2026-09-24, local): the chat recovery controller no
longer computes a `blocked` flag for synthetic `legacy-import` turns, which the
runtime no longer produces.
Both composition guards and the send handler drop that obsolete condition;
an active resolution still blocks sending, while ordinary unknown outcomes
remain visible and available for explicit verification.
The README no longer instructs users to import and acknowledge old guest journals.
The journal's rejection test for the invalid synthetic turn ID remains useful
validation coverage, not a compatibility path.
No durable record, formula, resolution policy or automatic replay behavior changes.
All 935 chat tests pass (ten skipped), as do all 52 Floot-space tests.
The UI regression holds a resolution reply, checks disabled composition and
send-handler fencing, then verifies sending resumes after acknowledgement.
Changed-source lint and formatting pass; documentation has zero errors
(180 warnings). Adversarial review approved the source and regression.
At the removal checkpoint, chat typechecking failed with 14 diagnostics in unchanged fixture
logic: optional fake-daemon handles and unknown/non-passable fake event values.
That checkpoint did not have a passing type gate; the repair below supersedes it.
Not deployed.

Fixture validation repair (2026-09-24): account-capacity/reset tests now take
their daemon from the existing setup return value, avoiding optional handles
assigned through callbacks.
Fake session and turn snapshots are hardened and narrowed with `isPassable`
before being published to the real buffered stream, rather than asserted with
a type cast or accepted as arbitrary unknown values.
Chat typechecking now passes with no diagnostics.
This changes test fixtures only: no production state, formula, or protocol changes.
All 935 chat tests pass (ten skipped); full package lint, typechecking, and
changed-file formatting pass. Documentation has zero errors (180 warnings).
Adversarial review approved the fixture changes and validation boundary.

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
The removal shipped in generation 159; its deployment is verified below.

The OpenCode `src/opencode-broker-service.js` wrapper and its package export are removed.
The current broker agent already uses the shared service kit directly.
All seven lifecycle/authority regression tests now exercise that shared kit with
the explicit OpenCode policy, account, and label; no replacement wrapper was added.
Repository search found no remaining production callers of the removed export.
Thirteen focused service/entrypoint tests and all 218 OpenCode package tests pass
locally with Unix-socket permissions; restricted execution hit three `EPERM`
socket failures before the unrestricted rerun passed.
Package ESLint reports zero errors and 36 warnings; it shipped in generation 159.
Do not infer deadness for all wrappers: current controllers still use `parse-rootfs.js`.

### Deployment verified

Both removals (`886192baf`, `8aa1edc99`, with `7f8eee056`) have run on Tokyo since
generation 159.
The 2026-09-22 inventory lists 55 module formulas under the current release: the
shared `managed-credentials-module.js` (two), `managed-renewable-credentials-module.js`
(five), the account oracle, account source, subscription, subscription-admin and
reset-redeemer modules, the three backend module sets and the platform caplets.
No package-local credential wrapper, `opencode-broker-service.js`, retired factory
or provider module appears in the host-root-reachable graph.
Two dormant formulas, `controller-for-lal` and `controller-for-llm-provider-factory`,
still name release `fde6c143…`, which retention has pruned; Floot's direct provider
does not depend on them, and whether to re-mint or retire them is left with the
operator (recorded under FA-07's ontology item, not here).

Completion: retained formulas and current callers reference current entrypoints, and removed
exports/tests no longer suggest a supported second topology.

## FA-13 — Align host image provisioning with the new builder

Retrospective publication follow-up (2026-09-24): host `4e2a574` adds the missing
parent-directory flush after atomically replacing the candidate image manifest.
The command cannot acknowledge a successful candidate lease before that flush.
A failed file flush preserves the old manifest; a failed directory flush reports
failure while retaining the uncertain visible replacement, without rollback or
deletion. Three new tests verify ordering, both failure boundaries, temporary-file
cleanup, and descriptor closure; two failed before the fix. All 32 current
image/holder/storage tests pass after independent review. Pushed to both remotes,
not deployed. No new formula, credential owner, lease period, or automatic activation.
This is injected-I/O evidence, not a physical power-loss test.

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
5. Resume FA-11/FA-12 legacy retirement/deletion (done 2026-09-22; see "Legacy
   retirement — 2026-09-22"), then FA-06/FA-10 extraction and FA-08 (deployed as
   generation 165 on 2026-09-22 with the full acceptance matrix passed), FA-07
   (deployed as generations 160 and 161 and accepted there), FA-09 storage (scoped
   2026-09-22 and deferred by the operator), and remaining bounded-context/compaction
   and resource-failure acceptance.

### Acceptance runner correction — 2026-09-23

Acceptance-runner correction (2026-09-23): the host's
`run-cutover4-*` scripts now preserve driver exit codes, stop before subsequent
phases after a failure, and refuse restart after failed seeding or recall after
failed restart. Hosted acceptance no longer unconditionally runs the
`verify-cancel` recovery phase after a completed cancellation (that phase
requires a pending attempt). Raw driver output is retained in the private run
log; transient script copies are removed on failure without deleting manifests
or sessions. Four local test methods cover 23 injected phase failures, four
empty-output successes, eight setup failures, and a failed restart using inert
host substitutes.
This changes only the one-shot operator harness, not daemon formula state or
replay. SSH connectivity is restored. Generation 166 uses the corrected phase
drivers through individual supervised invocations, preserving exit status and
not advancing after failures. Hosted create/tool, policy and cancellation phases
passed; restart/restore and live rebind acceptance remain pending. The cancel
result is deliberately limited to admitted turns with observed native calls,
not native-process termination proof. See the current cutover record in
endo-host `ops/hosted-cutover5-20260923.md`.

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

### Cutover progress — 2026-09-22

The third cutover (endo-host `ops/hosted-cutover3-20260922.md`) retired the
three pre-catalog brokers and activated the discovery release; its first
activation (generation 160) failed hosted restart/restore because of the
fail-closed native teardown, which was evicted to #1323; generation 160 had
passed create, native tool use, network policy and cancellation and generation
161 passed graceful restart/restore and deletion, on Luna, Haiku 4.5 and the
free routes, and generations 162 and 163 (the picker ordering, the
no-session-on-load rule and thinking folded into the actions group) passed the
discovery gate after each restart. Tokyo ended each activation
with zero native records, containers and mounts beyond the operator's own
sessions; Secrets and the four workspace archives are unchanged. The
inventoried graph still carries legacy one-shot helper formulas
(`cleanup.mjs`, `cleanup2.mjs`, `cleanup4.mjs`, `fresh1.mjs`, `rmbroker-1`,
`rmbroker-2`) and old `codex-subscription-v2/sessions` directories from
September's first migrations: FA-11/FA-12 retirement input, not touched here.

### Legacy retirement — 2026-09-22

Step 5's retirement ran on generation 163 without a release change (endo-host
`ops/hosted-retirement-fa11-20260922.md`). A fresh read-only inventory first
reconciled the register: every FA-11/FA-12 code removal was already deployed
and only shared entrypoints appear in the host-root-reachable graph. The
leftovers were then retired in one approved action with Caddy offline: the
twenty-six persisted one-shot helper formulas (the four named above plus the
`cleanv`, `fresh2`, `m-claude`, `mountain` and `ocprobe` series) unbound by
name, never cancelled, resolved or looked up, because the daemon evaluates a
dormant formula before cancelling it and collection is disabled on Tokyo; the
pre-shared Codex audit subtree renamed to
`retired-codex-subscription-state-20260922` with its 171 entries intact; and
79 filesystem entries (66 one-shot module files at the state root, 13 empty
Codex session scaffolds) moved, never deleted, into a root-only archive.
The final inventory differs from the pre-run one by exactly those names;
Secrets, pins, the four workspace archives and the operator's live session
are unchanged, and the discovery gate passed on every account afterwards.
Left for a decision: `controller-for-lal` and `controller-for-llm-provider-factory`,
dormant formulas pinned to a pruned release; the 2026-09-17 acceptance records
and one unnamed guest still in storage; and the state root's older directories
from earlier eras, inventoried but untouched.

Deleting a source file or pet name does not prove that a running resource stopped.
Do not erase generic sandbox functionality just because the retired hosted path used it.
New abstractions should serve the remaining current topology, not preserve both systems.

## Change log

2026-09-24 — Mapped five more application network/runtime changes and seven host
retirement/acceptance changes. Found and fixed legacy cancellation-triggered
revival in host `c98eb5d`; 44 helper tests pass. Fresh network/MCP/policy checks
pass (62 shared, 3 Claude, 7 OpenCode, 13 Codex). Corrected stale design text about
OpenCode network integration. Opened the old restoration runner's unrecorded-create,
manifest replacement and abandoned-ID boundary explicitly; not yet remedied.
No Tokyo runtime or Secret changes.

2026-09-24 — Initial host durability mapping found a missing candidate-manifest
directory flush. Corrected in host `4e2a574` after regression reproduction and
independent review; 32 image/holder/storage tests pass. Thirteen early host commits
now have owner/disposition/limitation mappings; 20 inventory/archive helper tests
also pass. The first six application commits are mapped to their retained grant,
MCP, cleanup and registry boundaries; superseded factory integrations are not
counted as current evidence. The design's stale three-adapter cleanup-scope claim
is corrected. No remote runtime state changed and no deployment occurred.

2026-09-24 — Added the retrospective change ledger: 479 application and 93 host
commits enumerated, including upstream and reverted work. Path-based triage is
explicitly not semantic durability approval. The remaining work is to connect
every retained implementation to its owner, replay/retirement rules and evidence,
including infrastructure predating the enumeration seeds. The newest 15 changes
are individually mapped with evidence limitations. Independent review verified
exact unique coverage and classifications in both repositories. No deployment change.

2026-09-24 — Claude diagnostic reads no longer hold turn failures behind stalled
stderr reads or iterator closure. Partial excerpts survive the read deadline and
late completions cannot resume pulls. Six regressions and all 225 package tests
pass after independent review; no durable schema or native retirement change.
Not deployed.

2026-09-24 — Claude no longer reports success when process exit observation
rejects. Three reproduced regressions and all 219 package tests pass; lint,
formatting and docs pass after independent review. Adjacent OpenCode client and
bridge failure paths were audited and 35 existing tests rerun successfully.
This is truthful outcome reporting, not native retirement proof. Not deployed.

2026-09-24 — Codex fixture contracts corrected in `5d419544e`, pushed to both
remotes after independent review. All 322 tests, full package lint, formatting,
and docs pass. No production or durable-state change.

2026-09-24 — Failed setup now retains acquisition exclusion until agent/native
rollback and exact journal closure acknowledge completion. Failed constructions
remain available to explicit cleanup instead of blocking it on a stale rejected
promise. Three realistic failure regressions and all 663 Floot tests pass;
lint/format/docs pass with existing warnings after adversarial review.
Seven adjacent real-daemon lifecycle and journal-retirement regressions also
pass, including failed disposal barriers and retirement across cold restarts.
Coverage limits and concurrent-disposal refusal are recorded above. Not deployed.

2026-09-24 — Stop/resume now closes old journal handles before publishing running,
with records-only acquisition fenced and stale/disposed resume continuations
prevented from granting execution. Six new lifecycle regressions pass alongside
the full 660-test Floot suite; lint/format/docs pass with existing warnings after
adversarial review. Failed-construction reclamation remains open. Not deployed.

2026-09-24 — Normal network/rebind replacement now closes and releases old
private journal facets after agent/backend drain, preserving durable history.
654 Floot tests pass; package lint has no errors, and root docs reports no
errors (180 existing warnings). Adversarial review approved the bounded change.
Emergency-stop/resume and failed-construction reclamation remain open.
Not deployed.

2026-09-24 — Usage totals and context readings now project from terminal journal
evidence; tree totals and the completed-total cache are removed. Optional totals
reporting cannot block durable settlement. 588 Floot tests and lint/docs/format
gates pass after adversarial review. Not deployed; legacy session retirement is
a cutover gate and tree-based history remains to remove.

2026-09-24 — Checkpoint recovery now selects only completed journal evidence;
tree token writes are removed. Legacy unproven tokens require retirement, not
silent promotion. 579 Floot tests and lint/docs/format gates pass after
adversarial review. Not deployed; tree/history/usage retirement remains open.

2026-09-24 — Tree-retirement prerequisite: persist bounded typed thinking
presentation separately from canonical model context, with ordering anchors,
timing and truncation. 575 Floot tests and lint/docs/format gates pass after
adversarial review. Settlement-time durability only; UI projection cutover and
Tokyo deployment remain pending.

2026-09-24 — Tree-retirement prerequisite: journal existing mail sender/receipt
metadata before tree writes or inference, validating it on replay and saved-state
reads. 564 Floot tests and lint/docs/format gates pass after adversarial review.
No retry/deduplication policy change or Tokyo deployment claimed.

2026-09-24 — Tree-retirement prerequisite: hosted successful finish journals its
backend checkpoint before native acknowledgement, with bounded token and settled
state validation on write/replay/snapshot/archive. 559 Floot tests and lint/docs/
format gates pass after adversarial review. Tree-based recovery remains for now;
no deployment or completed tree retirement claimed.

2026-09-24 — FA-01/02 bounded-context investigation reproduces eager full-tree
payload loading independently of journal paging. Record the remaining tree
semantics and a deletion-before-indexing sequence; no production storage change
or bounded-memory completion claim.

2026-09-23 — FA-02 real-daemon direct-provider journal verification: failed-turn
full content/tool evidence and a subsequent sealed turn survive two orderly cold
restarts, with no inference on reconstruction or repeated durable test effect.
Four daemon tests, lint/format and root docs pass. Not Tokyo or process-loss
acceptance; no production implementation changed in this test slice.

2026-09-23 — FA-02 direct-provider ordered transcript durability: journal model
replies before tools and settled results before continuation, seal before the
final tree mirror, and fence cancellation at effect and settlement admission.
547 Floot tests and documentation/lint/format gates pass; adversarial review
approved. No new schema or formula. Not deployed; real-daemon acceptance and
bounded context/automatic summaries remain open.

2026-09-23 — FA-07 runtime context plumbing: selected OpenCode route context
comes from the existing broker catalog at activation; fabricated model limits
are removed and the output budget remains explicit. Controller/cancellation
regressions, declaration build, formatting, and root docs pass (0 errors,
179 warnings); adversarial review approved. No new durable state. Not deployed;
live model-window and compaction/restart acceptance remain open.

| Date | Change | Verification / deployment |
|---|---|---|
| 2026-09-23 | Add canonical retained-tail compaction representation and one shared expansion rule | Pinned native source disproves summary-only capture; 686 hosted-agent tests (one skip), 502 Floot tests and Claude/Codex/OpenCode conformance suites (8/8/12) pass. Production declaration generation, formatting and scoped ESLint pass; docs have zero errors (178 warnings). Independent review approved validation, canonical ordering and idempotent expansion. Native capture, ordered journal persistence and tree projection remain gated; not deployed. |
| 2026-09-23 | Deploy archive paging, recorded-compaction replay and provider accounting fixes as generation 169 (app `819aa18c8`, host `7dbf7c3`) | Four-backend seed/restart/recall/delete passed; reconstructed archive API checked; Secrets, host and credential bindings preserved; no native resources left. Live archive-boundary and compaction/error-path injection remain open; see host cutover record. |
| 2026-09-23 | Preserve usage on OpenRouter HTTP/API/finish errors and stop automatic replay when token consumption is reported | 94 Lal tests (one skip), 501 Floot tests, production declarations, formatting and composite consistency pass; scoped lint has zero errors and docs have zero errors (178 warnings). Independent review found a swallowed error-body timeout; fixed and regression-tested with native-style AbortError and exactly two attempts. Tests also cover observer/no-observer behavior, zero-usage retries, fractional refusal, bounded error bodies and failed HTTP turn reconstruction. Reuses hosted-agent's bounded JSON reader rather than duplicating it; no new formula/schema. Not deployed. |
| 2026-09-23 | Preserve reported OpenRouter usage when assistant validation rejects a response, using an optional pre-settlement incremental provider notification and the existing turn finish journal | 500 Floot and 82 Lal tests pass (one Lal skip), including failed-turn reconstruction and no double counting; independently reviewed; changed-file ESLint has zero errors and docs have zero errors. Whole Lal lint still has eight project-service errors in unchanged files. No new durable schema; process loss before finish and API-error/retry usage remain open. Not deployed. |
| 2026-09-23 | Preservation-safe paired cutover activated as generation 166 | App `4b425552f` with host `d696a88`; zero sessions/runs, slot-free workflow startup records verified. Detached 24 old Floot/provider aliases with repeated Secret/host/credential/pool identity checks, then proved old-daemon shutdown and no containers/9p. No database wipe. Hosted setup, all-account discovery and hosted create/shell/policy-tool seed passed, including Luna/free routes; post-activation Secret and controller-host identities unchanged. Remaining cross-backend acceptance and live rebind are pending. See endo-host `ops/hosted-cutover5-20260923.md` |
| 2026-09-23 | Repair retirement helper's dormant-formula hazard and verify the durable empty registry | Host helper now detaches names without cancellation, validates capability-free registry sequence/data, preserves credential/pool/host state, and fences changed/reappearing aliases. Reviewed tests cover partial removal, collected metadata and empty-registry guards; Tokyo dry run passed for 22 provider plus two Floot bindings. No effectful retirement; startup-dependency check, quiescence, old-worker shutdown, activation and acceptance remain required |
| 2026-09-23 | Resume preservation-safe coordinated deployment preparation after SSH recovery | App `4b425552f` mirrored to Forgejo and prebuilt; paired host `5827da0` NixOS build passed without activation. Fresh inventories: six Secrets, no native session records/containers/9p/Floot guest roots, 22 broker/dependent bindings including three broker roots. No retirement or state wipe; guarded alias detachment, activation and full acceptance still pending. See endo-host `ops/hosted-cutover5-20260923.md` |
| 2026-09-23 | Bound the guest-GC deletion impact and research safe remedies | Two-session regression proves collateral facet loss and recovery of history/continued turns after restart. No supported deterministic import-release API found; design alternatives and acceptance gate recorded, no unsafe GC bypass |
| 2026-09-23 | Repair stale factory-disposal test backend after model catalog refactor | Reproduced late-native admission failure/timeout; current catalog and fail-fast gate restore all three lifecycle tests. Fake guest boundary explicit; no production change |
| 2026-09-23 | Verify terminal journal retirement across real daemon restarts; identify guest-GC/factory termination conflict | Four restart cases pass with persisted-registry assertions and a second cold start; acknowledgement faults isolated with GC off, real-GC interruption/recovery tested separately. Smooth GC-enabled deletion and shared-session impact remain pre-merge review items; no production semantic change or Tokyo deployment |
| 2026-09-23 | Add terminal private-journal namespace retirement after durable intent, writer drain and backend cleanup; fence delayed observation from rebuilding during deletion | Exact namespace/schema validation, uncertain-removal retry and factory reconstruction regressions; no generic-cleanup deletion; real-daemon evidence added above, Tokyo verification pending |
| 2026-09-23 | Retrospective durability audit: include partial pool-member construction in existing core rollback, releasing unused cleanup handles if a later member fails | Direct/wrapped regressions; no credential use or persistent state; normal member ownership preserved; not deployed |
| 2026-09-23 | FA-07: preserve saved subscription pins on restoration rather than silently falling back to automatic account selection | Removed-member and missing-descriptor factory regressions; backend admission remains authoritative; no new durable state; not deployed |
| 2026-09-23 | Prepare exact-binding live rebind harness in endo-host: refusal, explicit authorization, preserved history/workspace tool evidence, guarded cleanup | Local fake-facet tests and adversarial review; pending intents are not replayed; Tokyo run blocked by SSH connectivity |
| 2026-09-23 | FA-08: pin Claude/Codex native state roots in durable session plans and refuse relocation before rebind; automatically protect roots from guest placement | Parser and adapter conformance regressions; adversarial review; old-release retirement required before deploy; live acceptance pending |
| 2026-09-23 | FA-08: require Claude/Codex deletion owner to capture the same state provider used for activation; Claude setup also refuses mismatched retained storage | 52 focused tests; no new durable state; immutable native state-root pin still open; not deployed |
| 2026-09-23 | Repair Claude broker public JSDoc type and shared OCI literal inference from binding-vocabulary refactor; quarantine stale local generated profile declarations | Docs passes, zero errors; Claude production and hosted-agent types pass; 35 focused tests; no runtime/durability change |
| 2026-09-23 | FA-08: read-only recorded/proposed binding inspection and actual binding snapshot in rebind replies; delegated runners refuse operator identity disclosure | Three adapter conformance suites and Floot regression tests; durability boundary documented; live rebind and state-root placement remain open |
| 2026-09-23 | Acceptance runners preserve driver failures and stop before later phases, restart, or session deletion; remove transient copies even on setup failure | Four local test methods, 36 scenarios; shell syntax checks pass; no daemon-state change; Tokyo acceptance pending connectivity |
| 2026-09-23 | One binding vocabulary, slices 2 and 3: every hosted plan records `accountRef`, the operator-declared id of the account authority the broker serves (`account-authority.js`; host option `accountAuthority`, required), read by the shared reader; setup writes it into the broker's profile and refuses a retained broker serving another; a pool set carries it as `id`, the catalog snapshot as `authority`, the grant reports it, the controllers ask for it from the plan; the provider-name constants and Codex's `pool` label are gone, Codex's profile `accountRef` is the verified provider account for a single credential only, and the issuer no longer ties the id it reports to the policy's provider account; the provisioner owns the vocabulary (`rootfs` under `image`, `accountRef` under `account`, dependencies under `provider`, Claude's `credentialKind` under `account`), so every descriptor lists `['image', 'account', 'provider']` | hosted-agent 680, Codex 311, Claude 207, OpenCode 255 and the Floot factory suites pass; the shared conformance suite proves the vocabulary on every adapter over the real provisioner and rebinds `account` on Claude and OpenCode; new cases for the authority id on plans, catalogs and the issuer's split, for a profile from before (refused with the way out, all three readers) and for the Codex module's binding to the authority rather than the provider account; lint and formatting clean, the hosted-agent and Claude type checks clean, Codex's source clean with its pre-existing test-file errors; independent adversarial review, whose findings (the retained-broker message, the Codex set written before the retained comparison, the untested Codex binding, three stale documents) are fixed; not deployed (needs the three host values and the brokers retired) |
| 2026-09-23 | One binding vocabulary, slice 1: `rootfs` is the one image field of every hosted plan, read and pinned by the shared placement reader (`readPinnedRootfs`), so the execution envelope reads the plan's image itself and the three per-adapter image hooks go; every plan reader refuses a field it does not know (each adapter declares its `fields`; the retired-name checks fold in); Codex's plan field `imageRef` is gone; from the review, setup applies the runtime's pinned-reference rule to an operator's own pin too, where the message is read, rather than at every session creation | hosted-agent 678, Codex 310, Claude 205, OpenCode 252 pass; the shared reader's new cases prove the pinned-image spellings and the refusal for the shared and each adapter's reader; lint, formatting and the hosted-agent type check clean; independent adversarial review; not deployed |
| 2026-09-23 | Design: one binding vocabulary planned for every hosted plan (`image`, `account`, `provider`, with `rootfs` and `accountRef` in every plan, `account` naming the account authority a broker serves, a pool or a single account, by an operator-declared id the catalog, the plan and the grant share, and the credential kind bound under it), recorded in `designs/hosted-agent-sandbox-unification.md`; the grant's account reference is today the provider's name for Claude and OpenCode and the label `pool` for a Codex pool | Design note only; implementation to precede the next deploy and the live rebind cases; closes FA-07's account criterion and FA-08's account item when it lands |
| 2026-09-22 | FA-08: a session revision is one transition. The record store's `revise` stages the rebound edges and the plan under the record's `revision` entry before any published write, shows a staged revision as applied and finishes it before any mutation of the record or the owner's `start`; `rebind` folds into it. Found by the operator's reviewer (Astra): the first design left a crash between edge writes as a stopped record with mixed references that `start` accepted and the execution envelope cannot reject (a replacement service may report the same image and account; storage is unchecked) | Store cases: one transition, plan-only unstaged; interruption after intent shown whole, refused for `retain`/`remove` while the publication fails, finished by `settle`; a retry finishing or leaving the intent; `release` finishing it first; at the plan publication finished before removal's cleanup; before intent discarded. Owner case: removal refused until the revision finishes, then under the revised plan. Native owner cases: the next start refused without constructing until it finishes, then the revised plan activated with the rebound dependency; removal refused without a native call or lifecycle change until it finishes. Daemon session suites and type check pass; two independent adversarial review passes; not deployed |
| 2026-09-22 | Audit: status lines corrected to the deployed state, after two adversarial review passes: FA-03/04/05 register rows and the FA-05 line record the acceptance runs that exercised them (generations 158, 160 to 161 and 165) and what FA-05 still lacks; the FA-01, FA-03 and FA-04 lines and the two subscription-pool durability rows record generation 157, the FA-04 restoration slice generation 159 (on-host conformance left open) and the construction-prompt slices generation 160; FA-11/FA-12 pending lines and register rows record generation 159; the FA-07 register row, durability rows and progress paragraph record generations 160 and 161 (picker visual state unverified); the FA-06, FA-08 and FA-10 register, durability and section lines record generation 165; sequence step 5 and the 2026-09-22 cutover paragraph split the matrix across generations 160 and 161 as the record shows; FA-08 notes the matrix has no `rebind` case; FA-09 records the operator's deferral | Documentation only; no runtime change |
| 2026-09-22 | Deploy: app `e1ad34345` (FA-06, FA-08, FA-10, FA-09 scoped) to Tokyo as generations 164 and 165 under the wipe model; the operator recreated the six Secrets by hand (the primary Codex one renamed `codex-subscription-1`) and removed the env-token Floot provider, so Floot runs on `secrets/openrouter-auth` | Discovery gate, hosted seed/policy/cancel/inspect/cleanup on Haiku 4.5, Luna and the free route, Fae seed and cancel, restart/restore on all four backends, deletion: all passed; one incident (a recall phase during the daemon restart let the CLI start a rival daemon that killed the host on port 8921; one clean restart recovered it); endo-host `ops/hosted-cutover4-20260922.md`. Operator instruction: never wipe the Secrets manager again |
| 2026-09-22 | FA-08: a session record's image, account, credential-kind and service bindings are rebindable under an explicitly authorized reopen (`rebind: [...]`), after the owner's stop and with the daemon refusing the revision while any authority is held; the record store gains `rebind` and the owner's `revise` takes references; Floot's session facet gains the operator's `rebind` | Daemon store/owner cases; conformance cases per adapter plus the provider binding; Claude/OpenCode module cases; a Floot factory case; Floot 479, chat 935, space-floot 52, hosted-agent 676, Codex 308, Claude 205, OpenCode 252, daemon session suites 72 pass; package ESLint gates clean; independent adversarial review in four passes; FA-08 completion criteria met locally; not deployed |
| 2026-09-22 | FA-10: one reconciliation of a turn's tool evidence (`src/turn-evidence.js`) for history and restoration, on the restoration rules; one tool-pairing rule (`pairToolCalls` with `perTurn`); history tool rows carry the provider's call id; the tree-to-records projection emits only results an open call in the turn can take | Reducer suite (11 cases), a projection case, a restoration case and a pairing case; Floot 475, chat 935, space-floot 52, hosted-agent 675 pass; Floot and hosted-agent ESLint gates clean for the change; independent adversarial review; FA-10 completion criteria met locally; not deployed |
| 2026-09-22 | FA-10: one reply-event fold shared by the daemon turn and the browser component, one hosted-turn message converter for both commits, one transcript-delta applier in place of chat's mirror; chat depends on Floot at runtime for the two pure modules | New fold suite proves snapshot-adopting and event-applying views converge at every cut of a corpus; Floot 462, chat 935, space-floot 52 pass; package ESLint gates clean for the change; independent adversarial review; reconciliation and tool-pairing duplication remain; not deployed |
| 2026-09-22 | FA-06: one execution envelope in hosted-agent for the three native controllers; the provider-grant check and the canonical JSON encoder move from Codex into hosted-agent; exact grant, evidence and raw placement checks apply to every runtime | Envelope suite (10 cases); hosted-agent 674, Claude 203, Codex 306, OpenCode 250 pass; ESLint gates clean; hosted-agent types pass; independent adversarial review verified the checks against the real issuer and sandbox attestation builder and found one defect (Claude's single-token subscription sessions would have required an OAuth grant), fixed; FA-06 completion criteria met locally; not deployed |
| 2026-09-22 | FA-06: one session provisioner and one backend factory in hosted-agent; the three adapters declare their differences; shared placement reader and subscription lister; Claude/OpenCode setup refuse non-normalized or overlapping protected directories | Shared conformance suite (20, 20 and 19 cases across Claude, Codex and OpenCode); Claude 203, Codex 306, OpenCode 250 and hosted-agent 664 pass; package ESLint gates clean; hosted-agent types pass; independent adversarial review found a setup gap and a spread-order footgun, both fixed; the native controllers' envelope is the next slice; not deployed |
| 2026-09-22 | FA-07: bind broker model admission to each account's catalog; remove the operator model list from grants, issuers and broker configurations; Claude discovery | 24 new focused tests; hosted-agent 656, Claude 180, Codex 287, OpenCode 229 and the real-daemon catalog reconstruction test pass; independent adversarial review found 15 issues, all addressed and re-reviewed; broker retirement at cutover required; not deployed |
| 2026-09-22 | UI follow-up from the operator: the backend's public thinking folds into the same collapsed actions group as its tool calls, with the thought's duration on the group's head (live while it streams) and the reasoning one click further in; groups are keyed by session so an open one does not come up open elsewhere | space-floot 52 and chat 935 pass; independent review found a lint error, thought text styled as scrolling monospace code, and a preview that could read reasoning as a shell command, all fixed; deployed as generation 163 (`4411c058e`), discovery gate passed |
| 2026-09-22 | FA-07 follow-up from the operator's first look at the deployed picker: each backend's rows are listed in the picker's order (the provider's marked model first, then case-insensitively by title, then id; an OpenRouter account lists 372 in an order of its own), and the UI no longer makes a session on load when the factory lists none, since the first session is the person's to start with the backend and model they choose (sending a message with no session still starts one) | Floot 452, chat 935 and space-floot 49 pass; independent review found a lint error, a permanent loading state with no session, two wording gaps and a weak test, all fixed; deployed as generation 162 (`ca05516db`), discovery gate passed, the free router moved from position 208 to 72 |
| 2026-09-22 | FA-11/FA-12: register reconciled against a fresh Tokyo inventory (every code removal deployed since generation 160; only shared entrypoints in the graph); Tokyo's legacy state retired through two reviewed one-shot helpers (endo-host `92002a4`): 26 persisted helper formulas unbound by name, the pre-shared Codex audit subtree renamed to an archive with all 171 entries, 79 filesystem entries moved into a root-only archive | Four adversarial review rounds addressed; 31 helper tests, 173 ops tests pass; no cancel, lookup or deletion; final inventory differs from the pre-run one only by the retired names; Secrets, pins, workspace archives and the live session unchanged; discovery gate passed; left for a decision: two dormant direct-provider formulas pinned to a pruned release, the 2026-09-17 acceptance records, older state-root directories |
| 2026-09-22 | FA-07 cutover, second activation: `0d66bd945` evicted to #1323 (`2cfcfeb02` reverts; `b3f7bb1e0` re-applies on `codex/native-recovery-research`); generation 161 activates `2cfcfeb02` without broker retirement | Discovery gate passed again; restart/restore passed on all four backends after a graceful restart; all acceptance sessions deleted; zero native records, containers and 9p mounts; Secrets and archives unchanged |
| 2026-09-22 | FA-07 cutover: generation 160 activates `64176d7d5` on Tokyo after retiring the three pre-catalog brokers; live discovery gate passed (Luna, free routes, every account current); create, tools, network policy, cancel and delete passed on Luna, Haiku 4.5 and the free routes | Restart/restore passed for Fae, failed for all hosted backends (`0d66bd945` fail-closed teardown, #1323); six acceptance sessions stranded; Claude acceptance pinned to Haiku 4.5 after Anthropic's first-listed `claude-fable-5-1` failed in the runtime; rollback-or-keep decision with the operator |
| 2026-09-22 | FA-07: provider-backed model discovery end to end; static, Floot and NixOS model lists removed; per-account catalogs reach the picker; new pins admitted at plan recording, recorded pins kept; no "first listed" default; discovery re-read when the picker opens | Floot 451, chat 58, space-floot 49, Claude 183, Codex 287, OpenCode 231, hosted-agent 663 pass; host NixOS option and environment removed; independent adversarial review found eighteen issues, all addressed and re-reviewed; root type build clean and documentation gate at 0 errors (177 warnings) after quarantining stale generated declarations; live catalog reads, Luna and free routes are deployment gates; not deployed |
| 2026-09-21 | Separate native crash-recovery research from the current refactor | Dedicated investigation records evidence, retained-commit review, alternatives, and bounded continuation; prototypes isolated for draft tracking, not implementation approval; no deployment |
| 2026-09-21 | Repair public native-controller/HTTP declarations and missing hosted-agent type dependency | Clean declarations and full docs pass (0 errors, 175 warnings); 7 HTTP and 44 asset-server tests pass; independently reviewed; incremental generation and native deployment remain pending |
| 2026-09-21 | Correct OpenCode bridge and transcript declaration shapes | 26 focused tests and independent review pass; scoped lint has no errors and package docs convert; annotations only, no state or runtime behavior changes; not deployed |
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
