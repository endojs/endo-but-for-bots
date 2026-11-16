# Critique: coverage and contract fidelity of the harness build plan

Reviewer step, 2026-11-16. Inputs: `plan/architecture.md` (A), `plan/milestones.md` (M),
`plan/journal-seed.md` (J), `survey/spec-digest.md` (SD), `survey/reuse.md` (RU), checked against
`endo-harness-spec.md` (SPEC): Part I, section 10 (SPEC:1154-1242), 7.8 (SPEC:949-971), 9.2
(SPEC:1077-1109), Appendix A.4 (SPEC:1545-1650), Appendix F (SPEC:3024-3460).
Line numbers are for those files. Items are marked **B** (blocking: the plan must change before
building) or **A** (advisory). Guesses are marked [inferred].

---

## 1. P-01..P-67 coverage

Every item number appears in at least one milestone or in the backlog. Mapping:

| Milestone | P items |
|---|---|
| M1 | 03, 08, 09, 10, 13, 14, 16, 21 |
| M2 | 05, 08, 10, 11, 12, 13, 15, 25, 26, 27, 46 |
| M3 | 01, 02, 04, 22, 23, 24, 27, 48 |
| M4 | 05, 06, 07, 26, 45, 46, 58 |
| M5 | 15, 16, 17, 20, 40, 49, 53, 65 |
| M6 | 12, 18, 19, 20, 47, 55 |
| M7 | 38, 39 |
| M8 | 27, 36, 37 |
| M9 | 41, 42 |
| M10 | 43, 44, 64 |
| M11 | 30-35, 61, 66 |
| M12 | 28, 29, 50, 51, 52 (partial), 54, 56, 57, 67 |
| Backlog | 59, 60, 62, 63 |

Gaps and weak assignments:

1. **A - P-59, P-60, P-62, P-63 are deferred for reasons that are not the owner's principles.**
   M:668-675 gives "occasional; large" and "needs a device". The owner's out-of-scope list is host
   infrastructure (forge, reverse proxy, release machinery, browser peer relay), Whylip, irrelevant
   slash commands. P-62 (daemon-to-daemon peers, SPEC:1225) is not the browser peer relay; P-59
   (workflows) and P-60 (Android) are not infrastructure. The plan correctly raises them as open
   decision 7 (A:637-638); until the owner answers, the plan must not report parity as complete.
   State this in M's backlog heading.
2. **A - P-52 (core capability model, SPEC:1215) has no work unit and no acceptance test.** M12
   lists "P-52 (operator-visible parts)" (M:604) but no W12.x builds or tests reserved-name
   replacements (endowments), host/guest identities, directories, confined evaluation, plugin
   installation with explicit powers or cancellation. Either map each sub-feature to the
   Thixotrope primitive that already provides it (inventory, `install`, `install-native`,
   `retire`) and test it, or record each as "provided by Thixotrope, checked by test X".
3. **A - P-04 internet toggle is unassigned.** P-04 is in M3 (M:223) but the "switch internet access
   on or off where the preset allows" part depends on M7's network policy; neither M3 nor M7
   acceptance tests cover the toggle in the new-session flow. Add it to M7 acceptance.
4. **A - P-54 CLI is narrower than the item.** P-54 (SPEC:1217) asks for running setup scripts with
   chosen powers, evaluate, list/show, read and send mail, create agents, inspect. W12.2 (M:616-617)
   builds status, sessions, secrets import, rotate sign-in, reachability. Say which of the rest the
   `thix` CLI already provides and which are dropped as admin-irrelevant (owner principle 2 allows
   that, but it must be written down).
5. **A - P-45 account status has no acceptance test.** W4.5 builds it; M4 acceptance 1-6 (M:299-308)
   never checks plan/windows/provenance labels or the `accountStatus` tool (SD:279 has the test).
6. **A - P-29 "clears what a previous run left behind before starting"** has no test (M:623-624 test
   only "serve without state refuses").
7. **A - P-35 per-message replay and level meter, P-49 "preset used by the voice shortcut"** are only
   covered by reference to SD M6 tests; SD M6 tests do not cover replay or the voice-shortcut
   preset setting. Add them to M11.
