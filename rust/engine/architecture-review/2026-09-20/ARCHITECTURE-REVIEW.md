# IronHorse engine: architecture review

| | |
|---|---|
| **Created** | 2026-09-20 |
| **Reviewed commit** | [`62b907421`](https://github.com/endojs/endo-but-for-bots/commit/62b9074217aaf2907717f387ab2da98c54953f4b) (`chore(ironhorse-fuzz): rewrite the seed corpus for the second boot move`) |
| **Branch** | `bots/llm`, reviewed on `codex/ironhorse-architecture-review-2026-09-20` |
| **Scope** | `rust/engine`, `rust/endo/src/ironhorse_engine.rs`, `rust/endo/ironhorse-store-sqlite`, the pinned XS sources used by `xs-oracle`, and the current CI/design contracts |
| **Method** | Three region maps, three cross-cutting lenses, and three independent verification passes; see [Method](#method) |
| **Result** | 9 current findings: 1 high, 6 medium, 2 low; 3 are new defects, 1 is a previously documented lead now promoted, and the rest are current known or inherited risks |

Every line number in this directory refers to reviewed commit `62b907421`.
Read citations against that commit after the tree moves.

## Executive summary

IronHorse has moved materially beyond the architecture described by the first
review.
The VM is decomposed, the persistence seam has a non-overridable admission gate,
the compiler has totality matrices, native recursion and resource stops fail
closed, and the current suite outside the conformance/oracle package is green.
The strongest parts of the system are its explicit trust transitions:
compiled source is linked before execution, store content is decoded and
validated before adoption, metering receipts are reconciled at crate seams, and
side-table persistence is governed by a mechanical roster rather than an
informal list.

The most serious current issue is a compatibility-identity gap.
The snapshot boot fingerprint includes an Intl data identity, but that identity
is derived only from the ICU dependency graph.
In-tree Intl algorithms and tables can change guest-visible results without
changing the fingerprint; the source itself records that this happened when
compact notation landed.
Two replicas can therefore accept the same persisted state as compatible and
produce different answers.

Two new defects sit on recently changed surfaces.
A caught failure late in guest `Compartment` construction is not transactional:
it leaves the machine in the shared-compartment profile and retains a provisional
environment, changing later snapshot eligibility even though no compartment was
successfully constructed.
The pinned XS compiler oracle also converts out-of-range doubles to signed C
integers before checking representability.
That conversion is undefined behavior, is hidden by the upstream-wide UBSan
exclusion, and currently makes three required `ironhorse-262` gates fail while
the IronHorse lexer produces the defined ECMAScript answer.

The storage architecture remains fail-closed at the data-adoption boundary, but
its operational error contract is not yet precise enough for a supervisor.
SQLite maps foreign databases and malformed durable rows into retryable I/O,
while `BaselineMismatch` combines lineage refusal with authenticated-content
corruption.
Separately, the commit protocol has no outcome for “the write may be durable but
the acknowledgement failed”; the persistent worker assumes every returned error
left the previous epoch durable and may invite redelivery.

The review found two concrete regexp conformance errors that equality with the
pinned XS oracle conceals: empty `v`-mode sets are rejected, and legacy `u`-mode
negative Unicode properties use the `v`-mode fold/complement order.
The low-level VM string path is correct, but the crate's public `run(&str)` helper
also passes ordinary UTF-8 into a modified-CESU-8 matcher, and public mutable
`Program` fields let a Rust caller violate matcher invariants and panic it.

The recommended sequence is:

1. Bind all guest-visible deterministic semantics into compatibility identity.
2. Make guest-compartment creation transactional and give inherited compiler
   authority a lifetime tied to the child environment.
3. Repair and explicitly version the XS oracle overlay, then restore the red
   conformance gates.
4. Split persistence integrity, lineage, and retry outcomes, including an
   outcome-unknown reconciliation path.
5. Separate standards conformance from XS fidelity in the regexp test strategy.

### Findings at a glance

| Id | Severity | Provenance | Finding |
|---|---|---|---|
| F001 | High | Known current gap, independently verified | In-tree Intl semantics are not fully bound into compatibility identity. |
| F002 | Medium | New, reproduced | Failed guest `Compartment` construction is not transactional. |
| F003 | Medium | Documented lead, now structurally verified | A guest child's compiler authority expires with its creator. |
| F004 | Medium | New, reproduced | Undefined behavior in the XS numeric oracle makes required gates unsound. |
| F005 | Medium | New, independently reproduced | XS parity conceals two current RegExp conformance errors. |
| F006 | Medium | Inherited and self-acknowledged | Store failure classes merge retry, refusal, and corruption. |
| F007 | Medium | Inherited protocol risk | The checkpoint protocol cannot represent an ambiguous durable outcome. |
| F008 | Low | Previously mapped/known hardening debt | The public RegExp crate exposes incompatible and unchecked representations. |
| F009 | Low | Residual verification debt | Persistence fuzzing does not compose execution with durable reopen. |

## Method

The review followed the staged model in the 2026-09-06 review, at smaller scale
and with explicit delta scope.

Three region readers independently mapped:

- compiler, regexp, text, and meter;
- VM execution, heap, built-ins, and guest compartments;
- snapshot, store backends, Endo integration, Test262, fuzzing, and CI.

Three lens reviewers then read across those maps along security/determinism,
API/verification, and persistence/lifecycle concerns.
The candidate set was deduplicated and sent to three further reviewers:

- a code-truth refuter that defaulted to refutation unless current source or a
  reproducible probe established the claim;
- a significance judge with authority to lower severity or demote a claim to a
  recommendation;
- a history/scope auditor that separated new findings from inherited debt and
  deliberate rollout limits.

The root reviewer independently reproduced the two most consequential new
mechanisms and ran the test suites described in [Verification](#verification).
The final roster retains one disagreement: the significance judge proposed
demoting the regexp standards divergences because XS fidelity is an explicit
crate goal.
This review keeps them at medium because IronHorse also exposes an ECMAScript
engine and Test262 acceptance contract, and the affected behavior is a wrong
guest result rather than a named XS-compatibility mode or unsupported feature.

This is a fresh current-state delta review, not a claim that nine agents re-read
every branch of roughly 325,000 lines of Rust source and tests.
The exact exclusions are in [Scope limits](#scope-limits), and each region map
records what its reader did not inspect exhaustively.

## Architecture as built

### Crate and authority graph

The independent `rust/engine` workspace has eleven members.
The dependency direction preserves three important seams:

| Layer | Responsibility and boundary |
|---|---|
| `ironhorse-meter`, `ironhorse-text`, `ironhorse-unicode` | Versioned weights and portable text/Unicode primitives used above them. |
| `ironhorse-compile`, `ironhorse-regexp` | Budgeted translation from source/patterns to VM-consumable programs; neither owns the executing machine. |
| `ironhorse-vm` | `Machine`/`Interp`, indexed arenas, execution contexts, the object MOP, built-ins, modules, jobs, GC hooks, and the metering state. |
| `ironhorse-runtime` | The production `SourceCompiler` adapter, keeping the VM free of a production dependency on the compiler. |
| `ironhorse-snapshot` | Explicit row codecs, validation, side-table roster, checkpoint admission, stores, and restore adoption proofs. |
| `ironhorse-262`, `ironhorse-fuzz`, `xs-oracle` | Verification infrastructure; XS is a development oracle, not production authority. |
| `rust/endo` | Ephemeral and persistent worker lifecycle plus the SQLite backend outside the engine workspace. |

`Interp` owns the guest-visible machine state.
Heap values are integer slot/chunk references rather than native pointers, and
side tables carry object kinds whose state does not fit the base slot layout.
The MOP centralizes property behavior, while the generated state/GC/persistence
registries reconcile the side tables that must participate in roots, edges,
sweep, remapping, dirty tracking, and serialization.

`Machine` adds host ownership and policy.
Compartments share one primordial graph but have distinct global environments,
evaluators, compiler policy, and module maps.
Compiler services live outside the execution core and are reached through weak
environment references to avoid ownership cycles.
That separation is sound in shape but creates the lifetime finding in F003 for
guest-created child compartments.

### Execution, metering, and failure domains

The interpreter decodes XS-shaped bytecode into a central dispatch loop.
Guest throws are represented separately from terminal host/resource stops.
Native recursion, regexp work, compiler work, heap admission, and host callbacks
all have explicit ceilings or reconciliation points.
The current code consistently treats meter refusal and heap exhaustion as
uncatchable host stops rather than JavaScript exceptions.

Collection is explicit consumer policy.
A full collector and generated visitation coverage exist, but no wired policy
collects during a crank.
That remains the held F010/F076 decision from the earlier review, not a new
finding here.

### Persistence and supervisor lifecycle

`ironhorse-snapshot` distinguishes an image from proofs that it is safe to write
or adopt.
`GatedImage` is the write-side admission proof and `ValidatedSnapshot` is the
read-side adoption proof.
The `HeapStoreCommit` blanket implementation performs succession, geometry,
summary, and root checks before a backend receives a `VerifiedCommit`.
Backends therefore cannot override the common commit gate by accident.

Container and paged-store formats remain distinct.
Paged stores authenticate manifests, small-state section leaves, slot/chunk
leaves, free-list leaves, and page-edge summaries.
`PersistentMachine` executes a crank, checkpoints completed work according to a
cadence, and rewinds to the last checkpoint after a halt or checkpoint failure.
That model depends on the unexpressed commit-outcome assumption in F007.

### Verification architecture

The compiler comparison layer has two different responsibilities that are not
currently separated sharply enough:

- reproduce the pinned XS bytecode contract where XS is the intended oracle;
- establish ECMAScript correctness where the pin is known to diverge or is
  undefined.

The current failure demonstrates why those are separate authorities.
An optimized C oracle with undefined behavior cannot be the final judge of the
Rust compiler's defined numeric-literal classification.
The regexp suite has the same architectural tension: parity cases deliberately
pin XS behavior, while the engine's public contract and Test262 goals require
current ECMAScript behavior.

## Findings

### F001 — High — In-tree Intl semantics are not fully bound into compatibility identity

**Status:** open, explicitly recorded in current source but not mechanically
closed.

`Interp::boot_fingerprint` incorporates `INTL_DATA_VERSION`, and that is an
important existing defense.
However, `scripts/intl-profile.py:19-59` derives the identity only from the ICU
dependency graph, checksums, dependency edges, and root features.
It does not cover IronHorse's own Intl algorithms or locale tables.

`ironhorse-snapshot/src/versions.rs:42-60` records the consequence directly.
When compact notation and its in-tree `en` affixes landed, the guest-visible
answer for `{ notation: 'compact' }.format(12345)` changed from `12,345` to
`12K`, while a pre-change snapshot still resumed under the same boot fingerprint.

**Impact.** A compatibility identity that accepts two binaries with different
deterministic guest semantics breaks replay and replica agreement.
This is more serious than a stale version label: persisted execution can resume
successfully and then produce a different result for the same state and input.

**Recommendation.** Add an immutable digest or reviewed release identifier for
all in-tree Intl algorithms and tables to the boot fingerprint.
Add a CI diff gate requiring that identity to move whenever the covered files
change, and a negative resume fixture proving that a prior identity is refused.

### F002 — Medium — Failed guest `Compartment` construction is not transactional

**Status:** new and reproduced.

`construct_compartment` sets the machine-wide `shared_compartments` flag before
creating the environment at
`ironhorse-vm/src/interp/natives/compartment.rs:98-114`.
It restores the flag only if `create_environment` itself returns an error at
`:132-137`.

Later initialization can still fail normally.
For example, defining an endowment over the non-writable `NaN` global returns a
catchable `TypeError` at `:155-164`.
The exit path at `:172-175` switches back to the previous environment, but it
does not restore the profile flag or remove the provisional environment.
`create_environment` inserted that environment at
`interp/realm.rs:922-945`; its rollback at `:947-970` covers only an unwind
inside `create_environment` itself.

The following guest operation is enough:

```js
try {
  new Compartment({ globals: { NaN: 1 } });
} catch (_) {}
```

The review's temporary regression probe showed that a control default `Interp`
can be snapshotted, while the machine after this caught failure is refused by
`interp/persist.rs:584-603` for having the shared-compartment profile without
shared primordial roots.

**Impact.** A caught guest exception permanently changes machine profile,
retains dead environment/allocation state, and changes later persistence
eligibility even though construction returned no compartment.

**Recommendation.** Treat construction as one transaction across the profile
flag, active/inactive environment maps, evaluators, side tables, and allocations.
An RAII transaction guard should commit only after the instance row is installed
and roll back every non-success exit, including ordinary `Step::Throw` results.

### F003 — Medium — A guest child's compiler authority expires with its creator

**Status:** a documented lead, now verified structurally and promoted.

`inherit_compiler` stores only a `Weak` reference in the new environment at
`interp/natives/compartment.rs:185-204`.
Evaluation upgrades that weak reference and otherwise returns the uncatchable
`Halt::NotImplemented("eval:no-compiler")` at `interp/eval.rs:40-48`.
Compiler registry entries are retired with the creating environment during
collection at `ironhorse-vm/src/compartment.rs:1259-1278`.

A child `Compartment` can remain reachable through another compartment after
the creating host compartment is dropped and collected.
Its ordinary `child.evaluate("1")` operation can then change from working to a
host-shaped halt solely because the creator and a collection boundary went by.

**Impact.** The authority promised by guest construction is not owned by the
object that exposes it, and observable guest behavior depends on host lifetime
and collection timing.

**Recommendation.** Register inherited compiler policy under the child
environment and keep it alive for that environment's lifetime.
Keep the heap-facing reference weak if necessary to avoid cycles, but move the
strong policy ownership to a registry whose reachability follows the child.
Add the cross-compartment transfer/drop/collect regression described in the
security lens before closing this finding.

### F004 — Medium — Undefined behavior in the XS numeric oracle makes required gates unsound

**Status:** new, reproduced, and a current CI blocker.

Pinned XS classifies every parsed number by converting the `double` to
`txInteger` before comparing it back at
`c/moddable/xs/sources/xsLexical.c:347-355`.
Converting a finite value outside the signed integer range, infinity, or NaN to
that C integer type is undefined behavior.
`xs-oracle/build.rs:125-137` builds the source at optimization level 2.

IronHorse uses Rust's defined saturating cast followed by equality at
`ironhorse-compile/src/lexer.rs:959-969`, so `1e308` correctly remains a
`Number`.
The oracle instead compiled `1e308 + 1e308` as two `integer_4 2147483647`
instructions and evaluated it as `4294967294` in this review environment.

The sanitizer lane cannot reveal the problem because
`scripts/oracle-sanitizer-ignorelist.txt:1-6` excludes every pinned upstream XS
source from UBSan.
The build already creates a checked `xsLexical.c` overlay for a different
undefined diagnostic operation at `xs-oracle/build.rs:139-158`, so there is an
existing place to make the oracle definition explicit without editing the
submodule.

The current focused run reported 1,703 identical programs and eight unexpected
`XS_CODE_INTEGER_4` versus `XS_CODE_NUMBER` divergences.
The full `ironhorse-262` package reported 152 passing and three failing tests:
the byte-identity gate and two covered arithmetic/Test262 result gates.
CI invokes these packages with parity at `.github/workflows/ci.yml:1114-1132`.

**Impact.** A required gate is compiler-, optimization-, and host-dependent and
punishes the defined/spec-consistent implementation.
The red suite is a release blocker, but changing IronHorse to match this result
would introduce a real compiler defect.

**Recommendation.** Extend the checked lexical overlay to test finiteness and
the signed 32-bit range before conversion.
Pin boundary vectors under optimized and unoptimized builds, narrow the UBSan
exclusion where practical, and label the patch as an oracle repair.
Keep XS byte identity and independent ECMAScript correctness as separate gates.

### F005 — Medium — XS parity conceals two current RegExp conformance errors

**Status:** new and independently reproduced.

The `v`-mode set parser always requires an initial operand at
`ironhorse-regexp/src/compile.rs:1687-1694`, and the operand parser at
`:1753-1800` has no closing-`]` empty production.
As a result, `/[]/v` and `/[^]/v` are rejected even though current ECMAScript
accepts the empty set and its complement.

Negative Unicode-property folding also conflates the `u` and `v` rules.
The compiler complements the raw property endpoints at `compile.rs:1387-1434`,
then the matcher canonicalizes subjects for both modes at
`encoding.rs:162-181`.
The result matches the `v` fold-before-complement rule in both modes.
For example, `/^\P{Lowercase_Letter}$/iu.test("A")` returns false in XS and
IronHorse but true under the legacy `u` semantics; the corresponding `v` answer
is correctly false.

The parity corpus deliberately pins the XS result, so equality there cannot
detect either standards divergence.

**Impact.** These are wrong guest parse/result outcomes, not named unsupported
features.
They weaken the meaning of Test262 and public ECMAScript acceptance bars.

**Recommendation.** Add a standards-derived lane independent of XS.
Handle an immediate closing bracket as an empty `v` set, and model legacy `u`
property complement as matcher inversion rather than reusing `v` set algebra.
Record intended XS divergences explicitly instead of equating oracle parity with
language conformance.

### F006 — Medium — Store failure classes merge retry, refusal, and corruption

**Status:** inherited and self-acknowledged, still open.

The SQLite backend maps every `rusqlite::Error` to `StoreError::Io` at
`rust/endo/ironhorse-store-sqlite/src/lib.rs:46-51`.
It uses the same variant for out-of-range columns at `:53-59`, malformed section
hash shapes and content at `:108-181`, and populated unstamped or wrong
`application_id` databases at `:240-267`.
Core classification maps all `Io` values to `StoreFailure::Transient` at
`ironhorse-snapshot/src/store.rs:256-274`.

At the core layer, `BaselineMismatch` carries both an equal-epoch foreign/fork
lineage and recomputed-at-rest content disagreement.
Its documentation at `store.rs:181-195` explicitly says roughly eleven sites
represent tamper or bit rot but are classified toward “keep running.”

The early `PersistentMachine::open` profile check adds a third manifestation.
At `rust/endo/src/ironhorse_engine.rs:1087-1115`, it can report a canonical but
tampered function-state section as `StandaloneHeapState` before the manifest
root is authenticated by resume validation.
The operation still fails closed, but the failure is reported as policy rather
than poisoned storage.

**Impact.** A supervisor following the documented classification can retry a
permanent foreign database, retain corrupt storage, or diagnose tampering as an
ordinary configuration refusal.

**Recommendation.** Introduce structured backend errors and split lineage from
integrity mismatch.
Only genuinely retryable medium errors such as `BUSY`/`LOCKED` should be
transient; foreign identity should be refused; malformed or inconsistent durable
content should be poisoned.
Authenticate the current root before interpreting stored profile policy.

### F007 — Medium — The checkpoint protocol cannot represent an ambiguous durable outcome

**Status:** inherited design risk, supported structurally but not fault-injected
in this review.

`HeapStore::commit_verified` returns only `Result<(), StoreError>`.
SQLite returns the result of `COMMIT` at
`ironhorse-store-sqlite/src/lib.rs:1278-1288`.
The file backend makes the ambiguity concrete: rename is its publication point,
but directory sync, reopen, or decode can still return an error afterward at
`ironhorse-snapshot/src/store_file.rs:803-829`.

`PersistentMachine` states that a failed checkpoint left the prior epoch durable
at `rust/endo/src/ironhorse_engine.rs:1290-1294`.
On every checkpoint error it rewinds and returns an error at `:1525-1539`, so an
external supervisor may redeliver a crank that the store already contains.

**Impact.** Exactly-once delivery cannot be derived from this interface.
A lost acknowledgement can become double execution or a fork/conflict on retry.

**Recommendation.** Expose at least `NotCommitted`, `Committed`, and
`OutcomeUnknown`, and reconcile an unknown result by reopening and comparing the
expected epoch/seal before deciding whether to retry.
End-to-end delivery IDs or an explicitly at-least-once contract are required if
supervisors can redeliver across process failure.
Add fault injection at file post-rename and SQLite commit acknowledgement
boundaries.

### F008 — Low — The public RegExp crate exposes incompatible and unchecked representations

**Status:** previously mapped/known hardening debt, still open.

The convenience `run(&str)` documents UTF-8 and passes `subject.as_bytes()`
directly at `ironhorse-regexp/src/lib.rs:83-94`.
The matcher accepts an untagged “UTF-8 or XS CESU-8” byte slice at
`matcher.rs:143-150`, although non-Unicode ECMAScript matching is over UTF-16
code units and its decoder treats a raw zero byte as end-of-input at
`encoding.rs:65-76`.
Consequently the safe helper mishandles astral subjects in non-`u` mode and
cannot represent an embedded NUL.
The production VM avoids this by encoding each UTF-16 unit to modified CESU-8.

`Program` also exposes all code and structural counts as mutable public fields
at `compile.rs:40-63`.
The matcher immediately trusts `code[0]` and subsequent operands at
`matcher.rs:181-288`; clearing `program.code` after a valid compile panics at
the first access.

**Impact.** Current guest code does not reach this malformed boundary because
the VM supplies compiler-produced programs and correctly encoded strings.
Rust callers of the public crate can nevertheless obtain wrong matches or crash
the process through safe APIs.

**Recommendation.** Make compiled representation fields private and expose a
validated program type.
Separate a typed modified-CESU-8 matcher API from a UTF-8 convenience layer that
transcodes to UTF-16 semantics and defines returned offset coordinates.

### F009 — Low — Persistence fuzzing does not compose execution with durable reopen

**Status:** residual verification debt.

The fuzz project covers store row mutation through `MemoryStore`, and separate
targets cover live differential cranks and generated snapshot round trips.
No registered libFuzzer target composes reference-bearing execution, incremental
checkpoint, collection, durable backend reopen, restore, and continued
execution.
The fuzz target manifest also has no SQLite dependency.

**Impact.** File publication, SQLite dynamic types and schema rows, restore-time
policy reattachment, and continuation after checkpoint faults receive strong
example tests but not coverage-guided state-machine exploration.

**Recommendation.** Add a state-machine target over the reference store that
interleaves crank, checkpoint, collection, fault, resume, rewind, and continued
execution.
Add daemon-workspace fuzz/property targets for file directories and SQLite row
types, hashes, indices, transaction outcomes, and reopen behavior.

## Inherited open architecture debt

These items remain real but are not counted as new findings in this review.
Their canonical analysis and status history remain in the
[2026-09-06 open-findings index](../2026-09-06/OPEN-FINDINGS.md).

| Prior finding | Current posture |
|---|---|
| F063, compiler totality | Partially open. The recent parser/scoper/coder matrices materially strengthen the evidence, but remaining AST-shape assumptions mean totality is not proved. |
| F010/F076, in-crank reclamation | Held. The collector and heap ceiling exist, but no wired policy collects during a crank; the consumer usage-pattern decision still owns the next move. |
| F075, property-key namespace | Partially open. The monotone `u16` namespace and host-rooting requirements still block safe reclamation. |
| F119, exotic side-table dispatch | Open design question. Probe-chain instrumentation exists; the attempted central kind index was slower and removed. |
| F068, common engine abstraction | Partially open and blocked on the worker protocol for spawn-payload selection. |
| F149, persistent Script/eval shape | Partially open; a persistent realm lexical environment is still required. |

## Deliberate limits and unresolved design leads

The following should not be reported as silent defects:

- Live guest `Compartment` state and `globalLexicals` deliberately refuse
  persistence in phase 1.
- Guest module hooks and phase-2 import behavior are not implemented.
- `global_names` controls direct bindings, not transitive capabilities, and a
  guest-created compartment currently receives the standard set.
  That is a serious embedding footgun after lockdown, but it is the documented
  contract rather than an implementation violation.
- The machine-wide `installed_names_len` versus per-environment binding model
  remains a credible lead connected to the reflection gap, but this review did
  not reproduce a public wrong result from it.
- Sloppy function declarations colliding with `globalLexicals` are a documented
  correctness gap; phase 1's `evaluate` path is strict.
- A dead but uncollected guest-compartment row can keep the persistence gate
  closed until an explicit collection.

The distinction matters.
Fail-closed rollout gates are availability limits that require planned feature
work; they are not evidence that a snapshot silently loses state.

## Strengths worth preserving

- The shared store admission gauntlet is non-overridable and hands backends only
  a verified token.
- Snapshot rows are explicit wire records rather than Rust layout dumps, and
  structural fingerprints plus release ledgers guard schema movement.
- The generated side-table roster connects serialization, validation, restore,
  and GC coverage and is backed by mutation-sensitive registry tests.
- Metering distinguishes guest work, allocation admission, and terminal host
  stops across compiler, regexp, VM, and host-callable seams.
- Native recursion has an engine-owned budget and tests for proxy, JSON,
  iterator, renderer, callback, and compile-front-end paths.
- Compiler totality work now includes generated legal/illegal shape matrices,
  corpus sweeps, damaged-tree controls, and real eval/Function boundary tests.
- The persistence suite exercises eager/lazy stores, sparse checkpoints,
  content authentication, store collection, host recipes, queued jobs, and
  replay/fork guards across reference backends.
- Source comments candidly record several known compromises, including the Intl
  compatibility gap and `BaselineMismatch` taxonomy.

## Recommended work program

### W0 — Restore trustworthy verification

Repair and version the XS numeric overlay, add boundary vectors, and return the
required oracle/Test262 package to green.
At the same time, add an explicit standards lane for regexp cases where XS is
not the intended authority.

### W1 — Close consensus identity

Define the complete set of guest-visible deterministic inputs: boot layout,
meter release, Math provider, ICU graph, and in-tree Intl algorithms/tables.
Generate one reviewed compatibility digest from that set and make CI require an
identity transition when any member changes.

### W2 — Make compartment construction and compiler ownership explicit

Land a construction transaction guard and the failed-endowment regression first.
Then move inherited compiler policy ownership from the creator lifetime to the
child environment and add transfer/drop/collect coverage.
Keep the phase-1 persistence refusals until all environment ownership and lexical
rows have a durable representation.

### W3 — Give storage failures protocol meaning

Split backend retryability from durable-content validity, split lineage from
integrity mismatch, authenticate before interpreting stored policy, and add an
outcome-unknown reconciliation path keyed by epoch and seal.
Fault-inject both pre-publication and post-publication failures through the real
worker lifecycle.

### W4 — Harden public representations and compose fuzz state machines

Seal `Program` behind validation, make subject encoding explicit, and add the
durable reopen/continuation fuzz composition.
These are lower urgency than W0-W3 but cheap insurance at boundaries that are
likely to gain more callers.

## Verification

The review ran the following current-tree checks.

| Command / probe | Result |
|---|---|
| `cargo test --workspace --exclude ironhorse-262` from `rust/engine` | Passed, including unit, integration, and doc tests; ignored benchmark/golden-regeneration cases remained ignored. |
| `cargo test --locked -p ironhorse-262` | 152 passed, 3 failed: byte identity plus two covered arithmetic/Test262 gates. |
| Focused compiler byte-identity gate | Failed with 1,703 identical and 8 divergent programs, all `integer_4` in XS versus `number` in IronHorse. |
| XS probe for `1e308 + 1e308` | XS emitted two `integer_4 2147483647` operations and returned `4294967294`. |
| Temporary failed-Compartment snapshot regression | Control snapshot succeeded; caught `NaN` endowment failure caused the shared-primordial-profile write refusal. The temporary file was removed after the probe. |
| Compiler/regexp/text/meter focused suites | Passed outside the feature-gated oracle divergence described above. |
| Guest compartment, lockdown, realms, dispatch, GC, key-space, and probe-chain suites | Passed. |

The working tree was clean before review documents were added.
The Moddable submodule was at the repository's pinned commit, so the oracle
failure was not caused by an uninitialized or stale submodule.

## Scope limits

The review did not exhaustively inspect generated Unicode tables, every branch
of the roughly 7,000-line coder, every built-in implementation, every snapshot
codec arm, all SQLite tests, every Test262 expectation shard, or ignored release
benchmarks.
It did not run a full external daemon/Agoric replay campaign, cross-platform CI,
the nightly fuzz campaign, or the complete SES artifact lane requiring generated
external artifacts.

The review concentrated on changes since the last resolved review, architecture
seams, trust transitions, failure recovery, deterministic identity, and the
evidence behind current acceptance claims.
Companion region maps contain the more detailed exclusions.

## Companion evidence

- [Companion index and review process](README.md)
- [Compiler, regexp, text, and meter map](maps/compiler-regexp-meter-text.md)
- [VM and runtime map](maps/vm-runtime.md)
- [Persistence and integration map](maps/persistence-integration.md)
- [Security and determinism lens](lenses/security-determinism.md)
- [API and verification lens](lenses/api-verification.md)
- [Persistence and lifecycle lens](lenses/persistence-lifecycle.md)
