# Hosted native resource recovery: investigation and scope decision

| | |
|---|---|
| **Created** | 2026-09-21 |
| **Author** | kumavis (prompted) |
| **Status** | Proposed |
| **Source** | [Floot architecture audit](../packages/floot/ARCHITECTURE-AUDIT.md) |

## Decision for PR #1248

Do not implement the proposed privileged per-session producer architecture in
[PR #1248](https://github.com/endojs/endo-but-for-bots/pull/1248).
Treat automatic native crash recovery as a separate research/design follow-up.
This document records the unresolved problem; it does not select the producer design.
The operator explicitly requested this separation after reviewing its growing scope.

Keep the independently useful fail-closed and durability corrections below.
Accept that loss of cleanup authority may require operator-assisted recovery and
coordinated service downtime rather than an automatic per-session repair.
Never convert that availability limitation into an unsafe success acknowledgement.
Secrets, subscription renewal owners, and retained workspaces remain protected.

Continue #1248 with the remaining bounded refactor work: provider-discovered model
admission/picker wiring, legacy deletion, shared provisioning/reducers, context
handling, and verification of existing formula lifecycles.
Do not make those tasks depend on solving every question in this document.
Track their original completion criteria in the audit; this separation does not
silently close other findings, particularly credential exclusion or journal retirement.

Before deploying the current branch, prepare a bounded operator cutover procedure
using the old release to retire known test sessions/resources, preserving the protected
state. Verify stopped producers and exact resource identities before native cleanup.
If that cannot be demonstrated, stop the cutover and retain the original records.
No production-ready manual recovery command or safe-reset recipe is claimed here.
Automatic prefix/port sweeps are not a substitute for that procedure.
Ordinary graceful restart/restore remains part of cross-backend acceptance; it
must not be reclassified as an unsupported crash merely to pass the release gate.
Cross-backend normal-operation acceptance and explicit reporting of unsupported
process-loss recovery still apply; remove the *new architecture* as a merge dependency,
not evidence-based safety gates or the need to disclose recovery limitations.

## Where the problem was discovered

The retrospective durability audit examined cancellation/reconstruction after the
shared hosted supervisor and state-storage refactor, not an observed Tokyo incident
proving a new root service was needed.
The [supervisor](../packages/hosted-agent/src/session-supervisor.js) can recover its
recorded dependencies, but native runtime scope lookup is backed by process memory.
After that memory is lost, an absent scope previously risked being treated as successful
cleanup. Missing authority is not evidence that containers, helpers, sockets, or mounts
are absent, nor that a delayed operation cannot still create one.
Injected-reconstruction tests demonstrated the missing-scope problem.

Related inspection found runtime ownership markers without complete directory-flush
ordering and state-directory allocation that needed explicit ownership publication.
These are distinct durability defects; neither logically mandates automatic recovery.
See [runtime ownership](../packages/sandbox/src/runtime-ownership.js) and
[native state storage](../packages/hosted-agent/src/session-state-storage.js).

Host inspection found broad startup cleanup in endo-host `modules/endo-daemon.nix`:
port/UID-based process killing, socket deletion, mount-prefix lazy unmounts,
ownership-marker/file-store deletion, and container-name-prefix removal.
Their existence is not evidence that they are safe or that every old worker escapes.

## Evidence and its limits

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| Six injected reconstruction cases | Missing/rejected original scope closure must block stop acknowledgement and destructive follow-up | Real worker loss, OS process containment, or successful automated recovery |
| 27 native-state tests and four subprocess SIGKILL cases | Ownership publication/recovery at tested filesystem boundaries | Physical power loss or producer shutdown |
| 39 runtime/ownership cases | Flush ordering and failed-release retry behavior | Automatic orphan adoption/removal |
| Formula disposal/drain tests using actual daemons | Tested same-formula replacement cannot overlap admitted writers | Cross-worker exclusion or persistent recovery after daemon loss |
| Draft producer core: 20 tests under four SES configurations | Injected lifecycle ordering and filesystem append-store behavior | Integrated producer, host privilege safety, or deployment readiness |

Read-only Tokyo snapshot on 2026-09-21: `endo-daemon.service` was active, main PID
62866, with `KillMode=control-group`, `Delegate=yes`, and control group
`/system.slice/endo-daemon.service`.
Observed workers, conmon processes, and active Codex/OpenCode container processes
were under that group or its descendants, including conmon reparented to PID 1.
One Podman pause process was outside it in an SSH session scope; its ownership and
recovery significance were not determined. No processes were stopped for this check.
This snapshot supports investigating existing whole-daemon containment before adding
a new boundary. It is not exhaustive or a shutdown/crash experiment.

## Commit disposition

These commits are already on the working PR branch; no landed producer architecture
was found that needs moving or reverting.

| Commit | Keep in #1248 because | Availability/acceptance cost |
|---|---|---|
| `0d66bd945` | Refuses false cleanup success; requires original sandbox closure before mount reclamation | Missing sandbox **or broker** scope can block stop/delete/restart even if processes appear gone |
| `64b1de584` | Flushes runtime ownership publication/release and avoids deleting a successor marker on retry | Crash/uncertain flush can strand a marker until explicit proven retirement |
| `baecab949` + `40ba9133b` | Inode-bound unique native allocations and their SIGKILL regression evidence prevent unsafe adoption | Breaking storage format needs deliberate retirement/reset, not an implicit migration |
| `cef5de259`, `d54eef291` | Formula disposal/collection and factory drains prevent replacement overlap | Failed/hung disposal may block replacement; not native process-loss recovery |
| `e9478d846`, `ce8ba0a10` | Member and oracle retirement drain their tested admitted work | No claim of cross-worker credential exclusion |

Independent commit review recommended keeping these corrections.
Reverting them would restore unsafe ownership/acknowledgement behavior, not merely
remove an optional feature. Keep their associated dependency and regression changes.
Public declaration fixes in native-controller files are also unrelated to the redesign.

## Preserved prototype, not a selected implementation

Tracking branch: `codex/native-recovery-research`.
Draft tracking PR: [#1323](https://github.com/endojs/endo-but-for-bots/pull/1323).
It is a draft PR/branch pair serving as an issue-like tracker, not a merge candidate.
It is stacked on the #1248 branch to avoid presenting the whole refactor as its diff;
rebase it after #1248 merges before any implementation proposal is reviewed.

These previously uncommitted files and the two associated package exports are preserved
only on that branch:

- `packages/sandbox/src/native-producer-lifecycle.js`
- `packages/sandbox/src/native-producer-store.js`
- `packages/sandbox/src/native-producer-worker.js`
- `packages/daemon/src/fixed-worker.js`
- The two `native-producer-*` lifecycle/store test files under sandbox tests.
- The daemon fixed-worker and sandbox native-producer-worker export additions.

The lifecycle/store received bounded independent review; worker/bootstrap code is
incomplete and unverified. No root helper or Nix implementation landed, and none of
the prototype was deployed. The draft may be discarded entirely after research.
Its cumulative full-history admission records have scaling costs; tests do not justify
adopting its storage format as a durable production contract.

The proposal grew to include a root-managed service, fixed worker authentication,
immutable release provisioning, controller relocation over CapTP, per-incarnation
runtime/listener composition, and changes to cgroup/mount handling.
Subprocess-only routing was found insufficient because 9P/MCP/listener servers also
have effects inside their worker. This expansion explains why implementation stopped.

## Alternatives to compare before selecting a design

| Alternative | Benefit | Cost / unresolved requirement |
|---|---|---|
| Fail closed + operator-assisted retirement | Least new code and no new privileged protocol | Downtime and explicit recovery; needs a verified procedure, not blind deletion |
| Verified whole-daemon/worker containment | Reuses an existing boundary and may permit coordinated restart | Other sessions interrupted; prove placement, late-start exclusion, and exact residual cleanup |
| Per-session producer services | Potential independent crash recovery and stronger session attribution | New host protocol, auth, journals, process topology, release management, and portability burden |

The interim operational policy is the first row, with the second investigated before
the third. None is a proof merely because a unit is inactive or a container name matches.
Different failure classes may need different responses: graceful cancellation,
single worker crash, daemon crash, host reboot, and storage-write uncertainty.

## Research plan and decision gates

1. Agree on required availability: must one session recover without disturbing others?
   Separate safety requirements from convenience and operator-time goals.
2. Reproduce the failure in an isolated disposable environment. Trace worker, Podman,
   conmon, network helpers, mounts, sockets, and pending starts across each failure class.
   Record effective service settings and actual cgroup placement, not only parent PIDs.
3. Test existing containment before proposing replacements. Include orphaned helpers,
   delayed RPCs, queued starts, process reparenting, and an unrelated session/control.
   Establish what prevents future creation *after* cleanup evidence is collected.
4. Define exact residual-resource ownership and safe operator retirement boundaries.
   Directory existence, names, PID reuse, inaccessible paths, and unacknowledged writes
   must not authorize deletion. Exercise retry without touching unrelated resources.
5. Compare measured complexity/operational cost of the alternatives. Investigate
   delegated cgroup escape/placement and kernel-9P mount privileges specifically.
   The existing unrestricted sudo mount surface must not become an unnoticed new API.
6. Only if a new service is justified, review its root-owned configuration, immutable
   release identity, authentication, one-shot activation, delayed-start fencing,
   operation-ID/payload binding, and separation from shared renewal owners.
7. Define the relationship between Endo formula state and external recovery state:
   which owner is authoritative, how uncertain replies recover, and what happens when
   either journal survives without the other. Preserve capability attenuation.
8. Produce a reviewed design decision with acceptance tests, portability requirements,
   operational runbook, migration/reset policy, and rollback before implementation resumes.

The follow-up is complete when a proportionate policy/design is selected and verified
against these failure classes—not when the preserved prototype happens to pass tests.
No implementation estimate or critical-path commitment is assigned before this decision.

## Prompt

> Make a dedicated document about this problem, its discovery, known facts, and
> research needed next. Decide how the current PR can continue without solving all
> of it. Preserve unsuitable work in a draft tracking PR if useful, and reference it.