8. **A - P-53 and P-40 depend on an operator inventory that is built in M12.** M5 (parallel with M3,
   before M12) must test "custom presets may add capabilities from the operator's inventory" and
   "@-mention an inventory object" (M:354). The inventory view and the composer are M12/M3 work.
   Either move a minimal operator inventory into M5 or move those two tests to M12.
9. **A - Cross-references to SD test numbers are fragile.** M9-M12 acceptance says "spec-digest M2
   tests 5-8", "M4 tests 9-10", "M6 tests 1-9", "M7 tests 1-3 and 6" (M:522, 552, 585, 623). SD's
   milestone numbers differ from the plan's (SD M2 = plan M5/M8/M9). Copy the test text into M.

---

## 2. Contract behaviours with subtle semantics

### 2.1 Server-owned queue and idempotent submission (R4-52..R4-56)

10. **B - The queue-entry lifecycle at restart contradicts R4-54/R4-66 and can post a message twice.**
    A:358 records `TurnStarted{input}` in the claim crank, i.e. the journal has the input at claim.
    Per A.4 (SPEC:1619-1620 row "Entry state dispatching") the entry must then be removed ("removed
    once the journal has the input"). But A:363 removes the entry only at `TurnSettled`, and A:372-373
    says that for a turn with no `Dispatched` record "the queue entry returns to the queue". The turn
    is closed "Interrupted before dispatch" with its input already in the transcript, and the
    re-queued entry is sent again as soon as any new message or send-now releases the `restart` hold
    (R4-56): the user's message appears twice. Fix: remove the entry in the claim crank (atomic with
    `TurnStarted`), so an `interrupted` entry can never arise; on restart close the never-dispatched
    turn with the R4-66 text and do not re-queue. Record in the journal that atomic claim+record
    removes Endo's `interrupted` window (a good fit), and test it (M1 acceptance 7 does not).
11. **A - Hold release semantics are untested.** R4-56 "a new message or send-now releases every hold
    except `interrupted`" and the fixed hold texts are in W2.4 but no acceptance test exercises them.
12. **A - `startTurn` refusal text (R4-10) is untested.** "Session already has an active turn; observe
    or cancel it first" (SPEC:463, A.4 SPEC:1588). Add to M2.
13. **A - Request-id window with stale time.** A:499-501 falls back to "receipt membership when stale".
    Once 4,096 receipts have rotated, a stale `lastKnownTime` cannot reject an old id; say whether the
    gateway stamps `at` on every `enqueueOnce` (it can: it is an adapter) so the vat is never stale on
    this path.

### 2.2 Cancel (R4-7, R4-49, P-12)

