# M6 interface contract: environments (containers and git workspace)

Unit W6.0 of the M6 milestone (`milestones.md` M6), settled against the cross-check WX.0
(journal J-1410..J-1417, issues X-01..X-17) and the step-3 structure (unit W6.0 settle, journal
J-0813..J-0816). This file and `guest/lib/guards/environments.js` (the new resource's guards,
shapes, bounds and texts; moved from `resources/environments/interfaces.js` at the settle, X-11)
are the contract the M6 builders (W6.1-W6.6 in parallel after the cross-lane seam unit WX.1, then
W6.7) build against without talking to each other. Where this file and the guard file disagree,
the guard file wins and this file is wrong: report it. Paths: `H/` = `packages/thixotrope-harness/`,
`AH/` = `H/resources/agent-host/impl/`, `EV/` = `H/resources/environments/` (new), `EVI/` =
`EV/impl/`, `EVG` = `H/guest/lib/guards/environments.js`.
Spec items are `P-n`, `R2-n` .. `R8-n`, `A.n` of `endo-harness-spec.md` (outside the repository;
its deployment details are never copied here); "architecture n" is `designs/architecture.md`
section n; "Mk n" is `mk-interfaces.md` section n; "step 3" is
`designs/arch-review/step3-plan.md` (written in the `endo-thix-clean` lane; the plan read at
`53a8dbb9ea`, the code as built read at `cecfa12809`: `runtime-parts.js`, `turn.js` `claim`/
`claimNext`, `session.js`, `queue.js` `sendNow`, `export.js`, `tool-table.js`, `tools/exec.js`
`abandon`, `factory/delete.js`, `factory/factory.js`, `factory/services.js`); "WX.1" and "WX.F" are
the PM's cross-lane seam unit and group fold (X-02, X-17). Fae, exo-shell, exo-git and agent-tools sources are read at `1315bef86`
(`git show 1315bef86:<path>`); `@endo/git` and `@endo/exo-git` are workspace packages of this
checkout. Journal: J-0810..J-0829 is the contract's (W6.0: J-0810..J-0812; settle: J-0813..J-0816;
J-0817..J-0829 kept for the PM and the fold); build units W6.1..W6.8 use the ranges the PM assigns
(section 8).

M6 runs in parallel with M8 (compaction, images), M9 (mail, subagents) and M11 (voice), each in its
own lane. Everything here is shaped so the four lanes meet only at the seams of section 6.

Contents: 0 measured inputs; 1 scope; 2 decisions; 3 objects and interfaces; 4 sequences; 5 the
adapter; 6 seams and merge hotspots; 7 what persists and what a SIGKILL leaves; 8 work units; 9
acceptance; 10 performance; 11 too-big and hostile probes; 12 core requests; 13 owner questions;
14 the fold at merge; 15 fixed texts and code blocks for the shared guard modules.

---

## 0. Measured inputs (what the numbers below are derived from)

| input | value | source |
|---|---|---|
| vat -> adapter -> vat, answered | 70-76 ms | J-0161, J-9043 |
| adapter hop through the hub, no vat | 20-25 ms | J-0161, J-9043 |
| a call through a manager vat to its adapter and back (`Backend.open`) | 164-175 ms; first open (adapter process build) 0.83-1.13 s; after restart 151-163 ms | J-0222 |
| one manager crank on a hot path | about 75 ms | J-0494 |
| a trivial guest-to-guest call after CORE-11 (session -> exec -> session) | 53 ms | J-9382 |
| inbound bytes into a vat | about 10 us per byte; 24 KiB in 312 ms | J-0193, fact 2 |
| a handle crossing into or out of a vat | 7-15 ms | X-CLOSE (architecture 6) |
| vat frame ceiling the harness serves | 65,536 bytes per encoded frame (CC-027 at 50 M) | J-10125, J-10126 |
| `frameBytes` / `inlineBytes` / `blobPieceBytes` / `blobPageBytes` | 24,576 / 8,192 / 12,288 / 20,480 | `guest/lib/limits.js` |
| create a vat | about 4.4 s cold; a spare take 157-176 ms; `session.create` with the pool 849-864 ms | J-9045, J-9382 |
| healthy restart to serving | 3.3-6.9 s (median 4.1 s), 0 idle vats woken | J-9382 |
| install rate of a bundle | 11.6 s for 300 k ASCII characters | J-0193 |
| session program | 212,483 of 240,000 bytes on the step-3 tree (27,517 left for M6, M8, M9, M11) | J-1410 |
| existing session modules, comment-stripped | `packages.js` 2,312; `tools/mentions.js` 4,671; `tools/exec.js` 5,757; `tools/granted.js` 6,129 | J-1410 |
| a call frame over the vat ceiling | refused by the hub before it is journaled (`FRAME_TOO_LARGE`), the next turn served; measured for a call into a vat, not yet for an answer | J-10126, J-10127 |
| a cold create, per KB of session program | about 20 ms | J-10192 |
| spawn of `/usr/bin/true` from Node | median 1.02 ms, p95 1.37 ms (n 200) | J-0811 (this unit; load 7.6) |
| `git status --porcelain=v2` on a 10,000-file repository, 30 modified, 2 untracked | median 30.1 ms (n 30) | J-0811 |
| `git log` 50 entries of 1,002 commits | median 11.8 ms (n 30) | J-0811 |
| a command writing 10 MiB to stdout, drained | median 329 ms (n 5) | J-0811 |
| paging 1 MiB between two adapters through the hub in 20,480-byte pages | 0.74-1.5 s; hub log +2.9-3.0 MB per MiB | spike-data-references 1 |

Docker is installed on this machine but its daemon was not running at the time of writing (no
socket); podman is absent. No container number in this file is measured: every container budget
is marked `[real-runtime]` and recorded by the owner's run.

---

## 1. Scope

### 1.1 What M6 delivers

