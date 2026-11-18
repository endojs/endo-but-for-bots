# Architecture reviews of Thixotrope and the harness

Two read-only architecture reviews made on 2026-11-18, one of the core
(`packages/thixotrope`) and one of the harness built on it (`packages/thixotrope-harness`, written
in three days by about 150 agent runs, milestone by milestone, against written contracts). The
owner asked for "a review of the code base to identify clean architecture, repeated code,
excessive code paths, ensure ontological consistency, and catch other issues and code smells".
Both reviews were made to decide what to fix before milestones M6 to M13 are built.

| review | synthesis | area reports | findings in the synthesis |
| --- | --- | --- | --- |
| core | `core.md` (AR-SYN) | `core-net.md`, `core-daemon.md`, `core-control.md`, `core-apps-tests.md`, `core-ontology.md`, `core-duplication.md` | 31 ranked rows |
| harness | `harness.md` (HR-SYN) | `harness-guest.md`, `harness-host.md`, `harness-edge.md`, `harness-tests.md`, `harness-ontology.md`, `harness-duplication.md` | 38 ranked rows |

`tools/find-duplicates.mjs` is the duplicate-block finder both reviews used.

## How they were done

- **Readers.** Each review ran six area units in parallel: four by area of the tree, one for
  ontology (question 4) across the package, one for repetition and excess paths (questions 2 and
  3) measured across the package. Every unit answered the same five questions (architecture,
  repetition, excess paths, ontology, other smells), gave each finding a severity, file and line
  references, the smallest fix, its size and its risk, and said what is good and must be kept.
- **Evidence marks.** Every claim is **read** (the code was read), **measured** (a script counted
  it: import graphs, export-use counts, duplicate windows, function lengths, term counts, all kept
  outside the repository) or **inferred**.
- **Refuters.** Two verification units per review re-read each major and moderate finding at its
  cited lines and answered confirmed, confirmed-smaller or refuted, with the risk of the proposed
  fix and what the readers missed. No finding was refuted; many fixes were corrected (each
  synthesis lists them in its section 3.2).
- **Synthesis.** One unit per review merged duplicates across reports, kept only verified findings
  in its ranked table, listed the rest apart, named the root causes, and proposed an order of
  work.
- **What was run.** Nothing that starts a supervisor, a test, a lane, a build or a perf check.
  Correctness findings are confirmed by reading, not reproduced. The harness test-time figures
  come from the existing run record (`runs.jsonl`), the bundle figures from journal entry J-9933.

## Top ten across both reviews

| # | id | sev | what | class |
| --- | --- | --- | --- | --- |
| 1 | AR-SYN-1 | major | Hub retirement commits and sends in pieces; a throw or kill in between leaves a half-retired session whose cleanup never completes | do now |
| 2 | AR-SYN-2 | moderate | Shipped guest closures are guarded only by a hand-bumped `WORKSPACE_VERSION`; nothing fails when a bump is forgotten | do now |
| 3 | AR-SYN-3 | moderate | A retried vat retirement skips its own cleanup and never releases the image | do now |
| 4 | HR-SYN-1 | major | Harness contract scaffolding left after the merge: interface tables in up to three versions, views, widenings, an exec copy, 546 milestone-named identifiers; it also uses up the session program's byte budget | with the per-vat split (in hand) |
| 5 | HR-SYN-7 | moderate | The gateway's key vocabulary is collected by a file-name glob; the per-vat split can silently narrow it and refuse valid calls | do now |
| 6 | AR-SYN-5 | major | The vat life cycle has no owner: about ten transport flags, failure metadata on disk, a retry policy written twice | with C-8, C-10, C-11 |
| 7 | HR-SYN-2 | major | The agent-host manager part is not thin: adapter policy in a vat whose every change is a reference-breaking reinstall, with no reinstall migration yet | before M6, one reinstall |
| 8 | HR-SYN-3 | major | The provider seam is four shells around one round runner; the scripted double is a second round engine, so most integration tests prove the fake's path | before M6 (shell); plan (double) |
| 9 | AR-SYN-6 | major | A hub session's kind is a key prefix, seven attach flags and three outbox loops | with C-2 |
| 10 | HR-SYN-4 | major | The turn runner is one 1,560-line closure with eight jobs, reached into by other modules | before M6, after the split |

Next in line: AR-SYN-7 (vat GC parses the hub's files), AR-SYN-9 with HR-SYN-34 (failures told by
text), HR-SYN-5 (one wrapping key, three loaders), HR-SYN-6 (the UI controller), and the
correctness items HR-SYN-8 to HR-SYN-12.

## Root causes in one line each

- **Core:** closures grown by accretion; concepts passed as strings and flags; life cycles with no
  owner; a hand-kept version gate with compatibility code kept beside it; an application (mail)
  and an unbuilt engine (XS) inside the core; state bounded by history, not need.
- **Harness:** contracts kept as code after the merge; later lanes copied what they could not edit;
  the milestone used as a name; texts and file names at the seams; fakes built to the contract
  text; the durable half eroded by appending; closures that grow. Section 4 of `harness.md` says
  what in the building process to change for M6-M13.

## Combined order of work

The two packages' steps are independent except where a row says otherwise.

1. **Now, both packages, no format or manager change.** Core step 1 (retirement in one commit,
   retire retry, `appendJournal` repair, transient frames, inbound abort, `stop()`, the
   shipped-source digest, lane timing). Harness step 1 (vocabulary list and zero-skip test before
   the split merges, blob quota sweep, Composer pre-check, `unexpectedFailure` required, state
   directory once, perf windows, template ids, ARCH and glossary).
2. **Harness: fold the contracts inside the per-vat split** (harness step 2). Frees the session
   program's bytes that steps 3 and M6 need.
3. **In parallel: core step 2** (one owner for the vat life cycle, then C-8, C-10, C-11) **and
   harness step 3** (turn runner, runtime parts, one API provider shell, one catalogue core, the
   secret-write fixes with the sealed-writes work).
4. **Core step 3: hub-state version 3 with C-2's open part and C-18.** The typed retirement break
   (AR-SYN-9) changes the harness's `guest/lib/retired.js`, the Composer's retired-break rule
   (HR-SYN-10) and the perf modules that read the hub's files (HR-TEST-17) in the same change.
5. **One shipped-source bump and one manager reinstall together:** core step 4 (XS decision,
   compatibility paths, the native service shape AR-SYN-28, the control socket) with harness
   step 4 (the manager part made thin, pagers by serial, `logPath` out of the spec), so the agent
   host also drops its fake service key and its directory walk. If the core bump is not ready when
   M6 starts, do harness step 4 alone and accept a second reinstall later.
6. **Before M6 opens: harness step 5** (test-support layer, fakes on the real guards, UI feature
   state seam, subject-named tests, and the new conventions written into `milestones.md` and
   `process.md`). **Then core step 5** (structural splits, the mail decision, the glossary
   applied).

Plan items, each alone and after these: the scripted provider on the shared round runner, the UI
controller split, per-purpose subkeys for the wrapping key (a dual-read migration; the Secrets store
must never be wiped), the hub, daemon and supervisor splits, and mail out of the core.