14. **B - Cancel retires the exec vat, which destroys the persistent scope.** A:441-442 "on timeout or
    turn cancel, retires the exec vat". R4-49 says a running tool is not interrupted (except the shell
    environment), and the persistent scope (F.1 #5, SPEC:3049; M1 acceptance 8) is the main object-
    passing gain. Users press Stop often; each Stop would silently delete every `globalThis` binding.
    Fix: on cancel, abandon the pending exec answer (turn generation check, as A:377-378 already does
    for restart) and leave the exec vat running; retire only on the exec deadline or when the exec vat
    is still busy when the next exec call arrives (then report "previous call still running"). Record
    the scope loss in the tool result and in the journal whenever it happens.
15. **A - What cancel does with unsettled calls is unspecified.** R4-44 "a turn cannot complete while
    any call is unsettled" versus cancel recording `cancelled` at once. Say which applies and how late
    results for a cancelled turn are recorded (ignored, or recorded as late results).
16. **A - Cancel on subscription backends** must also revoke the endpoint (R4-49). `RoundControl.cancel`
    (A:255) closes the stream only; say whether the Endpoint object is revoked.

### 2.3 Tool call recorded before it runs; all calls of a round in parallel

17. **A - Intent-before-effect rests on one unverified property.** A:350-354 relies on "the hub commits
    a crank's outbound frames before forwarding them" (core.md:64-66, README 875-884). It is stated
    in the README and in CI SIGKILL tests, but none of the M0 spikes kills the daemon between crank
    end and forward to a *transient adapter session* (S4 only checks `hub.json` contents). Add a spike:
    SIGKILL right after the session vat issues a tool call to the containers adapter; after restart the
    journal must show the intent and the adapter must not have run the command twice.
18. **B - A round with many tool calls quarantines the session vat.** A:317-319 issues all calls of a
    round "from this crank"; A:519 and rule 12.3 (A:613) cap eventual sends per crank at 200 and >250
    measured MeterAbort (J:266). A model can return 200+ tool calls in one response (nothing in the spec
    bounds calls per round), and each call also triggers publish sends and answers. A quarantine is
    permanent loss of the session. Fix: an explicit calls-per-round bound (refuse the extras with an
    error result, R4-45 style) or spread issue across cranks with a self-sent continuation; add a
    too-big probe (300 tool calls in one round) to M1 perf.
19. **B - Oversized inbound frames have no delivery path, only a cap.** A:514 caps frames into a vat
    at 256 k characters, adapter-enforced, but nothing says what the adapter does when a legitimate
    `roundFinal` exceeds it: OpenRouter and Codex have no output limit (R4-92), the message may carry
    native context (Claude signed thinking, Codex encrypted reasoning, R4-31) and tool-call arguments
    (a model writing a 300 k file through `runCommand` or a long `exec` body). Truncating violates
    R4-31 (faithful replay) and R4-64 (content never deleted); refusing fails the turn. Fix: a
    chunked hand-over (adapter writes the oversize parts to the blob store and passes `Blob` handles +
    previews in `roundFinal`; the vat records handles; the context cache already lives in the
    adapter) and a too-big probe in M1/M2 (`roundFinal` of 1 M chars, a 300 k `exec` body).
20. **A - Parallelism test should also cover non-exec tools.** M1 acceptance 4 (M:118-119) uses two
    `exec` calls; both go to the one exec vat, which runs one crank at a time. They overlap only
    because `sleep` is async. Add a mixed round (exec + runCommand + object tool) in M6.

### 2.4 Restart: in-flight turn unknown, no replay (R4-65..R4-67, P-14)

21. **A - Child work keeps running after the parent turn is marked unknown.** Guest-to-guest promises
    survive restart (A:33-34, J-0002). After restart the parent's turn is `outcome-unknown`, but an
    `askSubagent` child and an exec call continue and spend tokens for a dead turn; their late results
    are ignored (A:377-378). In `recoverAfterRestart`, cancel in-flight child asks (`E(child)...cancel`)
    and record that. Also R4-67 requires the ask to fail ("inbox loop ended"), not resume silently;
    M9 says "fails rather than hangs" (M:520) but the mechanism (who rejects a surviving promise) is
    not designed.
22. **A - Recovery trigger depends on the factory's row being current.** D-5 (A:152-159) wakes only
    sessions whose factory row says `working` or whose queue was non-empty. Rows arrive by
    `E.sendOnly(...).rowChanged` (A:208). Say why the factory's start listener cannot run before the
    last `rowChanged` frames are delivered [inferred risk], or let the session vat recover itself when
    the hub delivers the rejection of its pending adapter calls (it is woken by that delivery anyway).
23. **A - reuse.md is wrong on replay.** RU:353 says "an interrupted provider call must be recorded and
    re-issued by the guest". That contradicts R4-66 and the architecture (A:374-376). Add a note in
    M1 so builders do not follow RU here.
24. **A - Dormant deviation from R4-65 is properly flagged** (A:152-159, open decision 2, J-0015) and
    matches the owner's recorded decision; fine.

### 2.5 Fixed system prompt and model (R4-22, R4-26..R4-28)

25. **A - Model and backend fixity is untested**, and R4-21's "empty model follows the factory's
    configured model" means an unpinned `provider` session's model can change later. Decide whether
    the session stores the resolved model at creation (recommended; it then satisfies R4-22 literally)
    and test "change the factory default; an existing session keeps its model".
26. **A - `createSession({ model })` conflicts with R4-6**, which says an option named `model` is
    rejected (the key is `modelId`, SPEC:1551). Either use `modelId` or record the rename.
27. **A - The guest prompt section must change with the persistent scope.** R4-26 part 2 tells the model
    "each call is a fresh function body, so nothing defined in one call is visible in the next".
    With D-11 that text is false; W5.2 must rewrite it (and the `store`/`remove` guidance) and record
    the deviation.

### 2.6 Credentials never visible to the session (R4-16, R7, P-26)

28. **B - The `services` record handed to session vats is unspecified and, as sketched, over-grants.**
    A:215 `make({ config, services, factoryInternal })` and D-13 (A:483-488) push the factory's
    services to sessions. `AgentHost` (A:243-252) has `getSecrets()`, `serveGateway`, `makeBackend`,
    `onStart`. If sessions receive `host` (the natural reading of `setServices({host, ...})`, A:180),
    any session, and model code if `powers` exposes it, can create or revoke Secrets, open a
    `SecretWriter`, register listeners or mint backends. Fix: define a per-session attenuated record
    (its Backend/Endpoint, its LiveChannel publisher facet, its BlobStore, its Workspace/Shell, a
    clock) and test with `thix reachability` from a session vat and an exec vat that no Secret admin,
    `SecretsAdmin`, `AgentHost` or gateway facet is reachable (M4 acceptance 5 checks only Secret
    admin/value). Same for `factoryInternal`: it must be a per-session facet that can only report
    that session's row.
29. **A - `SecretWriter.replace(secret, ...)` needs the Secret's internal entry reference** (D-6,
    A:264-267). Do not add a public `entryRef()` on `Secret` (a text id would become admin authority,
    against F A.2 "no admin-by-secret-id path", SPEC:3162); use rights amplification inside the
    resource (a manager-side WeakMap from Secret exo to entry, with the writer asking the manager).