| P / R | what M6 builds | left to |
|---|---|---|
| P-19, R3-40, R3-240, R3-246..R3-248 | a per-session git workspace on branch `main` with one empty initial commit; the `Git` writer facet bound in the session as `workspace` (exec code calls it, R3-40), its read-only facet, no rewrite or remote methods; `SourceReader.read` over the worktree (M5's `readSources`); `openImage(path)` on both facets for M8's `viewImage` (seam X-1, R3-30) | linked worktrees, tree views, the commit stream, `show`, `revParse`, `detach`, `checkoutConflict` (owner question O-7) |
| P-18, R2-7, R3-37, R3-44..R3-47, R3-266, R7-9, R7-36, R7-39 | a per-session container: rootless, unprivileged uid, capabilities dropped, read-only root, no new privileges, `/workspace` = the session's live workspace, a persistent home, no network; `runCommand` and `inspectShell` model tools; the `Shell` bound as `shell` for exec code | public egress and network policy (M7) |
| P-55, R8-41, R8-42 | image pinned by digest, never pulled; the adapter refuses to run anything when the pin is not a digest or the image is absent; a check function M12's service start calls | building the image (out of band, R8-41) |
| P-47, R4-8, R6-50, R6-57, R7-65 | emergency stop and resume on shell sessions: fence, hold, stop, withdraw, survive restart; resume leaves the queue held | - |
| P-12 (shell part), R4-7, R4-49 | cancel stops the environment | - |
| R4-81 (improved, D-16) | a failed stop is retried at the next adapter start and before the environment runs again; the session is not quarantined | - |
| P-20 (shell presets), R3-12..R3-15, R3-21 | `development`, `voice` (workspace and shell), `new-project` (workspace), `general` (either, as selected) become available once the runner is configured | `general`'s shell "because internet is on", `new-project`'s shell while internet is on, the default preset `general` (R3-20): M7; `full-control`: open decision 5 |
| R6-57, R6-50 UI | Settings: "Sandbox execution" status, Emergency stop, Resume | - |
| W-12 | memory, process and CPU limits on each container (configurable) | - |
| G-29 | workspace and home released with the session | - |

Deferred, stated (X-12): R3-10 (presets that turn public internet on) is M7; R3-16
(`full-control`) waits for open decision 5. Cross-lane items only the group fold can prove (WX.F):
the complete `voice` preset (R3-13: M6's objects and M11's pin), `viewImage` of a workspace path
(R3-30: X-1 with M8), a subagent of a shell preset getting its own workspace and shell (R4-70: M9's
child creation runs M6's service builder), and mail delivered to an emergency-stopped session
(D-M6-20).

### 1.2 Departures (journal J-0812)

- R3-46 keeps home "until an administrator disposes of it"; M6 deletes home with the session (the
  operator's delete is that disposal; G-29). Owner question O-3.
- R4-81 quarantines a session whose environment stop failed; M6 retries the stop instead (D-16,
  architecture 3.4). Owner question O-6.
- R7-39 says Endo sets no memory, process or CPU limit [inferred]; M6 sets configurable ones (W-12).
  Owner question O-4.
- `runCommand` takes no stdin (A.3 has none); architecture 3.4's `stdin?: Blob` is dropped.

---

## 2. Decisions (D-M6-n)

**D-M6-1. One native resource, `environments`, holds both the git workspace and the container
runner.** Directory `EV/` (`durable.js`, `ephemeral.js`, `interfaces.js`, `impl/`), installed as
`environmentsAdmin`. Reason: a container's `/workspace` *is* the workspace directory; in one adapter
process the runner finds a session's workspace from the `Git`/`EnvironmentControl` presence it
was handed (a `WeakMap` within the incarnation, D-7 (d)) and no path or key ever crosses between
processes or through a vat. Rejected: (a) two resources (`workspace`, `containers`, as architecture
1 and 3.4 drew them): the containers adapter would need the workspace's host path from another
process, either through a manager vat (a host path in a vat's heap and journal) or by a key both
adapters resolve against a directory layout they each guess from `argv` (HR-SYN-22 twice); two
installs, two attach sinks, two restore orders at start. (b) Inside the agent-host resource: every
change would be an agent-host manager reinstall (T6), and container processes would share the
agent-host's blast radius. Cost of the choice: M10's asset listener and M7's egress proxy live in
this adapter process too (paths in section 6.4).

**D-M6-2. Identities in the manager vat, data in the adapter; the key never leaves them.** The
manager mints, per environment, a record keyed by a counter key `e<n>` (like blob keys `b<n>`,
architecture D-15) and exos for it: `Git` (writer), `GitReader`, `Shell`, `EnvironmentControl`.
The record is found from any of them by a manager-side `WeakMap` (rights amplification, the
agent-host idiom). The key travels manager -> adapter only, where it names a directory and a
container (F.2 c: where a reference leaves the object system). The factory holds no admin facet
per session: it releases an environment by handing the manager the session's own `Session` (after
`bindSession`) or its `EnvironmentControl` (rollback), which the manager amplifies.

**D-M6-3. Everything is lazy; the registration is one service key.** `provide()` is one manager
crank and touches no disk (no adapter call). The workspace directory and repository are made on
first use (a git call or a command), behind a ready marker; the container starts on the first
command and stops after `idleStopMs` (D-16). There is no registration per environment: the kit's
`restore` re-binds only the service key, so restart cost is independent of how many sessions have
environments. The adapter's `bind` stops every container this state owns (left by a SIGKILL) and
asks the manager for the stops and releases it still owes (`EnvironmentsSink.attach` answers
`PendingWork`). Configuration (runtime, image pin, allowlist, limits) is data the operator gives
`EnvironmentsAdmin.configure`; the manager keeps it and puts it in the service key's spec, so every
adapter incarnation receives it in `bind` (the core has no install-time configuration, AR-SYN-28;
CC-091). Changing it re-registers the key and the adapter rebinds.

**D-M6-4. Commands on the turn path go through a per-incarnation `ShellPort`; exec code's calls
go through the manager.** The session's environment part opens `E(control).port()` once per
adapter incarnation (one manager crank, 151-175 ms, J-0222) and sends each `runCommand` tool call
straight to the adapter (vat -> adapter -> vat, 70-76 ms, J-9043), as the turn's `TurnPorts`
(contract 6.1). The `Shell` and `Git` exos bound as labels are durable manager objects (labels
outlive restarts); their calls are forwarded through the manager (two manager deliveries per
call). Rejected: every command through the manager (two manager cranks, about 150-175 ms per
command against a 150 ms overhead budget, and the manager on the per-command hot path, contrary to
D-7); an adapter-side `Shell` bound as a label (a tombstone after every restart).

**D-M6-5. A break from the environments adapter is the command's unknown outcome, never a
restart signal.** The environments adapter is not the turn's adapter: it can exit and be rebuilt
alone, while the agent-host lease and the provider stream live on. So the shell tool catches a
retired break from its `ShellPort` itself and answers `{ status: 'failed', text:
texts.commandOutcomeUnknown }`; it drops the port (the next call reopens) and never calls
`recoverAfterRestart`. Its tool-table `site` is `'guest'` (a retired break is not a restart; the
entry never lets one reach `turn.js` anyway). At a daemon restart the lease break arrives too and
recovery settles the turn; whichever arrives first, the transcript says the command's outcome is
unknown. A write through the manager-forwarded `Git`/`Shell` whose adapter call breaks is not
retried (a commit is not idempotent): the manager rejects with `environmentTexts.outcomeUnknown`;
reads are retried once after reattaching, as the agent-host's `withOps` does. Rejected: site
`'adapter'` (would run whole-turn recovery and drop live agent-host ports when only the runner
restarted).

**D-M6-6. Output is bounded per field in the adapter and staged through the agent-host's
writers.** The tool path answers the A.3 JSON `{stdout, stderr, exitCode, signal, truncated}`: each
stream kept to 64 KiB (R3-47), then cut per field so the JSON is at most `toolOutputUnits` (32,768)
UTF-16 units with the R4-46 marker inside each cut field (fixes G-19; algorithm 5.5). A JSON text
over `inlineBytes` is staged through the `BlobWriters` the session passes with the call
(`TurnPorts.writers`, agent-host adapter objects): pieces of at most `blobPieceBytes`,
adapter-to-adapter through the hub (20-25 ms each, at most 8 pieces for a 98 KB worst case), then
`close()` answers the `StagedText` the result carries. Staged model arguments are read through the
`Content` passed with the call. The exec path answers `CommandResult` records whose streams are
cut to 2,560 units each (fits `answerBytes` 16,384). No byte of output enters a vat beyond the
bounded text or the staged handle. **Spike seam:** all reads and writes of agent-host blobs go
through one adapter module, `EVI/blob-access.js` (`stageText(text, writers) -> StagedText`,
`readStaged(staged, content, maxBytes) -> string`). If the owner adopts the data-reference spike's
step 1, that module's backing changes to the blob store directory and the resolve amplifier carried
in the service spec (`spike-data-references.md` 1, row 1a: `locate(blob) -> { file, length }`), and
nothing else changes; M6 works without it.

**Data between two adapters is one design with M8 (X-06).** Two directions cross from this
adapter to the agent-host adapter: staged command output (pushed through `BlobWriters`, above) and
workspace images (pulled by M8's image tool through an `ImageSource` this adapter answers, seam
X-1: `Git.openImage(path)`, section 3.4). Both are the case the spike's step 1 names (the
workspace and containers adapters given the blob store directory and an amplifier). Until the owner
adopts it, both lanes accept its measured cost (+2.9-3.0 MB of hub log per MiB paged between
adapters, spike 1; at most 98 KB per command here, at most 2 MiB per image in M8), and CC-100 (M8's
request, policy for persisted adapter frames in core step 3) is asked once for both (section 12).
If adopted, `blob-access.js` and `EVI/image-source.js` are the two modules whose backing changes;
the image source then answers `locate()` instead of pages, and nothing on the vat side changes.

**D-M6-7. Host-side git through `@endo/git`'s native backend.** `EVI/git.js` drives
`makeNativeGitBackend` (with `makeGitOperations` from `@endo/exo-git` where it fits) over the
session's workspace directory. That backend already neutralises what a container-written
`.git/config` could make the host run (hooks, fsmonitor, attributes, filter and merge drivers,
includes; `packages/git/src/native-git-backend.js` `GIT_BASE_ARGS`, `EXECUTABLE_REPO_CONFIG`,
`makeGitEnv`), which matters because the container writes the same `.git`. Answers are rebuilt as
this resource's closed records (fixed keys; paths are values) and cut to `answerBytes`. Branch and
revision names are checked before git sees them (no leading `-`, `git check-ref-format`), paths are
relative, may not leave the worktree or name `.git`. Rejected: running git inside the container
(the `Git` capability must work for `new-project` sessions that have no shell, and without starting
a container).

**D-M6-8. One runtime contract, three drivers.** `Runtime = { kind, check(settings) -> { ok,
reason? }, start(env) -> undefined, exec(env, argv, { timeoutMs, onSpawn }) -> RawResult,
terminate(env, handle, signal), stop(env), sweep(stateTag) -> { stopped }, running() -> count }`
(section 5.3). Drivers: `fake` (`EVI/runtime-fake.js`: host child processes in the workspace
directory under the session's home as `HOME`, a scrubbed environment, each command in its own
process group recorded under `run/`, swept at start; **not a sandbox**), `podman` and `docker`
(`EVI/runtime-oci.js`, one module, the binary and two flags differ). Every acceptance item is
provable with `fake` except the isolation properties, marked `[real-runtime]`.

**D-M6-9. Emergency stop is the session's environment part's state, withdrawn where each
authority lives, and exported.** The session keeps `running | stopping | stopped` in its
`environment` runtime part (heap; survives a daemon restart because the vat does); the manager
keeps `stopped` on the environment record and refuses every `Git`, `GitReader`, `Shell` and
`EnvironmentControl.port` call while it is set. The adapter-side objects (`ShellPort`, the
`ImageSource`s of `openImage`) are refused in the adapter: `E(ops).stop(key, { withdraw: true })`
marks the key withdrawn, `E(ops).resume(key)` clears it, and `attach` answers the withdrawn keys in
`PendingWork.withdrawn` so a new incarnation refuses from its first call. Export and import (X-07;
step 3 2.3 forbids part state that must survive export): the export's head page carries
`execution` (seam X-E) and an import feeds it back to the part, which re-applies the hold `stopped`
and sends `emergencyStop` to the imported session's new environment (4.5). Rejected: a record kind
for the execution state (a record per stop and resume in the turn log, read back at every start,
for one value the export carries anyway). Sequence in 4.5.

**D-M6-10. The resource's guard table is a per-vat guard module, `guest/lib/guards/
environments.js` (`EVG`), excluded from the gateway vocabulary** (settled from X-11 (a); the owner's
rule puts interface guards in `guest/lib/guards/` or in a Node-only module listed in
`vocabulary-tables.js`). Its readers are the environments manager vat (a vat program, so the module
keeps prelude globals only) and its adapter; no harness vat program bundles it, and the gateway never
reaches these objects. Seam V-1: one line in `vocabularyExclusions` (`'guards/environments.js':
'environments manager vat and adapter table; no browser path reaches these objects'`), and WX.1
changes `gateway-vocabulary-tables.test.js` once so that an excluded module marked not
browser-sendable does not have to contribute its names (the same change makes M8's
`image-guards.js` exclusion unconditional). Rejected: (a) beside the resource
(`resources/environments/interfaces.js`, the W6.0 draft: outside the rule); (b) listed in
`vocabularyTables` (about 60 names no browser sends join the gateway pin). The session- and
factory-side entries go into their vats' guard modules (section 15). Owner question O-8.

**D-M6-11. The per-session job is one runtime part, `environment`** (step 3 2.4 suggests the name
`workspace`; `environment` is the concept the part owns: shell port, running commands, execution
state, cancel and recovery hooks; the workspace itself is only a label it seeds). The name is
`environment` in every lane (X-04: the part, `runtime.environment`, the service key
`SessionServices.environment`, `PartName`); `workspace` is only the label of the `Git` writer. Its
tools are static tool-table entries reaching `context.runtime.environment`.

**D-M6-12. Factory wiring by settings and static tables, no per-session factory state.** The
operator attaches the installed admin to the factory as a setting (`HarnessRoot.configure({
environments })`, provisioning step `60-environments.js`), so an existing factory needs no
reinstall and a state without environments simply has none. The preset template providers ask the
setting; the services builder calls `provide`; a binder sends `bindSession` after `make`; a releaser
releases on rollback; a delete hook releases by `Session`. Each is an entry in an existing static
table (step 3 2.2: factory tables stay static), except the delete hook, which the factory kit hands
to `makeDeletions` with M9's (D-M6-16).

**D-M6-13. The manager is thin and changes in one batch per group.** `EV/durable.js` keeps
identities, the settings, the pending-work list and the withdrawn set; policy (path rules,
allowlist checks, cuts) is in the adapter (T6). M7 and M10 add their manager methods in the next
group's single batched change of this manager (rule 5). The forward-and-reattach helper (the agent
host's `withOps`, about 40 lines) is not copied (X-16, review rule 3): W6.1 writes it once as a new
concept-named module, `resources/native-attach.js` (`makeAttachedOps({ reconcile, isRetired })
-> { withOps(fn, { write }), attach(ops), current() }`), which `EV/durable.js` imports and the agent
host adopts at its step-4 reinstall (its manager part is installed code; section 14).

**D-M6-14. No host path reaches any vat.** `inspect` answers allowlist, timeout and cap only
(A.3); errors from git or the runtime are rewritten by the adapter to texts without the state path
(acceptance 17 greps every vat's heap, journal and snapshot for the state directory path).

**D-M6-15. Shared seams are WX.1's, not a lane unit's (X-02, X-03, X-04).** Every entry M6 adds
to a shared guard module (section 15: `guards/session.js`, `guards/factory.js`,
`guest/lib/interfaces.js`, the vocabulary exclusion) and the part-API additions (`PartHooks.admit`
and its fan-out in `combineHooks`) are applied by the cross-lane seam unit WX.1 in one commit for
the four lanes, which also rebases `guards-split.test.js` and the vocabulary pin once. The W6.0
draft's own "first, alone" unit W6.0b is withdrawn: it is "done by WX.1". The order WX.1 records,
and M6 relies on: parts `powers, inspector, grants, exec, packages, environment, compaction,
inbox, subagents`; static tool entries after the package entries `runCommand, inspectShell`, then
`viewImage`, mail, requests, subagents. M6's own edits in shared files are then single lines
(section 6).

**D-M6-16. Delete hooks are handed to `makeDeletions` by the factory kit, unchanged signature
(X-05).** The built `makeDeletions({ admin, rows, starts, hooks = onDelete })` calls each hook with
`{ row, session }`. The factory passes `hooks: harden([subagents.deleteChildren, ({ session }) =>
releaseEnvironment({ session, settings: harnessSettings })])` (children first, so a child's
environment is released by its own delete; settings by closure, an object, not a context field).
The W6.0 draft's F-4 (a `settings` parameter and a `{ row, session, settings }` context) is
withdrawn. Rejected: the static `onDelete` table (it cannot close over the factory's settings).

**D-M6-17. One per-part call table (X-08).** The part's in-flight shell calls use the bounded
call table WX.1 exports from `tools/exec.js` or a module beside it (settle all calls of a turn
with a text, quietly or not; ignore late answers), not a third copy of exec's `abandon`. The part
keeps only its port and execution state of its own.

**D-M6-18. M6's session program share is a cap the PM sets after the owner's ruling (X-01).** On
the step-3 tree 27,517 bytes are left for four lanes. M6's estimate, from the stripped sizes of the
nearest peers (J-1410): the part about 4.5 K (exec's part and calls 5.8 K, less the shared call
table), the two tool entries about 1.2 K (as `tools/mentions.js` entries), the texts, shapes and
the two tool descriptions in `guards/session.js` about 2.5 K, the export and queue lines 0.3 K:
about 8.5 K, so M6 asks for at most 9,000 bytes. W6.4 starts only after the PM has set the per-lane
caps; its bundle check uses M6's cap, the group fold measures the sum (WX.F).

**D-M6-19. Exec-path git answers are hardened twice: a known cost (X-16).** A `Git`/`Shell` answer
through the manager (up to 16 KB) is decoded and hardened in the manager vat and again in the exec
vat (about 165 ms each at 10 us/B, J-0193). Accepted for M6: the exec path is not the turn path,
and the manager checks every answer's shape before it passes it on (D-M6-5). A probe of answer
forwarding (the manager returning the adapter's answer promise without awaiting it) is optional
work for W6.1, measured in `environments.gitStatus`; it is adopted only if it keeps the shape check.

**D-M6-20. Mail and turn sources wait while a session is stopped.** `admit()` refuses the
user-facing starts (`enqueueOnce`, `enqueueMessageOnce`, `startTurn`, `QueueEntry.sendNow`) and
`claimNext` claims nothing while it refuses (seam R-2), so a turn source (M9's inbox `nextTurn`)
never starts a turn. A delivery to a stopped session is not refused: the inbox keeps it under its
own bound and it starts after resume and release. WX.F proves it (X-12).

---

## 3. Objects and interfaces

Guards: `EVG` (`guest/lib/guards/environments.js`) `environmentInterfaces`, shapes
`environmentShapes`, bounds `environmentLimits`, texts `environmentTexts`/`environmentTextOf`. Session and factory entries:
section 15. "Heaviest crank" is the crank in the named vat with the most work per call.

### 3.1 Map

```
factory vat ──provide/bindSession/release/releaseSession──> environments MANAGER vat
   │ builds SessionServices { workspace: Git, shell: Shell, environment: EnvironmentControl }
   v
session vat ── part `environment` ──E(control).port()──> manager ──> adapter ShellPort (per incarnation)
   │   runCommand / inspectShell tools ───────────────────────────────> ShellPort (direct)
   │   onCancel: E.sendOnly(control).stop()          emergencyStop/resume: control
exec vat ── model code: E(workspace).status(), E(shell).runCommand(...) ──> manager ──> adapter ops
environments ADAPTER (Node): workspaces, git (@endo/git), runner (fake | podman | docker), output, blob access
   └── agent-host BlobWriters / Content (adapter to adapter, for staged results and arguments)
```

### 3.2 `EnvironmentsAdmin` (manager vat; inventory `environmentsAdmin`)

| method | caller | crank | mode | largest message | retired break means | heaviest crank |
|---|---|---|---|---|---|---|
| `configure(EnvironmentSettings) -> EnvironmentsStatus` | provisioning step `60-environments.js` (control client) | manager: store settings, `manager.register(SERVICE_KEY, { sink, settings })`, await reconcile | answered | settings: 32 names x 64 units, < 7 KB | the manager vat is lost (guest): fail provisioning | the reconcile (adapter bind: image check, sweep) |
| `status() -> EnvironmentsStatus` | provisioning, tests, M12 diagnostics | manager, forwards to ops when bound | answered | < 1 KB | as above | one ops hop |
| `provide({ workspace, shell }) -> EnvironmentKit` | factory services builder (creation) | manager: mint record `e<n>` and 2-4 exos; refuse when unconfigured or full | answered | answer: 3 handles, < 300 B | as above (the creation fails and rolls back) | minting 4 exos (record bounded by `maxEnvironments`) |
| `bindSession(control, session)` | factory binder, after `make` | manager: record.session = session; `sessionOf` `WeakMap` | sendOnly | 2 handles | - | trivial |
| `release(control)` | factory releaser (rolled-back creation) | manager: mark released, refuse calls, queue release; forward `E(ops).release(key)` | sendOnly from the factory | 1 handle | - | one ops hop |
| `releaseSession(session)` | factory delete hook | as `release`, found by the session | answered (the delete waits) | 1 handle | as above: the delete record stays at its step and resumes at the next start (M2 7.1) | one ops hop |

A release is idempotent; a release whose adapter call failed stays in `pendingReleases` and is
re-sent by the next `attach`. A released record is dropped from the manager once the adapter
answered `released([key])`.

### 3.3 `EnvironmentsSink` (manager) and `EnvironmentsOps` (adapter)

The D-7 attach pattern of the agent host, with the work a new incarnation owes:

| method | caller | crank | mode | largest | notes |
|---|---|---|---|---|---|
| `EnvironmentsSink.attach(ops, incarnation) -> PendingWork` | adapter `bind` | manager: keep ops, answer pending stops, releases and the withdrawn keys | answered | <= 3 x 1,024 keys, < 18 KB | the adapter then performs them and reports `stopped(keys)` / `released(keys)` (sendOnly); withdrawn keys are refused from the first call |
| `stopped(keys)`, `released(keys)` | adapter | manager: clear pending, drop released records | sendOnly | <= 1,024 keys | - |
| `EnvironmentsOps.git(key, { op, args })` | manager (from `Git`/`GitReader`) | adapter: one serial git operation per workspace | answered | answer <= `answerBytes` 16,384 | manager: reads reattach and retry once; writes reject `outcomeUnknown` |
| `runCommand(key, command, args, options) -> CommandResult` | manager (from `Shell`) | adapter | answered | 16 KB | write semantics: no retry |
| `inspect(key) -> ShellInfo`, `status()` | manager | adapter | answered | < 2 KB | read: retry once |
| `port(key) -> ShellPort` | manager (from `EnvironmentControl.port`) | adapter: one `ShellPort` per key per incarnation (same presence on a repeat) | answered | 1 handle | retry once |
| `openImage(key, path) -> ImageSource` | manager (from `Git.openImage`/`GitReader.openImage`) | adapter: path rules, `lstat` (a regular file inside the worktree, no symlink followed), mint an `ImageSource` exo over `(key, path)` | answered | 64 x 255 units in; 1 handle out | read: retry once |
| `stop(key, { withdraw? })`, `resume(key)`, `release(key)` | manager | adapter; `withdraw` marks the key refused for `ShellPort` and `ImageSource` calls, `resume` clears it | answered | tiny | idempotent: on a break the manager keeps it pending and answers its caller after one reattach-and-retry, or rejects |

### 3.4 `Git` and `GitReader` (manager vat; label `workspace` in the session)

Writer facet methods (`gitWriterMethodNames`): reads `status(options?)`, `diff(options?)`,
`log(options?)`, `branches()`, `currentBranch()`, `trackingStatus()` (upstream always `null`,
R3-248), `stashList()`, `read(SourceReadRequest)` (M5's `SourceReader`: Fae's `readSources` item
rules, worktree only), `help(method?)`; writes `add(paths)`, `restore(paths, { staged? })`,
`commit(message)`, `createBranch(name, { startPoint?, switchAfterCreate? })`, `switchBranch(name)`,
`renameBranch(from, to)`, `deleteBranch(name, { force? })`, `merge(name, { mode: 'ff-only' |
'merge-commit', message? })`, `stashPush(message?)`, `stashPop()`, `readOnly() -> GitReader`;
and the read `openImage(path) -> ImageSource` (seam X-1, M8 `viewImage`, below).
`GitReader` has the read methods only; a write method does not exist on it (the guard refuses the
name), and the adapter also refuses writes for a reader's calls (`gitReadOnly`). No facet has any of
`gitAbsentMethodNames`.

| caller | crank | mode | largest | retired break | heaviest crank |
|---|---|---|---|---|---|
| exec vat (model code through the membrane), the inspector (`describeCapability`, `readSources`) | manager: refuse when stopped or released; forward `E(ops).git(key, { op, args })`; then the answer crank forwards to the caller | answered | argument: membrane bound 12,288 B; answer <= 16,384 B | from the exec vat's view the manager answers: a lost manager is the retired text (the scope fails the call); an adapter break is `outcomeUnknown` (writes) or retried (reads) | the answer crank: up to 16 KB inbound (about 165 ms at 10 us/B) |

Every answer is a closed record of `environmentShapes` with `truncated` and, for `log`, `next`. A
git failure becomes a rejection with git's first line of stderr, bounded to `reasonUnits` and with
the state directory replaced by `/workspace`.

**`openImage(path)` (X-1, R3-30).** Caller: M8's image tool in the agent-host adapter (the
descent of `viewImage` on the `workspace` label), or exec code. Manager crank: refuse when stopped
or released; forward `E(ops).openImage(key, path)`; the answer crank passes one handle on (2
manager deliveries, handles only: no image byte enters the manager vat). Mode: answered. Largest:
the path (64 segments of 255 units) in, one handle out. Retired break: as any read (retry once).
The answer is an **adapter-side** `ImageSource` (`EVI/image-source.js`, built with M8's
`image-guards.js` `ImageSource` guard): `size()` and `readBase64({ offset, maxBytes })` read the
file at each call (open with no-follow, `fstat`, the path rules re-checked, read at most
`maxBytes`), so a file changed between reads is read as it is, and a symlink swapped in is refused
(`gitPathRefused`). The source holds no descriptor and no table entry (its closure keeps the key and
the segments); it is refused after the key is withdrawn or released and is a tombstone after the
adapter restarts. Pages go adapter to adapter (M8 asks up to `readPageBytes` 196,608 bytes, about
262,144 characters per page). An exec-vat caller asking a page above the vat's frame ceiling is
expected to get the hub's frame refusal as a rejection, as a call frame does (J-10127); W6.7's probe
(section 11) confirms it for an answer frame. If an answer frame instead halts or hangs the exec
vat, the fallback is that every `ImageSource` page is clamped to `blobPageBytes` (M8's tool then
reads a 2 MiB image in about 103 pages, about 2.3 s at 20-25 ms per adapter hop, J-9043), recorded
as a contract change. Exec code reads images in pages of at most `blobPageBytes`.

### 3.5 `Shell` (manager vat; label `shell`)

`runCommand(command, args, options?) -> CommandResult`, `inspect() -> ShellInfo`, `help(method?)`
(exo-shell's interface with `exec` renamed, A.3). Callers: exec vat, inspector. Forwarded like
`Git`; `runCommand` is a write (no retry). `CommandResult` streams are cut to
`shellAnswerStreamUnits` (2,560) each; a non-zero exit is data; a timeout, an allowlist refusal or a
runtime failure rejects with the exo-shell text.

### 3.6 `ShellPort` (adapter; one per environment per incarnation)

| method | caller | crank | mode | largest | retired break | heaviest crank |
|---|---|---|---|---|---|---|
| `runCommand({ opId, args, writers, content? }) -> ToolOutcome` | session vat, the `runCommand` tool | session: the call is issued in crank D (or a later result crank, `callWindow`); the answer is one session delivery that records the result | answered | request: args inline <= 8,192 B or staged; answer <= 8,192 B inline or a `StagedText` | D-M6-5: the tool answers `commandOutcomeUnknown`, drops the port | the result crank: record the result, publish `tool_result`, issue the next call |
| `inspect({ opId, args, writers }) -> ToolOutcome` | the `inspectShell` tool | as above | answered | < 1 KB | as above | - |

The adapter parses the model's JSON (`args`, read through `content` when staged): closed keys
`command`, `args`, `options` (`timeoutMs`), Fae's refusal texts (`textOf.unexpectedArgument`,
`argumentsNotJson`), `command` on the allowlist, `args` an array of strings, `commandArgsBytes`.
Refusals answer `{ status: 'failed', text }` (the session renders `Error: ...`).

### 3.7 `EnvironmentControl` (manager vat; in `SessionServices.environment`, never a label)

| method | caller | crank | mode | largest | retired break | notes |
|---|---|---|---|---|---|---|
| `describe() -> EnvironmentInfo` | session (inspect, UI state), tests | manager | answered | < 200 B | guest: environment lost | - |
| `port() -> ShellPort` | session part, first command per incarnation | manager -> ops `port(key)` | answered | 1 handle | the command has not run: the part answers `environmentTextOf.runtimeFailed` for it and opens again at the next call | refused while stopped/released |
| `stop()` | session part `onCancel` | manager -> ops `stop(key)`; pending on failure | sendOnly from the session | tiny | - | kills running commands, stops the container; keeps workspace and home (R4-7) |
| `emergencyStop()` | `Session.emergencyStop`; an import of a stopped session (4.5) | manager: `stopped = true` first (withdraw in the manager), then ops `stop(key, { withdraw: true })` (withdraw in the adapter) | answered | tiny | the session stays `stopping`, the caller sees `stopIncomplete` | idempotent |
| `resume()` | `Session.resume` | manager: `stopped = false`, then ops `resume(key)` | answered | tiny | guest: environment lost | does not start anything |

### 3.8 Session vat (`environment` part, tools, `Session` methods)

Part `environment` (`guest/session/environment.js`), the `RuntimePart` signature of the built
`runtime-parts.js` (step 3 2.1, as built): `{ name: 'environment', make(runtime) ->
PartValue }`, `make` synchronous, sending and awaiting nothing; services read from
`runtime.services`; other parts reached through `runtime` getters at run time only.

```js
// environmentPart = harden({ name: 'environment', make: runtime => EnvironmentPart })
EnvironmentPart = {
  hooks: {
    onCancel(turn),   // HookTurn; send E.sendOnly(control).stop(); settle the turn's shell calls (commandStopped)
    onRecover(turn),  // settle the turn's shell calls quietly (recovery wrote the unknown results); drop the port
    admit(),          // PartHooks.admit (added by WX.1): texts.sessionStopped while stopping or stopped, else undefined
  },
  runCommand(request, ports, context) -> Promise<ToolOutcome>,  // the tool entries call these
  inspectShell(request, ports, context) -> Promise<ToolOutcome>,
  executionState() -> ExecutionState,            // { state, supported }
  beginStop() -> Promise<ExecutionState>,        // crank E1's part (4.5)
  resume() -> Promise<ExecutionState>,
  exportExecution() -> ExecutionState | undefined,  // seam X-E: undefined when running or unsupported
  importExecution(state) -> void,                    // seam X-E: crank of the head chunk (4.5)
}
```

State in the part's closure: `execution` (`'running' | 'stopping' | 'stopped'`), `port` (a
`ShellPort`, a promise for one, or `undefined`) and the part's call table (WX.1's shared table,
D-M6-17; at most `callWindow` 16 in flight, entries deleted when settled). No module-level state.
Without `services.environment` the part answers `supported: false`, its tools are unavailable,
`admit()` answers `undefined` and `beginStop` throws `texts.noEnvironmentToStop`. The part is in
`requiredParts` (the built `makeRuntime` refuses a table without a required part); a test that
passes its own `parts` adds `environmentPart` like the others.

Tools (`guest/session/tools/shell.js`, `shellToolEntries`, appended to `toolTable` right after
`packageToolEntries`, X-04): `runCommand` and `inspectShell`, `site: 'guest'` (every entry names
its site since HR-SYN-23; D-M6-5), `available(ports, services)`: `services.shell !== undefined &&
ports?.writers !== undefined`; `execute(request, ports, context)` calls
`context.runtime.environment.runCommand(request, ports, context)`; the descriptions are Fae's
(`shellToolDescriptions`, section 15).

`Session` gains (seam S-1, applied by WX.1): `emergencyStop() -> ExecutionState` (callWhen),
`resume() -> ExecutionState` (callWhen), `getExecutionState() -> ExecutionState` (call). Callers:
the browser (Settings, through the gateway's pass-through), tests. The session publishes `{ type:
'execution', state, supported }` in the crank that changes the state (seam S-3).

Label seeds (static table, seam L-1): `{ label: 'workspace', from: services => services.workspace
}`, `{ label: 'shell', from: services => services.shell }`.

### 3.9 Factory vat

`guest/factory/environments.js` (new) exports the entries the static tables take:

- `environmentProviders` (two `ObjectProvider`s, kinds `git-workspace` and
  `development-environment`): `available(context)` answers `undefined` when
  `context.settings?.environments()` is set, else `environmentTexts.runnerRequired` (R3-21).
- `environmentServices` (a `ServiceBuilder`): when the preset snapshot selects either kind, `await
  E(settings.environments()).provide({ workspace, shell })` and answer `{ workspace?, shell?,
  environment }`. One manager crank on the creation path.
- `environmentBinder({ services, session, settings })`: `E.sendOnly(admin).bindSession(
  services.environment, session)`.
- `environmentReleaser({ services, settings })`: `E.sendOnly(admin).release(services.environment)`.
- `releaseEnvironment({ session, settings })`: `await
  E(settings.environments()).releaseSession(session)`; nothing when no admin is attached. The
  factory kit hands it to `makeDeletions` as `({ session }) => releaseEnvironment({ session,
  settings: harnessSettings })`, after M9's `subagents.deleteChildren` (D-M6-16, seam F-4).
- `environmentPromptSections`: part 6 entries (seam P-1), Fae's workspace section
  (`fae/session/system-prompt.js:295-360`) adapted: no `worktree()`, `/workspace` named when the
  session has a shell.

The factory imports no environments guard: it holds the admin as a remotable and reads
`texts.runnerRequired` from `guards/factory.js` (section 15.2).

### 3.10 Manager internals (`EV/durable.js`, W6.1)

- One registration: `SERVICE_KEY = 'environments'`, spec `{ sink, settings }`; `same(a, b)` is
  true when the settings are equal field by field (then a reconcile only re-attaches), else the
  kit replaces the binding and the adapter rebinds with the new settings. Unconfigured: no
  registration, `status().state === 'unconfigured'`, `provide` refuses with
  `environmentTexts.notConfigured`.
- `records: Map<string, EnvironmentRecord>` by key (bounded by `maxEnvironments`), and
  `recordOf: WeakMap<exo, EnvironmentRecord>` for every exo minted (amplification), `bySession:
  WeakMap<Session, EnvironmentRecord>` after `bindSession`. `EnvironmentRecord = { key, workspace,
  shell, stopped, released, git, reader?, shellExo?, control }`.
- `withOps(fn, { write })` from `resources/native-attach.js` (D-M6-13, X-16): reconcile when no
  ops; on a retired break, reconcile once and call again only when `write` is false; a write
  rejects with `outcomeUnknown`. Every forwarded answer is checked against the op's shape
  (`mustMatch`) before it is passed on.
- `withdrawn`: the keys of records with `stopped` set (bounded by `maxEnvironments`), answered in
  `PendingWork.withdrawn`.
- `pending: { stops: Set<key>, releases: Set<key> }` (bounded by `maxPendingWork`); `attach`
  answers them; `stopped`/`released` clear them.
- No clock, no timers: idle stop is the adapter's timer.
- Its bundle imports `EVG`, `guest/lib/guards/base.js`, `guards/session.js` (the `SourceReader`
  shapes), `guards/images.js` (M8's path bounds, X-1), `guest/lib/limits.js`,
  `guest/lib/retired.js` and `resources/native-attach.js` only.

### 3.11 What the integration helper does (`test/integration/_environments.js`, W6.7)

`environmentsTemplate()` (the `ensureTemplate` options with `options.environments` and the pool),
`startEnvironmentSession(state, preset)`, `runCommandTurn(session, argv, options)` (a scripted
round whose tool call is `runCommand`), `execCall(session, code)`, `environmentProcesses(state)`
(fake groups under `<state>/environments/sessions/*/run/` that are alive),
`killEnvironmentsAdapter(state)` (SIGKILL of the process `adapterProcess(state, installation)`
finds; that finder is CC-092's workaround: the process under the supervisor whose argv names the
installation's ephemeral bundle digest, exported from `test/integration/_adapter-processes.js`
(new, W6.7) so M11's K11-1 engine check imports it instead of writing a second one, X-15), and
`stateHasPath(state)` (the D-M6-14 grep).

---

## 4. Sequences (crank by crank)

### 4.1 Creation of a `development` session

1. Factory crank (create): resolvers as in M5 2.3; `buildSessionServices` runs `environmentServices`:
   `E(admin).provide({ workspace: true, shell: true })` -> manager crank M1 mints `e<n>`, `Git`,
   `GitReader` (lazily, on `readOnly()`), `Shell`, `EnvironmentControl`; answer: one factory
   delivery.
2. `make(config, services)` as today; `SessionServices` carries three more handles (frame check
   unchanged).
3. After `mustMatch(made)`: binders run; `bindSession` is sendOnly (manager crank M2, off the
   creation path). Rollback (any failure after step 1): releasers send `release(control)`.

Cost: + one manager crank on the path (about 75 ms) + 3 handles into the session vat (7-15 ms each).

### 4.2 First command in an adapter incarnation

1. Crank D: the round's intents recorded; the `runCommand` entry's `execute` asks the part; the
   part has no port: `E(control).port()` (answered).
2. Manager crank: refuse if stopped/released; `E(ops).port(key)`; the adapter makes the `ShellPort`
   (no disk work yet); answer crank forwards.
3. Session crank: keep the port; send `E(port).runCommand({ opId, args, writers, content? })`.
4. Adapter: parse args; ensure the workspace (create, `git init -b main`, empty commit
   "Initialize workspace", ready marker) and home; `runtime.start(env)` if not running; exec;
   collect; bound; stage if large; answer.
5. Session crank: record the result (`tool-result`), publish, issue the next call.

Later commands skip 1-2. Deliveries per command: 1 session delivery (5), 0 manager deliveries.

### 4.3 Exec code calls `E(workspace).status()`

Exec vat -> (membrane) -> manager crank (refuse if stopped/released; forward) -> adapter (serial
queue per workspace; ensure workspace; `git status`; build `GitStatus`, cut to 16 KB) -> manager
answer crank -> exec vat crank. 2 manager deliveries per call.

### 4.4 Cancel (R4-7, R4-49)

`Turn.cancel()` crank: `onCancel` hooks in part order; the environment part sends
`E.sendOnly(control).stop()` and settles every shell call of the turn with
`texts.commandStopped` (failed) through its call table, which ignores late answers (D-M6-17). Manager: forward stop
(kill every command's process group, stop the container). The exec part's hook abandons the exec
call as today. The turn settles `cancelled` in the same crank once nothing waits.

### 4.5 Emergency stop and resume (R4-8, R6-50, R7-65)

- **E1** (`Session.emergencyStop`): no environment -> throw `noEnvironmentToStop`; `stopped` ->
  answer the state. Else: part `execution = 'stopping'`; queue hold `stopped` (M2 5.2, its text);
  cancel the current turn (4.4); publish `execution` and `pending`; `E(control).emergencyStop()`.
- Manager: `stopped = true` (every `Git`, `GitReader`, `Shell` and `port` call refused from now:
  `environmentTexts.stopped`); `E(ops).stop(key, { withdraw: true })` (the adapter refuses the
  key's `ShellPort` and `ImageSource` calls from now, and kills and stops); on failure keep the stop
  pending (and the key in `withdrawn`) and reject.
- **E2** (answer): ok -> `execution = 'stopped'`, publish, answer `{ state: 'stopped', supported:
  true }`. Failure -> stays `stopping`, publish, throw `stopIncomplete` (the user retries; a retry
  is idempotent).
- While `stopping` or `stopped`: `admit()` answers `texts.sessionStopped`; `enqueueOnce`,
  `enqueueMessageOnce`, `startTurn` (seam R-3) and `QueueEntry.sendNow` (seam R-4, before it
  releases the hold) refuse with it before writing anything; `claimNext` claims nothing (seam R-2),
  so no turn source starts a turn either (D-M6-20). The Composer counts the text among
  `SUBMIT_REFUSALS` (seam C-1).
- **Resume**: `stopping` -> throw `finishStopFirst`; `running` -> answer. Else
  `E(control).resume()` (answered; the manager clears `stopped` and sends `E(ops).resume(key)`),
  then `execution = 'running'`, publish. The hold `stopped` stays until a new message or send-now
  (R4-56, R6-50); nothing is replayed.
- A restart changes nothing: both states are heap state; containers are stopped by the adapter's
  sweep anyway; a new adapter incarnation learns the withdrawn keys from `attach`.
- **Export and import (X-07, seam X-E).** `exportState`'s head page carries `execution:
  ExecutionState` when the part is not `running` (a `stopping` session exports `stopped`: nothing
  of the old environment comes along). The import's head-chunk crank calls
  `runtime.environment.importExecution(state)`: `execution = 'stopped'`, the queue hold `stopped`
  set whatever the queue holds (unlike the `restart` default, which applies only to a non-empty
  queue), and `E.sendOnly(control).emergencyStop()` to the imported session's own new environment,
  so its authority is withdrawn as well. An import into a state without environments keeps
  `execution` and refuses with `noEnvironmentToStop` at the next stop; `resume` then answers
  `running` with `supported: false`.

### 4.6 Delete (R4-9, G-29)

`deleteSession` step 1 runs `onDelete` hooks before fencing (M2 7.1): `releaseEnvironment` awaits
`E(admin).releaseSession(session)`. Manager: mark released (refuse all calls), forward
`E(ops).release(key)`; adapter: stop the container and its commands, `rm` the container, rename
`sessions/e<n>` to `trash/e<n>-<incarnation>`, fsync the parent, delete the trash entry, answer.
A failure rejects: the delete record stays at step 1 and resumes at the next start (M2 7.1). A
running turn of the session sees its commands fail (`released`) before `deleteSelf` cancels it.

### 4.7 Restart

Daemon start: the manager's lifecycle re-binds the service key; the adapter's `bind` computes this
state's tag, runs `runtime.sweep(tag)` (stops and removes every container or fake process group
the state owns), deletes `trash/*`, removes stale `index.lock` files of environments it sweeps,
`attach`es and performs the pending stops and releases. Nothing starts. Sessions are not woken (no
start listener in the environments resource touches a session). A session in a turn at the kill
point recovers through its lease break (architecture 4.4); its shell calls are settled by
recovery's unknown results and the part's `onRecover`.

### 4.8 The environments adapter alone exits

The kit rebuilds the adapter at the next manager call (`lifecycle.exited()` backoff). A command in
flight on a `ShellPort` breaks: D-M6-5. Exec-path calls in flight: reads retried, writes
`outcomeUnknown`. The new `bind` sweeps the old incarnation's containers (they are this state's).

---

## 5. The adapter (`EVI/`)

### 5.1 Layout (under the state directory found once from `argv[3]`, as the agent host does)

```
<state>/environments/
  tag                       # this state's container label value: sha256(realpath(state))[0:16], rewritten at each bind
  sessions/e<n>/workspace/  # the git repository (/workspace); `.thix-ready` marker in .git after init + empty commit
  sessions/e<n>/home/       # /home/node (R3-46)
  sessions/e<n>/run/        # fake runtime: one file per live process group (pgid, start time)
  trash/                    # releases in progress; emptied at bind
```

Directories 0700. The tag is path-dependent on purpose: a cloned state (test templates) gets its own
containers. The `findStateDir` of `AH/blobs.js` and `findHarnessRoot` of `AH/../ephemeral.js` are
imported, not copied (rule 3; moved to a shared module at the fold, section 14).

### 5.2 Modules (each one unit's file; signatures fixed here)

| module | exports |
|---|---|
| `EVI/index.js` | `makeEnvironmentsImpl({ incarnation, stateDir?, runtimes?, now?, trace? }) -> { bind(key, spec, epoch), unbind(key) }` |
| `EVI/ops.js` | `makeOps({ settings, layout, git, runner, ports, status }) -> EnvironmentsOps` (exo with the resource guard) |
| `EVI/layout.js` | `makeLayout({ stateDir }) -> { tag(), dirsOf(key) -> { workspace, home, run }, ensureWorkspace(key) -> Promise<void>, release(key) -> Promise<void>, sweepTrash() }` |
| `EVI/git.js` | `makeWorkspaceGit({ dirsOf, ensureWorkspace }) -> { run(key, { op, args }, { readOnly }) -> Promise<answer> }` (serial per key) |
| `EVI/runner.js` | `makeRunner({ runtime, settings, layout, timers }) -> { exec(key, argv, { timeoutMs }) -> RawResult, inspect() -> ShellInfo, stop(key), release(key), sweep(), runningCount() }` |
| `EVI/runtime-fake.js` | `makeFakeRuntime({ spawn?, kill? }) -> Runtime` |
| `EVI/runtime-oci.js` | `makeOciRuntime({ binary: 'podman' \| 'docker', exec? }) -> Runtime` |
| `EVI/images.js` | `isDigestPin(pin) -> boolean`, `checkImagePin({ runtime, image }) -> Promise<{ ok, reason? }>` (also M12's start gate) |
| `EVI/shell-port.js` | `makeShellPort({ key, runner, blobs, settings }) -> ShellPort` |
| `EVI/command-args.js` | `parseCommandArgs(jsonText, allowed) -> { ok, command, args, timeoutMs? } \| { ok: false, text }` |
| `EVI/command-output.js` | `boundCommandResult(raw, { maxUnits }) -> string` (5.5), `boundCommandRecord(raw, { streamUnits }) -> CommandResult` |
| `EVI/blob-access.js` | `stageText(text, writers) -> StagedText`, `readStaged(staged, content, maxBytes) -> string` |
| `EVI/image-source.js` | `makeImageSource({ key, segments, dirsOf, isWithdrawn }) -> ImageSource` (M8's guard, X-1) |
| `resources/native-attach.js` | `makeAttachedOps({ reconcile, isRetired }) -> { withOps(fn, { write }), attach(ops), current() }` (D-M6-13; manager-vat module, prelude globals only) |

### 5.3 Runtime contract

```js
Runtime = {
  kind,                                                   // 'fake' | 'podman' | 'docker'
  check(settings) -> Promise<{ ok: true } | { ok: false, reason }>,   // image pin and presence
  start(env) -> Promise<void>,                            // env = { key, name, tag, workspace, home, run, settings }
  exec(env, argv, { timeoutMs, killGraceMs, streamBytes }) -> Promise<RawResult>,
  stop(env) -> Promise<void>,                             // every command, then the container
  remove(env) -> Promise<void>,
  sweep(tag) -> Promise<{ stopped: number }>,             // everything this state owns
}
RawResult = { stdout: Uint8Array, stderr: Uint8Array, stdoutCut: boolean, stderrCut: boolean,
              exitCode: number | null, signal: string | null, timedOut: boolean, ms: number }
```

OCI `start`: `run -d --name thix-<tag>-<key> --label thix.state=<tag> --user 1000:1000 --cap-drop
ALL --read-only --tmpfs /tmp --security-opt no-new-privileges --network none --pids-limit <pids>
--memory <bytes> --cpus <n> --log-driver none -v <workspace>:/workspace:rw -v <home>:/home/node:rw
-w /workspace --env HOME=/home/node --env PATH=... --env LANG=C.UTF-8 <image> sleep infinity`,
podman adds `--userns keep-id` (the container's uid 1000 owns files as the daemon user). `exec`:
`exec <name> setsid sh -lc 'echo $$ > /tmp/thix-<op>.pid; exec "$@"' sh <argv...>`; a timeout sends
SIGTERM to the command's process group inside the container (`exec <name> kill -TERM -<pgid>`),
SIGKILL after `killGraceMs`; other commands keep running. The image is never pulled: `check` uses
`image exists` (podman) or `image inspect` (docker) and the pin form; `run` passes `--pull never`.
Environment variables are exactly A.3's list (no host variable, no credential, R3-45).

### 5.4 What a docker-backed run can and cannot show

Can (with the daemon running and the pinned image present locally): the argv the runner builds, pin
form and presence refusal, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, `--network none`,
pid and memory limits being accepted, uid 1000 inside, the workspace and home mounts (on macOS
through Docker Desktop's file sharing), per-command timeouts and process-group kills, stop, remove
and the label sweep after a supervisor SIGKILL, and every perf row with real container costs.
Cannot: rootless operation (Docker Desktop runs a root daemon in a VM; R3-45's "started by the
daemon's service user" is podman-only), `--userns keep-id` file ownership, podman's user-mode
networking, and the production platform's cgroup and seccomp defaults. Items needing those are
`[real-runtime: podman]`; the rest are `[real-runtime]` (either binary).

### 5.5 The tool-path output budget (G-19)

1. Each stream is drained to the end; the first `streamBytes` (65,536) bytes are kept
   (`stdoutCut`/`stderrCut`); decoded as UTF-8 with replacement (invalid bytes become U+FFFD; a
   cut inside a character drops the partial character).
2. `result = { stdout, stderr, exitCode, signal, truncated: stdoutCut || stderrCut }`; if
   `JSON.stringify(result).length <= toolOutputUnits` it is the text.
3. Else the room left for the two strings is `toolOutputUnits - JSON.stringify({...result,
   stdout: '', stderr: ''}).length - 2 x markerUnits`; stderr gets `min(its escaped length, max(2,048,
   room / 4))`, stdout the rest (then stderr any rest); each field is cut at a code-point boundary
   by its *escaped* length (binary search on the prefix) and gets `textOf.truncationMarker(original
   units)` appended inside the field; `truncated: true`. The final text is checked again and is at
   most 32,768 units: always valid JSON.
4. Text over `inlineBytes` UTF-8 bytes is staged (D-M6-6) and answered as `StagedText`; a staging
   failure answers `{ status: 'failed', text: textOf.stagingFailed(message) }`.

A timeout answers `{ status: 'failed', text: environmentTextOf.timedOut(ms) }` after the kill, as
exo-shell rejects; the partial output is dropped (as exo-shell does).

---

## 6. Seams and merge hotspots

Each is the smallest edit; the unit named makes it. "Partners" are the other lanes of the group
that touch the same file. Union merge does not apply to source files: the PM merges these by hand.
Line references are to the step-3 code at `cecfa12809`.

### 6.1 Shared guard modules and the part API (done by WX.1, X-02, X-03)

M6 makes none of these edits; WX.1 applies them for all four lanes in one commit, from section 15.
They are listed so the M6 builders know what exists when they start.

| id | file | what WX.1 adds for M6 | partners in the same WX.1 commit |
|---|---|---|---|
| S-1 | `guest/lib/guards/session.js` | the `Session` latest version's three methods; `shapes.ExecutionState`; `shapes.SessionServices` optional `workspace`, `shell`, `environment`; `SessionExportPage` optional `execution` (X-E); the texts and tool descriptions of 15.1 | M8 G-1, M9 S9 |
| S-2 | `guest/lib/guards/factory.js` | `shapes.HarnessSettings` optional `environments`; `texts.runnerRequired` | M9 F6, M11 H1 |
| S-3 | `guest/lib/interfaces.js` | `VatEvent` alternative `execution` | M8 G-2 |
| S-4 | `test/unit/guards-split.test.js`, `test/fixtures/guard-fold-map.json`, `gateway-vocabulary-tables.test.js` | the `added` list (or retirement of the before-split check) and one re-pin of the vocabulary; the not-browser-sendable exclusion rule (D-M6-10) | every lane |
| S-5 | `guest/session/runtime-parts.js` (typedefs and `combineHooks` only) | `PartHooks.admit?: () => string \| undefined`; `RuntimeHooks.admit()` answering the first refusal in part table order | M8 (`HookTurn.reading`, `Runtime.contextWindow`), M9 (`take` into `nextTurn`, the restart-hold condition) |
| S-6 | `guest/session/tools/exec.js` (or a module beside it) | the exported per-part call table (D-M6-17) | M9 W9.3 uses it |
| V-1 | `guest/lib/vocabulary-tables.js` | `vocabularyExclusions['guards/environments.js']` with its reason (D-M6-10) | M8 (`image-guards.js` exclusion) |

### 6.2 Session vat (W6.4)

| id | file | exact seam | partners |
|---|---|---|---|
| R-1 | `guest/session/runtime-parts.js` | `import { environmentPart } from './environment.js';`; `PartName` gains `\| 'environment'`; `'environment'` appended to `requiredParts` after `'packages'`; `environmentPart` appended to `runtimeParts` after `packagesPart`; one getter `get environment() { return made.get('environment'); }`; `Runtime` typedef `@property {any} environment` | M8 `compaction`, M9 `inbox`, `subagents` (the same five lines each, in the WX.1 order) |
| R-2 | `guest/session/turn.js` `claimNext` | one line after `if (current !== undefined \|\| fence.closed()) return undefined;`: `if (hooks.admit() !== undefined) return undefined;` (every claim path, enqueue, send-now and settle, reaches it) | M9 S2 (its `claimNext` change follows this line), M8 S-5 (not in `claimNext`) |
| R-3 | `guest/session/session.js` | (a) `refuseIfStopped()` beside `refuseIfDeleting` (`const refusal = runtime.hooks.admit(); if (refusal !== undefined) throw Error(refusal);`), called after `refuseIfDeleting()` in `enqueueOnce`, `enqueueMessageOnce` and `startTurn`; (b) `Session.emergencyStop`, `resume`, `getExecutionState`: delegate to `runtime.environment` plus `queue.hold('stopped', ...)` and `runner.cancelCurrent()` (4.5), about 15 lines; (c) `makeQueue({ ..., admit: () => runtime.hooks.admit() })` (R-4); (d) `makeSessionExport({ ..., execution: runtime.environment })` (X-E) | M9 (`Session` mail methods; its `makeQueue` option if any) |
| R-4 | `guest/session/queue.js` | `makeQueue` option `admit = () => undefined`; `sendNow()` first line `const refusal = admit(); if (refusal !== undefined) throw Error(refusal);` (before `submissions.sendNow`) | none known |
| X-E | `guest/session/export.js` | `head()`: `const execution = powers.execution?.exportExecution(); if (execution !== undefined) page.execution = execution;`; the `head` import branch: `if (chunk.execution !== undefined) powers.execution?.importExecution(chunk.execution);` | M9 (its inbox export section, X-07) |
| T-1 | `guest/session/tool-table.js` | `import { shellToolEntries } from './tools/shell.js';` and `...shellToolEntries` after `...packageToolEntries` in `toolTable` | M8 `viewImage`, M9 mail, requests and subagent tools (after it, X-04) |
| L-1 | `guest/session/label-seeds.js` | two entries (`workspace`, `shell`) | M9 (`user`) |
| B-1 | session program bytes | M6 adds at most its cap (D-M6-18: asks 9,000 bytes); measured by `bundle-guest.mjs` in W6.4 | M8, M9 (the PM's caps sum to the ruled limit, X-01) |

### 6.3 Factory vat (W6.5)

| id | file | exact seam | partners |
|---|---|---|---|
| F-1 | `guest/factory/preset-templates.js` | `objectProviders = harden([...environmentProviders])`; `ObjectProvider.build` removed from the typedef (never called; fold) | M7 next group (`publicInternetProviders`) |
| F-2 | `guest/factory/services.js` | `environmentServices` appended to `serviceBuilders`; two new append-only tables `serviceBinders` (`[environmentBinder]`) and `serviceReleasers` (`[environmentReleaser]`), each `({ services, session?, settings }) -> void`, sendOnly only; `ServicesContext` typedef gains `settings` | M9 (subagent services, its context fields) |
| F-3 | `guest/factory/factory.js` | (a) `makePresetCatalog({ templates: defaultTemplates, defaultsContext: harden({ settings: harnessSettings }) })` (line 132); (b) `settings: harnessSettings` in the one merged `buildSessionServices` context object (line 284; M9 adds its own fields to the same object, X-05); (c) after `mustMatch(made, shapes.MadeSession)` (line 348): `for (const bind of serviceBinders) bind({ services, session: made.session, settings: harnessSettings })`; (d) in `rollBack` (line 150): `for (const release of serviceReleasers) release({ services: creation.services, settings: harnessSettings })` when `creation.services` is set | M9 (subagent creation path, the same context object) |
| F-4 | `guest/factory/factory.js` (line 139) | `makeDeletions({ admin, rows, starts, hooks: harden([...M9's subagents.deleteChildren, ({ session }) => releaseEnvironment({ session, settings: harnessSettings })]) })`; `delete.js` unchanged (D-M6-16) | M9 F5 (the first entry; one line both lanes write: the PM merges it) |
| F-5 | `guest/factory/root.js` | `makeHarnessSettings` keeps `environments` (set, answer `environments()`, include in `current()`) | none |
| P-1 | `guest/lib/prompt-sections.js` | part 6 entries `...environmentPromptSections` (text in `guest/lib/environment-prompt.js`, new) | M9 part 4, M12 part 5 |

### 6.4 Adapters, provisioning, UI, tests

| id | file | exact seam | partners |
|---|---|---|---|
| C-1 | `AH/composer.js` (W6.6) | `SUBMIT_REFUSALS` gains `texts.sessionStopped` (the staged file of a refused submission is deleted) | none |
| P-2 | `scripts/provision-steps/60-environments.js` (new file; registry) | `install-native environments` (skip when present), `configure(options.environments)` (skip when equal), `HarnessRoot.configure({ environments: admin })`; skipped without `options.environments` | M11 takes `70-voice.js` (X-09); M8/M9 other numbers |
| U-1 | `ui/src/environment/feature.js` (new directory; registry) | slot `session.settings` (M3 4.x) | M11 `ui/src/voice/` |
| K-1 | `H/package.json` (W6.2; PM-merged) | dependencies `@endo/git`, `@endo/exo-git` (`workspace:^`) | M11 (speech deps) |
| K-2 | `scripts/test-integration.mjs` `regressionLists` (W6.7) | a new list `environments` with M6's four integration files (not the `core` list, X-14) | every lane (one list each) |
| K-3 | `H/perf/_harness.mjs` (PM-merged) | none planned; the perf files use `runWindow` and the template helper as they are | - |
| M-1 | M7 and M10 (next group) | their manager methods (`setNetworkPolicy`, routes) go into one batched change of `EV/durable.js`; their adapter code under `EVI/egress/` and `EVI/publishing/` (paths move from `resources/containers/egress/` and `resources/workspace/{assets,routes,mime}.js`) | M7, M10 contracts |

### 6.5 Merge hotspots (the PM merges these by hand)

`runtime-parts.js` (R-1: five one-line additions per lane, in the WX.1 order), `turn.js`
`claimNext` (R-2, then M9's lines), `session.js` (R-3, M9's methods), `tool-table.js` (T-1),
`label-seeds.js` (L-1), `factory.js` (F-3 context object, F-4 hooks list), `services.js` (F-2),
`prompt-sections.js` (P-1), `package.json` (K-1), `scripts/test-integration.mjs` (K-2). No other
file of M6 is edited by another lane.

## 7. What persists where, and what a SIGKILL leaves

| state | lives in | bound | after a supervisor SIGKILL |
|---|---|---|---|
| settings, environment records (`e<n>`, flags, session), pending stops and releases, the withdrawn set | environments manager vat heap | `maxEnvironments` 1,024; `maxPendingWork` 1,024; released records dropped on the adapter's answer | intact up to the last committed crank |
| `Git`, `GitReader`, `Shell`, `EnvironmentControl` | manager vat exos; bound as labels and services in session vats | one set per environment | intact; calls work after the adapter re-attaches |
| `ShellPort` | adapter (per incarnation); held by the session part | one per environment per incarnation | a tombstone; the part drops it at its next use (D-M6-5) |
| `ImageSource` of `openImage` | adapter (per incarnation); held by M8's image tool for one call | no table: a closure over key and segments, collected when dropped | a tombstone; `viewImage` answers `imageTexts.sourceLost` |
| withdrawn keys in the adapter | adapter heap, rebuilt from `PendingWork.withdrawn` at each `attach` | `maxEnvironments` | rebuilt at the next bind before any call is served |
| workspace repository, home | `<state>/environments/sessions/e<n>/` | grows with what the session writes (released on delete) | intact; a stale `.git/index.lock` from a killed git is removed at the next bind's sweep |
| containers / fake process groups | runtime (podman storage) / host processes | one per running environment | podman containers survive the kill; the next bind's sweep stops and removes them; fake groups are killed by the sweep from `run/` |
| execution state | session vat heap (`environment` part); the export's head page (X-E) | one value | intact; an export carries it, an import re-applies it (4.5) |
| `environments` setting | factory vat heap | one handle | intact |

| kill point | what the next start finds | what happens |
|---|---|---|
| K1 after `provide` answered, before `make` | a creation in the factory's set, an unbound record | the start listener rolls the creation back; the releaser releases the record (4.1) |
| K2 after `make`, before the `bindSession` delivery | the sendOnly is in the hub queue (durable guest to guest) | delivered after the restart; nothing lost |
| K3 during a command | a container or process group still running; the turn's lease breaks | sweep stops it; recovery settles the turn `outcome-unknown` with the command's result unknown (acceptance 12); the command may have changed the workspace |
| K4 during a git write through the manager | maybe a commit, maybe `index.lock` | the exec call gets `outcomeUnknown`; the lock is removed at the sweep; the model is told to check status |
| K5 during workspace creation | a directory without the ready marker | the next use wipes it and initialises again (nothing user-made exists before the marker) |
| K6 between emergency stop E1 and E2 | session `stopping`; manager maybe `stopped` | fenced; the user retries emergency stop (idempotent) and gets `stopped`; resume is refused until then |
| K7 during release (delete step 1) | the delete record at step 1; maybe `trash/e<n>-*` | the delete resumes; `releaseSession` again (idempotent); trash emptied at bind |
| K8 the environments adapter alone killed during a command | the session's turn alive | `commandOutcomeUnknown` for that call; the turn continues; the next command reopens the port and the container starts fresh |
| K9 after the manager set `stopped`, before the adapter's `stop(key, { withdraw })` answered | the key in `pending.stops` and in `withdrawn` | the next bind refuses the key's adapter-side objects from its first call, then performs the stop; the session is `stopping` and the user's retry answers `stopped` |
| K10 during an import of a stopped session (after the head chunk) | an importing session with `execution = 'stopped'` and the hold set; maybe the `emergencyStop` sendOnly in the hub queue | the import resumes from its progress (M2 7.3); the sendOnly is delivered after the restart (durable guest to guest) |

---

## 8. Work units

Units in one lane (one worktree, several agents), disjoint files. Prerequisites outside the lane:
step 3 merged and the PM's cross-lane seam unit WX.1 done (section 6.1: every shared guard entry,
the part-API typedefs, the call table, the vocabulary exclusion; this replaces the W6.0 draft's
W6.0b), and the PM's session-program caps set (D-M6-18, before W6.4). Then W6.1-W6.6 in parallel;
W6.7 last; the fold W6.8 after the merge (rule 2). Journal ranges: each unit's is the range the PM
assigns at launch ("PM assigns"); J-0817..J-0829 stay with the contract for the PM's notes.

| id | files owned (create or edit) | behaviour | tests | depends on | journal |
|---|---|---|---|---|---|
| W6.1 resource core | `EV/durable.js`, `EV/ephemeral.js`, `resources/native-attach.js`, `EVI/index.js`, `EVI/ops.js`, `EVI/layout.js`, `scripts/provision-steps/60-environments.js`, `test/adapter/environments-manager.test.js`, `test/adapter/environments-layout.test.js`, `test/adapter/environments-provision.test.js`, `test/unit/native-attach.test.js` | the manager (records, amplification, forward with reattach through `native-attach.js`, read retry and write `outcomeUnknown`, stopped/released refusals, the withdrawn set, pending work), the loader, the state layout, attach and sweep at bind, provisioning | manager with a fake manager kit built from the real guards (rule 4): mint, bind, release by control and by session, refusals, retries, pending work and withdrawn keys across a reattach; layout: ensure/release/trash/marker; provisioning idempotence; `withOps` read retry and write refusal | WX.1; its `index.js` composition commit after W6.2, W6.3b and W6.3c export their modules | PM assigns |
| W6.2 git and images | `EVI/git.js`, `EVI/image-source.js`, `H/package.json` (K-1, PM-merged), `test/adapter/environments-git.test.js`, `test/adapter/environments-git-hostile.test.js`, `test/adapter/environments-image-source.test.js` | every `Git` op on `@endo/git`, closed answers cut to `answerBytes`, ref and path checks, read-only refusal, serial per workspace, stale-lock removal, `SourceReader.read`; `openImage` and the adapter-side `ImageSource` (X-1) | a ported subset of `exo-git/test/kit-conformance.test.js` (branches, status, diff, log paging, stage, commit, merge both modes, stash), hostile repos (filter driver, include, hooks, fsmonitor), image source: pages, `size`, a file changed between reads, a symlink swapped in, `.git` and `..` refused, withdrawn key refused, checked against M8's `ImageSource` guard; `[real-git]` (always available) | WX.1 | PM assigns |
| W6.3a OCI runtime | `EVI/runtime-oci.js`, `EVI/images.js`, `test/fixtures/fake-bin/oci-cli.mjs` (a fake `podman`/`docker` that records argv and plays scripted answers), `test/adapter/environments-runtime-oci.test.js` | argv of `start`/`exec`/`stop`/`remove`/`sweep` for both binaries; pin form and presence check; timeout kills by process group | argv golden tests and refusals against the fake CLI everywhere; `[real-runtime]` cases under `THIX_HARNESS_REAL_RUNTIME=podman\|docker` in the same file | WX.1 | PM assigns |
| W6.3b fake runtime and runner | `EVI/runtime-fake.js`, `EVI/runner.js`, `test/adapter/environments-runner.test.js`, `test/adapter/environments-fake-runtime.test.js` | lazy start, idle stop (`idleStopMs`, adapter timers), stop, release, sweep from `run/` after a simulated SIGKILL, timeout then kill after 2 s, scrubbed env, the allowlist | fake runtime: the result shape, caps, timeouts, kill grace, leftover groups killed at sweep, env has only A.3's variables | WX.1 | PM assigns |
| W6.3c shell port and output | `EVI/shell-port.js`, `EVI/command-args.js`, `EVI/command-output.js`, `EVI/blob-access.js`, `test/adapter/environments-shell-port.test.js`, `test/adapter/environments-command-output.test.js` | model-JSON parsing with Fae's texts, the 5.5 budget, staging through `BlobWriters`, staged args through `Content`, the exec-path record, refusal of a withdrawn key | output budget property test (random stream sizes and character widths: always valid JSON, at most 32,768 units, markers inside fields); staging with a fake `BlobWriters` built from the real guard | WX.1 | PM assigns |
| W6.4 session part and tools | `guest/session/environment.js`, `guest/session/tools/shell.js`, edits R-1 (`runtime-parts.js`), R-2 (`turn.js`), R-3 (`session.js`), R-4 (`queue.js`), X-E (`export.js`), T-1 (`tool-table.js`), L-1 (`label-seeds.js`), `test/unit/session-environment.test.js`, `test/unit/session-shell-tool.test.js`, `test/unit/session-environment-export.test.js` | 3.8 and 4.2, 4.4, 4.5 on the session side, the export and import of the execution state | crank-order unit tests with a fake control and port built from the real guards: port opened once per incarnation, retired break -> `commandOutcomeUnknown` and reopen, cancel settles and stops, recovery settles quietly, emergency stop states, refusal before any write (enqueue, start, send-now), `claimNext` claims nothing while stopped even with a test part's `nextTurn`, resume keeps the hold, export and import of `stopped` re-apply hold and withdrawal; the session bundle within M6's cap (B-1) | WX.1, the PM's caps | PM assigns |
| W6.5 factory and prompt | `guest/factory/environments.js`, `guest/lib/environment-prompt.js`, edits F-1..F-5, P-1, `test/unit/factory-environments.test.js`, `test/unit/environment-prompt.test.js` | 3.9 and 4.1, 4.6 on the factory side | availability with and without the setting, provide on creation, binder after make, releaser on rollback, the delete hook handed to `makeDeletions` (children first, with a fake M9 hook), part 6 text present only with the objects | WX.1 | PM assigns |
| W6.6 UI and composer | `ui/src/environment/feature.js`, `ui/src/environment/ExecutionPanel.js`, `ui/src/environment/texts.js`, `AH/composer.js` (C-1), `test/unit/ui-environment.test.js`, `test/browser/environment-ui.test.mjs` | Settings "Sandbox execution": state from `getExecutionState` and the live `execution` event, Emergency stop, Resume, errors shown; hidden when `supported` is false; a refused submission's staged file deleted | happy-dom unit; composer refusal (unit); browser (acceptance 19) | WX.1 | PM assigns |
| W6.7 integration (last) | `test/integration/_environments.js`, `test/integration/_adapter-processes.js`, `test/integration/environments-shell.test.js`, `environments-restart.test.js`, `environments-stop.test.js`, `environments-presets.test.js`, `perf/environments.perf.mjs`, `perf/environments-git.perf.mjs`, `perf/environments-restart.perf.mjs`, K-2 (`scripts/test-integration.mjs`) | the acceptance list (section 9) and the perf table (section 10) on the combination; the template `environments` | each integration file under 5 minutes; each perf file under its time in section 10 | W6.1-W6.6 | PM assigns |
| W6.8 fold (after the merge) | the files of section 14 | section 14 | the greps and tests of section 14 | the merge of M6 | PM assigns |

Disjointness: no two of W6.1-W6.6 own the same file; the only shared files of the lane are the ones
W6.4 and W6.5 edit in 6.2 and 6.3, each owned by one of them. `H/package.json` is W6.2's alone
within the lane.

## 9. Acceptance (each proved by the named test; `[real-runtime]` repeated in an owner run)

Integration files start from the `environments` template (provisioned with `options.environments
= { runtime: 'fake', allowedCommands: [...defaults, 'true', 'printf', 'sleep', 'cat', 'head',
'id'] }` and the default pool).

1. **Pin refusal (P-55, R8-42).** A non-digest pin is refused by `configure`; an absent image puts
   the runner in `refused` with `imageRefused` and every command fails with it.
   `environments-runtime-oci.test.js` (fake CLI); `[real-runtime]` the same against podman and
   docker with an absent tag.
2. **One repository (R3-246).** `runCommand(git status)` and `E(workspace).status()` see the same
   repository; a commit made by `runCommand(git commit)` is in `E(workspace).log()`, and one made by
   `E(workspace).commit()` is in `runCommand(git log)`. `environments-shell.test.js`.
3. **Command contract (R3-44, R3-47, G-19).** Not allowlisted -> refused, nothing runs; non-zero
   exit returned as data; > 64 KiB per stream cut and `truncated`; `timeoutMs` 500 on `sleep 30`
   -> `timedOut`, SIGTERM, SIGKILL after 2 s for a trapping script; 10 MiB of stdout -> a result
   that parses as JSON, at most 32,768 units, staged. `environments-shell-port.test.js`,
   `environments-command-output.test.js`, `environments-shell.test.js` (the staged 10 MiB case).
4. **Lifetimes (R3-46, G-29).** A file in home survives two turns and a SIGKILL restart; after
   `deleteSession` the session's directory, its container (fake group) and its records are gone.
   `environments-restart.test.js`, `environments-stop.test.js`.
5. **Git surface (R3-247, R3-248).** No facet has a method of `gitAbsentMethodNames`; the reader
   has no write method and the adapter refuses a write for a reader (`gitReadOnly`); `trackingStatus`
   reports no upstream. `environments-git.test.js`; exec-path check in `environments-shell.test.js`.
6. **Emergency stop (R4-8, R6-50).** Stop fences (`enqueueOnce`, `startTurn` and a waiting
   entry's `sendNow` refused with `sessionStopped`), holds the queue (`stopped`), cancels the turn,
   stops the environment (no process of it alive), withdraws authority (`Git`, `Shell` refused with
   `environmentTexts.stopped` in the manager; a `ShellPort` and an `ImageSource` held from before
   refused in the adapter), and all of this holds after a SIGKILL restart; resume answers
   `running`, the queue stays held, a new message releases it. `environments-stop.test.js`; the
   crank-level refusals and a test part's `nextTurn` never claimed in
   `session-environment.test.js`.
7. **Concurrency (P-18).** A round with one `exec`, one `runCommand` (`sleep 1`) and one `echo`
   (`delayMs` 1,000) completes in under 1.6 x one call and records results in call order.
   `environments-shell.test.js`.
8. **Lazy after restart (D-16).** After a SIGKILL with a command running and a clean restart, no
   container or fake group is running until a session's first command; leftovers are gone.
   `environments-restart.test.js`.
9. **`[real-runtime]` isolation (R3-45, R7-9).** In the container `id -u` is 1000, `CapEff` is 0,
   writing outside `/workspace`, `/home/node` and `/tmp` fails, no network interface but `lo`;
   `[real-runtime: podman]` files written by the container are owned by the daemon user.
   `environments-runtime-oci.test.js` (gated).
10. **Cancel stops (R4-7, P-12).** Cancel during `sleep 600`: the turn ends `cancelled` within 1 s,
    the process is gone, the next command starts the environment again. `environments-shell.test.js`.
11. **Runner restart alone (D-M6-5).** Killing the environments adapter process during `sleep 5`
    records `commandOutcomeUnknown` for that call, the turn continues to its final answer, the next
    command works. `environments-restart.test.js`.
12. **SIGKILL during a command.** The turn is `outcome-unknown`, the command's result unknown, the
    process gone after restart; the next turn's command works. `environments-restart.test.js`.
13. **Delete during a command.** `deleteSession` while `sleep 600` runs completes; directory and
    process are gone. `environments-stop.test.js`.
14. **Presets (R3-12..R3-15, R3-21).** Without the setting, `development`, `voice`, `new-project`
    and `general` with objects are unavailable with `runnerRequired`; with it they are available;
    `new-project` gets `workspace` and no shell tools; `chat-only` gets none.
    `environments-presets.test.js`.
15. **`inspectShell` (A.3).** Answers `{ allowedCommands, timeoutMs, maxOutputBytes }` with no
    host path. `environments-shell.test.js`.
16. **`readSources` over the workspace.** `readSources({ petName: 'workspace', items })` reads lines
    of a committed file; a path with `..` is refused. `environments-shell.test.js`.
17. **Reachability and paths (D-M6-14).** `thix reachability` from a session vat and its exec vat
    reaches no `EnvironmentsAdmin` and no other session's environment objects; the state
    directory's absolute path appears in no vat heap, journal or snapshot (grep, as
    `assertNoSecretInState`). `environments-presets.test.js`.
18. **No credentials in the container (R3-45).** `runCommand(sh -c env)` lists only A.3's
    variables. `environments-shell.test.js`; `[real-runtime]`.
19. **UI (R6-57).** Settings shows "Sandbox execution" running; Emergency stop -> stopped,
    composer blocked with the text; Resume -> running, queue held. `test/browser/environment-ui.test.mjs`.
20. **Bounded state.** After creating and deleting 20 environment sessions the manager's record
    count and `pendingReleases` are back to before. `environments-stop.test.js` (gate check).
21. **Workspace images (X-1, R3-30, M8's protocol).** `E(workspace).openImage(['img', 'a.png'])`
    answers an `ImageSource` whose pages, read through M8's `ImageSource` guard, reassemble the
    file; `size()` is the file's size; `..`, `.git`, a symlink out of the worktree and a directory
    are refused with `gitPathRefused`; after emergency stop a source opened before is refused.
    `environments-image-source.test.js` (adapter) and `environments-shell.test.js` (through the
    manager, exec code reading pages of 12,288 bytes). The `viewImage` end-to-end case is WX.F's.
22. **Export and import of a stopped session (X-07).** A session emergency-stopped, exported and
    imported is `stopped` after the import, its queue held `stopped`, its new environment refuses
    `Git` and `Shell` calls; resume then works. `session-environment-export.test.js` (crank level)
    and `environments-stop.test.js` (the M2 export script over the template).

Cross-lane, proved by the group fold WX.F's named integration tests (X-12), not by an M6 file:
the complete `voice` preset (R3-13, with M11), `viewImage` of a workspace path (R3-30, with M8), a
subagent of a shell preset with its own workspace and shell (R4-70, with M9), and mail delivered to
an emergency-stopped session waiting until resume (D-M6-20, with M9).

---

## 10. Performance (fixed windows; each file under the 10-minute box)

Rows marked **gate** are counts or N-run checks, not rates: they pass or fail and are recorded, and
they are not perf rows of the fixed-window kind (X-14). Rows marked **recorded** have no measured
basis yet: the first run records them and a later unit sets the budget from that number (X-13).
File times include the template start (about 30 s from a cached template, J-9382 restart times)
and fixture builds.

| row | file | window | budget | derived from |
|---|---|---|---|---|
| `environments.runTrue`: tool_call event to tool_result event minus the runtime's own `ms` (fake, `true`) | `perf/environments.perf.mjs` | 60 s | median <= 150 ms; 1 session delivery and 0 manager deliveries per command | vat -> adapter -> vat 70-76 ms (J-9043), 53 ms guest call (J-9382); spawn 1.0 ms (J-0811) |
| `environments.firstCommand`: first command of an incarnation (port open + workspace init + fake start) | same | 60 s (one fresh session per sample, from the pool) | median <= 500 ms | manager hop 151-175 ms (J-0222) + runCommand path above + git init |
| `environments.sessionCreate`: `development` minus `chat-only` creation time | same | 60 s (alternating) | median <= 175 ms | one manager crank (J-0494) + 3 handles (7-15 ms each) |
| `environments.cancel`: cancel during `sleep 600` to `end cancelled` | same | 60 s | **recorded** (expected <= 1 s: one cancel crank, one sendOnly stop, one settle; not measured) | - |
| `environments.stopCleanup`: `stop()` to no process of the environment | same | 60 s | **recorded** (fake; `[real-runtime]` recorded separately) | - |
| `environments.tooBig`: 10 MiB stdout command, call to result recorded | same | **gate**, 5 runs | each <= 2 s; result <= 32,768 units, valid JSON; 0 halts; 1 session delivery | 10 MiB drained in 329 ms (J-0811); <= 8 pieces x 20-25 ms (J-9043) |
| `environments.bundles`: session program growth; manager bundle bytes; manager install | same | **gate**, single | session growth <= M6's cap (D-M6-18); manager bundle <= 80 KB; install <= 5 s | 212,483 B (J-1410); 11.6 s per 300 k (J-0193) |
| `environments.gitStatus`: `E(workspace).status()` from exec code, 10,000-file workspace (built by `runCommand` unpacking a fixture archive, not by turns) | `perf/environments-git.perf.mjs` | 60 s | median <= 1 s | git 30 ms (J-0811) + 2 manager deliveries (2 x 75 ms, J-0494) + exec call 53 ms + <= 16 KB inbound twice (about 330 ms, D-M6-19) |
| `environments.gitLog`: 50-entry page of 1,000 commits | same | 60 s | median <= 500 ms | git 12 ms (J-0811) + the same hops with a smaller answer |
| `environments.restart`: restart to serving with 20 sessions with environments (each ran one command) | `perf/environments-restart.perf.mjs` | **gate**, 5 runs | each <= 15 s; 0 containers started; 0 idle session vats woken | healthy restart 3.3-6.9 s (J-9382) |
| `environments.coldStart` `[real-runtime]` | `perf/environments.perf.mjs` (gated by `THIX_HARNESS_REAL_RUNTIME`) | 10 runs | **recorded** | - |

File times: `perf/environments.perf.mjs` five 60 s windows, the tooBig and bundle gates (about
20 s) and the template start: about 6 minutes (the real-runtime row adds about 1 minute when
gated in). `perf/environments-git.perf.mjs` two windows, the 10,000-file and 1,000-commit fixtures
unpacked from archives (under 10 s each, J-0811 sizes) and the template start: about 3 minutes.
`perf/environments-restart.perf.mjs` five restarts (each kill, restart and check under 30 s) on a
cached 20-session template: about 3 minutes, plus about 30 s for the template's first build (20 x
1.5 s through scripted turns, cached keyed like the others, `process.md` 3). If a file passes 8
minutes in its first run, its last row moves to a new file.

## 11. Too-big and hostile probes (`environments-command-output.test.js`, `environments-git-hostile.test.js`, `environments-shell-port.test.js`; the vat-facing ones in `environments-shell.test.js`)

| probe | expected |
|---|---|
| 10 MiB stdout, 10 MiB stderr, both at once | each kept to 64 KiB, the JSON at most 32,768 units, staged; no vat halt (`frames` of the session within `vatFrameBytes`) |
| invalid UTF-8 and a NUL in output | U+FFFD replacement; valid JSON |
| one 1 MiB line without a newline | cut inside the field with the marker |
| 2,000 arguments; one argument of 1 MiB; arguments totalling 300 KB | `maxCommandArgs` refusal; `commandArgsBytes` refusal; nothing runs |
| model JSON with 20,000 fresh keys in `options` | `unexpectedArgument` from the adapter; no record with those keys reaches any vat |
| `timeoutMs`: `-1`, `1.5`, `2**31`, `"10"` | `timeoutInvalid` |
| `command`: `/bin/sh`, `../sh`, `sh;rm`, `""` | `notAllowed`; names only |
| a command that forks a background process and exits | the result returns; the background process dies at stop (no lifetime across calls, R3-46) |
| a script trapping SIGTERM with `timeoutMs` 500 | killed 2 s later |
| exec code: `E(workspace).createBranch('--upload-pack=x')`, `'a..b'`, a 300-unit name | `gitRefRefused` / guard refusal |
| `add(['../../etc'])`, `add(['/etc/passwd'])`, `add(['.git/config'])`, a symlink in the worktree pointing outside | `gitPathRefused`; the symlink is staged as a link, never followed for `read` |
| container writes `.git/config` with `filter.x.clean`, `include.path`, `core.fsmonitor`, a hook | writes refused with `gitConfigRefused`; reads do not run any of them (no side-effect file appears) |
| a repository with 100,000 untracked files | `status` answers 1,000 entries, `truncated: true`, under 16 KB |
| a commit subject of 1 MiB made in the container, then `log()` | subject cut to 200 units; answer under 16 KB |
| `read({ path: [...64 segments] })` with `..`; a 1 GB file | refused; at most 1 MiB scanned (Fae's rule) |
| 300 `runCommand` calls in one round | `maxCallsPerRound` 64 refuses the rest; 16 in flight |
| emergency stop twice, resume twice, resume while stopping | idempotent; `finishStopFirst` |
| a session that is not a shell preset calls `emergencyStop` | `noEnvironmentToStop` |
| `openImage` with 65 segments, a 256-unit segment, `['..', 'x']`, `['.git', 'config']`, a FIFO, a 1 GB file | guard refusal; `gitPathRefused`; not a regular file refused; `size()` answers the size and M8 refuses before any read |
| exec code: `readBase64({ offset: 0, maxBytes: 196_608 })` on a workspace image | expected: the hub's frame refusal reaches exec code as a rejection and the exec vat is not halted (as J-10127 for a call frame); else the clamp fallback of 3.4; at 12,288 bytes the page is answered |
| a file replaced by a symlink to `/etc/passwd` between two `readBase64` calls | the second read refused with `gitPathRefused`; no byte of the target read |
| `sendNow` on a waiting entry while stopped; a test part whose `nextTurn` always answers a turn | `sessionStopped`, the hold kept; no turn claimed |

---

## 12. Core requests (CC-090..CC-099)

Settled against `arch-review/core.md` 5 and the spike (X-15): CC-090 and the W6.0 draft's CC-091
are one change, already in core step 4.

**CC-090. A service shape and install-time configuration for native resources (AR-SYN-28,
AR-CTRL-5 (a); core step 4, with its `WORKSPACE_VERSION` bump).** One row in `CORE-CHANGES.md`
under AR-SYN-28. Motivation: the environments resource is the second resource (after the agent
host) whose manager needs its adapter's root, not a passive registration, and whose adapter needs
(a) its implementation directory and (b) a directory of its own in the state directory; both are
guessed today from `argv[1]` and `argv[3]` (HR-SYN-22), and a fake service key stands for the
service. A third resource (M10's listener lives in this one; any later one) would guess a third
time. What a second and third resource need from the core: (1) the manager kit's
`provideAdapter()` (the keeper's `provide()` under the kit's queue), documented in
`pkg/src/native/contract.js` as the service shape; (2) `installNative(name, directory, config)`
keeping a passable record that the launcher hands the ephemeral `make(config)`; (3) the launcher
passing `{ stateDirectory }`, the installation's own directory, computed at each start so state
directories stay path-independent. Workaround if refused or until core step 4: the attach pattern
with a fake service key, written once in `resources/native-attach.js` (D-M6-13), configuration
through the service spec (D-M6-3), and `findStateDir`/`findHarnessRoot` imported from the agent
host.

**CC-091.** Merged into CC-090 (X-15); unused.

**CC-092. Name each adapter process in `status()`** (installation and pid). Motivation: acceptance
11 kills the environments adapter alone, and M11's K11-1 checks its engine processes the same way
(X-15). Workaround: one test helper, `test/integration/_adapter-processes.js` (W6.7), finds the
process among `processesUnder(supervisor)` whose `argv` names the installation's ephemeral bundle
digest; M11 imports it.

**CC-100 (M8's number) also covers M6.** Staged command output (D-M6-6) and workspace image pages
(X-1) are adapter-to-adapter frames that the hub persists in `hub-log.jsonl`; the spike already
measured +2.9-3.0 MB per MiB. M6 asks CC-100 unconditionally with M8, into core step 3's persisted
session kinds; no M6 number is reserved for it.

No other core change is needed; CC-093..CC-099 are unused.

## 13. Owner questions (the default is what M6 builds)

| id | question | default |
|---|---|---|
| O-1 | One `environments` resource instead of two (`workspace`, `containers`)? | one (D-M6-1) |
| O-2 | May a served state use the `fake` runtime (unconfined host processes)? | yes when configured so; `status()` and `inspectShell` say `fake`; provisioning never picks it unasked |
| O-3 | Delete home with the session (R3-46 says until admin disposal)? | delete with the session |
| O-4 | Container limits (W-12; R7-39 found none) | 4 GiB memory, 1,024 processes, 2 CPUs, configurable |
| O-5 | Default command timeout | 24 h (R3-47) |
| O-6 | A failed environment stop: quarantine (R4-81) or retry (D-16)? | retry at the next adapter start and before the next start of that environment |
| O-7 | Git surface: linked worktrees, tree views, commit stream, `show`, `revParse`, `detach`, `checkoutConflict` | not in M6; backlog |
| O-8 | Where the resource's guard table lives (D-M6-10) | `guest/lib/guards/environments.js`, excluded from the gateway vocabulary as not browser-sendable (settled from X-11; the W6.0 draft had it beside the resource) |
| O-9 | Export and import of a session with an environment | workspace and home are not exported; an imported shell session gets a fresh empty workspace (stated in the export's notes); the execution state is exported, and an imported stopped session stays stopped with its new environment withdrawn (X-07, 4.5) |
| O-10 | Fixed texts: Fae's words where they exist; `noEnvironmentToStop`, `commandOutcomeUnknown`, `commandStopped`, `outcomeUnknown`, `runnerRequired` reworded by the harness | as written in section 15 |
| O-11 | The data-reference spike's step 1 for this resource and M8's images (X-06) | not adopted in this group: M6 W6.2 builds `openImage` with adapter-side pages, both lanes accept the hub-log cost, CC-100 asked once; the seams if adopted are `EVI/blob-access.js` and `EVI/image-source.js` (D-M6-6) |
| O-12 | The session program limit (240,000; 27,517 left on the step-3 tree for four lanes whose likely sum is 257-267 K, X-01) | raise `sessionProgramBytes` (about +1.1 s on the cold create per +55 KB, hidden by the spare pool, J-10192); M6 asks a cap of 9,000 bytes (D-M6-18); W6.4 waits for the ruling and the PM's caps |
| O-13 | What Talk does on a state with no environment runner (the `voice` preset needs a shell, X-12) | refuse with `runnerRequired`; the Voice panel offers another shortcut preset (M11's to build) |

---

## 14. The fold at merge (W6.8; done-criterion is deletion, checked by grep or test)

Merge order of the group (X-17): WX.1, the four lanes, then merge M11, M6, M8, M9, each followed by
its own fold, then the group fold WX.F. W6.8 is M6's:

- No provisional seam remains: `grep -rn provisional guest/` is empty and sections 3 and 6 of
  this file name none (the settle resolved them against the built step 3; any WX.1 change of the part API that
  differs from section 6.1 is folded here).
- X-1 aligned with M8 after M8 merges: `image-tool.test.js`'s source cases pass against a real
  `Git.openImage` (M8's fold item 4); the `viewImage` integration case moves to WX.F.
- The `voice` preset's M6 half: `voice` creates with `workspace` and `shell` (acceptance 14); the
  complete preset is WX.F's.
- `ObjectProvider.build` gone from `preset-templates.js` (F-1); `grep -n 'build(context)'` empty.
- `findStateDir` and `findHarnessRoot` move to one shared module (`resources/native-layout.js`)
  imported by both resources; the agent-host side of that move waits for the step-4 reinstall
  (its `ephemeral.js` is installed code) and is listed there.
- `resources/native-attach.js` is the one attach helper: the agent host's copy is listed for its
  step-4 reinstall, or both disappear with CC-090.
- `designs/architecture.md`: 1 (layout: `resources/environments/`, `guards/environments.js`), 2
  (process diagram), 3.4 (this contract's objects replace `WorkspaceService`/`ContainerService`),
  D-16 (lazy workspace too), 9 (container output row), 10 (fake runtime path
  `EVI/runtime-fake.js`, `[real-runtime]` tags); `milestones.md` M6 (status, this file's tables:
  work units 8, acceptance 9, perf 10), M7 and M10 ownership paths (6.4 M-1); `process.md` 3.1
  (the `environments` regression list). The group's ownership-check row is WX.F's.
- `corepack yarn lint:duplicates` at or below the ceiling (2.05 % on the step-3 tree; it may only
  go down); any copy over 15 lines found in review is turned into an export.
- No `notBuilt`, no empty registry, no unused export in `EV/` or `EVG` (the review's grep).

## 15. Fixed texts and the shared guard entries (WX.1 applies these exactly)

Applied by WX.1, not by an M6 unit (D-M6-15).

### 15.1 `guest/lib/guards/session.js`

```js
// texts (beside the existing ones)
sessionStopped: 'Session is stopped or stopping; explicitly resume it in Settings', // Fae assertSessionAdmission
noEnvironmentToStop: 'This session has no shell environment to stop',
finishStopFirst: 'Finish emergency stop before resuming',                           // Fae resumeSession
stopIncomplete: 'Session stop incomplete; retry in Settings',                       // Fae emergencyStop
commandOutcomeUnknown:
  "The command's outcome is unknown: the environment runner restarted while it ran. Inspect the workspace before retrying.",
commandStopped:
  'The turn was cancelled; the environment was stopped while this command ran. Its effects may have happened.',

// shapes
ExecutionState: () =>
  record({ state: M.or('running', 'stopping', 'stopped'), supported: M.boolean() }),
// SessionServices optional part gains:
//   workspace: M.remotable('Git'), shell: M.remotable('Shell'),
//   environment: M.remotable('EnvironmentControl'),

// SessionExportPage optional part gains (X-07, seam X-E):
//   execution: S.ExecutionState,

// Session (latest version) gains:
emergencyStop: M.callWhen().returns(S.ExecutionState),
resume: M.callWhen().returns(S.ExecutionState),
getExecutionState: M.call().returns(S.ExecutionState),

// tool descriptions (A.3; agent-tools json-tools/shell.js at 1315bef86, `exec` -> runCommand,
// `inspect` -> inspectShell), as ToolDescription records like execDescription:
shellToolDescriptions = { runCommand: { name, description, parameters }, inspectShell: { ... } }
//   runCommand.description: the agent-tools `exec` description word for word;
//   parameters: { type: 'object', properties: { command, args, options: { timeoutMs } },
//     required: ['command', 'args'], additionalProperties: false } as agent-tools writes it;
//   inspectShell.description: 'Report the command allowlist, default invocation timeout, and
//     output cap. Reveals no host path.'; parameters: the empty closed object.
shellToolArgumentNames = { runCommand: ['command', 'args', 'options'], options: ['timeoutMs'], inspectShell: [] }
```

### 15.2 `guest/lib/guards/factory.js` and `guest/lib/interfaces.js`

```js
// factory.js, HarnessSettings optional part:
environments: M.remotable('EnvironmentsAdmin'),
// factory.js texts (R3-21; the same words as guards/environments.js environmentTexts.runnerRequired,
// kept equal by a unit test):
runnerRequired: 'A preset that provisions a shell needs a configured environment runner',
// interfaces.js, VatEvent gains:
record({ type: 'execution', state: M.or('running', 'stopping', 'stopped'), supported: M.boolean() }),
```

### 15.3 The part API (`guest/session/runtime-parts.js`, typedefs and `combineHooks`)

```js
// PartHooks gains:
//   @property {() => (string | undefined)} [admit]  asked before a user-facing start and by
//     claimNext; a refusal text, or undefined to admit
// RuntimeHooks gains:
//   @property {() => (string | undefined)} admit  the first part's refusal, in table order
// combineHooks: const admit = listOf('admit');
//   admit: () => { for (const hook of admit) { const refusal = hook(); if (refusal !== undefined) return refusal; } return undefined; },
```

### 15.4 `guest/lib/vocabulary-tables.js`

```js
// vocabularyExclusions gains:
'guards/environments.js':
  'environments manager vat and adapter table; no browser path reaches these objects',
```

### 15.5 The resource's texts

`EVG` `environmentTexts` and `environmentTextOf`, committed with this contract
(`outcomeUnknown` is D-M6-5's manager rejection of a forwarded write).
