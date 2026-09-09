# IronHorse architecture

Current-state guide audited at `96db92e23` on 2026-09-09.
GC policy incorporates the W6 decision at `d38196799`.
This describes the implementation, with explicit limits where it differs from
[the roadmap](../../designs/ironhorse-engine.md#status).
[README acceptance status](README.md#acceptance-status) records which bars remain open.
[CHANGELOG](CHANGELOG.md) preserves historical measurements verbatim.
The architecture review is an independently revised record, not this guide's TODO list.

## Workspace and dependency direction

`rust/engine/Cargo.toml` defines an independent workspace with **nine members**.
The repository's outer Cargo workspace excludes it but consumes its crates by path.
A dependency arrow means the source crate imports the target crate.
The [generated crate diagram](CRATE-GRAPH.md) includes optional and development edges.
Runtime dependencies and development dependencies must not be confused:
`ironhorse-vm` uses the compiler in tests, while its production source compiler
is supplied through a trait owned by the VM.

| Member | Responsibility |
|---|---|
| `ironhorse-meter` | Frozen weights, default keys, canonical digest, append-only release identities. |
| `ironhorse-text` | CESU-8 encoding/decoding for symbol names, including lone surrogates. |
| `ironhorse-vm` | Values, arenas, interpreter, built-ins, modules, collector and meter integration. |
| `ironhorse-compile` | Lexer, parser, scoper, coder and budgeted source compilation. |
| `ironhorse-regexp` | XSRE-derived regexp compiler and backtracking matcher. |
| `ironhorse-snapshot` | Atom codecs, validated images, side-table ledger, heap stores and checkpoints. |
| `ironhorse-262` | Test262 orchestration, compiler comparisons and XS result differential. |
| `ironhorse-fuzz` | Testable fuzz logic; nested fuzz project provides libFuzzer entry points. |
| `xs-oracle` | XS C/FFI reference compiler and runtime for development and CI. |

There is no `ironhorse-ses` or `ironhorse-debug` crate.
Integrity operations and the current compartment surface live in the VM.
The debugger roadmap is not implemented by a missing crate of another name.
`rust/endo/src/ironhorse_engine.rs` embeds IronHorse directly.
The separate xsnap backend does not depend on the IronHorse VM.
`rust/endo/ironhorse-store-sqlite` implements the store backend outside this workspace.
It links bundled SQLite through `rusqlite`.
The engine library-root unsafe rule therefore does not mean “the daemon contains no C.”

## Execution and ownership

`Interp` owns the executing machine's arenas, stack, activation state, globals,
modules, native state and per-instance side tables.
The opcode enum and decoding metadata follow the pinned XS bytecode format.
The compiler emits bytecode plus a symbol atom; the VM links names before execution.
The interpreter dispatches opcodes and routes object operations through its MOP
(metaobject protocol) helpers, with native and native-method enums for built-ins.
Remaining MOP bypasses are tracked by the architecture review; a central dispatcher
is not evidence that every call site already uses it.

`SlotIndex` identifies an arena slot and `ChunkOffset` identifies byte storage.
These are integer references rather than native pointers.
Slots can be reclaimed and reused, so validation must check liveness, not merely range.
Rust `Slot` has no stable C representation and is 24 bytes on the audited 64-bit build.
The snapshot writer encodes fields explicitly into a distinct wire record.
XS's 32-byte accounting is neither the Rust layout nor total resident heap usage.
Side tables and arena bookkeeping contribute additional memory.

Guest strings use UTF-16 code units in chunks.
Compiler/VM symbol names use CESU-8 through `ironhorse-text`.
Those representations serve different boundaries; neither implies UTF-8-only strings.
BigInt, regexp, Intl, Temporal, promises, generators and disposal state are present.
Their presence does not certify full test262 coverage or persistence of every live state.

`Machine`, `Intrinsics` and `Compartment` are public VM types, but the current
compartment evaluator creates an independently owned interpreter.
`BootTemplate` speeds this by copying a pristine template; it is not shared frozen intrinsics.
[W6 decision 1](../../designs/ironhorse-w6-decisions.md#1-realm--decided-extract-it)
requires Realm extraction and retains the public surface meanwhile.
[W6 decision 2](../../designs/ironhorse-w6-decisions.md#2-engine-trait--deferred-and-here-is-the-trigger)
defers a common daemon engine trait until its stated consumer/protocol trigger.
Neither planned abstraction should be presented as already wired.

## Seam 1: SourceCompiler

The VM owns `SourceCompiler` in `ironhorse-vm/src/interp.rs`.
An embedder installs an implementation for dynamic source evaluation.
This avoids a production VM-to-compiler dependency cycle.
The compiler itself emits data the VM consumes, not an interpreter instance.

`compile_source` receives source, strictness, a raw budget and an incremental
charge callback, returning `CompiledSource` or `SourceCompileError`.
Its callback charges work before and during compilation, including work incurred
before syntax failure; successful cost reports are not charged a second time.
Admission covers source-sized work and regexp compilation too.
`MeterAbort` and `HeapExhausted` are host stops, not JavaScript syntax errors.

The compiler's private budget-stop unwind requires `panic=unwind`.
`panic=abort` is rejected at compile time for that path.
Unrelated panics retain panic semantics rather than becoming ordinary budget refusal.
The Endo seam starts the budget before compile/link/execute and preserves its baseline.
Persistent failures rewind to the last checkpoint.
See [W4](architecture-review/2026-09-06/W4-IMPLEMENTATION.md) and the compiler's
`tests/parse_meter_determinism.rs` for release-vector evidence.

## Seam 2: HeapStore

`ironhorse-snapshot/src/store.rs` owns `HeapStore` and `HeapStoreCommit`.
Backends expose encoded slot pages, chunk extents, small state and manifests.
The snapshot layer owns decoding and validation; a backend must not invent a codec.
The read/write split and verified commit token keep admission at the shared seam.
`HeapStoreCommit` checks batches before backend mutation.
SQLite runs shared admission inside an IMMEDIATE transaction.
FileStore retains a single-writer caller contract.

Container persistence and paged store persistence are distinct representations.
Both preserve machine state and meter identity, but have separate version numbers.
`MachineImage` is a data representation; `ValidatedSnapshot` is the adoption proof.
`GatedImage` is the immutable write-side proof used by production blob/batch writers.
Unchecked tooling is explicitly feature-gated for tests and fuzzing.

The persistent machine checkpoints completed cranks.
A halted crank is not a valid snapshot boundary simply because some tables are empty.
`last_crank_completed`, the transient gates and side-table policies establish admission.
On a failed persistent operation the machine restores the previous checkpoint.
Host diagnostic rendering is separate from guest dispatch completion.
This distinction matters for cyclic or unrenderable completion values.

Store validation checks canonical encoding, live references, authenticated manifests
and compatibility before state adoption, including cold lazy restore.
CAS reads validate keys and content hashes.
Manifest roots/seals bind collection policy and counters as well as stored content.
This authenticates the selected policy; it does not choose a fleet-wide GC schedule.

Checkpoint performance carries deliberate derived state:
section-level hashes/inventories, dirty-state tracking and cached aggregate hashes
avoid repeatedly processing the whole live state.
Do not replace those with unconditional whole-image scans without measuring the cost.
[Performance tradeoffs](architecture-review/2026-09-06/PERFORMANCE-TRADEOFFS.md)
records the retained allocations and consistency obligations.
The `store_suite` compares storage variants; backend correctness is more than
passing a single in-memory round trip.

## Seam 3: GcHooks

`ironhorse-vm/src/gc.rs` owns `GcHooks` and the full collector.
The collector sees arena references directly, while hooks expose state outside arenas.
`extra_edges` reports outgoing slot references for a marked owner.
`swept` removes entries for reclaimed owners.
`external_chunk_refs` visits external offsets before and after chunk compaction.
`ephemeron_edges` adds conditionally reachable edges to a fixpoint.
`prune_dead_keyed` removes weak state after marking and before sweep.

A side-table edge is not automatically a root.
Rooting every keyed entry would retain unreachable owner graphs forever.
The machine supplies actual roots and the hooks connect reachable owners to their state.
Chunk holders outside arena slots must be visited both for liveness and relocation.
The field reconciliation test is
[`gc_visitation_registry.rs`](ironhorse-vm/tests/gc_visitation_registry.rs).
Behavioral GC tests remain necessary: a source classification alone does not prove reachability.

The full collector exists, but production persistence currently uses paged collection
rather than calling `Interp::collect_garbage` as its normal collection policy.
Do not infer production weak-collection or chunk-compaction behavior from kernel tests.
Allocation admission and heap exhaustion also do not imply allocation-pressure collection.
[W6 decision 5](../../designs/ironhorse-w6-decisions.md#5-gc-schedule--decided-engine-consumer-policy)
assigns scheduling to the engine consumer; production reclamation remains Phase 2B work.
Consumers requiring replica-identical heaps must coordinate collection events and policy,
including recovery and resume.

### Async and generator roots

Async instances retain saved activation state and their result promise/resolving functions.
A pending `AsyncAwait(SlotIndex)` reaction connects its promise to the suspended instance.
Saved slots, jump state and externally held chunks must participate in the relevant visits.
The same owner-edge discipline applies to generator saved frames.
Do not turn every suspended instance into an unconditional permanent root.
See `gc_visitation_registry.rs`, `gc_frame_state.rs`, and the snapshot
`async_carry.rs`, `generator_carry.rs` and `promise_carry.rs` suites.

The XS mechanism maps `START_ASYNC` to creation of an async instance and immediate
stepping until await/completion; `AWAIT` saves activation state, and promise reactions
resume it through `step_async`/`await_schedule` in the interpreter.
Use function and opcode names when locating the XS reference at the current gitlink,
`23b4d6b0a65f35209d9118c4c13c6c9b3e68784d`; old XS line numbers are not stable.
Async generators, promise combinators, `finally` and await-in-try have implementation
paths now; the retired handoff's “still folded” list is not current scope.
This is a mechanism map, not a claim of exhaustive async conformance.

## Seam 4: side-table ledger

`ironhorse-snapshot/src/sidetable.rs` defines `SideTable`, descriptors and `Coverage`.
The ledger reconciles machine fields with persistence treatment.
Serialized state travels through its codec; boot-derived state is reconstructed;
transient state must meet the boundary predicate; unsupported live state refuses admission.
Read the current descriptor and predicate together rather than inferring support from a name.

Closures/functions, proxies and accessors are carried.
A resumed guest function is callable; “functions cannot resume” is not a valid gate rationale.
`functions_carry.rs`, `proxy_carry.rs` and `accessor_carry.rs` exercise these paths.
Generators and promises have carried representations subject to their boundary restrictions.
Not every possible live async activation has a portable persistent representation.
`persist_gates.rs` tests refusals; a refusal is not a silent omission or successful carry.

The ledger's source reconciliation detects new unclassified fields and stale entries.
It does not generate all interpreter visitors or prove every encoded field is correct.
Keep GC, codecs, boot reconstruction, quiescence and checkpoint handling aligned when
adding a new per-instance field.
The schema perspectives describe those duties by task:
[wire schema](../../designs/ironhorse-snapshot-schema.md),
[GC](../../designs/ironhorse-snapshot-schema-gc.md),
[debugging](../../designs/ironhorse-snapshot-schema-debugging.md), and
[surgery](../../designs/ironhorse-snapshot-schema-surgery.md).

## Halts, resource admission and determinism

`Halt` distinguishes guest/control-flow outcomes from host stops.
It includes **`HeapExhausted`** and **`Panic(PanicKind)`** as well as
`MeterAbort`, `StackOverflow`, `StepLimit`, `Decode`, `NotImplemented`, `Refused`,
`EngineInvariant`, `Throw` and `Return`.
Yield/await are internal `DispatchOutcome` control outcomes, not `Halt` variants.
A guest exception handler must not catch resource exhaustion or an engine panic.
`Halt::is_panic` defines the panic set; `ExecutionOutcome::classify` also rejects
non-panic outcomes that cannot commit a crank.
The unsupported-label registry limits which declines the differential harness may skip.
Engine invariant failures and contained panics are not missing-feature acceptance.

The frozen table and default keys have a canonical platform-independent SHA-256 identity.
Execution determinism is **scoped per release binary per platform**, with identical
initial state, input and host policy.
Platform transcendental results can affect guest branches and therefore computrons.
A matching digest or passing limited golden corpus does not extend that execution scope.
W6 §4 selects a future provider feature subject to coverage; it is not implemented here.
Canonical NaNs are enforced on slot construction and independently by the snapshot codec.

The current meter release is `ironhorse-meter-5`.
The release name and table digest are both needed: releases 3, 4 and 5 share weights
but differ in charging/admission policy.
The VM, compiler and regexp engine use the shared cost definitions.
Golden runtime, compilation and carried-state vectors pin results and costs.
XS computron differences are advisory telemetry, not the IronHorse release contract.
The weights are frozen estimates, not measured CPU calibration.
`cost-calibration` currently supplies histogram/model scaffolding; the timing driver,
object-code firewall proof and calibration loop remain planned work.

## Release and compatibility identifiers

The source documentation in [`versions.rs`](ironhorse-snapshot/src/versions.rs)
names the bump rules and upgrade consequences.
These are the five identifiers named by the review, audited at `96db92e23`.
`PARSE_METER_RELEASE` is now an alias, so they are not five independent counters.

| Identifier | Owner and current value | Bump rule and compatibility cost |
|---|---|---|
| `COST_TABLE_VERSION` | `ironhorse-meter/src/lib.rs`: `ironhorse-meter-5` | Change weights, charging points or admission policy by appending to `releases::PINNED`, changing the release literal and deliberately updating golden vectors together. `METR` requires both matching name and digest; old-meter persisted heaps cannot resume on the new engine. |
| `PARSE_METER_RELEASE` | `ironhorse-compile/src/meter.rs`: alias of `COST_TABLE_VERSION` | No independent bump. Compiler charge/admission changes follow the shared meter release procedure; do not recreate a second version namespace. |
| `IRONHORSE_FORMAT_VERSION` | Snapshot `format.rs`: 16 | Change the container encoding/interpretation with a format bump and explicit decoder support/refusal. `MIN_READ` is 1, but decoding an old container is not permission to execute it: boot and meter identity gates still apply. |
| `STORE_SCHEMA_VERSION` | Snapshot `store.rs`: 28 | Change paged-store/manifest/small-state representation with a schema bump and verified migration step or explicit refusal. `migrate_store` authenticates old state and advances monotonically; it does not translate old meter semantics. |
| `INTL_DATA_VERSION` | VM `interp.rs`: `ironhorse-intl-2026a` | Identifies built-in Intl data and is exposed as `Intl.__ironhorseDataVersion`. Data changes need deliberate release review and a data identifier update. No independent persisted equality gate ties this label to all ICU data/dependency versions today; changing it alone does not make resume safe. |

The derived table digest versions weight/default-key encoding, not every charging point.
Never overwrite an old release pin; releases with equal weights can have different names.
The derived `Interp::boot_fingerprint()` replaces the retired `BOOT_LAYOUT_VERSION`.
It hashes ordered intrinsic layout and participates in execution compatibility;
changes to debug representations can conservatively invalidate old snapshots.
Neither this fingerprint nor the Intl label is a substitute for locking ICU dependencies.

A meter upgrade needs an explicit worker-state transition plan before deployment:
retain the old executable to drain/export state, or reboot workers from an approved
initial state under the new release.
There is no general heap translator across meter releases; schema migration must
not restamp an incompatible heap and claim that it now resumes.
These are existing gate consequences, not a new migration implementation.

## Compatibility and where X is specified

Version changes are distinct from source package versions.
Do not assume an old snapshot can resume merely because a container reader accepts it.
Meter, boot and data compatibility must also be satisfied.
No general cross-meter heap migration is supplied by the format/schema migrators.

| Question | Specification / authoritative construct | Evidence |
|---|---|---|
| What is accepted today? | README acceptance table; engine design Status | Named current tests plus historical CHANGELOG tips |
| What is planned or decided? | Engine roadmap and W6 decisions | Explicit landed/deferred/open distinctions |
| What does source compilation charge? | `SourceCompiler`; compiler `coder.rs`; W4 record | Compiler and VM golden computrons |
| What are the release weights? | Meter `lib.rs` and `releases.rs` | Digest release pins and runtime vectors |
| What is the symbol encoding? | `ironhorse-text/src/lib.rs` | Text and compiler symbol tests |
| What is a guest string? | VM string helpers and chunk representation | UTF-16 string and snapshot tests |
| What are GC edges? | `GcHooks`, machine roots and schema GC guide | `gc_visitation_registry.rs`, `gc_frame_state.rs` |
| What may persist? | `SideTable` descriptors and `is_quiescent` | `persist_gates.rs`, side-table ledger tests |
| What is the atom grammar? | Snapshot `format::CANONICAL_ATOM_ORDER` | Codec round-trip and malformed-input tests |
| What is the store protocol? | `HeapStore`, `HeapStoreCommit`, `VerifiedCommit` | `store_suite` and `commit_contract` |
| What changes at resume? | `ValidatedSnapshot`, boot fingerprint and restore functions | `persistence_identity.rs`, `boot_native_identity.rs` |
| What is the panic contract? | `Halt`, `PanicKind`; panic design | Halt taxonomy tests and regression fixtures |
| What is the daemon boundary? | `rust/endo/src/ironhorse_engine.rs` | Persistent-machine lifecycle tests |
| How is the oracle provisioned? | README; `c/moddable` gitlink; oracle build script | Oracle lane and sanitizer scope probes |
| What performance is measured? | `benches/README.md` and baseline provenance | Self-relative regression/scaling gates, not XS envelope |

## Reading and changing this map

Follow source symbols rather than recorded review line numbers.
The original review claims describe `97d8de25`; its last revision at `1b130df7`
is the latest review status, while this guide audits the newer base stated above.
The W2/W3/W4 and performance companion documents record their own implementation tips.
They are evidence of changes, not interchangeable specifications for today's whole engine.
A new field or dependency requires checking the affected seams and this guide.
Keep historical counts in CHANGELOG and current acceptance in one README table.
Do not mark the architecture review complete by editing its status paragraphs.