30. **A - LiveChannel combines publish and subscribe on one object** (A:260) and is handed to browsers
    (A:342-346). A browser could inject fake events into other viewers' streams. Split into a publisher
    facet (session vat only) and a subscriber facet (viewers).

### 2.7 Subagent limits (R4-69..R4-73, R4-101, R4-102)

31. **A - Covered in M9 (M:517-520)** with tree 8, depth 2, R4-71 text, inheritance and stop
    depth-first. Missing: "counting in-flight spawns" in the test, the 65,536 retained-asks bound
    (R4-102, owner's PR 1248 rule), answer cap 16 Mi then tool limit, and subagent cost: each child is
    another session vat (+ exec vat), so a full tree is ~8 x 36 MB and 8 x 4.4 s without spares.
    Add a perf check for a burst of 8 spawns against a pool of 2.

### 2.8 Compaction (R4-34..R4-37)

32. **A - Who decides to compact must be the vat.** A:396-398 plans compaction in the adapter. R4-34
    triggers "before a round" from the previous reading and postpones after new images; R4-35 must
    never hide unknown outcomes, which are vat records. Say that the vat makes the decision (it has the
    reading) and records a `CompactionStarted` intent before the summary round, so a restart during
    compaction is an ordinary outcome-unknown round, not a half-applied checkpoint.
33. **A - Giving Claude/Anthropic a configured window** (M:480) deliberately departs from R4-37
    (and fixes G-04/G-05). Record it in the journal as a spec deviation.

---

## 3. Object-passing conformance (Appendix F)

The interfaces are largely object-passing: factories return objects; `QueueEntry`, `Turn`, `Route`,
`Secret`, `Blob` carry their own methods; strings remain for keys (d), request ids (e), cursors and
refs (d), model ids (c), labels (a)/(b). Specific points:

34. **A - Two name stores are being built.** M5 W5.3 keeps `store`/`remove`/`lookup` over a session
    "label map" (M:346) and W5.4 mirrors it into exec `powers` "refreshed on adopt/store/remove"
    (M:347). F.4 (SPEC:3308-3309, rows `store`/`remove`: "drop") recommends the persistent scope
    instead. Keeping a separate label map plus a copied `powers` record recreates the pet store and
    needs synchronisation. If P-17 parity requires the tools, make the label map the single store and
    give exec a live read facet over it (not a copy); otherwise drop `store`/`remove` per F and record
    it.
35. **A - Last-served (stickiness) records need a key.** R4-24/R4-103 keep up to 256 durable last-served
    records (A:140). Endo keys them by `sessionId` (F A.2 `openEndpoint({sessionId})` keep (e),
    SPEC:3205). Say whether the plan keys them by the session object (manager-vat WeakMap) or by the
    session key text; either is allowed, but it must be decided.
36. **A - `liveChannelFor(session)` keyed by a presence in an adapter WeakMap** (A:247, 331-333) relies
    on the presence identity being stable for one adapter incarnation [inferred]. S2 should check it.
37. **A - No F violations found** in `findSession(key)` (d), `getTurnContent(ref)` (d), `opId` text
    (journal marker, F.1 #15), `makeBackend({kind})` (c), install CLI arguments (c). `Turn.resolve(note)`
    is a correct object form of `resolveTurn(turnId, note)`.

---

## 4. Known defects and weaknesses (SPEC:1232-1242, W-n, G-n)

38. **B - The W-8 fix does not work as designed.** A:467-468 keys the failed-attempt limiter "per client
    address", and the adapter binds loopback behind an (out-of-scope) reverse proxy (A:459-460). Every
    client then has the proxy's address, so the limiter is global again: W-8 reproduced. Use a
    configured trusted-proxy setting and the forwarded client address (SD:319 says exactly this), and
    test it with two forwarded addresses.
39. **B - G-19 is reproduced.** A:446-447: container output is cut to 64 KiB per stream, then the
    whole result is cut to 32,768 units. The result is the JSON `{exit, stdout, stderr, truncated}`
    (A:282), so the outer cut yields unparseable JSON, exactly G-19 ("do not copy", SPEC:1097). Same
    for `readSources` (48,000 budget) and `askSubagent`. Fix: budget each field so the serialised
    result stays under the tool limit (stdout/stderr cut with markers inside the JSON), and test that
    every tool result with 10 MiB output is valid JSON.
40. **B - Voice stream timeouts are missing.** The defects list (SPEC:1240) names "voice streams have no
    timeouts"; SD:323 and SD:534 call for STT/TTS inactivity timeouts (R5-67). M11 (M:563-595) has no
    timeout behaviour or test. Add an inactivity timeout to the audio route and engines with a test.
41. **A - W-3 / `full-control` is built in M6 before its authority is decided.** P-20 needs it; open
    decision 5 (A:633-634) is unanswered. Make M6's `full-control` work unit wait on the decision, and
    default its network to `off`.
42. **A - W-4 only partly fixed** (key outside the state directory but readable by every unconfined
    adapter of the same user). J-0027 says so honestly; keep it visible in open decision 4.
43. **A - G-05: Claude overload retry.** W4.3 implements R4-76 ("does not retry"); G-05 says do not copy
    and SD:354 asks for an overload retry. Decide and record.
44. **A - G-31 copied.** W6.4 "failed stop quarantines the agent (R4-81)" reproduces G-31 (improve on).
    Since the containers resource owns its registrations, a failed stop can be retried by the manager
    at the next adapter start; design that and test it with the fake runtime.
45. **A - Decisions the plan does not raise:** G-10 spending limits, G-11 voice preset pinning a model
    that may leave the catalogue (P-61 work in W11.5), G-15 date in prompt, G-26 backend for
    agent-built apps, G-33 retention. Add to A section 13 open decisions. The 30-minute turn deadline
    (A:524) departs from R4-48 and may cut legitimate development turns; add it to the open decisions
    too.
46. **A - Collection waits until M13.** G-29/G-30 fixes (vat, blob and directory reclamation on delete)
    land in M13 (M:650-651), but M2 already "deletes" sessions (R4-9) and the disk has about 21 GB.
    Retire a deleted session's vats and blobs in M2's delete; leave only `collectVats` sweeping to M13.
    Also R4-9's "a delete interrupted by a restart completes afterwards" and R4-6's "failed creation
    leaves nothing half-made, including after a restart" have no test anywhere.
47. **A - W-1, W-2, W-6, W-12, W-13, W-14, W-15** are designed out adequately (Origin check, rotation,
    no sudo mount, exec vat, container limits, bounded exec console, sandboxing CSP, app CSP). W-13:
    also forbid adapters from logging tool arguments and results.

---

## 5. Nothing out of scope is built

48. No milestone builds Forgejo, a reverse proxy, NixOS release machinery, Whylip or the browser peer
    relay. M10 explicitly defers per-publication subdomains because they need the proxy (M:559); M12
    ships only a launchd/systemd sample (M:615). M13's upgrade is application data migration, not
    release machinery. **No finding.**
49. **A - M0 edits Thixotrope core** (`rust/endo/xsnap/src/polyfills.js`, `pkg/src/core/evaluate-source.js`).
    That is in scope (the work tree is the build target) and is flagged as CORE-1/1b; keep it in its
    own commits so it can be upstreamed separately.

---

## 6. Acceptance tests: behaviour versus implementation

Most tests are observable through the public API, the browser or the network. Implementation checks
that should be restated:

50. **A** - M2 acceptance 8 "the session vat's resident record count stays <= 256 turns" (M:195-196):
    restate as observable (history complete back to turn 1; snapshot message <= 64 k chars; session
    vat snapshot size bounded) and move the count to a perf metric.
51. **A** - M1 acceptance 4 "the journal shows one intent record before both results" (M:119): check it
    through `getHistoryPage` (the public record), not by reading vat state.
52. **A** - M1 acceptance 7 "idle sessions were not woken (engine wake counters)" and M0 acceptance 2-3
    (`test:ironhorse` 55/55, spike verdicts recorded) are process or implementation checks; fine as
    gates, but they should be listed as perf/gate checks, not as acceptance behaviour.
53. **A - Contract behaviours with no test at all** (in addition to items 10-12, 25, 46): R4-32
    (prior failed/cancelled/unknown turns are in the next context, with the "Tool outcome unknown"
    text), R4-31 (native context replayed faithfully after a restart that rebuilds the context
    cache), R4-57 (subagent replies claimed first, own echoes dismissed), R4-83 (usage `skipped if not
    read in time`), R4-62 (reload re-attaches through `getCurrentTurn`), SD M3 tests 8 and 12 (raw
    view, "Load earlier messages", highlighted exec source), SD M6 test 4 "a finished turn replays to
    the end" (W11.3 computes speech from the live channel, which no longer holds a finished turn:
    design the replay source).

---

## 7. Journal seed honesty

The seed is mostly honest (J-0016..J-0025 state the hard limits plainly, J-0027 admits W-4 is only
partly fixed). Problems:

54. **B - J-0004 hides an incompatibility with dormant-after-restart.** It calls registration restore
    "restart recovery for free" for containers (J:66-71). native.md:177-178 and 288-289 say `restore`
    re-binds *every* desired registration at every start, i.e. every development session's container
    is restarted at boot. With 50 sessions that breaks the restart budget (A:596, 15 s) and the owner's
    dormant decision (D-5). The containers resource needs a lazy desired state ("may run"; started on
    first `runCommand`, stopped on idle) and a restart perf check with 20 sessions that have
    environments. Re-grade J-0004 to awkward and add an entry.
55. **A - J-0002 is graded "good fit" but is mixed**: surviving guest-to-guest calls also mean
    runaway child work after a restart or cancel (items 14, 21).
56. **A - J-0006 "good fit" omits the cost it causes**: 3.3 bytes per character of snapshot, state dir
    doubling while running, and the 256 MiB chunk wall (A:404-406) are why D-10's archive exists.
    Grade awkward for disk and snapshot.
57. **A - Missing poor-fit/incompatible entries** that the plan already acts on: the submission limit
    cut from 100 M to 200 k characters (open decision 1) is a spec deviation forced by frame cost;
    "two places for content" (resident journal + blob archive, M:212); one agent-host adapter process
    holding gateway, providers, secrets, live channels, blobs and speech (one crash takes everything
    down, and audio decoding runs beside tokens); the 50 ms full GC per crank treated as fixed
    (A:18-21) without a journal entry asking whether a core change (conditional GC) would be the
    largest available speed-up.

---

## 8. Performance coverage gaps (owner principle 3)

58. **B - No check covers several sessions at once.** Every budget in A section 11 is single-session.
    All vats' journals are fsynced by the supervisor's single Node thread (core.md:36-39), and the
    factory vat receives `rowChanged` from every working session (A:207-209) at about 15 deliveries/s
    total. R4-11 expects sessions to run concurrently. Add to M1/M2: 10 sessions streaming turns with
    tool rounds at once; measure per-session turn start, crank latency p95, factory row latency and
    list-viewer push latency. Restrict `rowChanged` to row-visible changes.
59. **A - Archive cost is unmeasured.** Moving 256 turns (~2 M chars) to blobs in 32 k pieces is ~64
    answered puts (~128 deliveries, ~8 s of session vat time, A:410-413). Add `journal.archive` to M2
    perf, and use sendOnly appends so a session is not blocked mid-turn.
60. **A - Snapshot cost under load**: checkpoints copy the whole DB every 256 deliveries
    (core.md:44-51, 6.7 s in production). Measure the turn latency spike when a busy session vat
    checkpoints mid-turn.
