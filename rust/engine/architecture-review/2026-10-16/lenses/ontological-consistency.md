# Lens: ontological consistency

Reviewed commit `61cd656cb`.

The question: is each concept the engine names (in its types, enums, outcome categories, labels
and documents) defined once, named the same way everywhere, and classified the same way at every
site that meets it?
And wherever a guest can see the difference, does the engine's model match the ECMA-262 model it
implements (Realm, Environment Record, job, agent, module record, completion)?
This lens reports a candidate only when it has a concrete consequence: a misclassification or bug
at a named site, a guest-observable divergence, a persistence or compatibility hole, or a
demonstrated confusion that has already produced inconsistent code.
Naming taste alone goes to the glossary or to the leads list.

## Method

### Six finders

Six finders read the code at `61cd656cb` independently, under the brief's independence rule.
Each worked through one modality.

| Finder | Modality | What it looked for | Candidates |
|---|---|---|---|
| vocabulary | Names and their meanings | One concept with several names, or one name for several concepts, across crates, comments and docs; grep-driven term counts, then targeted reads. | 8 |
| taxonomy | Classification schemes | Enums, halt classes, outcome and report categories, coverage classes and skip-reason labels that are not exhaustive, not disjoint, or applied differently at different sites. | 7 |
| identity | Identifiers and versions | What identifies persisted state and releases: container format, store schema, row schema, boot fingerprint, meter release, Intl profile, environment and root ids. | 8 |
| spec-model | Engine model against ECMA-262 | Realm, Environment Records, jobs, agents, module records and completion, where a guest can observe the difference. | 8 |
| types | Type encoding | Whether the Rust types (`Slot`, `SlotIndex`, `u16` key ids, number kinds, accessor encodings) carry the distinctions the concepts need. | 5 |
| doc-model | Documents against code | Whether `ARCHITECTURE.md`, `README.md`, crate docs and design notes describe the concepts the code implements. | 8 |

The finders probed in three ways:

- JS probes run on `rust/engine/target/release/ironhorse-xst` and compared with Node 22;
- differential runs of `endot-ih` against the pinned XS oracle on private test262 roots;
- temporary Rust tests named `zz_audit_ont_<n>.rs`, built with the audit's shared
  `CARGO_TARGET_DIR` and deleted after each run.

Probe sources and outputs are under
`../probes/ontology/`.
Each finder used its own subdirectory (`vocabulary/`, `taxonomy/`, `identity/`, `spec-model/`,
`types/`, `doc-model/`), and each verifier used its own (`verify-ont<N>/`, `verify2-ont<N>/`,
`ont<N>-verify/`, `ont<N>-intent/` and similar).
When this report writes `probes/ontology/...`, that path is relative to the `review/` directory
above.

### Merge

Candidates that described the same mechanism were merged under one `ONT-<n>` id.
Each merged finding records the finder candidates it absorbed.
Eight merges took the 44 candidates down to 34:

- ONT-1 absorbed two candidates (vocabulary, taxonomy);
- ONT-7 two (vocabulary, taxonomy);
- ONT-8 two (vocabulary, taxonomy);
- ONT-14 three (vocabulary, spec-model, doc-model);
- ONT-20 two (identity, doc-model);
- ONT-22 two (identity, doc-model);
- ONT-25 two (vocabulary, doc-model);
- ONT-31 three (vocabulary, identity, doc-model).

### Verification

Every merged candidate went through up to two refuters.

1. **Code-evidence refuter (all candidates).**
   It re-opened every cited location at `61cd656cb` and checked that the quoted text was there.
   It re-ran the probes or wrote its own, and tried to find a guard, normalization or later step
   that makes the mechanism harmless.
2. **Consequence-and-intent refuter (only when the first refuter left a candidate standing at
   medium or above).**
   It asked four questions.
   Is the behaviour a documented decision?
   Can a guest observe it?
   Can real callers reach it?
   Does a gate already turn it into a loud refusal?

A candidate survives only if no verifier refuted it.
Its final severity is the lowest of the finder's proposed severity and every verifier's severity.
Wherever a verifier corrected a location, a scope or a claimed consequence, the finding below
states the corrected version and says so in its Verification note.

### Counts

| Stage | Count |
|---|---|
| Finder candidates | 44 |
| After merge | 34 |
| Refuter passes | 52 (34 code-evidence, 18 consequence-and-intent) |
| Surviving | 32 |
| Refuted | 2 (ONT-4 by its code-evidence refuter; ONT-18 by its consequence-and-intent refuter) |
| Final severity of survivors | 3 high, 9 medium, 20 low |
| Severity lowered by verification | 9 (ONT-1, ONT-5, ONT-7, ONT-8, ONT-10, ONT-14, ONT-16, ONT-20, ONT-22) |

### Caveats on the probe evidence

- **The shared build directory aliases modified copies.**
  The verifier that refuted ONT-4 found that all audit Rust probes share one `CARGO_TARGET_DIR`.
  Cargo hashes a path package by its workspace-relative path, so a modified copy of
  `rust/engine` built into that directory writes the same artifact the real repository uses, for
  example `libironhorse_vm-a6da1ab66af81e75`.
  The repository's sources date from 14:03, so cargo then keeps reusing the copy's newer
  artifact.
  The verifier proved this directly: an instrumented copy's `eprintln` output appeared in a test
  run from the real repository.
- **Three modified copies are known to have been built into that directory:**
  1. the identity finder's copy with commit `aaec6a06`'s VM diff reverted (`date.rs`, `json.rs`,
     `keys.rs`, `halt_labels.rs`; `probes/ontology/identity/aaec6a06-revert.patch`);
  2. the ONT-20 verifier's copy with a one-character edit at
     `rust/engine/ironhorse-vm/src/intl_number.rs:825`;
  3. the ONT-4 verifier's instrumented and reverted builds, between about 23:35 and 23:39 UTC.
     That verifier afterwards restored a pristine HEAD build.
- **What the aliasing did.**
  It produced ONT-4's evidence, which was really the pre-`aaec6a06` behaviour; that is why ONT-4
  is refuted.
  The ONT-20 verifier ran its repository probe before its copy probe.
  Among the surviving findings, ONT-2 is the only one whose mechanism shares a file the revert
  touched (`keys.rs`).
  Its guest-visible claims are also shown by `ironhorse-xst` runs of the repository's own release
  build, and that build is outside the shared directory.
  Every other surviving mechanism lies outside the edited files.
- **Probe-file collision.**
  The vocabulary finder warns that the taxonomy finder used the same probe file names
  (`rust/engine/ironhorse-262/tests/zz_audit_ont_1.rs`, `zz_audit_ont_2.rs`).
  Its own `ironhorse-262` `zz_audit_ont_1.rs` was created at 22:16:49 and deleted before the
  taxonomy files appeared at 22:21.
  It cannot rule out that its file overwrote an earlier taxonomy file.
- **Leftover temporary files.**
  At the time of writing, `git status` at `61cd656c` shows no `zz_audit_ont_*` file left in the
  repository.
  The only untracked file is another lens's `rust/engine/ironhorse-262/tests/zz_audit_cov_1.rs`.

## Glossary

This table merges the six finders' glossaries.
Paths are under `rust/engine/` unless they start with `rust/endo/`, `designs/` or `c/`; the
finders cited them relative to `rust/engine` and the crate.
The **Finding** column lists the findings in which the term figures.
**synonym** or **homonym** marks a finding in which the naming or classification of the term is
itself the defect.
A dash means the term's several meanings were noted but no consequence was shown; several of
those appear again under "Leads that did not survive".

| Term | Meanings found (where) | Finders | Finding |
|---|---|---|---|
| Machine | (1) `ironhorse_vm::Machine`, the public host handle (`ironhorse-vm/src/compartment.rs:878`): `Rc<MachineState>` holding `RefCell<Interp>`, the Realm, the compiler registry and restore policies. (2) `MachineState`, its private core (`compartment.rs:72`). (3) "the machine" in prose, for XS `the` or the whole engine instance. (4) The "Slot Machine" commit/supervisor component in the endo seam (`rust/endo/src/ironhorse_engine.rs:318`). (5) `MachineImage`, `MachineSnapshot`, `PersistentMachine` for persisted forms. `ARCHITECTURE.md:47` and `:70` both say Interp and Machine own the arenas; Machine owns Interp. | vocabulary | — |
| Interp | The interpreter state struct (`ironhorse-vm/src/interp/state.rs:28`): arenas, value stack, frames, per-instance side tables, the current `CompartmentEnvironment` (`self.environment`), the meter. "Interpreter" in docs means the same; the `interp` module is private (`ARCHITECTURE.md:149`). | vocabulary | — |
| Realm | (1) struct `Realm` (`ironhorse-vm/src/interp/realm.rs:24`): `Rc<Intrinsics>` plus `default_global`, one per Machine. (2) The ECMA-262 Realm Record, which has one [[GlobalEnv]]; here one Realm serves N global environments, and the shared evaluators have no fixed realm (`realm.rs:855-890`). (3) A compartment, informally: `tests/realms.rs`, `sibling_realms_keep_independent_source_compilers`, "This realm's actual global object" on `CompartmentEnvironment::global_object` (`realm.rs:896`), "start realm", and "default realm" for the start compartment's environment (`compartment.rs:1220`, `:1299`). (4) A local name for a `CompartmentEnvironment` (`realm.rs:944`) or for a global-object `SlotIndex` (`compartment.rs:749-750`). (5) `set_realm_meter` / `detach_realm_host`, meaning the whole interpreter. (6) The VM crate doc's "Each Compartment retains a Realm" (`ironhorse-vm/src/lib.rs:13-14`). | vocabulary, spec-model, doc-model | ONT-24 (homonym), ONT-14 |
| Intrinsics | `ironhorse_vm::Intrinsics` (`compartment.rs:37`): primordial root `SlotIndex`es plus lockdown flags (`locked_down`, `locking_down`, `hardening`, `harden_marks`). Also the spec's %Intrinsic% objects, and "intrinsic names" in the `global_names` policy. | vocabulary | — |
| Compartment | (1) The host handle `ironhorse_vm::Compartment` (`compartment.rs:355`), with a per-handle `CompartmentId` counter. (2) The guest `Compartment` constructor and instance (`interp.rs:769`, `interp/natives/compartment.rs`) with `GuestCompartmentData`. (3) SES Compartment semantics, which the engine targets (`designs/ironhorse-ses-compartment-equivalence.md`). (1) and (2) both wrap a `CompartmentEnvironment`. The same endowment failure is `Halt::Refused("compartment:global-definition-rejected")` on the host side and a catchable `TypeError` on the guest side; these are different boundaries and were not reported. | vocabulary, spec-model | ONT-14, ONT-16 |
| CompartmentEnvironment, environment | (a) `CompartmentEnvironment` (`realm.rs:45`): global object, `global_props`, `binding_names`, `globalLexicals`, module map, compilers. Functions and suspended activations "capture" it (`ARCHITECTURE.md:82`), and `ARCHITECTURE.md:108` calls it the "environment record". (b) `Interp::env`, the XS closure/scope register (`interp/state.rs:716`) and closure cells: the analogue of the spec's declarative Environment Records. (c) `EnvironmentId(u32)` (`compartment.rs:199`), which is the global object's `SlotIndex`, and `EnvironmentPolicy` in restore. (d) `global_env: SlotIndex` on `FuncInfo`, `CallerState`, `SavedFrame` and `PromiseData`: a global-object slot, NULL meaning "ambient". (e) `XS_ENVIRONMENT_BEHAVIOR_ID = u16::MAX`, the key id reserved for internal environment records (`README.md:61-62`). (f) A CI or test environment. | vocabulary, spec-model, doc-model | ONT-19, ONT-24, ONT-30 |
| `global_env` NULL | Documented three ways: "default global" (`ARCHITECTURE.md:114`), "standalone default" (`interp.rs:845`, `:2139`, `:2314`), and "whichever environment called" (`realm.rs:875`). Implemented as the environment that is ambient at call time: the caller for a direct call, the pump's current environment for a job. | spec-model | ONT-30 (homonym), ONT-5, ONT-14 |
| start compartment, default environment, default global | Synonyms for the environment created at boot (`Realm::default_global`). It is the only environment whose `eval` and `Function` are not homed. | spec-model, vocabulary | ONT-14 |
| global | (1) The global object (`global_obj`, `globalThis`). (2) `global_props`, the id-to-property-slot cache. (3) `global_names`, host policy for which intrinsic names are bound as globals (`CompartmentOptions::global_names`, renamed from `intrinsic_permit`; `HeapStoreOptions::global_names`). (4) "default global" = `Realm.default_global`. (5) "globalLexicals". | vocabulary | — |
| global lexicals | `CompartmentEnvironment::global_lexicals` holds only the guest Compartment's `globalLexicals` option. A Script's top-level `let`/`const`/`class` belong to "the running program" and are discarded when the Script ends. ECMA-262 and XS keep both in one [[DeclarativeRecord]] (in XS, the realm closures). | spec-model | ONT-15 |
| evaluate | Guest `Compartment.prototype.evaluate`: documented as a Script, implemented as a strict eval program (`interp/natives/compartment.rs:396`, `:412`). Host `Compartment::evaluate_with_symbols`: runs whatever goal the embedder compiled. Tests use Script (`compile_atoms`); the Endo daemon uses `Goal::Eval` (`compile_atoms_with_meter`). | spec-model | ONT-16 (homonym), ONT-23 |
| evaluator | (1) The dynamic-code entry points `eval`, `Function`, and the three unnamed families (GeneratorFunction, AsyncFunction, AsyncGeneratorFunction). Per-compartment homed copies are minted by `compartment_evaluator`; the originals are caller-homed (`realm.rs:855`). (2) "Evaluator service", meaning a `SourceCompiler` implementation (`ARCHITECTURE.md:113`, `compartment.rs:1220`). (3) "Evaluator identities" (`ARCHITECTURE.md:81`). (4) The snapshot's `EvaluatorRow`. | vocabulary | ONT-14 |
| source compiler adapter | `ironhorse_runtime::IronhorseSourceCompiler` (Endo, harness); the thixotrope worker's private `Compiler`, which lacks `compile_eval_units`; and the trait's default `compile_eval_units`, which drops the `EvalContext`. | doc-model | ONT-18 (refuted) |
| Slot | (1) `value::Slot` (`ironhorse-vm/src/value.rs:620`), the 24-byte XS cell `{next, id: u16, flag, kind, payload}`. One type serves as arena record, JS value (stack, arguments, locals, side-table values), property record (`id` = key, `flag` = attributes, `next` = next property), array item (`flag` = element attributes), instance head (`payload` = prototype, `next` = property list, `flag` = EXOTIC / DONT_MODIFY / DONT_PATCH / DONT_MARSHALL), closure cell, and EnvReference or super reference. Turning a record into a value takes a hand scrub at about 70 sites. (2) An arena position (`SlotIndex`). (3) Value-stack slots: `StackOverflow(usize)` counts "slots in use" (`interp.rs:1715-1717`). (4) Spec internal slots ([[ProxyTarget]] and others; about 38 doc mentions, e.g. `interp.rs:685`). (5) Store slot pages and the 20-byte serialized slot record (`ironhorse-snapshot/src/slot_codec.rs:34`). (6) "Live slots" for `BOUNDED_RUN_SLOT_CEILING` (`interp/dispatch.rs:278`). | vocabulary, types | ONT-3 (homonym: value vs record) |
| SlotIndex | A `u32` index into `SlotArena` (`value.rs:433`), NULL = `u32::MAX`. Used untyped for objects, functions, environments' globals, promises, closures and iterator results. Reused as the persisted `EnvironmentId` and `HostRootId` numbers (`compartment.rs:171`, `:207`, `:452`). | vocabulary | ONT-19 |
| id (`u16`) | (1) Property-key id (`Slot.id`). String keys are 1-based positions in the name table and grow upward; symbol keys are minted downward from `u16::MAX-1` (`next_symbol_key_id`); the two meet at the id-space latch. (2) `XS_NO_ID` 0: no name, anonymous, or (inside `Payload::At`) an integer index. (3) `u16::MAX` with `XS_INTERNAL_FLAG`: environment behaviour marker. (4) Tagged-template site keys. The types finder listed them as symbol-range ids; the ONT-34 verifier found they are name-table entries (`"\0ironhorse-template-site:N"` via `append_name_key`, `interp/link.rs:1346`). (5) `value.rs:623` says `id` doubles as "argument count on frame slots"; this is stale, as argc is a stack integer (`interp/frames.rs:306`). (6) Program-local compiler symbol ids versus machine-canonical ids after relinking (`symbols.rs:4-11`, `interp/link.rs:20-75`). (7) `EnvironmentId` / `HostRootId` (reused slot indices); `CompartmentId` (per-machine handle counter, not persisted, `compartment.rs:259`, `:403`); `ModuleId`, `CellId`, `HostCallableId`; test262 `run_id`. | vocabulary, types | ONT-2, ONT-19, ONT-34 |
| key, index | A `u16` property id is either an interned name or a symbol key. Element indices are meant to be `ReadKey::Index(u32)`, but `array_generic_index_id` mints them as name ids, so "index" and "name" collapse on the generic Array paths. Also: "default keys" (XS `gxIDStrings` in `ironhorse-meter/src/default_keys.rs`, part of the cost-table digest), "canonical keys" (the machine key table), store/CAS keys (content hashes), and the `KEYS` snapshot atom. | taxonomy, vocabulary | ONT-2 (homonym: index vs name) |
| key-space exhaustion | Soft limit: a catchable `RangeError` "property key space exhausted", keeping a 1,024-id reserve. Hard latch: `id_space_exhausted`, which raises `Halt::Refused("property-key:id-space-exhausted")`. At link time: `RelinkError::TableFull`, which the harness spells `Halt::Decode(Relink(TableFull))` and the production compartment path `Halt::Decode(InvalidSymbols)`. `ARCHITECTURE.md:349` calls this "exhaustion handling, not reclamation". | types | ONT-2, ONT-10, ONT-34 |
| flag (`u8`) | Property attribute byte (DONT_DELETE 2, DONT_ENUM 4, DONT_SET 8, METHOD 16, GETTER 32, SETTER 64, INTERNAL 1). Instance-head flags that reuse the same bit positions with other meanings (EXOTIC 1, DONT_MODIFY 8, DONT_PATCH 16, DONT_MARSHALL 64). `XS_NAME_FLAG` 1 as a define-mask bit, never stored. `SUPER_PRIMITIVE_RECEIVER` 0x80 OR a `Kind` on an EnvReference. | types | ONT-3 |
| `Payload::Reference` | Object reference (`Kind::Reference`), prototype link (`Kind::Instance`), symbol descriptor (`Kind::Symbol`), closure cell (`Kind::Closure`), environment or super receiver (`Kind::EnvReference`). Which one depends on `kind`. No site was found that confuses them for guest values. | types | — |
| name | (1) `symbol_names`, the CESU-8 string name table (`SymbolName`), with positional ids. (2) The `global_names` policy. (3) A function's `name` property, `ErrorInfo.name`. (4) The Compartment `name` option. (5) Halt labels ("names a skip"). (6) A host-callable service name. A function's name exists twice: `FuncInfo.name` is a Rust `String` rendered through `SymbolName` Display, so a lone surrogate appears as the literal text `\ud800`; it is used for the anonymity test, Error stack frames, host rendering and `FunctionRow.name`. `FuncInfo.name_chunk` holds UTF-16 units and is used for `.name` and `Function.prototype.toString`. Both are persisted. | vocabulary, types | — |
| symbol | (1) The compiler's "symbols": the identifier/property-name table and the `SYMB` atom (`symbols.rs:1-18`). (2) JS Symbol values and symbol keys (`SymbolKeyIds`, `next_symbol_key_id`). (3) The symbol registry (`Symbol.for`). (4) `well_known_symbols`. `symbol_names` holds string names, not Symbols. | vocabulary | ONT-34 (related) |
| string | Guest String: a chunk of UTF-16BE code units. Names and keys: `SymbolName` CESU-8 (`ironhorse-text`), lossless. Working form: `Vec<u16>`. Rust `String`/`&str`: diagnostics, key-text matching (`scalar_key_text`), Intl and Temporal identifiers, error frames, module records. No lossy path was found for guest-visible values. | types | — |
| number | `Kind::Integer` (`i32`, which cannot hold -0) and `Kind::Number` (`f64`, NaN canonicalized in `Slot::of` and the slot codec). The Integer-or-Number fold is written by hand at three sites the finder named (`interp/coerce.rs:7`, `interp/numeric.rs:337`, inline at `interp/numeric.rs:107`); verifiers found a fourth with a third rule (`interp/natives/json.rs:1543-1552`). | types | ONT-12 |
| built-in accessor property | A real accessor on the intrinsic prototype (ArrayBuffer, TypedArray and DataView getters), or a `GET_PROPERTY` opcode interception keyed by id or key text (RegExp, Temporal, `Intl.Locale`, `Intl.Collator` `compare`, `DisposableStack` `disposed`). | types | ONT-6 (two encodings of one concept) |
| compartment identity | `CompartmentId` (a process-local counter, with the root forced to 0 on restore, returned by `global_this()`); `EnvironmentId` (the global object's `SlotIndex`, persisted); `CompartmentEnvironment` and `inactive_environments` (keyed by `SlotIndex`); `Realm` (intrinsics shared across compartments). | types | ONT-19 |
| chunk | XS byte-storage arena entries addressed by `ChunkOffset` (`value.rs:445`): strings (UTF-16), bytecode, BigInt digits. "Chunk ceiling" (`DEFAULT_CHUNK_CEILING`, 256 MiB, `value.rs:15`) also absorbs side-storage charges. "Chunk extent": a 64 KiB store unit (`value.rs:172`). | vocabulary | — |
| arena | `SlotArena` (`value.rs:829`) and `ChunkArena` (`value.rs:2066`); "arena coordinates" are raw `SlotIndex` or `ChunkOffset` values (`ARCHITECTURE.md:163`). | vocabulary | ONT-25 (related) |
| side table | Per-instance `HashMap`s in `Interp` keyed by `SlotIndex`. The snapshot `SideTable` enum and its `Coverage` classes (`ironhorse-snapshot/src/sidetable.rs:153`) are generated from `#[snapshot_table(..)]` attributes in `interp/state.rs`. "Side storage": their guest-sized elements, charged against the chunk ceiling (`side_storage.rs`). | vocabulary | ONT-27 |
| SATELLITE | A side-table reconciliation group, documented as "rides its primary row". In practice it holds FUNC-carried, flag-carried, rebuilt, boot-derived but unfingerprinted (`pending_surfaces`, `intrinsic_key_ranks`) and presence-refused (`guest_compartments`) fields. | identity | ONT-27 |
| ledger | (1) The side-table ledger: persistence coverage classification (`sidetable.rs`; `ARCHITECTURE.md:296`, "Seam 4"). (2) The side-storage ledger: a byte charge kept in `ChunkArena` against the chunk ceiling (`interp/side_ledger.rs:1-10`). (3) Release ledgers: the append-only `row_schema_releases.tsv` and the meter's `releases::PINNED` (`ARCHITECTURE.md:151`, `:384-388`). (4) "The SymbolTables ledger row". | vocabulary | — |
| row | Capture/restore row structs in `interp/snapshot_rows.rs`, fingerprinted by `ROW_SCHEMA_VERSION`; tuple-shaped capture/restore rows in `persist.rs` and `restore.rs`, not fingerprinted; wire rows such as `BufferImage` (`ironhorse-snapshot/src/image.rs`); side-table ledger rows; store rows (paged slot and chunk records). | doc-model | ONT-22 |
| crank | (1) One top-level Interp run: script dispatch plus, on the `run_program` and pump paths, the promise-job drain (`interp.rs:3095-3160`). (2) Compartment evaluation: script only, with no drain (`ARCHITECTURE.md:99`), yet it sets the same `completed` / `last_crank_completed` latch. (3) One delivery in endo and supervisor terms (crank counters, `Refusal::CrankCounterExhausted`). (4) One test run in the harness. | vocabulary | ONT-23 (homonym) |
| completion | (1) The completion value (`result`). (2) `RunOutcome.completed`: `halt == Return`, with or without a job drain. (3) The spec's Completion Record, not modelled as such (Step and Halt instead). (4) The report's `Provenance.completion`: a "complete" or "incomplete" sweep (`ironhorse-262/src/report.rs:310`). (5) The async completion latch in the harness. | vocabulary | ONT-23 |
| quiescent | `Interp::is_quiescent` = `fields_are_quiescent() \|\| (last_crank_completed && fields_at_shared_collection_boundary())`. GC admission = `is_quiescent \|\| fields_at_shared_collection_boundary`, with no `last_crank_completed` requirement. README uses "quiescent" as the sole GC precondition. | doc-model | ONT-23 |
| checkpoint | (1) A persistent store commit at a completed crank (`CheckpointBatch`, `ironhorse-snapshot/src/store.rs:1369`; `ARCHITECTURE.md:218`). (2) A meter "check point", a loop-closing point where the meter host is consulted (`meter.rs:8`, `interp/natives/promise.rs:862`). (3) The harness's `dual_run_scripts_checkpoint`. | vocabulary | — |
| snapshot | Generic persisted machine state (container or store); the `snapshot_api` rows and `ROW_SCHEMA_VERSION`; `ValidatedSnapshot` (`image.rs:538`); `MachineSnapshot` (`machine.rs`); `snapshot_id()`, returning an `EnvironmentId` or `HostRootId`; the panic design's "frozen-at-fault snapshot"; regexp "capture snapshots" (`ironhorse-regexp/src/matcher.rs:126`). | vocabulary | ONT-19 (`snapshot_id`) |
| image | `MachineImage` (`image.rs:406`), the decoded data; `GatedImage` (`image.rs:500`), the write-side admission proof; the "paged logical image" (`store.rs:3`); "boot image/region" in prose. | vocabulary | — |
| container | The XS_M atom container, a single-blob interchange format with its own `IRONHORSE_FORMAT_VERSION` (`ironhorse-snapshot/src/format.rs:20`, `:246`), distinct from paged store persistence (`ARCHITECTURE.md:212`). "Two containers" (`store.rs:11`) means the atom container and the keyed store. | vocabulary | ONT-32 |
| store | The `HeapStore` / `HeapStoreCommit` traits (`store.rs:1422`, `:1449`): paged keyed residence with its own `STORE_SCHEMA_VERSION`. Implementations: `MemoryStore`, `FileStore` and the SQLite backend in `rust/endo`. Also the "store suite" and `StoreError` / `StoreFault`. | vocabulary | ONT-26, ONT-33 |
| blob, page, extent, manifest | Blob: container bytes as written by production blob writers (`ARCHITECTURE.md:215`); CAS blobs. Page: a 256-slot store unit (`SLOTS_PER_PAGE`, `value.rs:168`), WASM linear-memory pages, the side-table "page projection", lazy page faults on resume. Extent: 64 KiB of chunk bytes (`CHUNK_EXTENT_BYTES`, `value.rs:172`). Manifest: `StoreManifest` (`store.rs:437`: VERS, SIGN, CREA, schema, geometry, epoch, counters, commit token, collection policy; `ARCHITECTURE.md:237`), the test262 whole-tree `manifest.txt`, Cargo manifests. | vocabulary | — |
| atom | Snapshot FourCC atoms (the XS chunk grammar, `format::CANONICAL_ATOM_ORDER`); the compiler's symbol atom (`SYMB`) and code atoms handed to the VM; `report.rs`'s "atom of a full-run report" (`CaseRecord`). | vocabulary | — |
| Refused, refusal | (1) `Halt::Refused(label)`: uncatchable, not `is_panic`, documented as a "deliberate execution-profile exclusion" covering "a resource-size ceiling, key-space limit, or host-policy restriction" (`interp.rs:1683-1687`), registered in `REFUSED_LABELS` (`halt_labels.rs`). In practice it is mostly hard-coded 1<<24 size caps, plus `atomics:wait-notify` under "agent-model". (2) The report's `Category::Refused`, the test262 column for `refused:` reasons. (3) `StoreFailure::Refused`: a "deterministic" store refusal that also absorbs `HostAllocationFailed` through `MachineOperation`. (4) `RelinkError` docs say "refused" for `TableFull` and `MalformedBytecode`, both surfacing as `Halt::Decode`. (5) `HeapExhausted` described as "a ceiling's deterministic refusal" (`ARCHITECTURE.md:334`). (6) `MeterCheck::Abort`, "the host refused more computation". (7) `CeilingRefused` (`value.rs:51`). (8) The endo `Refusal` enum (`rust/endo/src/ironhorse_engine.rs:50`). (9) Snapshot admission refusals. (10) Prose "refused" at `NotImplemented` sites (`compartment.rs:602`, `interp/natives/compartment.rs:192`). | vocabulary, taxonomy, spec-model, doc-model | ONT-7, ONT-9, ONT-11, ONT-25 (misclassification), ONT-26 |
| NotImplemented, declined | `Halt::NotImplemented`: an unported opcode, built-in or value shape (`interp.rs:1682`), skip-eligible only if listed in `NOT_IMPLEMENTED_LABELS` or `NOT_IMPLEMENTED_HELPER_LABELS`. The `halt_labels` module calls NotImplemented and Refused together "declined". The test262 reason prefix for any NotImplemented label is `unsupported-opcode:`, even for non-opcode labels such as `unsupported-opcode:module:dynamic-import`. `HARNESS_NOT_IMPLEMENTED_LABELS` is "harness infrastructure declining". The `Halt::Throw` doc's "native catches have declined the thrown value" means did not catch it. Endo's "Ironhorse declines a program it cannot run". `CompartmentSkip`: "honest named skips" emitted as NotImplemented. | vocabulary, taxonomy, doc-model | ONT-25 |
| unsupported | `ParseErrorKind::Unsupported` (valid JS not yet ported, `ironhorse-compile/src/parser.rs:66`); `ironhorse_regexp::CompileError::Unsupported` (declared, never constructed); `SourceCompileError::Unsupported`, which becomes `Halt::NotImplemented("eval:compiler-unimplemented")`; `IronhorseCompile::Unsupported` in the harness, which also absorbs regexp budget, resource and host-allocation lex errors; `report::Category::Unsupported` (any IronHorse gap, including `ironhorse-aborted-limit`, `parse-or-decode` and `shared-positive-test-failure`); `StoreError::Unsupported` (a backend capability refusal); `native_unsupported_name`, which produces `native-call:*` NotImplemented labels; `ARCHITECTURE.md:301`'s "unsupported live state" (no `Coverage` variant has that name); `describe_halt`'s "unsupported opcode". | vocabulary, taxonomy, doc-model | ONT-8, ONT-10, ONT-27 |
| gap | Engine or coverage gap (report Unsupported); `computron_gap` (oracle and IronHorse computron counts differ, advisory); the `builtin-coercion-computron-gap` reason; "shared conformance gap" (`shared-test262-failure`); host or oracle gap (`oracle-host-missing-*`). | vocabulary | — |
| skip | `xst::Verdict::PreSkip` (declared or structural, never run) and `RunSkip` (ran, honestly named non-comparison); the parallel `report::Verdict` with wire strings; `report::Category::Skipped` (declared and structural only; RunSkips land in Unsupported, Refused, Skipped or Infrastructure); `expectations::Outcome::Skip`, which collapses PreSkip and RunSkip; the legacy `test262::Class::Skipped`; the skip-feature list; skip eligibility of halt labels; `CompartmentSkip`. The pre-run reasons `structural:multi-agent` and `structural:can-block` are assigned by source substring and flags. | vocabulary, taxonomy, spec-model | ONT-8, ONT-11 |
| quarantine | (1) A worker failure after N attempts: a `quarantine:` reason, Infrastructure, making the run "incomplete" (`report.rs:194`, `:921`). (2) A known-failure entry in an expectation list (`expectations.rs:421`; `bin/endot_ih.rs:365`). | vocabulary | — |
| halt, Step, DispatchOutcome | `Halt` (`interp.rs:1631`): every host-observable end of a run, including normal completion (`Return`), an uncaught throw (`Throw`), resource stops, gaps, faults and `MachineBusy`. Internal control transfers live in the private `Step` (`interp.rs:1858`), which `ARCHITECTURE.md:337` calls `DispatchOutcome`, a type that does not exist. | vocabulary, spec-model | ONT-30 |
| panic | `Halt::is_panic()`: the terminate-without-commit set (StackOverflow, ReentryLimit, MeterAbort, HeapExhausted, HostAllocationFailed, EngineInvariant, `Panic(_)`, and the provisional Decode and StepLimit). `Halt::Panic(PanicKind::EngineFault)`: built only by embedders, while panics caught inside the VM become `EngineInvariant("host:*-panicked")`. `ExecutionOutcome::Panicked`: a superset that also absorbs NotImplemented and Refused. `IronhorseCompile::Panicked`: a front-end panic. | taxonomy | ONT-10 |
| invariant | `Halt::EngineInvariant(label)`: an interpreter guard fired, or a host-callback panic was caught. `SourceCompileError::Invariant` and `ironhorse_compile::CompileError::Invariant`: a caught compiler panic. `StoreError::EngineInvariant`: the VM halted with EngineInvariant or Panic, or a lazy fault found the store borrowed; classified Poisoned although the store itself is intact. | taxonomy | — |
| HeapExhausted | Documented as the configured slot or chunk ceiling (`interp.rs:1638`). Also raised for the regexp matcher's fixed 65,536-state / 64 MiB profile and for the regexp compiler's storage ceiling. `SourceCompileError::HeapExhausted` is documented as "Regexp compilation exceeded its storage profile": its name says heap, its doc says regexp profile. | taxonomy | ONT-1 (homonym) |
| ceiling | Configured slot ceiling (default 1,000,000) and chunk ceiling (256 MiB), with consensus maxima (`value.rs:14-41`); the step ceiling (`StepLimit`) and `BOUNDED_RUN_SLOT_CEILING` (live slots, also reported as StepLimit); the regexp storage ceilings `MAX_MATCH_STATES` / `MAX_MATCH_BYTES` (`matcher.rs:127-128`), reported as HeapExhausted; the guest key soft ceiling versus the hard id-space latch. | vocabulary | ONT-1 |
| limit | `ReentryLimit` (native recursion), `StepLimit`, `MeterLimit` (compiler work), regexp `ResourceLimit` (storage and quantifier range), "key-space limit", fixed 2^24 result caps (Refused `*:result-too-large` / `*:oversized-*`), and the harness reason `ironhorse-aborted-limit` (any non-throw abort). | vocabulary | ONT-1, ONT-7 |
| result too large | A catchable `RangeError` ("result too large", "count too big", "invalid length") at the 0x7fff_ffff bound; `Halt::Refused("*:result-too-large" / "*:oversized-*")` at private fixed caps; `Halt::HeapExhausted` at the configured chunk ceiling. XS has one memory abort for all of these. | taxonomy | ONT-7 (synonym: three classes) |
| Decode, parse-or-decode | `Halt::Decode(DecodeError)`: malformed bytecode, but also `MissingBytecode` (a harness stand-in for a failed or panicked compile) and `Relink(TableFull)` (key-space exhaustion). The `parse-or-decode` test262 reason covers compiler gaps on positive Scripts, compiler panics and genuine decode faults. | taxonomy | ONT-10 (homonym) |
| stack overflow | `Halt::StackOverflow`: the modelled XS value-stack geometry (`fxOverflow`, `XS_JAVASCRIPT_STACK_OVERFLOW_EXIT`). `Halt::ReentryLimit`: the native recursion budget, the analogue of `fxCheckCStack` / `XS_NATIVE_STACK_OVERFLOW_EXIT`. The parser's "stack overflow" `SyntaxError` (`PARSER_STACK_BUDGET`, XS `fxCheckParserStack`). README calls the native-budget stop StackOverflow. | doc-model | ONT-28 (synonym) |
| outcome | `RunOutcome` (`interp.rs:1897`), `EvalOutcome` and `ExecutionOutcome` {Quiesced, Uncaught, Panicked} in the endo seam, `DispatchOutcome` (internal yield/await, per ARCHITECTURE), regexp `MatchOutcome` and compile outcome, `expectations::Outcome` {Pass, Fail, Skip}, `CompileFuzzOutcome`, the harness's four-valued `Agreement`. | vocabulary | — |
| throw, abort, stop | Throw: `Halt::Throw {value, rendered}` (uncaught guest throw at the host boundary), `Step::Threw` (internal, catchable by native boundaries), `Halt::synthetic_throw` (harness stand-in), `raise_js` / `catchable_range_error_msg`. Abort: any non-Return halt ("completion or abort"), `MeterAbort` / `MeterCheck::Abort`, XS `fxAbort`, StepLimit "aborts here", Rust panic=abort or a WASM trap, the harness's `Agreement::BothAbort` and `abort-value-differs`. Stop: "host stop" = MeterAbort and HeapExhausted (`ARCHITECTURE.md:192`), deterministic crank outcomes; "resource stop" payloads caught by `resource_halt` (`interp.rs:1605`); the compiler's "budget-stop unwind". Distinct from "host failure" (`Halt::is_host_failure`, HostAllocationFailed only), which is never the crank's outcome. | vocabulary | ONT-26 (related) |
| charge, cost, computron, weight, meter | Charge: add raw 16.16 units to the meter; the compile "charge callback" and "receipt"; side-storage charge (bytes against the chunk ceiling); the regexp matcher's "consensus byte charges" (`matcher.rs:130-134`); host-callable work charging. Cost table: the frozen release weights (`COST_TABLE_VERSION` `ironhorse-meter-9`, `ironhorse-meter/src/lib.rs:15`). Computron: raw >> 16 (`meter.rs:337`; `RunOutcome.computrons`); "XS computrons" are the oracle's meter, advisory; host intervals are given in computrons and scaled by << 16 (`meter.rs:113-121`, `:143`). Weight: frozen per-operation constants, and also the "weighted depth" of native recursion (2,048 units). Meter: the `Meter` struct (`meter.rs:85`), `MeterState` in METR, the meter host callback, the meter release. | vocabulary | — |
| budget, allowance | Budget: the raw compile budget passed to `SourceCompiler` (`interp.rs:270-311`); the regexp compile budget derived from meter headroom (`interp/natives/regexp.rs:327`); the native-recursion budget (`interp.rs:360-408`); the render dispatch budget (`interp.rs:336`); harness per-case timeouts. Allowance: a synonym for the raw compile budget ("hard raw allowance", `ironhorse-compile/src/error.rs:23`, `parser.rs:55`), and also a grammar permission ("sloppy-mode allowance", `ast.rs:42`, `lexer.rs:73`). | vocabulary | — |
| admission | Compile/source admission, pre-charging source-sized work (`ARCHITECTURE.md:191`; `interp/admission.rs`); allocation admission under the ceilings, and scratch admission; snapshot admission by the persist gates and quiescence (`ARCHITECTURE.md:220`, `:301`); store commit admission (`HeapStoreCommit`, `VerifiedCommit`); guest key admission (`admit_guest_key_count`, `interp/property/keys.rs:53`). | vocabulary | — |
| release | (1) Meter release, the `COST_TABLE_VERSION` name such as `ironhorse-meter-9`. (2) "Release binary", the per-binary scope of determinism (VM `lib.rs`, `versions.rs`). (3) Row release, an entry in `row_schema_releases.tsv`. (4) Intl "profile release" (`DETERMINISM-METERING.md`), which no mechanism can produce. (5) A cargo `--release` build. The meter docs' "matching release" reads as (1); the determinism claim needs (2). | identity | ONT-20 |
| version | `IRONHORSE_FORMAT_VERSION` (container encoding, carried in VERS and in the store manifest); `STORE_SCHEMA_VERSION` (paged-store representation); `ROW_SCHEMA_VERSION` (capture/restore declarations); the XS version and pin; and the "version-4 meter pin" in `ironhorse-262/src/xst.rs`, a stale label for meter-9 pins. | identity | ONT-31, ONT-32 |
| fingerprint, digest | Boot fingerprint: SHA-256 over Debug renderings of the fresh boot heap and tables, carried in SIGN as IHB1. Cost-table digest: weights plus `DEFAULT_KEYS`, carried in METR. Row declaration fingerprint: SHA-256 over two source files, kept in the TSV ledger. ICU dependency-graph digest: `intl_profile.rs` comment and alias suffix. Store section-level change-detection digests. | identity | ONT-20, ONT-21, ONT-22 |
| signature (SIGN) | A host-chosen callback-table string plus the engine boot fingerprint ("IHB1"). Endo calls it "the combined signature"; `HeapStoreOptions` calls it the "boot-layout generation"; it replaced the retired `BOOT_LAYOUT_VERSION`. Legacy signatures lack the fingerprint and cannot authorize restore. `INTL_DATA_VERSION` reaches it only as a boot string. | identity, doc-model | ONT-20, ONT-33 |
| pin | XS source pins: `opcode.rs` and `metering.rs` cite `48ee02d8cfe0`, while the gitlink, oracle and compiler use `23b4d6b0a65f`. Meter release digest pins (`releases::PINNED`, append-only by comment only). test262 raw meter pins (`ironhorse-meter-9-raw-N` features). Golden snapshot pins and fixtures that get "restamped". | identity | ONT-21, ONT-31 |
| restamp | (1) Regenerating persisted fixtures and inline digests after a boot-heap move (`8af3bbc9`, `392502d3`). (2) A migration-ladder step that changes only the manifest schema number ("37 → 38 is an identity restamp"). (3) A checkpoint rewriting an older readable VERS to current. | identity | ONT-21, ONT-33 |
| installed-names floor (NFLR) | A persisted scalar id ceiling: names at or below it are assumed to have had their intrinsic members installed. | identity | ONT-4 (refuted) |
| profile | The Intl data profile (`INTL_DATA_VERSION`); the shared primordial profile (realm intrinsic roots checked at shared restore); platform versus deterministic Math; the host signature string "standalone-profile" in Endo tests. | identity | ONT-20 |
| `PARSE_METER_RELEASE`, `COMPILE_METER_RELEASE` | Two aliases of `COST_TABLE_VERSION` (`ironhorse-compile/src/meter.rs:5-6`): one concept under three names. The docs mention only `PARSE_METER_RELEASE`. | identity | — (synonym, no consequence shown) |
| departure, GAP | The `ironhorse-262/tests/xs_departures.rs` tables (DEPARTURES, UNPAIRED, KEPT, SHARED, GAPS). README says every deliberate departure is recorded; the caller-environment rule for shared dynamic constructors is not. | doc-model | ONT-14, ONT-12, ONT-13 |

## Findings

The 32 surviving findings are ordered by final severity, then by id.
Paths are repo-relative at `61cd656cb`.
The severity line gives the proposed severity and each verifier's.
"Lowered" means verification brought the final severity below what the finder proposed.
A section that re-finds a region map's defect carries a "Same defect as" line, and one that shares
a root with a region finding carries a "Same root as" line.
"Medium as merged" gives the severity of the merged finding, as the summary's index lists it.

| Id | Short title | Final severity | Category |
|---|---|---|---|
| ONT-2 | Array indices interned as 16-bit name keys on generic Array paths | high | type-encoding |
| ONT-3 | `Slot` conflates value and record; `f.apply` copies element attribute flags | high | type-encoding |
| ONT-6 | Built-in accessors as `GET_PROPERTY` interceptions, not prototype accessors | high | spec-model |
| ONT-5 | Jobs record no realm or environment | medium (lowered from high) | spec-model |
| ONT-9 | Symbol weak keys: Refused in constructors, TypeError elsewhere | medium | taxonomy |
| ONT-11 | No Agent [[CanBlock]] model for Atomics wait/notify | medium | taxonomy |
| ONT-12 | `parseInt` loses -0; the integer fold is written several times | medium | type-encoding |
| ONT-13 | Same-type TypedArray construction canonicalizes NaN payloads | medium | type-encoding |
| ONT-15 | No global declarative record for Script lexicals | medium | spec-model |
| ONT-17 | Global object has a null [[Prototype]]; name resolution hard-wires %Object.prototype% | medium | spec-model |
| ONT-19 | `EnvironmentId` is a reusable slot index, not a lineage id | medium | identity-versioning |
| ONT-21 | The persisted bytecode ISA is identified by no gate | medium | identity-versioning |
| ONT-1 | `HeapExhausted` names the configured ceilings and fixed regexp limits | low (lowered from high) | synonym-homonym |
| ONT-7 | "Result too large" classified three ways at three thresholds | low on its own (lowered from medium); medium as merged | taxonomy |
| ONT-8 | test262 module-path compile classification and unclassified `module:*` skips | low on its own (lowered from medium); medium as merged | taxonomy |
| ONT-10 | `Halt::Decode` / `parse-or-decode` conflates four conditions | low (lowered from medium) | taxonomy |
| ONT-14 | Start compartment's `eval`/`Function` and shared constructors have no home | low (lowered from medium) | spec-model |
| ONT-16 | Guest `Compartment.prototype.evaluate` is an eval program, documented as a Script | low (lowered from medium) | spec-model |
| ONT-20 | No persisted identifier covers guest-visible semantics; `INTL_DATA_VERSION` covers only ICU | low (lowered from medium) | identity-versioning |
| ONT-22 | Row-schema gate fingerprints two files; tuple rows escape it | low (lowered from medium) | identity-versioning |
| ONT-23 | "completed" means "job queue drained" in docs, not in compartment evaluation | low | synonym-homonym |
| ONT-24 | "Realm" names three things; crate docs say per-compartment and always frozen | low | synonym-homonym |
| ONT-25 | Host-policy refusals filed as `NotImplemented` | low | taxonomy |
| ONT-26 | Store maps `HostAllocationFailed` to deterministic `Refused` | low | taxonomy |
| ONT-27 | Side-table ledger has no "unsupported" class | low | taxonomy |
| ONT-28 | README names the native-recursion halt `StackOverflow`; code emits `ReentryLimit` | low | taxonomy |
| ONT-29 | Module records lack [[EvaluationError]] | low | spec-model |
| ONT-30 | One NULL sentinel, three documented meanings | low | doc-code-drift |
| ONT-31 | Identifier documentation gives stale values | low | doc-code-drift |
| ONT-32 | The VERS stamp can understate content for formats 25 and 26 | low | identity-versioning |
| ONT-33 | The store migration ladder sits behind the boot-fingerprint gate | low | identity-versioning |
| ONT-34 | Symbol key ids are never returned after GC proves them dead | low on its own; medium as merged | identity-versioning |

### ONT-2 — Array indices are interned as 16-bit property-name keys on the generic Array paths, so `new Array(70000).fill(0)` throws and leaves the realm unable to mint names or run new code

**Severity:** high (proposed high; code-evidence verifier high; consequence-and-intent verifier high).

**Category:** type-encoding.

**Same defect as:** NOBJ-1 and PROP-1, one merged finding (high) with NOBJ-1 as its primary.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/natives/array.rs`: `:2056` (`array_generic_index_id`),
  `:2061` (the non-minting sibling `array_index_read_key`), and call sites `:2677`, `:2787`,
  `:2935`, `:3010`, `:4565`.
- `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:4362`.
- `rust/engine/ironhorse-vm/src/interp/property/keys.rs:56`. The finder cited `:53`, which is a
  doc comment; the `RangeError` is built at `:56` and the capacity predicate is at `:62-69`.
- `rust/engine/ironhorse-vm/src/interp/link.rs:1396`, `:1410`.
- `rust/engine/ironhorse-262/src/lib.rs:671`.
- Added by verifiers:
  - `array.rs:4497` (`array_sort`, which has no dense path) and `array.rs:4571`;
  - `array.rs:3213` (`array_generic_create_data_property`, documented XS parity);
  - `rust/engine/ironhorse-vm/src/compartment.rs:784-786` (the production relink path);
  - `rust/engine/ironhorse-262/src/test262.rs:158`.

**Excerpt:**

```
array.rs:2056  pub(in crate::interp) fn array_generic_index_id(&mut self, k: u64) -> Result<u16, Step> {
        let name = k.to_string();
        self.intern_key(&name)
    }
array.rs:2061-2067 (the sibling read helper's own contract): "An index above u32::MAX is not an array index at all ... Every real element index resolves to a name only if one already exists."
keys.rs:56  return Err(self.catchable_range_error_msg("property key space exhausted".into()));
```

**Mechanism:** The engine has two kinds of property key.

- Integer element indices (`ReadKey::Index(u32)`) live in the array and index side tables, as XS
  stores them, and never enter the key table.
- Interned names are `u16` ids drawn from the 16-bit name/symbol id space shared by string and
  symbol keys. They are persisted in the NAME/SYMB atoms and never reclaimed: nothing in
  `ironhorse-vm/src` truncates or retains `symbol_names` or `symbol_ids`.

`array_generic_index_id` collapses the first kind into the second.
For every index it touches, it calls `k.to_string()` and then `intern_key`, which charges
`admit_guest_key` and mints a permanent name id.
A grep finds the definition plus 29 call sites: 24 in `array.rs`, 4 in `regexp.rs` and 1 in
`string.rs`.

- **The 23 call sites that diverge.** They sit in push/pop (`:2495`, `:2519`), shift/unshift
  (`:2568-2637`), reverse (`:2677-2678`), splice (`:2787-2858`), copyWithin (`:2935-2936`), fill
  (`:3010`) and the sort write-back (`:4565`, `:4571`). XS completes all of these without
  interning.
- **The documented exception.** The 24th call site is in `array_generic_create_data_property`
  (`:3213`, used by `toSorted`, `flat` and `map` results). `designs/ironhorse-known-defects.md:508-512`
  records that the pinned XS interns on that path too.
- **The `regexp.rs` and `string.rs` sites** pass only small indices.

A holey array such as `new Array(n)` misses the dense fast paths: `dispatch.rs:4362` sends `fill`
to `array_generic_fill` unless `dense_array_this` succeeds.
`array_sort` (`:4497`) has no dense path at all, so even a dense `a.sort()` mints one name per
element.
Reads mint names too: `reverse` interns both indices before `mop_has`, so absent holes cost ids.

The soft-ceiling `RangeError` is catchable, so the crank completes and stays quiescent.
It can then be committed and snapshotted with the exhausted table.
From then on:

- every run-time name (computed key, `JSON.parse` key, symbol key, indirect-eval declaration)
  throws `RangeError`;
- `relink_crank` refuses every later crank that introduces a new identifier with
  `RelinkError::TableFull` (`link.rs:1396`, `:1410`).

That refusal is spelled `Halt::Decode(Relink(TableFull))` by `ironhorse-262` (`lib.rs:671`),
which `test262.rs:158` files as `parse-or-decode`.
It is spelled `Halt::Decode(DecodeError::InvalidSymbols)` by the production compartment path
(`compartment.rs:784-786`).

**Consequence:** Guest-visible divergence on common idioms.

- **Preallocate-and-fill.** XS and Node complete `new Array(70000).fill(0)`; IronHorse throws
  `RangeError: property key space exhausted`.
- **Other holey operations.** The same happens for `reverse`, `splice`, `unshift`, `copyWithin`
  and `sort` on large holey arrays.
- **Dense sorts.** An ordinary sort of a dense array of 65,000 or more elements also throws.
- **Successful operations still use up the budget.** After a dense sort of 64,000 elements
  IronHorse can mint only 407 more names in that realm's lifetime, while XS mints all 1,000
  requested. After a successful `new Array(40000).fill(0)`, IronHorse mints 24,410 of 30,000
  requested names; Node mints all 30,000.
- **The degraded state persists.** The realm's state stays consistent but exhausted, and it is
  committed and persisted. Unrelated later code fails, and so does every future crank that names
  a new identifier.

A relink refusal caused by guest behaviour is reported as a bytecode decode fault, and under two
different `DecodeError` variants.

**Evidence:** The finder's probes are in `probes/ontology/taxonomy/`:

```
Probes in ../probes/ontology/taxonomy/ (run.sh compares ironhorse-xst with node).

p18_fill_common.js:
  const out = [];
  for (const n of [1000, 70000]) { try { const a = new Array(n).fill(0); out.push(n + ":ok:" + a.length + ":" + a[n - 1]); } catch (e) { out.push(n + ":" + e); } }
  ... throw new Error(out.join(" | "));
  ironhorse: Error: 1000:ok:1000:0 | 70000:RangeError: property key space exhausted | new-name ok
  node:      Error: 1000:ok:1000:0 | 70000:ok:70000:0 | new-name ok

p21_poison.js (fill, catch, then mint names at run time):
  try { new Array(70000).fill(0) } catch {}; then o["k"+12345]=1; JSON.parse('{"freshJsonKey":1}'); m["name_"+i]=i; Symbol.for(...)
  ironhorse: Error: fill RangeError: property key space exhausted || RangeError: property key space exhausted | RangeError: property key space exhausted | RangeError: property key space exhausted | ok
  node:      Error: fill ok || ok | ok | ok | ok

p24_latch.js (after the fill): o[Symbol("s"+i)] = i and (0,eval)("var zzGlobal"+i+" = 1")
  ironhorse: Error: symbol keys after 0: RangeError: property key space exhausted | eval globals after 0: RangeError: property key space exhausted
  node:      Error: symbol keys ok 3000 | eval globals ok 3000

p36b/p36c/p39b: new Array(140000).reverse() / splice(0,1) on a 140000-holey array / sort of a 70000-holey array
  ironhorse: caught RangeError: property key space exhausted (all three); node: 140000 / 139999 / 70000

XS oracle (Rust probe zz_audit_ont_1.rs and zz_audit_ont_3.rs, ironhorse-262/tests, deleted after the run; copies in the probe dir):
  ORACLE fill-70000-then-fresh-name: completed=true result="0"
  IRONHORSE fill-70000-then-fresh-name: completed=false halt=Throw{ rendered: "RangeError: property key space exhausted" }
  reverse-holey-140000  XS: completed=true result="140000"  IRONHORSE: result="caught RangeError: property key space exhausted"

Cross-crank (zz_audit_ont_2.rs: crank 1 = guarded fill, crank 2 = `var someBrandNewIdentifier = 1`):
  CRANK "var r; try { new Array(70000).fill(0); r = 'ok'; } catch (e) { r = String(e); } r": completed=true result="RangeError: property key space exhausted" halt=Return
  CRANK "var someBrandNewIdentifier = 1; someBrandNewIdentifier": relink refused: TableFull
  (the same second crank on a fresh machine: completed=true result="1")

Differential runner (endot-ih with a private test262 root, t262/test/built-ins/probe/fill-70000.js): fail: "ironhorse threw where the oracle completed: RangeError: property key space exhausted".
```

The code-evidence verifier wrote its own XS-oracle and cross-crank probe,
`ironhorse-262/tests/zz_audit_ont_207.rs` (deleted after the run; copy at
`probes/ontology/verify-ont2/zz_audit_ont_207.rs`).
It was run with
`CARGO_TARGET_DIR=$SCRATCH/audit-target cargo test --release -p ironhorse-262 --test zz_audit_ont_207`:

```
ORACLE fill-70000: completed=true result="0"
IRONHORSE fill-70000: completed=false halt=Throw{.. rendered: "RangeError: property key space exhausted"}
ORACLE fill-70000-then-fresh-name: completed=true result="fresh ok"
IRONHORSE fill-70000-then-fresh-name: completed=true result="RangeError: property key space exhausted" halt=Return
ORACLE reverse-holey-140000: completed=true result="140000"
IRONHORSE reverse-holey-140000: completed=true result="caught RangeError: property key space exhausted"
ORACLE dense-push-70000-fill: completed=true result="0"
IRONHORSE dense-push-70000-fill: completed=true result="0"   (dense fast path unaffected)
CRANK "var r; try { new Array(70000).fill(0); ...": completed=true result="RangeError: property key space exhausted" halt=Return
CRANK "var someBrandNewIdentifier = 1; someBrandNewIdentifier": relink refused: TableFull
CRANK "r": completed=true result="RangeError: property key space exhausted"
fresh machine: CRANK "0" ok; CRANK "var someBrandNewIdentifier = 1; ..." completed=true result="1"
```

The consequence-and-intent verifier's probes are in `probes/ontology/verify-ont2-intent/`
(`results.txt`, `results_t.txt`).
Each JS probe ran in a fresh realm on `ironhorse-xst` and Node 22, inside the wrapper
`let r; try { BODY; } catch (e) { r = 'caught ' + e; } throw new Error(String(r));`.

| Probe | Body | IronHorse | Node |
|---|---|---|---|
| c05_dense_sort | `const a=[]; for(let i=0;i<70000;i++) a.push(70000-i); r = a.sort((x,y)=>x-y)[0]` | caught RangeError: property key space exhausted | 1 |
| t_sort_default_dense | default `sort()` on a dense array of 70000 strings | caught RangeError | 1 |
| c09_array_fn_fill | `r = Array(70000).fill(0).length` | caught RangeError | 70000 |
| c22_dense_with_one_hole_fill | 70000 dense, `delete a[5]`, `fill(0)` | caught RangeError | 0 |

Its XS-oracle probe, `zz_audit_ont_251.rs`, produced the following:

```
ORACLE    dense-sort-70000: completed=true result="1"
IRONHORSE dense-sort-70000: completed=true result="caught RangeError: property key space exhausted"
ORACLE    dense-toSorted-70000: completed=false error="undefined"     <- XS parity (documented exception)
ORACLE    flat-70000: completed=false error="undefined"               <- XS parity (documented exception)
ORACLE    holey-fill-70000: completed=true result="70000"
IRONHORSE holey-fill-70000: completed=true result="caught RangeError: property key space exhausted"
ORACLE    dense-sort-40000-then-30000-names: result="names 30000"
IRONHORSE dense-sort-40000-then-30000-names: result="names 24407 RangeError: property key space exhausted"
ORACLE    dense-sort-64000-then-1000-names: result="names 1000"
IRONHORSE dense-sort-64000-then-1000-names: result="names 407 RangeError: property key space exhausted"
```

Fill and dense sort succeed at 64,400 elements and throw at 65,000.
In a fresh realm IronHorse mints 64,412 computed names; Node mints 80,000.
Dense `map`, `filter`, `slice`, `concat`, `reverse`, `splice`, `unshift`, `fill` and `copyWithin`,
`Array.from({length:70000})`, `[...Array(70000)]`, `split`, `JSON.parse` and holey `map` all
matched Node.

**Recommendation:**

1. **Give integer indices their own key type end to end.**
   Make `array_generic_index_id` return a `ReadKey`/`PropertyKey` enum: `Index(u32)` for
   `k <= 2^32-2`, and an interned `Id` only above that, as `array_index_read_key` already does
   for reads.
   Route the MOP has/get/set/delete calls of the diverging call sites through that enum.
2. **Give `array_sort` a write-back that does not intern.**
3. **Decide `array_generic_create_data_property` explicitly.**
   It is recorded XS parity and is tied to metering calibration
   (`designs/ironhorse-known-defects.md:508-512`).
4. **Add regression tests.**
   Fill, reverse and sort a 200K holey array, then mint a fresh name.
   Add a dense-sort budget test and a cross-crank relink test.
5. **Name key-space exhaustion once.**
   Make `RelinkError::TableFull` a named resource refusal everywhere it surfaces.
   Today it is `Decode(Relink(..))` in the harness and `Decode(InvalidSymbols)` at
   `compartment.rs:784-786`, and neither is a decode error.

**Verification:**

- **Code-evidence verifier (kept high).**
  - Re-read every cited line and counted 30 grep matches for `array_generic_index_id`: the
    definition plus 29 call sites, split 24/4/1.
  - Found no reclamation of `symbol_names` or `symbol_ids`.
  - Confirmed the shared capacity bound in `link.rs`, the `Decode(Relink(..))` mapping, the
    harness's `parse-or-decode` filing, and the hard latch at `interp.rs:3118`,
    `dispatch.rs:289` and `promise.rs:876`.
  - Re-ran the JS probes, and wrote the oracle and cross-crank probe above: XS completes every
    case, and the dense fast path is unaffected.
  - Corrected `keys.rs:53` to `:56`.
- **Consequence-and-intent verifier (kept high).**
  - Checked whether the behaviour is a decision. `ARCHITECTURE.md:349-353` covers guest-created
    string and symbol keys only. The engine's own tests (`index_read_mints_no_key_all_shapes.rs`,
    `index_scaling_mints_no_key.rs`) treat an index that mints a name as a divergence from XS.
    Only `array_generic_create_data_property` and `array_from_define` are documented XS parity,
    and the oracle confirms it: XS also fails `toSorted` and `flat` of 70,000.
  - Showed that dense sorts are affected and that successful operations erode the lifetime
    budget.
  - Found the claimed "one condition, three classes" overstated. The soft-ceiling `RangeError` and
    the hard-latch `Refused` are deliberately distinct and the latch is not reached through these
    paths, so only the two `Decode` spellings of relink exhaustion remain.
  - Corrected the first verifier on production relink callers: its
    `rust/endo/src/ironhorse_engine.rs:2138` and
    `rust/endo/ironhorse-store-sqlite/src/lib.rs:1342` are test-module code, and the production
    caller is `compartment.rs:784`.

### ONT-3 — Slot conflates a JS value with a property/element record: Function.prototype.apply copies frozen array elements' attribute flags into the callee's arguments object and rest array

**Severity:** high (proposed high; code-evidence verifier high; consequence-and-intent verifier
high).

**Category:** type-encoding.

**Same root as:** NOBJ-NEW-1 (high), where the array fast paths copy a `const` binding's
`DONT_SET` flag into the stored element.
Both come from one `Slot` type serving as a value and as a property record, so attribute flags
travel with copied values.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/apply.rs:207`, in `dot_apply_operands` (`apply.rs:161`).
- `rust/engine/ironhorse-vm/src/interp/apply.rs:385`, in `enter_call_dot_apply` (`apply.rs:324`).
- `rust/engine/ironhorse-vm/src/interp/dispatch.rs:1288`, `:1293`.
- `rust/engine/ironhorse-vm/src/value.rs:620`.
- `rust/engine/ironhorse-vm/src/interp/property/indexed.rs:8`. Lines `:8-24` are
  `array_item_value`, the projection the leaking sites skip.
- Added by verifiers: `bulk.rs:175` (`ArrayData.items`, a `BTreeMap<u32, Slot>`) and
  `bulk.rs:281-286` (`store_item` keeps `value.flag` and counts it as an attribute).

**Excerpt:**

```
apply.rs:385 (and :207 in dot_apply_operands): `let args = Self::fill_scratch(buffer, (0..len).map(|i| data.items()[&i]));`
dispatch.rs:1288-1293 (exec_arguments): `let values: Vec<Slot> = self.args.iter().copied().skip(offset).collect(); ... data.insert_item(index as u32, value, &mut self.side_refs, &mut self.chunks);`
indexed.rs:23 (the projection these sites skip): `Slot::of(item.kind, item.value)`
```

**Mechanism:** One Rust type, `Slot` (`value.rs:620`), stands for two different things:

- a JS value (`kind` plus payload);
- a stored property or element record, where `id` is the key and `flag` holds the attributes
  (XS_DONT_SET 8, XS_DONT_DELETE 2, XS_DONT_ENUM 4).

Array items in the `arrays` side table are full records, so a frozen, sealed or attributed
element carries attribute bits in `flag`.
Because the type system cannot stop a record being used as a value, the code scrubs by hand at
about 70 sites.
The finder counted 40 `Slot::of(x.kind, x.value)` rebuilds, 23 `.id = 0` resets and 7 `.flag = 0`
resets, plus the helper `array_item_value`.
The code-evidence verifier's regex counted 40, 19 and 9.

The dense fast path of the `f.apply(thisArg, arr)` member-call form skips that scrub and forwards
the raw item records as call arguments.
That form is the call-site trampoline at `apply.rs:207` and `:385`.
The branch is entered whenever `data.items().len() == len` and the source is not an arguments
object.
A frozen dense array satisfies both conditions.

Two consumers then store the argument `Slot`s verbatim, so the leftover `flag` byte is read back
as attributes:

- `exec_arguments` (`dispatch.rs:1288-1293`), when it builds the callee's arguments object or rest
  array;
- native callees reached through the same path (`push`, `unshift`, `concat`, `Array.of`), which
  store into their target through `store_item`.

`Function.prototype.apply.call(f, …)`, an extracted `apply` invoked with `.call`, `Reflect.apply`,
spread, `.call`, construct, and a sparse source all build the argument list through
`arraylike_to_vec` or iteration, and they scrub.
So the same operation gives different results depending on how it is entered.
Upstream XS does not do this: `mxPushSlot` clears `flag` to `XS_NO_FLAG` when it pushes an
argument.
`designs/ironhorse-known-defects.md:153-190` records an earlier bug at this same shortcut (F179).
The shortcut forwarded mapped-arguments closure cells as values, and the fix routed arguments
objects away from the shortcut instead of projecting items.

**Consequence:** In hardened JavaScript, `harden()` freezes arrays as a matter of routine.

- **Callee state.** After `fn.apply(thisArg, frozenArray)`, the callee's rest array and
  `arguments` object have non-writable, non-configurable elements. In strict code (all SES code)
  a write to them throws `TypeError`; in sloppy code the write fails silently. In-place `sort`,
  `reverse`, `pop`, `delete` and `length = 0` on the rest array throw.
- **Caller state.** `Array.prototype.push.apply(target, hardenedArray)` gives the caller's own
  unfrozen target array non-writable, non-configurable elements. The same holds for `unshift`,
  `[].concat.apply` and `Array.of.apply`.
- **Every attribute bit leaks, and the damage propagates.** A sealed source makes the element
  non-configurable. A non-enumerable source element becomes non-enumerable, so `Object.keys`
  drops it. The flags carry forward when the damaged array is itself applied again.
- **Common code reaches it.** TypeScript 6.0.2's ES5 output compiles `target.push(...items)` to
  `target.push.apply(target, items)` and `fn(...args)` to `fn.apply(void 0, args)`. Code shipped
  as ES5 therefore hits this path even when written with spread.
- **It survives lockdown.** The behaviour persists after `lockdown()`, and template-strings arrays
  leak the same way.

Parameter locals are not affected.
Endo's own dispatch uses `Reflect.apply` (`packages/eventual-send/src/local.js:96`, `:135`), so the
platform path is unaffected.
test262 does not cover this: no file combines `.apply(` and `Object.freeze(`.

**Evidence:** The finder's probe is
`probes/ontology/types/p20_apply_flags.js`, compared using `cmp.py` in the same directory:

```
JS probe ../probes/ontology/types/p20_apply_flags.js, run with ironhorse-xst and compared against node 22 using cmp.py in the same directory.
Source excerpt:
  function d(o,k){var x=Object.getOwnPropertyDescriptor(o,k);return x?(x.writable?'W':'w')+(x.enumerable?'E':'e')+(x.configurable?'C':'c'):'none';}
  var F = Object.freeze([1, 2]);
  function rest(...r) { return r; }  function argsf() { return arguments; }
  t('apply_rest', ()=>d(rest.apply(null, F), 0));
  t('reflect_apply_rest', ()=>d(Reflect.apply(rest, null, F), 0));
  t('spread_call_rest', ()=>d(rest(...F), 0));
  t('apply_args', ()=>d(argsf.apply(null, F), 0));
  t('bound_apply_rest', ()=>{var b=rest.bind(null);return d(b.apply(null,F),0);});
  t('mutate_rest_strict', function(){'use strict';var r=rest.apply(null,F);r[0]=99;return r[0];});
  t('push_after', ()=>{var r=rest.apply(null,F);r.push(3);r.sort((a,b)=>b-a);return r.join(',');});
  t('harden_like', ()=>{var args=Object.freeze(['x']);function g(...xs){xs[0]='y';return xs[0];}return g.apply(undefined,args);});
Observed (xst vs node):
!! apply_rest: xst='wEc'  node='WEC'
   reflect_apply_rest: xst='WEC'
   spread_call_rest: xst='WEC'
!! apply_args: xst='wEc'  node='WEC'
!! apply_strict_args: xst='wEc'  node='WEC'
!! bound_apply_rest: xst='wEc'  node='WEC'
!! mutate_rest_strict: xst='THROW TypeError:set ?: not writable'  node='99'
!! mutate_rest_sloppy: xst='1'  node='99'
!! push_after: xst='THROW TypeError:C: xsSet ?: not writable'  node='3,2,1'
!! harden_like: xst='x'  node='y'
!! nonwritable_elem_apply: xst='wEC wEC'  node='WEC wEC'
A wider sweep (p19_flagleak.js) tried 36 copy paths from frozen and attributed arrays: slice, spread, from, map, concat, assign, toSorted, push, splice, destructuring, Object.values/entries, Array.prototype.slice.call(arguments), and others. All were correct except `fn.apply(null, a)` into `arguments` and into a rest parameter. Second-order paths in p21_flagleak2.js (reduce seed, Map built from frozen entries, Set built from a frozen array) are also correct.
```

The code-evidence verifier's probes, `probes/ontology/verify-ont3/v1.js` and `v2.js`, used the
same `d()` and `t()` helpers:

```
   param_assign_strict: '5'   param_assign_sloppy: '5'   param_closure_assign: '6'
   param_to_obj / param_to_array_lit / param_push / param_index_set / arguments_slice: 'WEC'
!! rest_spread_again: xst='wEc'  node='WEC'
!! rest_delete: xst='THROW TypeError:delete ?: no permission (strict mode)'  node='2:false'
!! rest_reverse: xst='THROW TypeError:C: xsSet ?: not writable'  node='2,1'
!! sealed_source: xst='WEc'  node='WEC'
!! nonenum_source: xst='WeC 0'  node='WEC 0,1'
   reflect_apply_args / call_apply / apply_apply: 'WEC'
!! array_of_apply: xst='wEc'  node='WEC'
!! push_apply: xst='wEc'  node='WEC'
   reduce_seed_arguments / reduce_seed_rest / reduceRight_seed_rest / reduce_seed_push: 'WEC'
   sparse_frozen_apply: 'WEC'   (non-dense path goes through arraylike_to_vec and is scrubbed)
!! push_apply_frozen_then_write: xst='THROW TypeError:set ?: not writable'  node='9,2'
!! concat_apply: xst='wEc'  node='WEC'
!! unshift_apply: xst='wEc'  node='WEC'
   splice_apply: 'WEC'
```

The consequence-and-intent verifier's probe is
`probes/ontology/verify-ont3-consequence/c1_ts_emit.js`.
It uses the TypeScript ES5 emit shapes `collect` (`target.push.apply(target, items)`) and `wrap`
(`fn.apply(void 0, args)`), with `H = harden` on xst and `Object.freeze` on Node:

```
!! ts_push_spread_desc: xst='wEc'  node='WEC'
!! ts_push_spread_then_write: xst='THROW TypeError:set ?: not writable'  node='9,2'
!! ts_push_spread_then_clear: xst='THROW TypeError:set length: array length update rejected'  node='0'
!! ts_push_spread_then_sort: xst='THROW TypeError:C: xsSet ?: not writable'  node='1,2,3'
!! ts_push_spread_then_pop: xst='THROW TypeError:delete ?: not configurable'  node='1'
   ts_fn_spread_rest_pop: xst='3'            (slice.call(arguments) copy is clean)
!! ts_fn_spread_restparam_pop: xst='THROW TypeError:delete ?: not configurable'  node='3/2'
!! ts_fn_spread_args_shift: xst='THROW TypeError:C: xsSet ?: not writable'  node='1/2'
   reflect_apply_push: xst='WEC'
   apply_call_push: xst='WEC'
   extracted_apply_push: xst='WEC'
!! dot_apply_push: xst='wEc'  node='WEC'
   dot_apply_nonfrozen: xst='WEC'
   math_max_apply_frozen: xst='5'
!! template_strings_apply: xst='wEc'  node='WEC'
```

Its `c2_after_lockdown.js`, the same file with `lockdown();` prepended, gave identical results.

**Recommendation:**

1. **Project at the source.**
   At `apply.rs:207` and `:385`, project each item to a value with
   `self.array_item_value(arr, item)` or `Slot::of(item.kind, item.value)`.
   Fixing only `exec_arguments` would leave the leak into `push.apply` targets, because native
   callees store argument `Slot`s directly.
2. **Audit the other raw reads.**
   Check the other raw `items()[&i]` reads at `collection.rs:303`, `:311` and
   `natives/dispatch.rs:3799`.
   Probes show the reduce seed at `:3799` is correct today.
3. **Fix the cause.**
   Add a `Value` type (kind plus payload) for stack, argument, return and side-table-value
   positions, separate from the arena `Slot` record.
   A record then cannot become a value without an explicit projection, and the hand scrubs become
   type conversions.
4. **Add a regression test.**
   Apply a frozen array through `f.apply`, then write to `arguments`, to the rest parameter and to
   a `push.apply` target.

**Verification:**

- **Code-evidence verifier (kept high).**
  - Confirmed every location and the record-to-value path through `bulk.rs` `store_item`.
  - Re-ran `p20` exactly as the finder did.
  - Wrote `v1`/`v2`, which show the leak also reaches native callees and the caller's target
    array, that every attribute bit leaks, and that parameter locals do not.
  - Recounted the scrub sites.
- **Consequence-and-intent verifier (kept high, at the lower end of high).**
  - Found no document recording the behaviour as a decision.
  - Found that the same shortcut caused an earlier bug of the same kind (F179 in
    `designs/ironhorse-known-defects.md`), which supports the claim that the record/value
    conflation has already produced inconsistent code.
  - Narrowed the trigger to the `f.apply(...)` member-call trampoline:
    `Function.prototype.apply.call`, an extracted `apply` and `Reflect.apply` all scrub.
  - Widened the reach through TypeScript's ES5 emit, and confirmed the leak survives `lockdown()`.
  - Noted Endo's own `Reflect.apply` dispatch as mitigation.

### ONT-6 — Built-in accessor properties are implemented as GET_PROPERTY opcode interceptions, not prototype accessors (RegExp, Temporal, Intl.Locale, Intl.Collator.compare, DisposableStack.disposed), while ArrayBuffer/TypedArray/DataView use real accessors

**Severity:** high (proposed high; code-evidence verifier high; consequence-and-intent verifier
high).

**Category:** spec-model.

**Same defect as:** CORE-3, RGX-2, NVAL-4 and NOBJ-9.
ONT-6 is the primary; each of the four is medium on its own and high as merged into ONT-6.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs`:
  - `:45`, `:55`, `:75`, `:130` (Temporal Instant, Duration, Plain and Zoned arms);
  - `:200` (`DisposableStack` `disposed`);
  - `:209` (the ArrayBuffer/TypedArray/DataView arm's comment);
  - `:215` (RegExp);
  - `:251` (`Intl.Locale`);
  - `:286` (`Intl.Collator` `compare`).
- `rust/engine/ironhorse-vm/src/interp/boot.rs:1427`.
- `rust/engine/ironhorse-vm/src/interp/link.rs:45`.
- Added by verifiers:
  - `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:157-158` and
    `rust/engine/ironhorse-vm/src/interp/intrinsic_order.rs:20-21` ("not yet");
  - `rust/engine/ironhorse-vm/src/interp/property.rs:1682` (`regexp_getter_uses_default`);
  - `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:6008-6015`;
  - `rust/engine/ironhorse-vm/src/interp/natives/temporal.rs:198-222`;
  - `rust/engine/ironhorse-vm/src/interp/boot.rs:1129-1145` (ArrayBuffer getters via
    `proto_accessors`);
  - `rust/engine/CHANGELOG.md:1221-1223`.

**Excerpt:**

```
boot.rs:1427-1430: "`%RegExp.prototype%`: `exec`/`test`/`toString` ... the `source`/`flags`/per-flag accessor getters are special-cased by id in `GET_PROPERTY`."
property_read.rs:209-211 (ArrayBuffer/TypedArray/DataView arm): "These are real accessors on the intrinsic prototypes. Ordinary lookup preserves guest deletion, replacement, and own-property shadows."
property_read.rs:58-59: `match self.scalar_key_text(id).as_deref() { Some("years") => Slot::number(d.years as f64), ...`
```

**Mechanism:** The spec concept "accessor property on %X.prototype%" has two encodings in the
engine.

ArrayBuffer, TypedArray and DataView getters were moved to real accessors, as `property_read.rs:209`
records.
`boot.rs:1129-1145` installs, for example, `NativeMethod::ArrayBufferByteLengthGetter` under the
name "get byteLength".

For five other families, the only implementation is a set of arms in the `GET_PROPERTY` handler.
Each arm matches the receiver's side table and the key id or key text, ahead of ordinary lookup.

- **RegExp:** `source`, `flags` and 8 per-flag getters (`global`, `ignoreCase`, `multiline`,
  `dotAll`, `sticky`, `unicode`, `hasIndices`, `unicodeSets`). Together these are the 10 ids of
  `RegExpGetterIds`, an `Option<u16>` cache filled from name strings at `link.rs:45`.
- **Temporal:** Instant, Duration, Plain* and ZonedDateTime fields, about 60 key texts.
- **`Intl.Locale`:** 12 getters.
- **`Intl.Collator`:** `compare`.
- **`DisposableStack`:** `disposed`.

None of these accessors is installed on its prototype.
`RegExp.prototype` holds only `compile`, `exec`, `test`, `toString` and `constructor`.
Every other [[Get]] path therefore finds nothing: computed member access (`GET_PROPERTY_AT`),
`Reflect.get`, Proxy forwarding, reads through an object whose prototype is the instance, `in`,
`getOwnPropertyDescriptor`, and generic natives.
The dot-access arm runs before ordinary lookup, so it also ignores own-property shadows, subclass
getters and guest replacement of the getter.
Its text match answers keys the type does not define: `id` on a `PlainDate` returns
`"iso8601"`.

The engine also disagrees with itself.
`RegExp.prototype.toString` (`natives/dispatch.rs:6008-6015`), `regexp_flags_units` and
`regexp_replace_fast_safe` model the implicit accessor correctly: through
`regexp_getter_uses_default` (`property.rs:1682`) they walk the chain for shadows and Proxies,
then fall back to `mop_get`.
The `GET_PROPERTY` arm does no such check.
`temporal_plain_from` (`natives/temporal.rs:198-222`) reads fields from another Temporal object
through `mop_get_option_field`, which cannot see the interception-only getters.

The interception dates from stage 3b, which aimed at bit-exact XS computrons
(`CHANGELOG.md:1221-1223`).
`README.md:6-8` now calls XS computron parity "a non-goal — not a deferred goal".
`natives/regexp.rs:157` ("keeps the intrinsic RegExp accessors implicit") and
`intrinsic_order.rs:20` ("does not yet") treat the gap as unfinished.

**Consequence:** Common code paths give wrong results, silently.

RegExp:

- `re[k]` with `k = 'flags'` or `'source'` is `undefined`; so is `Reflect.get(/a/gm, 'flags')`.
- `'flags' in /a/g` is `false`.
- `RegExp.prototype.source` is `undefined` (spec: `"(?:)"`), and `RegExp.prototype.toString()`
  gives `'/undefined/undefined'` (spec: `'/(?:)/'`).
- `Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags')` is `undefined`, so the generic
  getter cannot be borrowed.
- Feature detection with `'hasIndices' in RegExp.prototype` reports `false`.
- An own `global: false` on a RegExp is ignored by `.flags`.
- A subclass's `get flags()` is ignored by dot access but honoured by `@@replace` and `toString`.
- `super.flags` and `super.source` in a subclass getter are `undefined`.
- On an object whose prototype is a RegExp, or on a Proxy of one, the spec getter throws
  `TypeError`; IronHorse returns `undefined`.

Temporal and Intl:

- The usual idiom `for (u of units) d[u]` returns `undefined` for Temporal, and the same holds
  for `Intl.Locale`.
- The engine's own Temporal natives fail. `Temporal.PlainYearMonth.from(plainDate)`,
  `PlainMonthDay.from(plainDate)`, `PlainMonthDay.from(plainDateTime)` and
  `PlainYearMonth.compare(plainDate, …)` throw `TypeError: Temporal: missing or invalid required
  date/time fields`.

test262:

- 86 of the 88 `built-ins/RegExp` failures in the pinned sweep (`target/test262-report/report.json`)
  are in `built-ins/RegExp/prototype/{flags,global,ignoreCase,multiline,dotAll,unicode,unicodeSets,sticky,hasIndices,source}/`.
  Those ten directories hold 128 tests: 86 fail and 42 are covered.
  Examples are `built-ins/RegExp/prototype/global/15.10.7.2-2.js`, which fails with
  "TypeError: cannot coerce undefined to object", and `S15.10.7.2_A8.js`.
- `built-ins/DisposableStack/prototype/disposed/` has 4 IronHorse failures out of 7.
- `built-ins/Temporal/PlainYearMonth/from/argument-plaindate.js` and
  `built-ins/Temporal/PlainMonthDay/from/fields-object.js` fail when run directly. Both sweeps,
  including the oracle-off sweep, skip them as `oracle-host-missing-global:Temporal`.
- The expectation ratchet records the RegExp failures as expected `fail`.

RegExp `lastIndex` is a real own data property and is unaffected.

**Evidence:** The finder's probes are in `probes/ontology/types/`:

```
JS probes are in ../probes/ontology/types/.
p8c_paths.js:
  t('re_paths', ()=>{var r=/ab/gi;var k='flags',s='source',g='global';return [r.flags,r[k],Reflect.get(r,'flags'),r.source,r[s],String(r.global),String(r[g]),String('flags' in r)].join('|');});
  t('locale_paths', ()=>{var l=new Intl.Locale('en-US');var k='language';return l.language+'|'+String(l[k])+'|'+String(Reflect.get(l,'language'));});
Observed:
!! re_paths: xst='gi|||ab||true|undefined|false'  node='gi|gi|gi|ab|ab|true|true|true'
!! locale_paths: xst='en|undefined|undefined'  node='en|en|en'
   ds_paths (DisposableStack): xst='true|undefined|undefined'
p8b_reproto.js:
!! names: xst='compile,exec,test,toString,constructor'  node='constructor,exec,dotAll,flags,global,hasIndices,ignoreCase,multiline,source,sticky,unicode,compile,toString,test,unicodeSets'
!! flags_desc: xst='none'  node='get/set/enumerable/configurable function'
!! proto_override2: xst='g patched patched'  node='patched patched patched'
p8_intercept.js:
!! re_own_source: xst='a own own'  node='own own own'
!! re_subclass (class R extends RegExp{get flags(){return 'sub'}}): xst='g sub'  node='sub sub'
!! re_flags_generic (own global:false on /a/gi): xst='gi'  node='i'
!! collator_compare_own: xst='function [""] (){[native code]} own'  node='own own'
p7b_temporal.js (node 22 lacks Temporal; the spec defines these as prototype getters):
  dot:'4' computed:'undefined' reflect:'undefined' in:'false' proto_desc:'none' getter_call:'none' plain_dot:'2020 undefined undefined' instant_three:'5 undefined undefined' subclass_shadow:'4' (expected 'sub') proxy:'undefined' obj_with_proto:'undefined'
p7_temporal.js: overriding Temporal.Duration.prototype.years still yields '1' (spec: 42); own property 'days' is ignored ('3', spec 'own').
Test262 tally from report.json: the RegExp accessor directories contain 128 tests: 86 ironhorse-failure, 42 covered. All built-ins/RegExp ironhorse-failures: 88.
```

Selected outputs from the code-evidence verifier's probes (`probes/ontology/verify-ont6/v1_regexp.js`,
`v2_others.js`, `v3_temporal.js`, `v4_ab_contrast.js`):

```
- computed `r[k]` for k = flags/source/global:
  xst "undefined|undefined|undefined", node "gi|ab|true".
- proto_source `RegExp.prototype.source`: xst "undefined", node "(?:)".
- own_global_flags (own `global: false` on /a/gi): xst "gi", node "i".
- obj_with_proto (`Object.create(/a/g)`):
  xst "undefined undefined", node THROW TypeError (the spec getter throws).
- proxy (`new Proxy(/a/g, {})`):
  xst "undefined undefined", node THROW TypeError.
- re_tostring_subclass `r.flags + ' ' + String(r)`: xst "g /a/sub", node "sub /a/sub". The engine disagrees with itself.
- collator_compare `[typeof c.compare, typeof c[k], typeof Reflect.get, 'compare' in c, gopd]`:
  xst "function|undefined|undefined|false|undefined", node "function|function|function|true|[object Object]".
- pd `[p.year, p[k], p.id, p.timeZoneId]`: "2020|undefined|iso8601|undefined". PlainDate has no `id` in the spec.
v4_ab_contrast.js: ArrayBuffer byteLength across dot, computed, Reflect, in and gopd gives xst "8|8|8|true|function", the same as node.
```

The consequence-and-intent verifier's probes are in
`probes/ontology/verify-ont6-consequence/`.
`c1_regexp_reach.js` produced:

```
!! lodash_get: xst='undefined|undefined'  node='gi|ab'
!! map_keys: xst=',,,'  node='ab,gim,true,true'
!! super_flags: xst='gi'  node='xgi'
!! super_source: xst='a /<undefined>/g'  node='<a> /<a>/g'
   dot: xst='gi|ab'                      (agrees)
   destructure: xst='gi|ab|true'         (agrees)
   lastIndex_paths: xst='3|3|3|true|3|lastIndex'  (agrees; not affected)
!! proto_tostring: xst='/undefined/undefined'  node='/(?:)/'
!! feature_detect: xst='false|false|undefined'  node='true|true|object'
   assign_spread: xst='{}{}'             (agrees)
```

`c3_temporal_causality.js` (xst only; Node 22 has no Temporal) produced:

```
t('ym_from_pd_plain', ()=>Temporal.PlainYearMonth.from(Temporal.PlainDate.from('2020-05-17')).toString());
t('ym_from_pd_ownprops', ()=>{var pd=Temporal.PlainDate.from('2020-05-17'); Object.defineProperties(pd,{year:{value:pd.year},month:{value:pd.month},monthCode:{value:pd.monthCode}}); return Temporal.PlainYearMonth.from(pd).toString();});
t('pd_has_year', ()=>{var pd=Temporal.PlainDate.from('2020-05-17'); return ['year' in pd, Reflect.get(pd,'year'), pd.year].join('|');});
Output: {"ym_from_pd_plain":"THROW TypeError:Temporal: missing or invalid required date/time fields","ym_from_pd_ownprops":"2020-05","pd_has_year":"false||2020"}
```

Own data properties fix the conversion, so the missing accessor is the cause.

**Recommendation:**

1. **Install real accessors.**
   Put real accessor functions (`NativeMethod` getters with the spec names, for example
   "get flags") on `RegExp.prototype`, `Temporal.*.prototype`, `Intl.Locale.prototype`,
   `Intl.Collator.prototype` (`compare`) and `DisposableStack.prototype` (`disposed`), as was done
   for ArrayBuffer, TypedArray and DataView.
2. **Remove or guard the interception arms.**
   Delete the arms in `property_read.rs`, or keep them only as a fast path guarded by both of
   these checks:
   - the receiver has no own shadow;
   - the prototype's property slot still holds the intrinsic getter.

   `regexp_getter_uses_default` (`property.rs:1682`) already implements that guard for RegExp.
3. **Drive both from one table.**
   Generate boot installation and any fast path from one table of intrinsic accessors, so the
   two encodings cannot drift apart.
4. **Plan it as a boot-layout bump.**
   New prototype getters change the boot layout and fingerprint, so snapshots from the earlier
   layout fail the existing `BootLayoutMismatch` gate, as happened when Map/Set `size` moved to
   real accessors (`designs/ironhorse-2a-property-mop-completion.md:182-189`).

**Verification:**

- **Code-evidence verifier (kept high).**
  - Confirmed every arm and comment.
  - Grepped for any second implementation and found none.
  - Found the engine documents the RegExp choice as deliberate but unfinished
    (`natives/regexp.rs:157-158`, `intrinsic_order.rs:20-21`).
  - Found that the in-engine natives honour overrides through `regexp_getter_uses_default` while
    the opcode arm does not.
  - Re-ran fresh probes reproducing every divergence, and confirmed the 88/86/128 test262 tally
    plus the 4 `DisposableStack` failures.
  - Corrected "10 flag getters" to `source`, `flags` and 8 per-flag getters.
  - Noted that a subclass `flags` getter returning `'g'` sends `'aaa'.replace` into
    HeapExhausted. That is the spec's own unbounded loop, not a separate defect.
- **Consequence-and-intent verifier (kept high).**
  - Found no document accepting the divergence. The interception was a bit-exactness shortcut
    whose reason README now disowns, and the stated direction is real accessors (Map/Set `size`,
    ArrayBuffer/TypedArray/DataView).
  - Showed reach beyond reflective code: generic property helpers, `super.flags`, feature
    detection, and the Temporal conversion natives, which throw.
  - Found no gate that turns any of it into a loud refusal.
  - Noted that RegExp alone might rate medium, but the Temporal native failures and computed
    access across five families justify high.

### ONT-5 — Jobs record no realm or environment: a reaction handler with no home environment runs against whichever compartment the pump happens to be in

**Severity:** medium, lowered from high. The finder proposed high; both verifiers rated it medium.

**Category:** spec-model.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp.rs:1401`
- `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:878`, `:892`
- `rust/engine/ironhorse-vm/src/compartment.rs:1375`
- `rust/engine/ironhorse-vm/src/interp/invoke.rs:236`, `:238` (call sites; the NULL no-op itself
  is at `rust/engine/ironhorse-vm/src/interp/realm.rs:911-913`)
- `rust/engine/ironhorse-vm/src/interp/realm.rs:308`

Added by verifiers:

- `compartment.rs:750` (activation is never restored)
- `realm.rs:150-162`, `:850` (homed copies minted only after the default global is linked)
- `rust/engine/ironhorse-vm/src/interp/frames.rs:423` (closures switch on entry)
- `rust/engine/ARCHITECTURE.md:83`, `:115`
- `designs/ironhorse-engine.md:694`, `:699`
- `rust/engine/ironhorse-vm/src/interp/shared_persist.rs:112`

**Excerpt:**

```
enum PromiseJob { Reaction { reaction: PromiseReaction, value: Slot, rejected: bool }, Thenable { then, thenable, resolve, reject } }   // no realm/environment field
...
let Some(job) = self.promise_jobs.pop_front() else { return Ok(()); };
self.run_promise_job(code, job)?;          // no switch_environment before the job
```

**Mechanism:**

- **What the spec requires.** ECMA-262 27.2.2.1 NewPromiseReactionJob computes
  `handlerRealm = GetFunctionRealm(handler)`, and 9.5.5 HostEnqueuePromiseJob(job, realm)
  requires the job to run prepared for that realm.
- **What a job carries.** In IronHorse a job carries only the reaction slots (`interp.rs:1401`).
  `drain_promise_jobs` and `run_promise_job` (`promise.rs:878-892`) never select an environment.
  `Machine::pump` (`compartment.rs:1375`) and `Interp::run_inner` drain in whatever
  `CompartmentEnvironment` the previous host operation left active.
  `Compartment::execute` activates its environment (`compartment.rs:750`) and never restores the
  previous one, so the ambient environment is the compartment the host touched last.
- **Which handlers escape.** A closure handler switches to its own captured `global_env` on
  entry (`frames.rs:423`). A native whose `FuncInfo.global_env` is NULL does not: `call_native`
  switches to the target, and `switch_environment(NULL)` does nothing (`realm.rs:911-913`).
- **Which natives are NULL-homed.** The start compartment's original `eval` and `Function` are.
  `compartment_evaluator` mints homed copies only once `shared_compartments` is set, and that
  happens after the default global is linked (`realm.rs:150-162`, `:850`). Before lockdown, the
  shared function-family constructors are NULL-homed too (ONT-14).
- **What goes wrong.** Such a handler runs in the pump's ambient environment, not in the
  environment of whoever registered it. Any ambient-reading step inside the job, mainly
  `CreateDynamicFunction`, `PerformEval` and `inherit_compiler`, sees the wrong compartment.
- **Narrowing by the code-evidence verifier.** Ambient capture for new promises affects only
  unhandled-rejection attribution (`interp.rs:2611`). Closures are created only by bytecode,
  which runs after a closure's own switch.
- **Precedent.** The engine has shipped one bug of this class before: `realm.rs:306-309` records
  a lockdown check that "read the AMBIENT environment, which a guest steers by queueing a promise
  job".

**Consequence:** The failure is reachable through the public `ironhorse-vm` `Machine`/`Compartment`
API on a frozen `Machine::new()`.

- **Host-ordered evaluation.** The start compartment registers its own `eval` or `Function` as a
  reaction handler. The host then evaluates compartment B and pumps the shared queue. START's
  source is compiled and evaluated against B's global: B's globals are read, START's
  declarations land on B, and START receives functions that close over B's global.
- **Consumer cranks alone are enough.** A sibling B that settles a START promise through a resolver
  the host shared makes START's `p.then(eval)` evaluate against B. In a consumer crank of B,
  START's queued `.then(eval)` declares `var leaked` on B's global.
- **Order-dependent.** With the host operations in the other order, the same job answers START.

This is a confused-deputy integrity break on START's side; B cannot cause it alone.

What keeps it at medium:

- **No in-repo production host reaches it.** `rust/endo/src/ironhorse_engine.rs` discards old
  jobs and uses one fresh compartment on its ephemeral path (`:729-772`), and cranks only `start`
  on its persistent path (`:1186`, `:1491`).
- **Guest-only programs cannot observe it.** Guest `Compartment.prototype.evaluate` restores the
  environment (`interp/natives/compartment.rs:434-441`). Ten guest-only scenarios after lockdown
  all answered START.
- **No replica divergence.** The active environment is persisted (`current_global`,
  `shared_persist.rs:112`), and host operation order is input.
- **The docs promise the opposite.** `ARCHITECTURE.md:83` says direct, nested, callback and
  promise calls restore the defining environment. `ARCHITECTURE.md:115` and
  `designs/ironhorse-engine.md:694`, `:699` say compartment `eval` and `Function` are bound to
  their own globals. The NULL rationale at `realm.rs:874-880` ("whichever environment called
  for it") does not cover jobs, which have no caller.

**Evidence:** The finder's Rust probe and JS probes are in `probes/ontology/spec-model/`.
The JS probes `p6.js` and `p3.js` turned out to show ONT-14, not this finding: their job half
answers START, as XS does.

```
Rust probe (temporary rust/engine/ironhorse-vm/tests/zz_audit_ont_1.rs, now deleted; copy at ../probes/ontology/spec-model/zz_audit_ont_1.rs):
  let machine = Machine::new(); machine.set_source_compiler(Rc::new(TestCompiler)).unwrap();
  let start = machine.start_compartment(); let mut b = machine.new_compartment(); b.set_source_compiler(Rc::new(TestCompiler));
  show(&start, "var marker = 'START'; var out = []; Function('return marker')()");
  show(&start, "(0, eval)('marker')");
  show(&start, "Promise.resolve('return marker').then(Function).then(f => out.push('Function:' + f())); Promise.resolve('marker').then(eval).then(v => out.push('eval:' + v)); 0");
  show(&b, "var marker = 'B'; 0"); machine.run_promise_jobs(); show(&start, "out.join(' ')");
Observed (cargo test -p ironhorse-vm --test zz_audit_ont_1 -- --nocapture):
  start direct Function: START
  start direct eval    : START
  pump completed      : true Return
  start out           : Function:B eval:B
JS probe after lockdown ($SCRATCH/.../spec-model/p6.js): globalThis.marker='START'; lockdown(); const c = new Compartment({globals:{marker:'CHILD', startEval: eval, report}}); c.evaluate("const direct = startEval('marker'); Promise.resolve('marker').then(startEval).then(v => report(direct + '/' + v));"). report() halts the engine (heap exhaustion) only for the pair it is given. ironhorse-xst prints 'InternalError: ironhorse halted: HeapExhausted' for 'CHILD/START' and exits 0 for START/START, CHILD/CHILD and START/CHILD, so the observed pair is CHILD/START.
Oracle (endot-ih --test262-dir $SCRATCH/.../t262 zzprobe/start-eval-job.js, flags [async]): 'async: Test262:AsyncTestFailure:Test262Error: Expected SameValue(«CHILD/START», «START/START») to be true (the oracle completed)'. XS gives START/START.
Before lockdown, the shared constructor reached through the prototype behaves the same way ($SCRATCH/.../p3.js): the child's direct F('return globalThis.marker')() gives CHILD, and .then(F) gives START (halt fires only for 'CHILD/START').
```

The code-evidence verifier's probe, `probes/ontology/verify-ont5/zz_audit_ont_51.rs`, ran three
cases:

- **Case A:** the finder's sequence, plus a closure handler for comparison.
- **Case B:** START queues `.then(eval)`, then a production-style consumer crank of B
  (`evaluate_compartment_with_symbols_continuing_meter_shared`) pumps.
- **Case C:** a fresh machine on which B is evaluated first.

```
A start direct Function: START
A start direct eval    : START
A pump completed       : true Return
A start out            : Function:B eval:B closure-eval:START
B b crank              : 0
B start out            : eval:B start.leaked=undefined
B b leaked             : B
C pump completed       : true Return
C start out            : eval:START
```

The consequence-and-intent verifier's probe, `probes/ontology/ont5-intent/zz_audit_ont_53.rs`,
uses consumer cranks only:

```
fn crank(m:&Machine,c:&Compartment,src:&str)->String{ let (code,symbols)=ironhorse_compile::compile_atoms(src).unwrap();
  let out=m.evaluate_compartment_with_symbols_continuing_meter_shared(c,Rc::from(code),&symbols,Meter::new(),None);
  if out.completed{out.result}else{format!("HALT {:?}",out.halt)} }
let machine=Machine::new(); machine.set_source_compiler(Rc::new(TestCompiler)).unwrap();
let start=machine.start_compartment(); let mut b=machine.new_compartment(); b.set_source_compiler(Rc::new(TestCompiler));
crank(&machine,&start,"var marker = 'START'; var out = []; var settle; var p = new Promise(r => { settle = r; }); p.then(eval).then(v => out.push('nativeEval:' + v)); p.then(s => eval(s)).then(v => out.push('closureEval:' + v)); 'queued'");
let settle=start.global_value("settle").unwrap(); b.define_global_value("settle",&settle).unwrap();
crank(&machine,&b,"var marker = 'B'; settle('marker'); 'settled'");
crank(&machine,&start,"out.join(' ')");
```

```
1 start crank : queued
2 b crank     : settled
3 start crank : nativeEval:B closureEval:START
```

Its ten guest-only scenarios after `lockdown()` are in the same directory.
They cover:

- s1: a child async function suspended across jobs;
- s2: a child generator;
- s3: a child throw caught in START;
- s4: the child's own `eval` queued first;
- s5: a rejecting child handler;
- s6: a child thenable;
- s7: a child async generator;
- s8: the child's `Function` queued first;
- s9: a grandchild compartment;
- s10: a nested evaluate inside a job.

All ten exited 0 with `EXPECT='START'`.
Every negative control exited 1 with HeapExhausted, the probe's signal.

**Recommendation:**

1. **Record the job's environment.**
   Store the handler's environment when a job is enqueued (the HostEnqueuePromiseJob realm):
   the closure's `global_env`, or for a native the environment of the code that registered it.
   Switch to that environment in `run_promise_job` and `run_thenable_job`.
   Do the same for FinalizationRegistry cleanup jobs.
2. **Remove the ambient meaning.**
   Forbid a NULL `global_env` in shared-compartment mode, for example with a debug assertion in
   `switch_environment`, so that "ambient environment" stops being a meaning anything can rely
   on.
3. **Cheap mitigation (from the consequence-and-intent verifier).**
   Home START's `eval` and `Function` to the default global, as every other compartment's copy is
   homed.
   That closes this finding and ONT-14 on frozen machines without adding a field to every job.
4. **Fix the docs.**
   Either change the code or correct `ARCHITECTURE.md:83`, `:115` and
   `designs/ironhorse-engine.md:694`, `:699`.
5. **Add a test.**
   Add a `realms.rs` test that pumps after activating a different compartment.

**Verification:**

- **Code-evidence verifier: medium.** It confirmed every location.
  - It located the NULL no-op at `realm.rs:911-913` and showed why START's evaluators are
    NULL-homed.
  - It reproduced the cross-compartment evaluation, including a declaration landing on B during a
    production-style consumer crank (case B), and the order dependence (case C).
  - It lowered the severity: the repo's production host never pumps one compartment's jobs while
    another is active, the trigger is narrow, and the result is deterministic and persisted.
  - It noted that the finder's JS probes demonstrate ONT-14, not this finding.
- **Consequence-and-intent verifier: medium.** It found no documented decision; the docs promise
  the opposite.
  - Its ten guest-only scenarios show guests cannot observe the problem.
  - It showed that consumer cranks alone reach it once a sibling settles a START promise.
  - It judged the trigger narrow (START's own `eval`/`Function` passed directly as a handler,
    avoided by any wrapper), with no replica divergence, so it confirmed medium.

### ONT-9 — Symbol as a weak key: Refused (uncatchable) via the WeakMap/WeakSet constructors, catchable TypeError via set/add/WeakRef/register

**Severity:** medium (the finder proposed medium; the code-evidence verifier rated it medium; the
consequence-and-intent verifier rated it medium).

**Category:** taxonomy.

**Same defect as:** NOBJ-13 (medium), the primary.

**Locations:** all in `rust/engine/ironhorse-vm/src/` unless stated.

- `interp/natives/collection.rs:316-321`: the Refused branch. The Symbol test is at `:318`; the
  finder cited `:317`.
- `interp/natives/collection.rs:92-93` (`WeakMap.prototype.set`; the finder cited `:91`).
- `interp/natives/collection.rs:121-122` (`WeakSet.prototype.add`).
- `interp/natives/collection.rs:2577-2578` (`getOrInsert`).
- `halt_labels.rs:94`.
- Added by verifiers:
  - `interp/natives/weak.rs:54-55` (WeakRef), `:161`, `:182`, `:213` (FinalizationRegistry);
  - `interp/natives/weak.rs:5-8` (the stated model) and `:22-27` (the existing `weakly_holdable`
    helper);
  - `interp/natives/collection.rs:185` (`populate_collection_from_dense_array`);
  - `rust/engine/ironhorse-fuzz/src/lib.rs:1874-1877`.

**Excerpt:**

```
collection.rs:316-322  if matches!(kind, CollKind::WeakMap | CollKind::WeakSet) && key.kind != Kind::Reference {
        if key.kind == Kind::Symbol {
            return Err(Step::Host(Halt::Refused(
                "collection-constructor:weak-symbol-oracle-version",
            )));
collection.rs:91  if weak && key.kind != Kind::Reference {
        return Err(self.catchable_type_error_msg("key: not an object".into()));
```

**Mechanism:** CanBeHeldWeakly(symbol) is decided at six or more sites:

- `WeakMap.prototype.set` and `WeakSet.prototype.add`;
- `WeakMap` `getOrInsert` and `getOrInsertComputed`;
- `WeakRef`;
- `FinalizationRegistry` `register` (target and token) and `unregister` (token).

All of them reject a symbol with a catchable `TypeError`.
That matches the pinned XS oracle, whose `fxCanBeHeldWeakly` (`xsMapSet.c:1378-1393`) admits
symbols only under `mxKeysGarbageCollection`; that macro defaults to 0 and the oracle build does
not define it.
It diverges from ES2023, which admits unregistered symbols.
`weak.rs:5-8` states the engine's model in so many words: a symbol is "not an object" here.

One site breaks that model.
The dense-Array fast path of the WeakMap/WeakSet constructor (`populate_collection_from_dense_array`,
`collection.rs:185`) raises `Halt::Refused("collection-constructor:weak-symbol-oracle-version")`.
That is an uncatchable profile refusal, registered in `REFUSED_LABELS` as an "oracle-version
policy limit".
The generic iterable path behaves differently: a Map, Set or generator iterable, a sparse array,
or a custom adder calls the adder and throws a catchable `TypeError`.
So one constructor classifies one condition two ways, depending on the iterable's shape.
The refusal also fires for registered symbols (`Symbol.for`), which every spec edition, XS and
Node reject with a catchable `TypeError`.
For those the "oracle-version" justification does not apply at all.

**Consequence:**

- **Guest-visible.** A guest's `try { new WeakMap([[sym, v]]) } catch` cannot catch the failure,
  the crank aborts, and a `finally` block does not run. `try { new WeakMap().set(sym, v) } catch`
  catches a `TypeError`.
- **An oracle divergence too.** XS throws a catchable `TypeError` on both paths, because its
  `fx_WeakMap` calls `set` inside `mxTry`.
- **Split test262 reporting.** In the pinned sweep, the 28 cases that declare
  `symbols-as-weakmap-keys` fall into two categories:
  - 22 `shared-positive-test-failure` and 1 `shared-test262-failure` (Category::Unsupported);
  - 5 `refused:collection-constructor:weak-symbol-oracle-version` (Category::Refused).
  One missing feature is therefore reported in two categories.
- **Hidden from the fuzz differential.** It treats any registered Refused label as an honest skip
  (`ironhorse-fuzz/src/lib.rs:1874-1877`), so this XS divergence cannot surface there.

**Evidence:** The finder's probes are in `probes/ontology/taxonomy/`.

```
p25_weak_set_method.js (each guarded):
  ["WeakMap.set", () => new WeakMap().set(Symbol("a"), 1)], ["WeakSet.add", ...], ["WeakRef", () => new WeakRef(Symbol("c"))], ["FinReg.register", ...], ["WeakMap.set registered", () => new WeakMap().set(Symbol.for("e"), 1)]
  ironhorse: Error: WeakMap.set:TypeError | WeakSet.add:TypeError | WeakRef:TypeError | FinReg.register:TypeError | WeakMap.set registered:TypeError
  node:      Error: WeakMap.set:ok | WeakSet.add:ok | WeakRef:ok | FinReg.register:ok | WeakMap.set registered:TypeError
p26_weak_ctor.js: let r; try { new WeakMap([[Symbol("a"), 1]]); r = "ctor ok"; } catch (e) { r = "ctor " + e.name; } throw new Error(r);
  ironhorse: InternalError: ironhorse halted: Refused("collection-constructor:weak-symbol-oracle-version")
  node:      Error: ctor ok
p27 (WeakSet ctor): same Refused halt.
XS oracle (zz_audit_ont_1.rs):
  ORACLE weakmap-ctor-symbol: completed=false error="TypeError: key: not an object"   IRONHORSE: halt=Refused("collection-constructor:weak-symbol-oracle-version")
  ORACLE weakmap-set-symbol:  completed=false error="TypeError: key: not an object"   IRONHORSE: halt=Throw("TypeError: key: not an object")
Sweep report.json, cases with feature symbols-as-weakmap-keys: 22 run-skip/unsupported shared-positive-test-failure, 5 run-skip/refused refused:collection-constructor:weak-symbol-oracle-version, 1 run-skip/unsupported shared-test262-failure.
```

From the code-evidence verifier, `probes/ontology/verify-ont9/`:

```
v4_ctor_registered_dense.js: let r; try { new WeakMap([[Symbol.for("reg"), 1]]); r = "ctor ok"; } catch (e) { r = "ctor " + e.name; } throw new Error(r);
  ironhorse: InternalError: ironhorse halted: Refused("collection-constructor:weak-symbol-oracle-version")
  node:      Error: ctor TypeError     <- every spec edition gives a TypeError here, yet ironhorse refuses
v2_ctor_paths.js (each case wrapped in try/catch):
  t("WeakMap(new Map)", () => new WeakMap(new Map([[Symbol("a"), 1]])));
  t("WeakSet(new Set)", () => new WeakSet(new Set([Symbol("b")])));
  t("WeakMap(gen)", () => new WeakMap((function* () { yield [Symbol("c"), 1]; })()));
  ...
  ironhorse: Error: WeakMap(new Map):TypeError | WeakSet(new Set):TypeError | WeakMap(gen):TypeError | ... | WeakMap.set:TypeError | WeakSet.add:TypeError | WeakRef:TypeError | FinReg.register:TypeError | WeakMap ctor registered:TypeError | WeakMap ctor number dense:TypeError
  node:      Error: WeakMap(new Map):ok | WeakSet(new Set):ok | WeakMap(gen):ok | ... | WeakMap.set:ok | WeakSet.add:ok | WeakRef:ok | FinReg.register:ok | WeakMap ctor registered:TypeError | WeakMap ctor number dense:TypeError
```

From the consequence-and-intent verifier, `probes/ontology/verify2-ont9/`:

```
a3.js (finally does not run either):
  let log = []; try { try { new WeakMap([[Symbol("a"), 1]]); } finally { log.push("finally"); } } catch (e) { log.push("caught"); } throw new Error(log.join(","));
  ironhorse: InternalError: ironhorse halted: Refused("collection-constructor:weak-symbol-oracle-version")
  node:      Error: finally
```

**Recommendation:**

1. **One helper.** Make CanBeHeldWeakly one helper used at every site. `weak.rs:22-27` already
   defines `weakly_holdable`, and `collection.rs` does not use it.
2. **Pick one behaviour.** Either implement ES2023 symbols-as-weak-keys everywhere, admitting
   unregistered symbols and rejecting registered ones with `TypeError`, or, while pinned to the
   old oracle, throw the same catchable `TypeError` from the constructor's dense path.
3. **Remove the label.** Then delete the `collection-constructor:weak-symbol-oracle-version`
   refusal label.

**Verification:**

- **Code-evidence verifier: medium, worse than stated.**
  - Confirmed the refusal and every catchable site, and found the engine's own model statement at
    `weak.rs:5-8`.
  - Confirmed from the XS source that the oracle throws a catchable `TypeError` on the
    constructor path.
  - Found no conversion of the Refused halt and no document mentioning the label.
  - Re-derived the sweep split from both the oracle and oracle-off reports.
  - Found two things the finder had missed: the refusal is confined to the dense-Array fast path,
    and it fires for registered symbols too.
  - Corrected the line numbers.
- **Consequence-and-intent verifier: medium.**
  - Found the label only at its refusal site, its registry entry and the expectation files. No
    design document and no test asserts it. The engine's stated model contradicts it.
  - Showed it is observable: `finally` does not run.
  - Showed it is hidden rather than caught by the fuzz differential and the expectation ratchet.
  - Kept medium, not higher: the halt is controlled and named, guests can already halt a crank
    through other refusals, and real use of a dense literal is narrow.

### ONT-11 — No Agent [[CanBlock]] model: Atomics.wait/notify/waitAsync are uncatchable Refused halts before argument validation, and the harness files 109 single-agent cases and both CanBlockIsFalse cases as needing threads

**Severity:** medium (the finder proposed medium; the code-evidence verifier and the
consequence-and-intent verifier both rated it medium).

**Category:** taxonomy.

**Same defect as:** NOBJ-14 and T262-4, one merged finding (medium) with NOBJ-14 as its primary.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:2232`: the `if op >= 10` guard. The
  Refused return is at `:2233`, before `atomics_integer_typed_array` (`:2236`) and
  `atomics_access_index` (`:2238`).
- `rust/engine/ironhorse-vm/src/halt_labels.rs:92`.
- `rust/engine/ironhorse-262/src/xst.rs:1544`, `:1558`.

Added by verifiers:

- `buffer.rs:2204-2207`: the doc claims validation "in XS's order".
- `xst.rs:50-53`: says only `$262.agent` is excluded.
- `xst.rs:1550-1557`: says a wait on a non-can-block agent "is itself a spec TypeError".
- `rust/engine/ironhorse-262/src/test262.rs:88-90` and `rust/engine/ironhorse-262/src/report.rs:52`:
  two more labels for the same flag.
- `rust/engine/ironhorse-vm/src/interp/state.rs:2014`.

**Excerpt:**

```
// `wait`/`notify`/`waitAsync` take the explicit host-refusal path.
if op >= 10 {
    return Err(Step::Host(Halt::Refused("atomics:wait-notify")));
}
...
// `CanBlockIsFalse` marks the `$262.agent`/Atomics blocking-agent tests,
// which need a threading story ironhorse does not have
if src.contains("$262.agent") || src.contains("Atomics.wait") || src.contains("Atomics.notify") { return preskip("structural:multi-agent"); }
```

**Mechanism:**

- **What the spec says.** ECMA-262 makes blocking a property of the Agent Record ([[CanBlock]],
  9.7).
  - DoWait (25.4.3.14) first validates the typed array, the index and the value. For a sync wait
    it then throws a catchable `TypeError` when AgentCanSuspend() is false.
  - `Atomics.notify` with no waiters returns 0.
  - `Atomics.waitAsync` with a mismatched value or a zero timeout resolves synchronously.
  - All of this is deterministic in a single-agent engine that chooses [[CanBlock]] = false.
- **What XS does.** It behaves the same way: `fx_Atomics_notify` and `fx_Atomics_wait` validate
  first, notify returns 0 without waiters, and `fxWaitSharedChunk` throws a catchable
  `TypeError("main thread cannot wait")` on the main thread.
- **What IronHorse does.** It has no Agent concept. It refuses all three operations before
  validating any argument, as an uncatchable host halt filed under `REFUSED_LABELS`
  ("agent-model … policy limits"). That contradicts its own doc at `buffer.rs:2204-2207`.
- **How the harness classifies.** It works by source substring, despite its own `xst.rs:50-53`
  saying only the `$262.agent` slice is excluded:
  - any file mentioning `Atomics.wait` or `Atomics.notify` becomes `structural:multi-agent`;
  - CanBlockIsFalse files become `structural:can-block`, with a comment (`xst.rs:1541`) saying
    they "need a threading story". They need only the `TypeError`, as the harness's own comment
    ten lines later (`xst.rs:1550-1557`) acknowledges.
- **One flag, three labels.** The same CanBlockIsFalse rule appears as `structural:can-block`
  (`xst.rs:1545`), `structural:async-or-can-block` (`test262.rs:88-90`) and "unmodelable host
  shape" (`report.rs:52`).

**Consequence:**

- **Guest-visible.** `try { Atomics.wait(ia, 0, 1, 0) } catch {}` cannot recover and halts the
  crank. Under the [[CanBlock]] = false model, a sync wait with valid arguments always gives a
  catchable `TypeError`; "not-equal" is an outcome only for `waitAsync`.
- **Halts where nothing blocks.** `Atomics.notify(ia, 0, 1)` also halts, though it never blocks.
  So do argument errors (`Atomics.wait({}, …)`, a bad index), a notify on a non-shared buffer
  (spec: 0), and `waitAsync` with a mismatched value (spec: `{async:false, value:"not-equal"}`).
- **Reachable inside hardened compartments.** After native `lockdown()`, `Atomics` and
  `SharedArrayBuffer` are reachable in a new Compartment's globals.
- **Wrong coverage taxonomy.** All 230 notify, wait and waitAsync files are pre-skipped. 109 of
  them use neither `$262.agent` nor a CanBlockIs flag: 36 notify, 25 wait and 48 waitAsync. Among
  those, 11 already pass on IronHorse today (descriptor, length, name, `is-function`,
  `not-a-constructor`).
- **The CanBlockIsFalse cases need only a `TypeError`.** `built-ins/Atomics/wait/cannot-suspend-throws.js`
  and its bigint twin are filed as needing threads.
- **The engine's refusal never shows up as itself.** In both the oracle and the oracle-off sweeps,
  no case reports the harness's `refused:atomics:wait-notify` verdict (`xst.rs:2990`); the
  refusal is entirely re-attributed to host structure.
- **Thin real-world reach.** The SES shim suppresses `Atomics` (`packages/ses/src/permits.js:1562`),
  and the only in-repo caller, `packages/captp/src/atomics.js`, needs a second agent.

**Evidence:** The finder's probe is `probes/ontology/spec-model/p5.js`.

```
JS probe p5.js:
  const ia = new Int32Array(new SharedArrayBuffer(8)); t('waitNotEqual', () => Atomics.wait(ia, 0, 1, 0)); ... t('notify', () => Atomics.notify(ia, 0, 1)); ...
ironhorse-xst: 'InternalError: ironhorse halted: Refused("atomics:wait-notify")' (exit 1). The first operation halts the engine, and the try/catch does not catch it.
node: {"waitNotEqual":"not-equal","waitTimeout0":"timed-out","waitTimeout10":"timed-out","waitAsync":"function","waitAsyncResult":{"async":true,"valueType":"object"},"notify":1,"nonShared":"threw TypeError: ..."}
Sweep tally (report.json @61cd656cb): notify 52 pre-skip structural:multi-agent; wait 75 structural:multi-agent + 2 structural:can-block; waitAsync 101 structural:multi-agent. In the test262 tree, the files with neither '$262.agent' nor CanBlockIs: notify=36, wait=25, waitAsync=48 (12 of them async).
```

Node's `notify` returns 1 only because the earlier `waitAsync` registered a waiter.

From the code-evidence verifier, `probes/ontology/verify-ont11/`:

```
v1_wait_badarg.js: `let r; try { Atomics.wait({}, 0, 0, 0); r='returned'; } catch (e) { r='caught '+e.name; } throw new Error(r);` -> ih: halted Refused, exit 1 | node: Error: caught TypeError
v2_notify_nonshared.js: `r = Atomics.notify(new Int32Array(4), 0, 1)` in try/catch -> ih: halted Refused | node: Error: 0
v3_notify_badrange.js: `Atomics.notify(new Int32Array(new SharedArrayBuffer(8)), 100, 1)` in try/catch -> ih: halted Refused | node: caught RangeError
v4_waitasync_notequal.js: `JSON.stringify(Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(8)), 0, 1, 0))` -> ih: halted Refused | node: {"async":false,"value":"not-equal"}
v5_shape.js: `[typeof Atomics.wait, typeof Atomics.notify, typeof Atomics.waitAsync, Atomics.wait.length, Atomics.notify.length]` -> both: ["function","function","function",4,3]
```

That verifier also ran all 97 synchronous single-agent files, each assembled as `sta.js`,
`assert.js`, the includes and the body (`sweep/results.txt`).
The result was pass=11, halt=85, other=1.
The one "other" is `notify/immutable-buffer-returns-0.js`, which fails in the harness factory and
has nothing to do with Atomics.

From the consequence-and-intent verifier, `probes/ontology/verify2-ont11/`:

```
c1_compartment_reach.js:
  lockdown(); const c = new Compartment(); const r = {};
  r.typeofAtomicsInCompartment = c.evaluate('typeof Atomics');
  r.typeofSABInCompartment = c.evaluate('typeof SharedArrayBuffer');
  r.frozen = c.evaluate('Object.isFrozen(Atomics)'); throw new Error(JSON.stringify(r));
  ih: Error: {"typeofAtomicsInCompartment":"object","typeofSABInCompartment":"function","frozen":true}

c2_compartment_notify.js:
  lockdown(); const c = new Compartment();
  const out = c.evaluate(`let r; try { r = 'returned ' + Atomics.notify(new Int32Array(4), 0, 1); } catch (e) { r = 'caught ' + e.name; } r;`); throw new Error(out);
  ih: InternalError: ironhorse halted: Refused("atomics:wait-notify") (exit 1)
  node, same body without the Compartment: returned 0
```

**Recommendation:**

1. **Model the agent explicitly.** Use a fixed [[CanBlock]] = false for the deterministic
   profile.
2. **Implement the non-blocking outcomes.** This means DoWait's validation and its sync-mode
   `TypeError`; notify returning the count of async waiters woken (0 when there are none); and
   `waitAsync`'s synchronous results.
3. **Narrow the refusal.** Keep Refused only for `waitAsync` with a finite positive timeout, which
   needs a host timer.
4. **Fix the harness classification.** In `xst.rs`, classify by `$262.agent` alone and run the
   CanBlockIsFalse cases.
5. **Skip CanBlockIsTrue in the same change.** Those seven files do not use `$262.agent` but
   require blocking: `wait/{negative,null,true,false,object}-for-timeout.js` and
   `wait/bigint/{negative,false}-for-timeout.js`.

**Verification:**

- **Code-evidence verifier (medium).**
  - Confirmed the guard, the label, both pre-skips and the doc contradictions.
  - Found no Agent or CanBlock concept anywhere and no layer that makes the Refused catchable.
  - Confirmed against `xsAtomics.c` that XS validates first, returns 0 from notify and throws a
    catchable `TypeError` on the main thread.
  - Re-derived the sweep and tree counts, and ran the 97 synchronous single-agent files: 11 pass
    and 85 halt.
- **Consequence-and-intent verifier (medium).**
  - Found the halt is intentional profile policy: `rust/endo/tests/js_machine_trait.rs:497-519`
    pins it.
  - Found the CanBlockIsFalse pre-skip copies `xst262.c`. No document, however, justifies
    refusing validation or the non-blocking outcomes. XS's sync wait can block off the main
    thread while IronHorse can never block, so the copy inverts XS's meaning.
  - Confirmed reach into hardened compartments, and that no case ever reports the engine's own
    refusal label.
  - Kept medium as the ceiling, given the thin real-world use and the deterministic, fail-closed
    halt.
- **Cross-reference.** The consequence-and-intent verifier notes this duplicates NOBJ-14 and
  T262-4 in this audit's other lenses, also rated medium. The ontology-specific contribution is
  the three labels for one flag and the contradictory comments at `xst.rs:1541` and `:1550-1557`.

### ONT-12 — parseInt returns +0 for negative zero: the f64-to-slot integer fold is written three times and only the parse_int copy omits the -0 guard

**Severity:** medium (proposed medium; both verifiers rated it medium).

**Category:** type-encoding.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/numeric.rs:107`. The fold spans `:106-112`, with the
  comparison at `:108`.
- `rust/engine/ironhorse-vm/src/interp/coerce.rs:7`, the function signature. The guard is at
  `:8`.
- `rust/engine/ironhorse-vm/src/interp/numeric.rs:337`, the function signature. The guard is at
  `:340`.
- Added by verifiers:
  - `rust/engine/ironhorse-vm/src/interp/natives/json.rs:1543-1552`, a fourth fold with a third
    rule;
  - `rust/engine/ironhorse-vm/src/interp/natives/number.rs:481-495` (`GlobalParseInt`, the only
    caller);
  - XS `c/moddable/xs/sources/xsNumber.c`, `fx_parseInt` (around lines 192-205).

**Excerpt:**

```
numeric.rs:106-112: `result *= sign; let ir = result as i32; if ir as f64 == result { Slot::integer(ir) } else { Slot::number(result) }`
coerce.rs:8: `if value == (value as i32) as f64 && !(value == 0.0 && value.is_sign_negative()) {`
numeric.rs:340: `if number == check && (number != 0.0 || !number.is_sign_negative()) {`
```

**Mechanism:**

`Kind::Integer` (`i32`) cannot represent -0, so every f64-to-Slot fold must route -0 to
`Kind::Number`.
The fold is written by hand at least four times, under three different rules:

| Site | Rule |
|---|---|
| `slot_from_number` (`coerce.rs:8`) | excludes -0 |
| `math_to_integer` (`numeric.rs:340`) | excludes -0 |
| JSON (`json.rs:1543-1548`) | excludes every zero |
| `parse_int` (`numeric.rs:106-112`) | no guard |

The `parse_int` copy has no guard because `0 as f64 == -0.0` is true.
Its only caller, `GlobalParseInt`, returns the slot unchanged.
The concept "canonical numeric slot" has no single constructor: `value.rs:688-694` has only the
raw `Slot::integer` and `Slot::number`.
The copy that differs is the one that loses information.
IronHorse inherited the unguarded fold faithfully from XS: `fx_parseInt` does
`aResult *= aSign; aRadix = (txInteger)aResult; ... if (aSign == aResult) { … XS_INTEGER_KIND }`
with no -0 guard.

**Consequence:**

ECMA-262 `parseInt` step 16 requires -0 when the sign is -1 and the integer value is 0.
IronHorse returns +0 instead for:

- `parseInt('-0')`, `parseInt('-00')`, `parseInt('-0x0')` and `parseInt('-0', 16)`;
- `parseInt(' -0.5')` and `parseInt(-0.5)`;
- `Number.parseInt('-0')`.

So `1/parseInt('-0')` gives `Infinity` instead of `-Infinity`, and
`Math.atan2(parseInt('-0'), -1)` gives +π instead of -π.
In the same probes every other producer of -0 is correct: arithmetic, `Math.*`, `Number()`,
unary `+`, `JSON.parse`, typed arrays, closures, generators and `parseFloat`.

test262 does not cover this.
Its only -0 case, `built-ins/parseInt/S15.1.2.2_A1_T2.js`, checks `parseInt(-0)`, where +0 is
correct, which is why the bug survived in both XS and IronHorse.
The fuzz arm generates `parseInt` inputs only in -20..19.
Most code cannot tell the zeros apart, so the claim that this breaks a common truncation idiom is
overstated.

**Evidence:** The finder's probe is `probes/ontology/types/p9_negzero2.js`.

```
Probe ../probes/ontology/types/p9_negzero2.js:
  function z(x){ return Object.is(x, -0) ? '-0' : String(x); }
  t('parseInt_variants', ()=>[parseInt('-0'),parseInt('-00'),parseInt('-0x0'),parseInt('-0',16),parseInt(' -0.5'),Number.parseInt('-0')].map(z).join(','));
  t('parseInt_neg_frac', ()=>z(parseInt(-0.5)));
Observed:
!! parseInt_variants: xst='0,0,0,0,0,0'  node='-0,-0,-0,-0,-0,-0'
!! parseInt_neg_frac: xst='0'  node='-0'
   unary_plus_str '-0', sub_str '-0', json_arr '-0-0', int_div '-0', int_mod2 '-0', compound '-0', round_half '-0', ... (all match node).
An earlier run of p3_negzero.js showed the same: `!! parseInt: xst='0' node='-0'`, with 60+ other -0 cases matching.
```

The consequence-and-intent verifier's probe is `probes/ontology/verify2-ont12/v2.js`:

```
function z(x){ return Object.is(x, -0) ? '-0' : String(x); }
var r = [
  parseInt('-0'), parseInt(-0.5), parseInt('-0.9'), Number.parseInt('-0'),
  parseInt(-0), parseInt('0'),
  1/parseInt('-0'), Math.atan2(parseInt('-0'), -1), Object.is(parseInt('-0'), -0),
  Number('-0'), +'-0', parseFloat('-0'), Math.trunc(-0.5), -0 * 1, JSON.parse('-0'),
  Math.round(-0.4), (-0.5)|0
].map(z);
throw new Error(JSON.stringify(r));
ironhorse-xst (exit 1): Error: ["0","0","0","0","0","0","Infinity","3.141592653589793","false","-0","-0","-0","-0","-0","-0","-0","0"]
node v22:               Error: ["-0","-0","-0","-0","0","0","-Infinity","-3.141592653589793","true","-0","-0","-0","-0","-0","-0","-0","0"]
```

**Recommendation:**

1. Add one constructor, for example `Slot::from_f64` in `value.rs`, that folds to Integer only when
   the value is integral, fits in `i32` and is not -0.
2. Use it in `parse_int`, `slot_from_number` and `math_to_integer`, and delete the inline fold.
   Check whether the JSON site's all-zeros rule is deliberate. That rule affects representation
   only, not guest-visible values.
3. Add `parseInt('-0')` and `parseInt(-0.5)` to the numeric tests.
4. The fix departs from the XS pin, so record it as an exceptions-ledger or known-defects entry,
   as `designs/ironhorse-engine.md:826-829` and the `SHARED` precedent at
   `designs/ironhorse-known-defects.md:373-375` require.

**Verification:**

- **Code-evidence verifier (medium):**
  - confirmed the unguarded fold, the two guarded siblings and the single caller;
  - re-ran nine negative-zero variants, all wrong;
  - found the inherited XS bug and the fourth fold in `json.rs`;
  - found that test262 has no `parseInt('-0')` case;
  - corrected the line numbers.
- **Consequence-and-intent verifier (medium):**
  - found no design document recording the sign of zero as a decision; the project keeps
    XS-shared spec bugs open as `SHARED` candidates rather than accepting them;
  - found that no gate pins either behaviour;
  - added the `atan2` case as a downstream difference beyond the sign of zero;
  - kept medium under the rubric's "spec divergence on edge cases", while calling the
    truncation-idiom claim overstated.

### ONT-13 — Same-type TypedArray construction pushes raw element bytes through Number slots, canonicalizing NaN payloads, which breaks the spec's byte-copy rule and the engine's own 'raw bytes are not Numbers' rule

**Severity:** medium (the finder proposed medium; the code-evidence and consequence-and-intent
verifiers both rated it medium).

**Category:** type-encoding.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:1114` and `:1126`. The copy loop is
  `:1115-1126`; `:1114` is the closing `);` of the snapshot binding.
- `rust/engine/ironhorse-vm/src/interp.rs:3311` and `:3371`.
- `rust/engine/ironhorse-vm/src/value.rs:633`.
- `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:1103` and `:1199`.
- Added by verifiers:
  - `buffer.rs:1746-1760` (`set` copies raw bytes when the kinds match);
  - `value.rs:715-717` (`Slot::of` canonicalizes NaN);
  - XS `c/moddable/xs/sources/xsDataView.c:1605`, `:1532`, `:1571`, `:2372` and `:2436-2444`;
  - `rust/engine/xs-oracle/build.rs:125`;
  - `rust/engine/ironhorse-262/tests/xs_departures.rs:4-5`, `:660` and `:755-768`.

**Excerpt:**

```
natives/dispatch.rs:1114-1126: `for i in 0..length { let v = match source_ta { ... Some(src) => self.typed_array_element_get(src, i).expect(...), ... }; self.typed_array_element_set(code, ta, i, v)?;`
value.rs:633: "Raw ArrayBuffer bytes are not Numbers and must not pass through this helper."
buffer.rs:1103-1105: "`slice` ... copies values (raw bytes for the same element type, preserving NaN payloads)"
```

**Mechanism:**

ECMA-262 InitializeTypedArrayFromTypedArray requires a byte copy when the element types match:
"If elementType is srcType, let data be ? CloneArrayBuffer(srcData, srcByteOffset, byteLength)".
A byte copy preserves bit-level encodings.

The `new TA(typedArray)` constructor (`typed_array_from_source`) instead converts every element
to a Number `Slot` and back, even when the element types match.

- **Decode:** `decode_element_le` (`interp.rs:3311`) builds `Slot::number`, which goes through
  `Slot::of` and canonicalizes NaN.
- **Encode:** `encode_element_le` (`interp.rs:3371`) canonicalizes again. Float32 NaN is forced to
  `0x7fc00000` (`interp.rs:3362-3366`).

`TypedArray.prototype.slice` (`buffer.rs:1199`) and `.set` (`buffer.rs:1746-1760`) already treat
a same-type transfer as a byte copy, and copyWithin preserves the bytes too.
So the engine treats one concept, "same-type element transfer", two ways: as a raw-byte operation
at some sites and as a Number round trip at others.

The behaviour is inherited from XS.
XS's `fx_TypedArray` has the intended same-type `c_memcpy` (`xsDataView.c:1605`), but its test
`dispatch == sourceDispatch` compares two different instances' dispatch slots (`:1532`, `:1571`).
The two pointers are never equal, so the branch is dead.
XS's `set` (`:2372`) and `slice` (`:2436-2444`) compare correctly.
The oracle is built with `mxCanonicalNaN=1` (`xs-oracle/build.rs:125`), so it also rewrites
payloads on this path, and the differential cannot see the problem.

**Consequence:**

`new Float64Array(src)`, `new Float32Array(src)` and `new Float16Array(src)` rewrite every
non-canonical NaN bit pattern.
A negative NaN also loses its sign bit, and subclass constructors are affected the same way.
A Float64Array used as a raw 8-byte container (NaN-boxing, packed hashes, binary records) is
silently corrupted by the common copy idiom, while `src.slice()` and `dst.set(src)` keep the same
bytes.

Any binary data cloned through a float-typed constructor is corrupted at about 1 word in 2,048
(Float64) or 1 word in 256 (Float32).
In a 64 KiB random blob that is 4 of 8,192 words and 65 of 16,384 words.
NaN canonicalization when SetValueInBuffer writes a Number is allowed by the spec; this byte-copy
path is not.
Ordinary float data never carries non-canonical NaNs in this engine; only raw byte writes produce
them.
No in-tree consumer uses the idiom.
test262 has bit-precision tests for slice, set and copyWithin, but none for the constructor's
typed-array argument.

**Evidence:**

The finder's probes are in `probes/ontology/types/`:

```
Probes p3_negzero.js and p4_fts.js in ../probes/ontology/types/:
  t('nan_ta_copy', ()=>{var b=new Uint8Array([1,0,0,0,0,0,0xf8,0x7f]);var f=new Float64Array(b.buffer);var g=new Float64Array(f);return Array.from(new Uint8Array(g.buffer)).join(',');});
  t('nan_ta_set', ...g.set(f)...);  t('ta_slice', ...f.slice()...);
  t('ta_ctor_f32', ()=>{var b=new Uint8Array([1,0,0xc0,0x7f]);var f=new Float32Array(b.buffer);var g=new Float32Array(f);return Array.from(new Uint8Array(g.buffer)).join(',');});
Observed:
!! nan_ta_copy: xst='0,0,0,0,0,0,248,127'  node='1,0,0,0,0,0,248,127'
   nan_ta_set:  xst='1,0,0,0,0,0,248,127' (matches)
   ta_slice:    xst='1,0,0,0,0,0,248,127' (matches)
   ta_copyWithin: xst='1,0,0,0,0,0,248,127' (matches)
!! ta_ctor_f32: xst='0,0,192,127'  node='1,0,192,127'
   ta_slice_f32: xst='1,0,192,127' (matches)
(nan_canon via g[0]=f[0], nan_dv via DataView, and Float64Array.from also differ from node, but the spec permits those because they pass through a Number.)
```

The code-evidence verifier's probes are `probes/ontology/verify-ont13/p1_ctor_nan.js` and
`p2_f16.js`:

```
!! f64_ctor: xst='0,0,0,0,0,0,248,127'  node='1,0,0,0,0,0,248,127'
!! f64_ctor_negnan: xst='0,0,0,0,0,0,248,127'  node='0,0,0,0,0,0,248,255'
!! f64_ctor_offset: xst='0,0,0,0,0,0,248,127'  node='1,0,0,0,0,0,248,127'
!! f32_ctor: xst='0,0,192,127'  node='1,0,192,127'
   f64_set: xst='1,0,0,0,0,0,248,127'
   f64_slice: xst='1,0,0,0,0,0,248,127'
   f32_set: xst='1,0,192,127'
   f32_slice: xst='1,0,192,127'
!! f64_subclass_ctor: xst='0,0,0,0,0,0,248,127'  node='1,0,0,0,0,0,248,127'
   i32_ctor: xst='255,255,255,255,255,255,255,127'
p2_f16.js (xst only): Error: {"ctor":"0,126","slice":"1,126","set":"1,126"}
```

The consequence-and-intent verifier's probe is `probes/ontology/verify2-ont13/p1_blob.js`.
It builds a deterministic xorshift 64 KiB blob and counts changed words after each copy path:

```
xst : Error: {"f64_ctor_changed_words_of_8192":4,"f32_ctor_changed_words_of_16384":65,"f64_slice_changed":0,"f64_set_changed":0,"ab_slice_then_view_changed":0,"u8_ctor_changed":0}
node: Error: {"f64_ctor_changed_words_of_8192":0,"f32_ctor_changed_words_of_16384":0,"f64_slice_changed":0,"f64_set_changed":0,"ab_slice_then_view_changed":0,"u8_ctor_changed":0}
```

**Recommendation:**

1. In the TypedArray-source arm of the constructor, when `src.kind == idx`, copy `byte_length`
   bytes from the source buffer, after the detach and length re-check already done there, as
   `typed_array_slice_or_subarray` does.
   Keep the element loop only for differing element types.
2. Keep charging `TYPED_ARRAY_FROM_SOURCE_ELEMENT_METERING` once per element on the byte-copy
   path, or document the meter change on purpose (`dispatch.rs:1127-1128`).
3. Because the fix departs from the pinned oracle, add a DEPARTURES row to
   `ironhorse-262/tests/xs_departures.rs`, with a dual-run program over Float64, Float32 and
   Float16.
   Until then, at least add a SHARED row.
4. Consider an `ElementBytes` newtype for typed-array element reads, so raw bytes cannot silently
   become a canonicalized Number `Slot`.
   The same family includes the NaN rewrite by `TypedArray.prototype.sort`, which `xs_departures.rs`
   already records as GAPS rows (`:755-768`).

**Verification:**

- **Code-evidence verifier (medium).**
  - Confirmed that the loop has no same-kind branch, that both canonicalization points exist,
    and that slice and set use raw bytes.
  - Found the dead XS branch and the oracle's `mxCanonicalNaN`.
  - Showed with probes that negative NaN, subclass constructors and Float16 are affected.
  - Corrected the loop's line range and noted that no test262 test covers the constructor.
  - Judged medium correct, with low defensible because XS behaves the same.
- **Consequence-and-intent verifier (medium).**
  - Found that this is not a decision.
  - The project's own rule (`xs_departures.rs:4-5`: match XS "unless XS contradicts the
    specification") makes it an unrecorded SHARED-class item.
  - The engine's statements of intent (`value.rs:633`, `buffer.rs:1103-1105`, `:1747`, the
    `nan-canonicalization.js` fixture) go the other way.
  - The XS behaviour is an accident: a dead branch.
  - Measured the corruption rate on random data.
  - Found no gate covering it and no in-tree consumer of the idiom.
  - Kept medium.

### ONT-15 — No global declarative record: Script-level let/const/class do not persist, GlobalDeclarationInstantiation's lexical checks are missing, and globalLexicals is a separate record from script lexicals

**Severity:** medium (proposed medium; code-evidence verifier medium; consequence-and-intent
verifier medium).

**Category:** spec-model.

**Same defect as:** T262-2 (medium), the primary.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/realm.rs:45`, `:72`.
- `rust/engine/ironhorse-vm/src/interp/environment.rs:101`, `:129`.
- `rust/engine/ironhorse-vm/src/interp/dispatch/environment.rs`. The finder cited `:102`, which is
  the `global_props` arm. The `global_lexicals` arms are `:93` (read) and `:318` (write).
- The finder also cited `rust/engine/ironhorse-262/src/xst.rs:47`. Both verifiers found that line
  unrelated: it is `DEFAULT_ENDOR_SKIP_FEATURES`.
- Added by verifiers:
  - `rust/engine/ironhorse-vm/src/interp/dispatch.rs:1443-1444`: locals and `id_map` cleared after
    the var hoist.
  - `rust/engine/ironhorse-compile/src/coder.rs:1780`: a Script is coded in eval shape.
  - `rust/engine/ironhorse-262/src/xst.rs:453-497` (`assemble`) and `xst.rs:1282-1290`
    (`negative-oracle-unexpected`).
  - `rust/engine/ironhorse-262/src/lib.rs:609-633` and `:385`.
  - `rust/engine/ironhorse-vm/src/interp/boot.rs:2518` (`$262` gets only `detachArrayBuffer`).

**Excerpt:**

```
// enclosing lexical binding — here the realm's global lexical
// environment, holding the running program's top-level
// `let`/`const`/`class` ...
...
pub(super) global_lexicals: std::collections::HashMap<u16, crate::value::SlotIndex>,  // 'Empty for every environment but a guest compartment's.'
```

**Mechanism:**

ECMA-262 9.1.1.4 defines a Global Environment Record as an [[ObjectRecord]] plus a
[[DeclarativeRecord]]. The declarative half holds every Script's top-level lexical declarations.
16.1.7 GlobalDeclarationInstantiation checks each new lexical name against that record with
HasVarDeclaration, HasLexicalDeclaration and HasRestrictedGlobalProperty. The last check makes
`let undefined` and `let NaN` SyntaxErrors.

IronHorse's `CompartmentEnvironment` (`realm.rs:45-97`) splits this differently:

- `global_props` holds the object record;
- `global_lexicals` is filled only from the guest Compartment's `globalLexicals` option;
- no field holds a Script's top-level `let`, `const` and `class`.

The compiler codes a Script program in eval shape (`coder.rs:1780`).
`exec_eval_environment` hoists only var and function names, then clears `locals` and `id_map`
(`dispatch.rs:1443-1444`).
After that, the lexicals take frame slots that disappear when the Script ends.
`hoist_vars_to_global` (`environment.rs:101`) walks only the var and function names, so the
lexical half of GlobalDeclarationInstantiation never runs.
The comment at `environment.rs:129` calls the active environment "the realm's global lexical
environment", but it is only the current run's chain.

XS's `fxRunProgramEnvironment` does have these checks:

- it raises "duplicate variable" against the realm closures and "restricted variable" against a
  DONT_DELETE global;
- it defines script lexicals into those closures;
- `fx_Compartment` puts `globalLexicals` into the same closures environment.

So XS has one record where IronHorse has two.

**Consequence:** The divergence is guest-visible on every Script-goal host.

1. **ironhorse-xst.** A single Script declaring `let undefined`, `let NaN` or `let Infinity` runs
   its body. ECMA-262 and Node throw SyntaxError.
2. **A host running several Scripts in one compartment** (`Compartment::evaluate_with_symbols`
   with Script-goal bytecode):
   - the first Script's `let lx` is lost;
   - a later `let lx`, a later `var lx` and `let undefined` all succeed where the spec throws
     SyntaxError;
   - a closure can still reach the binding, but the name no longer resolves at global scope.
3. **The test262 dual-run harness** (`xst.rs:453-497`, `lib.rs:609-633`, compiled with
   `compile_atoms` at `lib.rs:385`):
   - it runs the harness setup and the case body as separate Scripts in one interpreter;
   - so top-level `const`s in `nativeFunctionMatcher.js` (`assertNativeFunction`) and
     `wellKnownIntrinsicObjects.js` (`WellKnownIntrinsicObjects`) are gone before the body runs;
   - the eval-framed oracle shim loses them too, so the failure is filed as
     `shared-positive-test-failure` and stays hidden;
   - all 68 reported includers of those files carry that label (mostly
     `built-ins/Function/prototype/toString/*`), and 69 of the 70 files pass when harness and case
     are concatenated into one Script;
   - real `xst` keeps those consts in the realm closures.
4. **Other hidden cases.** `language/global-code/decl-lex-restricted-global.js` is a run-skip with
   reason `negative-oracle-unexpected` (`xst.rs:1282-1290`). Of the 31 test262 files that use
   `$262.evalScript`, 28 are run-skips, because `$262` exposes only `detachArrayBuffer`.

Two limits on the claim:

- **The Endo daemon is not affected.** Its paths compile with `Goal::Eval`
  (`rust/endo/src/ironhorse_engine.rs:757`, `:1435`), where per-crank lexicals are spec-correct.
- **Guest Compartments are a separate issue.** Guest `Compartment.prototype.evaluate` is a
  deliberate strict indirect eval matching SES. Its divergence from XS is a framing choice and is
  reported as ONT-16. The finder's claim about guest compartments is therefore withdrawn here.

**Evidence:** The finder's probes are in `probes/ontology/spec-model/`.

```
Rust probe zz_audit_ont_1.rs (frozen Machine, start compartment, compile_atoms = Goal::Script), observed:
  script1 let         : 1          ("let lx = 1; lx")
  script2 typeof lx   : undefined  (spec: number)
  script3 let lx again: 2          (spec: SyntaxError)
  script4 var lx      : no error   (spec: SyntaxError)
  script5 let NaN     : no error   (spec: SyntaxError)
  script6 let undefined: no error  (spec: SyntaxError)
JS probe p7.js 'let undefined; throw new Error("reached body ...")': ironhorse-xst prints 'Error: reached body: no GlobalDeclarationInstantiation SyntaxError'. node vm.runInThisContext prints 'SyntaxError: Identifier 'undefined' has already been declared'. For a second script, node gives 'typeof lx in 2nd script: number' and 'var after let: SyntaxError'.
Oracle zzprobe/global-lexicals-vs-script-lexicals.js: new Compartment({globalLexicals:{a:1}}), then evaluate('let a = 2; a') and evaluate('let undefined = 3'). Result: 'ironhorse failed a harness assertion the oracle passed: Expected SameValue(«ok/ok/1», «SyntaxError/SyntaxError/1»)'.
Sweep report (target/test262-report/report.json, endo_sha 61cd656cb): decl-lex-restricted-global.js run-skip negative-oracle-unexpected; evalScript users: 25 shared-positive-test-failure, 3 shared-test262-failure, 3 covered.
```

The code-evidence verifier's probe is `probes/ontology/verify-ont15/zz_audit_ont_1501.rs`, built
on a frozen `Machine::new()`:

```
s1 let lx=1           : 1
s2 typeof lx          : undefined
s3 const cx=1         : 1
s4 typeof cx          : undefined
s5 class K{}          : function
s6 typeof K           : undefined
s7 let lx again       : 2
s8 var lx             : no error
s9 let undefined      : no error
s10 closure across    : ok
s11 getQ()            : 5
s12 typeof q          : undefined
g1                    : 2/1/3/undefined
```

That verifier's JS probes `a2.js` (`let NaN = 1; …`) and `a3.js` (`let Infinity = 1; …`) also
reach the body on IronHorse; Node throws SyntaxError.
Its XS-oracle probe `ont15-persist.js` gave `oracle=…«SyntaxError/3/number/SyntaxError»`
and `ironhorse=…«2/3/undefined/4»`.

The consequence-and-intent verifier's probes are in `probes/ontology/verify2-ont15/`:

```
test/language/zzv/harness-const-visible.js:
/*---
includes: [nativeFunctionMatcher.js, wellKnownIntrinsicObjects.js]
flags: [noStrict]
---*/
var seen = typeof assertNativeFunction + "/" + typeof NATIVE_FUNCTION_RE + "/" + typeof WellKnownIntrinsicObjects;
assert.sameValue(seen, "undefined/undefined/undefined");
Output: endot-ih: total=1 covered=1 failed=0 skipped=0

language/zzw/arrow-as-is.js run-skip shared-positive-test-failure
language/zzw/arrow-inlined.js covered

shell loop over the 70 includers, harness + case concatenated as one Script on ironhorse-xst: pass=69 fail=1
```

In the first probe, both IronHorse and the eval-framed oracle see the three setup consts as
`undefined` in the case Script.
In the second pair, the same toString test flips from run-skip to covered once its include is
inlined.
The one failure in the shell loop, `method-computed-property-name.js`, is a toString content
mismatch, a different bug.

**Recommendation:**

1. **One persistent record.** Give `CompartmentEnvironment` one persistent declarative record for
   global lexical bindings. Seed it with `globalLexicals`, and have Script-goal lexical
   declarations instantiate into it.
2. **The lexical half of GlobalDeclarationInstantiation.** Implement HasLexicalDeclaration,
   HasVarDeclaration and HasRestrictedGlobalProperty, applied atomically before the body runs.
3. **Resolve through the record.** Have `dispatch_get_variable` and `dispatch_set_variable`
   consult that record.
4. **Harness.**
   - Add `$262.evalScript` to ironhorse-xst and endot-ih, so the 28 global-code cases are judged.
   - Stop treating `negative-oracle-unexpected` as infrastructure for
     `decl-lex-restricted-global.js`.
   - Until the record lands, either concatenate setup and body for cases whose includes declare
     top-level lexicals, or give that class its own skip reason instead of
     `shared-positive-test-failure`.

**Verification:**

- **Code-evidence verifier: medium.**
  - Confirmed the absent record, the eval-shaped Script coding, the clearing of locals after the
    var hoist, and the missing lexical checks.
  - Confirmed against XS's `fxRunProgramEnvironment` that XS has one record.
  - Reproduced every divergence, including `const` and `class` loss across Scripts, and the
    persistence of script lexicals in XS's guest Compartment.
  - Corrected the dispatch line numbers and dropped `xst.rs:47`.
- **Consequence-and-intent verifier: medium.**
  - Found no document recording script-lexical lifetime as a decision.
  - Refuted the guest-Compartment sub-claim: that evaluate is a deliberate strict indirect eval,
    as in SES.
  - Narrowed the reach to Script-goal hosts. The Endo daemon uses `Goal::Eval`.
  - Found the strongest consequence the finder had missed: the dual-run harness silently hides
    about 68 test262 cases, because harness `const`s vanish between setup and case.

### ONT-17 — Global object has a null [[Prototype]] while identifier resolution consults a hard-wired %Object.prototype%, so HasBinding is not HasProperty(globalObject)

**Severity:** medium (proposed medium; code-evidence verifier medium; consequence-and-intent
verifier medium).

**Category:** spec-model.

**Same defect as:** CORE-4 and PROP-7, one merged finding (medium) with CORE-4 as its primary.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/boot.rs:66`
- `rust/engine/ironhorse-vm/src/interp/realm.rs:943`
- `rust/engine/ironhorse-vm/src/interp/dispatch/environment.rs`:
  - `:114` and `:141` on the read side;
  - `:125`, which is a comment line inside the `:114` arm;
  - `:354` on the write side, with its comment at `:309-312`.
- Added by verifiers: `designs/ironhorse-known-defects.md:492` (F189).

**Excerpt:**

```
let global_obj = slots.alloc(Slot::instance(crate::value::SlotIndex::NULL));
...
} else if self.mop_has(code, self.object_proto, name)? {
    // ... ironhorse's global object carries a NULL prototype (a separate, pre-existing
    // divergence: `Object.getPrototypeOf(globalThis)` is `null` here and `%Object.prototype%` in XS),
    // so the inherited half of the question is put to `%Object.prototype%` directly.
```

**Mechanism:**

ECMA-262 defines the global object record's HasBinding(N) as HasProperty(globalObject, N)
(9.1.1.2.1, 9.1.1.4.1). GetBindingValue and SetMutableBinding are Get and Set on that object.

IronHorse allocates the start global (`boot.rs:66`) and every compartment global (`realm.rs:943`)
with a NULL prototype.
The comment at `boot.rs:63-65` calls this temporary: "the intrinsic %Object.prototype% wiring
lands with the intrinsics seam".
That wiring never landed, and `create_intrinsics` never links the two.

`dispatch_get_variable` and `dispatch_set_variable` work around it.
After the frame, the global lexicals and `global_props`, they look in `self.object_proto`
(`mop_has` at `:114`, `mop_get` at `:141`, `:354` on writes) instead of walking the global's
actual prototype chain.
The global's real [[Prototype]] is never read during resolution.

The engine therefore holds two models of one object:

- the reflective model, which has no prototype;
- the name-resolution model, which behaves as if the prototype were fixed at %Object.prototype%.

The code comments call this "a separate, pre-existing divergence" and leave it.
`designs/ironhorse-known-defects.md:492` lists it as open defect F189, "Resolve inherited
properties in the global Object Environment Record".

ECMA-262 §19 makes the global object's [[Prototype]] host-defined, so a null prototype alone is
allowed. It diverges from XS, which uses %Object.prototype%.
The spec violation is the mismatch: HasBinding is not HasProperty(globalObject, N), and that holds
whatever prototype a host picks.

**Consequence:** Guests can see this, and the XS oracle disagrees.

- `Object.getPrototypeOf(globalThis)` is `null` in both the start and compartment globals; XS gives
  %Object.prototype%.
- `'toString' in globalThis` is false while `typeof toString` is `'function'`. No conforming host can
  produce that combination.
- `globalThis.toString` is `undefined`, and `String(globalThis)` or `'' + this` in global code
  throws `TypeError: cannot coerce object to string`; XS gives `[object global]`.
- `this.hasOwnProperty(...)` in global code throws.
- A prototype the guest installs on `globalThis` with `Reflect.setPrototypeOf` is ignored by
  identifier resolution: `globalThis.injected === 42`, yet `typeof injected === 'undefined'`, and
  reading `injected` throws `ReferenceError`.

About 10 test262 files already fail for this reason. They are recorded in the checked-in
whole-tree expectations:

- `built-ins/Object/getPrototypeOf/15.2.3.2-2-30.js` fails with "cannot coerce null to object".
- Nine files call `this.hasOwnProperty` or `this.propertyIsEnumerable` in global code:
  - `built-ins/Object/defineProperty/15.2.3.6-4-625gs.js`;
  - the `decodeURI`, `decodeURIComponent`, `encodeURI`, `encodeURIComponent`, `parseFloat` and
    `parseInt` `*_A*.5.js` files;
  - `language/global-code/decl-lex.js`;
  - `language/statements/function/S13.2.2_A19_T7.js`.

**Evidence:** The finder's probes are in `probes/ontology/spec-model/`:

```
JS probe p8.js. ironhorse-xst: {"protoIsNull":true,"inGlobal":false,"reflectHas":false,"typeofToString":"function","toStringIsObjectProto":true,"callHasOwn":"threw TypeError: ...","withGlobal":"function","getViaGlobal":"undefined"}. node (vm.runInThisContext): {"protoIsNull":false,"inGlobal":true,"reflectHas":true,"typeofToString":"function",...,"getViaGlobal":"function"}.
JS probe p9.js: const proto = {injected: 42}; Object.setPrototypeOf(proto, Object.getPrototypeOf(globalThis)); Reflect.setPrototypeOf(globalThis, proto). ironhorse-xst: {"setProto":true,"viaProperty":42,"viaIdentifier":"undefined","readIdentifier":"threw ReferenceError: get injected: undefined variable",...}. node: {"viaProperty":42,"viaIdentifier":"number","readIdentifier":42,...}.
Oracle zzprobe/global-object-shape.js: oracle='start:ObjectProto cmp:ObjectProto cmpToString:function ...', ironhorse='start:null cmp:null cmpToString:function ...' (abort-value-differs).
```

The consequence-and-intent verifier's probes are in `probes/ontology/verify2-ont17/`.
Its JS probe `a.js` gave:

```
ironhorse-xst:
  {"protoNull":true,"inToString":false,"typeofToString":"function","typeofValueOf":"function","globalToString":"undefined","strTemplate":"threw TypeError: cannot coerce object to string","thisHasOwn":"threw TypeError: call: not a function","cmpProtoNull":true,"cmpTypeofToString":"function","cmpInToString":false,"setProto":true,"viaProperty":42,"typeofInjected":"undefined","readInjected":"threw ReferenceError: get injected: undefined variable","sloppyAssign":true}
node 22 (vm.runInThisContext):
  {"protoNull":false,"inToString":true,"typeofToString":"function","typeofValueOf":"function","globalToString":"function","strTemplate":"[object global]","thisHasOwn":true,"cmpProtoNull":"none",...,"setProto":true,"viaProperty":42,"typeofInjected":"number","readInjected":42,"sloppyAssign":true}
```

Its XS-oracle probe `t262/test/language/zzprobe/global-hasbinding.js` gave:

```
abort-value-differs: oracle="«true true function [object global] true true number»" ironhorse="«false false function threw TypeError threw TypeError true undefined»"
```

**Recommendation:**

1. Allocate the start and compartment globals with %Object.prototype% as their [[Prototype]], as XS
   does.
2. Resolve unqualified names by HasProperty, Get and Set on the global object itself, through the
   same MOP used for `with` object records. Do not use the hard-wired `object_proto` arm.
3. That removes the special cases at `dispatch/environment.rs:114`, `:141` and `:354`.
4. Re-pin the meter vectors this changes.
5. The listed test262 failures should then pass.

**Verification:**

- **Code-evidence verifier (medium).**
  - Confirmed both allocations, the temporary-sounding comment at `boot.rs:63-64` and the
    hard-wired arms.
  - Found no code that rewires the global's prototype and no design document making a null
    prototype intended.
  - Re-ran `p8` and `p9`, and wrote a probe covering compartments and an injected prototype.
  - Confirmed the oracle divergence.
  - Corrected the spec framing: a null prototype is host-defined and allowed; the violation is
    the HasBinding mismatch.
  - Added the roughly 10 test262 failures as the missing consequence.
- **Consequence-and-intent verifier (medium).**
  - Found the behaviour is not a decision but a re-discovery of open defect F189.
  - Confirmed it is reachable from ordinary global code, with no gate.
  - Found the extra `String(globalThis)` failure.
  - Kept medium, the rubric's "spec divergence on edge cases". These paths are rare in real SES
    code, so it does not reach high, and it involves no nondeterminism or escape.

### ONT-19 — EnvironmentId and HostRootId are documented as stable lineage identifiers but are raw slot indices that collection reuses, and the two id kinds share one forgeable number space

**Severity:** medium (proposed medium; the code-evidence and consequence-and-intent verifiers both
rated it medium, the latter "at the floor").

**Category:** identity-versioning.

**Locations:**

- In `rust/engine/ironhorse-vm/src/compartment.rs`: `:197`, `:201`, `:171`, `:207`, `:452`,
  `:973`, `:1026`.
- `rust/engine/ARCHITECTURE.md:136`.
- Added by verifiers:
  - `compartment.rs:224-225`: restore policy must cover environments "retained only by guest
    references".
  - `compartment.rs:1025`: "Dropped originating handles are not required".
  - `rust/engine/ironhorse-vm/src/interp/persist.rs:639-641`: refuses only a live guest
    Compartment.
  - `rust/engine/ironhorse-snapshot/src/machine.rs:3174-3197`: the restore closure sees only ids
    and meter state.
  - `rust/engine/ironhorse-vm/src/interp/shared_persist.rs:62-69`, `:757-763`, `:767-780`,
    `:785-798`.
  - `rust/endo/src/ironhorse_engine.rs:1285-1292`.

**Excerpt:**

```
compartment.rs:197-199 `/// Stable identifier within a snapshot lineage, never a dereferenceable arena handle. ... pub struct EnvironmentId(pub u32);`; :452 `self.environment.get().map(|i| EnvironmentId(i.0))`; :207 `HostRootId(self.root.0)`; :973-977 `if ids.is_empty() || ids...map(EnvironmentId)... != policy.environments.keys()... { return Err(Halt::Refused("machine:incomplete-restore-policy")); }`
```

**Mechanism:**

`EnvironmentId` is the `SlotIndex` of the compartment's global object.
Slots are reclaimed and reused (`ARCHITECTURE.md:58`).
After a compartment dies and is collected, the next allocation can receive the same index.
The "stable identifier" then names a different compartment.

The restore check that is meant to be exhaustive (`compartment.rs:973-975`) compares only the set
of ids against `policy.environments.keys()`.
It cannot catch the reuse, for two reasons:

- the host necessarily builds its policy from the ids it is handed;
- the restore closure sees only the ids and the meter state (`machine.rs:3174-3197`), never the
  persisted per-environment rows (`host_owned`, `compiler_required`).

`claim_compartment` (`compartment.rs:1026-1050`) then attaches the old policy (name,
`global_names`, hook flags, compiler service) to whichever environment now lives at that slot.
`claim_environment` (`shared_persist.rs:767-780`) hands out a fresh lease for any environment,
including one that was never host-owned.
The compiler gate (`shared_persist.rs:757`) fires only when the policy lacks a compiler.

The documented contract invites the dangerous pattern.
A host must keep policy for environments "retained only by guest references"
(`compartment.rs:224-225`), and "dropped originating handles are not required"
(`compartment.rs:1025`).
The persist gate (`persist.rs:639-641`) refuses a snapshot only while a guest `Compartment`
instance is live, so orphaned environments pass.
No design document scopes `EnvironmentId` to slot liveness.
`designs/ironhorse-snapshot-schema-debugging.md:172-173` even notes that slot reuse breaks
cross-snapshot identity.

`HostRootId` is also a raw slot number, but for two different referents:

- for an `ObjectIdentity`, the object's slot (`compartment.rs:171`);
- for a `RootedValue`, a private value-copy cell (`compartment.rs:207`, `realm.rs` `root_value`).

Both id kinds are `pub u32` newtypes.
The verifiers found, however, that the claim-time kind checks refuse a cross-kind id:
`claim_identity_root` requires `Kind::Instance`, and `claim_value_root` rejects Instance slots
(`shared_persist.rs:785-798`, `persist.rs:112-136`).
The "forgeable" part of the title therefore has no consequence.
Reusing a dropped handle's `HostRootId` is host misuse, because its docs say it roots its referent
only while held.

**Consequence:**

The case the API cannot disambiguate runs as follows:

1. The host creates compartment A, records its id, and drops its handle while the guest still
   holds one of A's functions.
2. The guest drops that function. A is collected, and nothing notifies the host.
3. The guest creates its own compartments and drops the instances. Allocation is deterministic,
   so by choosing padding and timing the guest can make one of them take A's slot.
4. On restore, the host's id-keyed policy is accepted.
5. `claim_compartment(aid)` returns a handle named "A" whose global belongs to the guest's
   compartment.

From then on, writes and endowments the host makes to "A" reach guest code.
This is a confused deputy.
The compiler gate does not catch it when every environment has a compiler.

A misapplied `global_names` had no guest-visible effect in the probe, because standard bindings
are already installed.
What is actually misapplied is the name, the hook flags, the compiler service, and the host's
belief about which compartment it holds.

No shipped embedder is exposed. The only one, `rust/endo/src/ironhorse_engine.rs:1285-1292`,
refuses any store with more than one environment.
The hazard falls on multi-compartment hosts that use the public API as its tests do, and on the
daemon and guest-compartment phase 2 designs.

**Evidence:** The finder's probe source is in `probes/ontology/vocabulary/`:

```
Rust probe zz_audit_ont_2.rs (ironhorse-vm, deleted after the run; source in probes/ontology/vocabulary/). Loop: `let c = m.new_compartment(); let id = c.snapshot_id(); drop(c); m.collect()`. Then on the start compartment: `globalThis.o = {round:N}`, `start.global_object_identity("o").snapshot_id()`, drop, `delete globalThis.o`, collect. Output:
`round 0: EnvironmentId=Some(EnvironmentId(3173)) CompartmentId=CompartmentId(1)`
`round 1: EnvironmentId=Some(EnvironmentId(3248)) CompartmentId=CompartmentId(2)`
`round 2: EnvironmentId=Some(EnvironmentId(3248)) CompartmentId=CompartmentId(3)`
`round 3: EnvironmentId=Some(EnvironmentId(3248)) CompartmentId=CompartmentId(4)`
`round 0..3: HostRootId=HostRootId(3248)` (each collect reclaimed 76 or 2 slots, live=3173).
Three distinct compartments share EnvironmentId 3248, and the same number is then a HostRootId for four distinct objects. The non-persisted CompartmentId, a counter, is the only distinct value.
```

The code-evidence verifier's probe, `probes/ontology/verify-ont19/zz_audit_ont_19.rs`, runs the
scenario above end to end, sweeping the guest's padding:

```
pad=0 sid=EnvironmentId(0) aid=EnvironmentId(3173)
  host dropped A handle, guest retains fa: ids=[0, 3173]
  guest dropped fa: ids=[0]
  after 8 guest compartments: 9 envs, contains aid: false
  restore accepted the host's id-keyed policy
  claim_compartment(EnvironmentId(3173)) -> Refused("machine:unknown-restored-environment")
pad=76 sid=EnvironmentId(0) aid=EnvironmentId(3173)
  host dropped A handle, guest retains fa: ids=[0, 3173]
  guest dropped fa: ids=[0]
  after 8 guest compartments: 9 envs, contains aid: true
  restore accepted the host's id-keyed policy
  host claimed EnvironmentId(3173) believing it is A: name=Some("A") who=guest-C2 typeof f=undefined
  guest reads marker through its own references: [[2,"written-via-host-handle-A"]]
```

With the guest Compartment instance still live, the snapshot is refused:
`PendingStateUnsupported { row: "a live guest `Compartment`, whose environment binding no snapshot carries" }`.

The consequence-and-intent verifier's probe, `probes/ontology/ont19-consequence/zz_audit_ont_1919.rs`,
repeats the scenario with a machine compiler, a per-compartment compiler, narrow `global_names`
on A, and a compiler for every environment in the restore policy:

```
pad=0 sid=EnvironmentId(0) aid=EnvironmentId(3173) envs=9 contains aid: false
  restore accepted (compiler gate armed: every env got a compiler)
  ... typeof WeakRef per C_i: ["function" x8]   typeof Map per C_i: ["function" x8]
  claim_compartment(EnvironmentId(3173)) -> Refused("machine:unknown-restored-environment")
pad=67 sid=EnvironmentId(0) aid=EnvironmentId(3173) envs=9 contains aid: true
  restore accepted (compiler gate armed: every env got a compiler)
  ... typeof WeakRef per C_i: ["function" x8]   typeof Map per C_i: ["function" x8]
  host claim of EnvironmentId(3173): name=Some("A") who=guest-C1
```

**Recommendation:**

1. Mint lineage-unique environment identities: a monotonic `u64` persisted with the FUNC or small
   state, or a `(slot, generation)` pair.
2. Alternatively, show the restore closure the persisted per-environment rows (`host_owned` and
   the recorded name), so a host can detect that an id now denotes a different environment.
3. If slot-based ids are kept, rewrite the docs to say an id is valid only while its referent is
   retained, and have the restore check compare a per-environment fingerprint as well as the id
   set.
4. Making the fields private is reasonable hygiene but not required by any consequence shown.

**Verification:**

- **Code-evidence verifier (medium):**
  - re-ran the original probe with identical output;
  - built the end-to-end confused-deputy case, in which the restore accepts and the host's "A"
    handle aliases a guest-owned global;
  - found that cross-kind forgery is refused by the claim-time kind checks, so that clause was
    dropped;
  - found that `HostRootId` is a homonym (object slot versus value-copy cell);
  - noted that no shipped embedder is exposed.
- **Consequence-and-intent verifier (medium, at the floor):**
  - found no document scoping `EnvironmentId` to slot liveness; the documented contract invites
    keeping ids for guest-retained environments;
  - found that no gate turns the collision into a refusal, even with the compiler gate armed;
  - found that misapplied `global_names` is guest-invisible for standard names;
  - noted that guest-compartment phase 2 (`designs/ironhorse-guest-compartment.md` §7) would
    widen the hazard;
  - recommended this as the first finding to downgrade if latent API holes with no shipped caller
    are rated low.

### ONT-21 — The persisted bytecode ISA (opcode numbering and widths) is identified by no gate; the XS-derived alphabetical enum renumbers on any opcode insertion

**Severity:** medium (proposed medium; code-evidence verifier medium; consequence-and-intent
verifier medium).

**Category:** identity-versioning.

**Locations:**

- `rust/engine/ironhorse-vm/src/opcode.rs:2`
- `rust/engine/ironhorse-vm/src/interp/snapshot_rows.rs:97`
- `rust/engine/ironhorse-vm/src/interp/persist.rs:1834`
- `rust/engine/ironhorse-snapshot/src/format.rs:197`
- `rust/engine/ironhorse-vm/tests/compiler_opcode_contract.rs:9`

Added by verifiers:

- `persist.rs:1785-1801`, plus `restore.rs:199-207`, `snapshot_roster.rs:1492` and
  `image.rs:4942`. These are width-only walks.
- `opcode.rs:496-509`, a hand edit.
- `rust/engine/ironhorse-snapshot/tests/row_schema.rs:20`, `:59-66`.
- `rust/engine/ironhorse-vm/src/interp/boot.rs:147`.
- `c/moddable/xs/sources/xsCommon.h:449-460` and `:159`.
- `c/moddable/xs/sources/xsSnapshot.c:1505-1507`, `:2389-2393`.
- `designs/ironhorse-snapshot-store-seam.md:3456`, `:3462-3466`.
- `rust/engine/ironhorse-snapshot/tests/state_golden.rs:375`.

**Excerpt:**

```
opcode.rs:1-2: // GENERATED from c/moddable xs/sources/xsCommon.h (enum) and xsCommon.c
// (gxCodeNames, gxCodeSizes) at pin 48ee02d8cfe0. Do not edit by hand.
snapshot_rows.rs:97: pub segments: Vec<Vec<u8>>,
```

**Mechanism:**

FUNC persists guest functions' raw bytecode segments, and restore adopts them verbatim
(`persist.rs:1834`).
Every restore-side check only walks instruction widths (`persist.rs:1789-1797`, `restore.rs:199-207`,
`snapshot_roster.rs:1492`, `image.rs:4942`).
How the bytes are read depends on `opcode.rs`, an enum transliterated from XS.
No identity covers that table:

- `derive_boot_fingerprint` hashes no code segments, and the boot heap has no bytecode.
- METR's digest hashes named weights; `CODE_METERING` is one uniform weight.
- `IRONHORSE_FORMAT_VERSION` is set by hand and documented as bumped for "the atom layout or the
  slot-record encoding" (`format.rs:197`).
- The row fingerprint reads only `snapshot_rows.rs` and `intl_data.rs`.
- `compiler_opcode_contract.rs` checks only that the compiler and the VM agree.

The same codebase treats renumbering as identity elsewhere:

- `row_schema.rs:20`: "renumbering one silently changes every stored row's meaning";
- `boot.rs:147`: "reordering variants cannot silently remap stored natives".

The opcode enum is the one persisted, discriminant-defined table left outside every identity.

XS gates its own ISA. It writes `XS_MAJOR/MINOR/PATCH_VERSION` into its snapshot's VERS and
asserts them on read (`xsSnapshot.c:1505-1507`, `:2389-2393`).
IronHorse replaced that payload with the IRON magic and a hand-set format number, and the ISA
identity was dropped.

The header names XS pin `48ee02d8cfe0`, while the gitlink, the oracle and the compiler's
byte-identity pin are `23b4d6b0a65f`.
The same `48ee02d8cfe0` appears as "the pin" in several other comments, so this is general comment
drift.
The table itself matches the gitlink header exactly: 246 of 246 names, with dense ordinals.

Two parts of the title need narrowing:

- **"Alphabetical" holds only partly.** The XS enum is alphabetical only through `XS_CODE_YIELD`;
  `PROFILE`, `YIELD_STAR` and the explicit-resource-management block are appended
  (`xsCommon.h:449-460`).
- **"Any insertion" is too broad.** Appending renumbers nothing.

Even so, XS did renumber its ISA mid-enum in releases 3.9.0 (9 opcodes) and 4.5.0 (12 opcodes),
each time with an `XS_MAJOR_VERSION` bump.
The ISA has been unchanged from 6.0 through the 8.3.1 pin and the upstream `public` head.

The repo has no generator for `opcode.rs`: `scripts/generate-compiler-opcodes.py` runs from the VM
to the compiler only.
`opcode.rs` has been hand-edited despite its header (the PROFILE width note, `opcode.rs:496-509`).

**Consequence:**

Suppose a future change inserts or removes an opcode mid-enum (for example by following an XS
renumbering, which the compiler byte-identity bar would force), changes a width, or makes an
IronHorse-local edit.
Old heaps then pass SIGN, METR, VERS, the row-schema fingerprint and the store schema, and execute
their persisted bytecode with shifted meanings.
That is persistent-state corruption with no refusal.

The width walk gives essentially no protection.
After a simulated mid-enum insertion, 93-98% of 1,711 compiled corpus programs still pass it.

The renumbering would change compiled bytes inside FUNC, so the `state_golden` digests (whose
fixtures include closures and generators) would fail CI.
But the prescribed remedy, `regenerate_persistence_identities` (`state_golden.rs:375`), recognizes
only "format/schema/boot" changes. It re-pins; it does not refuse old heaps.

An ISA change that also adds intrinsics or named cost weights would be refused by accident, through
the boot fingerprint or METR. A pure renumbering or width change would not.

Present exposure is nil:

- the engine is unreleased, and containers are regenerated (`designs/ironhorse-snapshot-store-seam.md:3456`);
- `PersistentMachine::open` has only test callers;
- the worker protocol is unwired.

The release contract, however, says containers survive compatible engine upgrades with SIGN as
the fail-closed gate (`designs/ironhorse-snapshot-store-seam.md:3462-3466`).

**Evidence:** The finder's evidence is static:

```
Static: grep finds no CODE_SIZES, CODE_NAMES or XS_CODE_COUNT reference in ironhorse-snapshot or in any identity computation; derive_boot_fingerprint (boot.rs:115-) has no code-segment term. A Python comparison of opcode.rs against the checked-out gitlink's xsCommon.h gives 246 == 246 names, identical. The table is therefore correct today, but its header pin is stale and nothing would catch a renumbering.
```

The code-evidence verifier compared the tables
(`probes/ontology/ont21-verify/compare_opcodes.py`):

```
xs names 246 ironhorse names 246 identical True
ironhorse discriminants dense True
xs enum (after NO_CODE) sorted alphabetically: False
out-of-order adjacent pairs: [('XS_CODE_CONST_LOCAL_2', 'XS_CODE_CONSTRUCTOR_FUNCTION'), ('XS_CODE_YIELD', 'XS_CODE_PROFILE'), ('XS_CODE_YIELD_STAR', 'XS_CODE_USED_1'), ('XS_CODE_USING_ASYNC', 'XS_CODE_AT_2')] 4
```

It then simulated an insertion with `probes/ontology/ont21-verify/zz_audit_ont_21.rs`.
The probe compiles all corpus programs, simulates one opcode inserted at enum position k, and
re-runs a walk identical to `instruction_len`:

```
programs=1711
insert@  1 width1: affected=1711 silently_accepted=1631
insert@ 30 width1: affected=1711 silently_accepted=1669
insert@ 90 width1: affected=1711 silently_accepted=1665
insert@150 width1: affected=1711 silently_accepted=1682
insert@210 width1: affected=1065 silently_accepted=1065
insert@237 width1: affected=  25 silently_accepted=  25
insert@246 width1: affected=   0 silently_accepted=   0
TOTAL affected=26184 silently_accepted=25554
len=165 accepted_by_width_walk=true shifted=36 of 85 instrs; first diffs: [("XS_CODE_RESERVE_1","XS_CODE_REGEXP"), ("XS_CODE_NEW_LOCAL","XS_CODE_NEW_CLOSURE"), ("XS_CODE_UNDEFINED","XS_CODE_UNCATCH"), ("XS_CODE_VAR_LOCAL_1","XS_CODE_VAR_CLOSURE_2"), ("XS_CODE_POP","XS_CODE_PLUS"), ...]
```

The consequence-and-intent verifier compared the XS headers of each release
(`probes/ontology/ont21-intent/scripts/isa_history.py`):

```
xsCommon-3.5.0.h: count=237 first XS_MAJOR_VERSION=13
xsCommon-3.9.0.h: count=240 first XS_MAJOR_VERSION=14 | vs 3.5.0: added=3 removed=0 renumbered=9 of 237
xsCommon-4.0.0.h: count=240 first XS_MAJOR_VERSION=14 | vs 3.9.0: added=0 removed=0 renumbered=0 of 240
xsCommon-4.5.0.h: count=242 first XS_MAJOR_VERSION=15 | vs 4.0.0: added=2 removed=0 renumbered=12 of 240
xsCommon-5.0.0.h: count=242 first XS_MAJOR_VERSION=15 | vs 4.5.0: added=0 removed=0 renumbered=0 of 242
xsCommon-6.0.0.h: count=246 first XS_MAJOR_VERSION=16 | vs 5.0.0: added=4 removed=0 renumbered=0 of 242
xsCommon-8.0.0.h: count=246 first XS_MAJOR_VERSION=17 | vs 6.0.0: added=0 removed=0 renumbered=0 of 246
xsCommon.h (gitlink 23b4d6b0): count=246 XS_MAJOR_VERSION=17 | vs 8.0.0: renumbered=0
xsCommon-public.h (upstream head): count=246 XS_MAJOR_VERSION=17 | vs gitlink: added=0 removed=0 renumbered=0
```

**Recommendation:**

1. **Add an ISA identity.** Hash the opcode name and width tables (`CODE_NAMES`, `CODE_SIZES`,
   `ID_SIZE`) into the boot fingerprint or SIGN, since SIGN is the documented compatibility gate.
   Alternatively, add an ISA digest atom checked at adoption, or include `opcode.rs` in the
   row-schema ledger fingerprint so an ISA edit forces a format bump.
2. **Teach the regeneration tool about the ISA.** Add "ISA" as a named class in its taxonomy.
3. **Fix the header.** Regenerate it to the current pin, or remove the "generated" claim, since
   no generator exists in the repo.

**Verification:**

- **Code-evidence verifier: medium (latent).**
  - Confirmed that no gate covers the table and that every restore check only walks widths.
  - Showed by simulation that the width walk silently accepts 93-98% of shifted programs.
  - Corrected "alphabetical … any insertion": XS appends now, and appending renumbers nothing.
  - Found that `opcode.rs` has no generator and has been hand-edited.
  - Placed the stale pin among general comment drift.
- **Consequence-and-intent verifier: medium.**
  - Found that no document excludes the ISA from identity. The store-seam decision makes
    cross-build survival the contract, so the gap is an omission, not a choice.
  - Showed that XS gates its ISA in VERS and that XS has renumbered in past releases.
  - Found the loud signal (`state_golden`) is routed to a re-pin rather than a refusal.
  - Stated the present exposure as nil, and kept medium on the strength of the release contract.

### ONT-1 — Halt::HeapExhausted (documented as the configured slot/chunk heap ceiling) also names the regexp engine's fixed match-state profile (65,536 states / 64 MiB) and a >2^31-1 quantifier-bound parse check, so long greedy matches halt uncatchably and 452 test262 cases are misfiled as anonymous 'ironhorse-aborted-limit'

**Severity:** low, lowered from high. The finder proposed high; the code-evidence verifier
rated it high; the consequence-and-intent verifier rated it low.
The guest-visible behaviour in the title is real, but the cap and the quantifier refusal cause
it, not the name.
The correctness lens files that behaviour as RGX-1 (high), and the anonymous report reason as
T262-7.

**Category:** synonym-homonym.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp.rs:1638`
- `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:348`, `:556`
- `rust/engine/ironhorse-regexp/src/matcher.rs:127`, `:128`
- `rust/engine/ironhorse-regexp/src/compile.rs:34`, `:2222`
- `rust/engine/ironhorse-compile/src/error.rs:97`
- `rust/engine/ironhorse-runtime/src/lib.rs:54`
- `rust/engine/ARCHITECTURE.md:334`
- `rust/engine/ironhorse-262/src/xst.rs:761`, `:880`
- `rust/engine/ironhorse-262/src/report.rs:207`

Added by verifiers:

- `interp.rs:1796-1808` (`is_panic`)
- `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:1664-1666` (a fixed regexp cap filed as
  Refused)
- `rust/engine/WASM-BLOCKERS.md:295`, `:311-312`
- `rust/engine/ironhorse-compile/src/error.rs:58`
- `rust/engine/ironhorse-262/src/lib.rs:131-137`
- `rust/engine/ironhorse-262/tests/xst_host_error_names.rs`
- `rust/engine/README.md:174`
- `c/moddable/xs/sources/xsre.c:1666-1667`

**Excerpt:**

```
interp.rs:1638 `/// The configured slot or chunk heap ceiling was exhausted. /// Deterministic: the same program under the same ceilings halts here ... HeapExhausted,` / matcher.rs:126-128 `/// Independent of metering: bounds retained states and their capture snapshots. pub const MAX_MATCH_STATES: usize = 65_536; pub const MAX_MATCH_BYTES: usize = 64 << 20;` / regexp.rs:348 `Err(ironhorse_regexp::CompileError::ResourceLimit) => { return Err(Step::Host(Halt::HeapExhausted)) }` / regexp.rs:556 `if outcome.resource_limit { return Err(Step::Host(Halt::HeapExhausted)); }` / compile.rs:2222 `if value > 0x7FFF_FFFF { return Err(CompileError::ResourceLimit); }` / xst.rs:759-761 `// ironhorse aborted for a limit reason (stack/meter) the oracle cannot share ... _ => Verdict::RunSkip("ironhorse-aborted-limit".into()),`
```

**Mechanism:** Three different conditions share one name.

1. The configured slot and chunk ceilings (`Interp::set_slot_ceiling` / `set_chunk_ceiling`,
   `value.rs:14-15`). This is what the `Halt::HeapExhausted` rustdoc describes (`interp.rs:1638`:
   "The configured slot or chunk heap ceiling").
2. The regexp matcher's own fixed storage profile. The compile-time constants are
   `MAX_MATCH_STATES` = 65,536 retained backtrack states and `MAX_MATCH_BYTES` = 64 MiB of match
   scratch (`matcher.rs:127-128`). `save_captures` (`matcher.rs:155-163`) compares against those
   constants only and never reads the configured ceilings. A greedy quantifier pushes one state
   per character, so `.*`, `a+` or `\s+` over more than 65,536 characters trips it.
3. A parse-time range check that refuses quantifier bounds above 2^31-1 (`compile.rs:2222`). It is
   filed as `CompileError::ResourceLimit` ("A deterministic compiler storage ceiling was reached",
   `compile.rs:34`). The XS source it transliterates clamps instead (`xsre.c:1666-1667`:
   `if (value > 0x7FFFFFFF) value = 0x7FFFFFFF;`).

The VM's `regexp.rs` maps (2) (`outcome.resource_limit`, `:556`) and (3) (`:348`, and
`ironhorse-runtime/src/lib.rs:54` for eval-compiled literals) to `Halt::HeapExhausted`.
`HeapExhausted` is in `Halt::is_panic`, so guest `try`/`catch` never runs.

The engine also classifies fixed regexp caps two ways in one file.
The capture cap at `natives/regexp.rs:1664-1666` is `Halt::Refused("RegExp.replace:oversized-result")`,
which matches `Halt::Refused`'s own doc ("a resource-size ceiling" of the execution profile).
The fixed state and storage caps in the same file are HeapExhausted.

Two documents are broader than the rustdoc and partly sanction the wide use.
`ARCHITECTURE.md:334` says "a ceiling's deterministic refusal", without "configured".
`WASM-BLOCKERS.md:295` and `:311-312` document the regexp compiler and matcher's "own byte
budgets" producing an uncatchable `HeapExhausted`.
The doc that actually conflicts with the code is the rustdoc at `interp.rs:1638`, together with
the runner comments at `xst.rs:759` ("(stack/meter)") and `:877` ("(stack geometry, meter, step
ceiling)").

The finder also read three spellings of the quantifier condition as a homonym:

- `LexErrorKind::RegExpResourceLimit`, "regexp storage limit exhausted" (`error.rs:97`);
- `HeapExhausted`;
- `ironhorse-aborted-limit`.

The consequence-and-intent verifier showed these are deliberate, exhaustively matched mappings
across layers:

- `error.rs:58` documents the kind as "Regexp compilation exceeded its deterministic storage
  profile";
- every real embedder maps it to `SourceCompileError::HeapExhausted`;
- `compile_failure_name` (`ironhorse-262/src/lib.rs:131-137`) deliberately renders it as
  `InternalError` so an engine limit never passes as `SyntaxError`, and
  `tests/xst_host_error_names.rs` pins that.

The 262 runner's positive-case arms file every non-Throw IronHorse halt under a `_ =>` wildcard
as `ironhorse-aborted-limit` (`xst.rs:761`, `:880`), and `report::classify` (`report.rs:207`)
puts it in Category::Unsupported.
The reason does not name the halt kind.
The same wildcard also absorbs MeterAbort, StackOverflow, HostAllocationFailed, MachineBusy,
StepLimit and non-EngineFault Panic kinds.

**Consequence:**

- **The documented remedy cannot help.** An embedder told by the rustdoc to look at the
  configured ceilings can raise both to their consensus maxima and nothing changes.
- **The report hides the halt kind.** It gives no halt kind for its single largest regexp gap.
- **Classification noise only.** The class split (HeapExhausted here, Refused for the capture
  cap) changes only labels and reason strings. It does not change guest behaviour, commit or
  discard handling, determinism or persistence. A Refused label is just as uncatchable, and the
  embedder seam (`rust/endo/src/ironhorse_engine.rs:370-385`) sends both to Panicked.

The guest-visible behaviour is real, and is covered by RGX-1:

- `/^a+$/.test('a'.repeat(65537))` and `/.*/.exec(line)` over a 70,000-character line end the
  crank with an uncatchable halt, and so does `new RegExp('b{2147483648}')`. Node and the XS
  oracle return a result.
- All 452 `ironhorse-aborted-limit` cases in the sweep are this regexp limit: 444
  `property-escapes/generated`, 4 `unicodeSets`, 3 `CharacterClassEscapes` and 1
  `quantifier-integer-limit.js`.
- Those cases are pinned by path in the checked-in expectations as 904 rows, and
  `rust/engine/README.md:174` documents the reason as the non-gating limit skip.
- So "misfiled" overstates it. Unsupported, the IronHorse-gap bucket, is defensible; the defect
  is the anonymous reason string.

**Evidence:** The finder's probes are in `probes/ontology/vocabulary/` and
`probes/ontology/taxonomy/`:

```
[vocabulary] Probes in ../probes/ontology/vocabulary/.

re_n65600.js: `const s = "a".repeat(65600);\nthrow new Error("ok " + /^a+$/.test(s));`. ironhorse-xst: `InternalError: ironhorse halted: HeapExhausted`. Node: `Error: ok true`. With 65000 instead of 65600, ironhorse prints `Error: ok true`, so the threshold is MAX_MATCH_STATES = 65,536.

re3.js: `for (const n of [2147483647, 2147483648]) { try { out.push(n + ":" + new RegExp("b{" + n + "}").test("")); } catch (e) { out.push(n + ":caught " + e.name); } } throw new Error(out.join(" "));`. ironhorse-xst: `InternalError: ironhorse halted: HeapExhausted` (the catch did not run). Node: `Error: 2147483647:false 2147483648:false`.

re4.js: `const r = /b{2147483648}/; throw new Error("ok " + r.test(""));`. ironhorse: `InternalError: line 1: regexp storage limit exhausted`. Node: `Error: ok false`. re5.js, the same pattern via eval inside try/catch: ironhorse `InternalError: ironhorse halted: HeapExhausted`; Node `Error: result: false`.

Rust probe zz_audit_ont_4.rs (ironhorse-vm, deleted after the run): Machine::new(), then optionally `with_persistence(|i| { i.set_slot_ceiling(CONSENSUS_MAX_SLOT_CEILING); i.set_chunk_ceiling(CONSENSUS_MAX_CHUNK_CEILING) })`, then evaluate. Output: `default ceilings: /^a+$/.test('a'.repeat(65600)) -> completed=false halt=HeapExhausted`; `maximum ceilings: ... -> completed=false halt=HeapExhausted`; `try { new RegExp('b{2147483648}').test('') } catch ... -> halt=HeapExhausted` under both ceilings; `b{2147483647} -> halt=Return result="false"`.

test262: assembled cases run through ironhorse-xst (CharacterClassEscapes/character-class-non-digit-class-escape-positive-cases.js, unicodeSets/generated/rgi-emoji-15.1.js, property-escapes/generated/ASCII.js) all print `InternalError: ironhorse halted: HeapExhausted`; Node exits 0. rust/engine/target/test262-report/report.json (endo_sha 61cd656cb) has 452 'ironhorse-aborted-limit' cases, all under built-ins/RegExp.

[taxonomy] p31c.js: let r; try { r = /^a+$/.test("a".repeat(1000000)); } catch (e) { r = "caught " + e; } throw new Error("1e6 a+:" + r);
  ironhorse: InternalError: ironhorse halted: HeapExhausted
  node:      Error: 1e6 a+:true
p32_dotstar.js: const line = "x".repeat(70000); ["dotstar-exec", () => /.*/.exec(line)[0].length] ... (guarded)
  ironhorse: InternalError: ironhorse halted: HeapExhausted
  node:      Error: dotstar-exec:70000 | trim-replace:70000 | split-lines:2
XS oracle (zz_audit_ont_1.rs / zz_audit_ont_3.rs, deleted after run):
  ORACLE regexp-greedy-70000: completed=true result="true"   IRONHORSE: completed=false halt=HeapExhausted
  dotstar-70000  XS: completed=true result="70000"   IRONHORSE: halt="HeapExhausted"
endot-ih with a private test262 root (t262/test/built-ins/probe/regexp-greedy-70000.js and a try/catch-guarded twin): both reported run-skip "ironhorse-aborted-limit".
Sweep (rust/engine/target/test262-report/report.json, run_id endo=61cd656cb): q_limit.py tally of reason "ironhorse-aborted-limit": 444 built-ins/RegExp/property-escapes, 4 built-ins/RegExp/unicodeSets, 3 built-ins/RegExp/CharacterClassEscapes, 1 built-ins/RegExp/quantifier-integer-limit.js. Rerunning property-escapes/generated/ASCII.js, quantifier-integer-limit.js and unicodeSets/generated/rgi-emoji-13.1.js standalone (harness concatenated) under ironhorse-xst: each printed "InternalError: ironhorse halted: HeapExhausted". `/\p{ASCII}/u` alone compiles and matches (p28), so the trigger is the matcher state cap on the long generated subject.
report::classify(RunSkip, "ironhorse-aborted-limit") => unsupported (zz_audit_ont_1 CLASSIFY line).
```

The code-evidence verifier's Rust probe is `probes/ontology/verify-ont1/zz_audit_ont_71.rs`, run
in `ironhorse-262`.
It runs each case on `xs_oracle::run` and `run_script_source`, then on `Machine::new()` with and
without the consensus-maximum ceilings:

```
a+ 65536: XS completed=true "true" | IRONHORSE completed=true halt=Return
a+ 65537: XS completed=true "true" | IRONHORSE completed=false halt=HeapExhausted is_panic=true
a+ 65600 guarded: XS true | IH HeapExhausted is_panic=true
dotstar 70000 guarded: XS "70000" | IH HeapExhausted
quant 2^31 guarded: XS "false" | IH HeapExhausted
quant 2^31-1: XS "false" | IH Return "false"
quant MAX_SAFE_INTEGER u: XS "false" | IH HeapExhausted
a+ 65537 raise=false: HeapExhausted ; raise=true: HeapExhausted
quant 2^31 guarded raise=false: HeapExhausted ; raise=true: HeapExhausted
```

It also ran 24 of the 452 cases (all 8 that are not property-escapes, plus 16 random
property-escapes) on `ironhorse-xst`; all halt with HeapExhausted.
A second probe, `zz_audit_ont_72.rs`, ran 5 of them under the XS oracle, and each completed.

The consequence-and-intent verifier's probes are in `probes/ontology/verify-ont1-intent/`:

```
i1_refused_pad.js: let r = "no"; try { r = String("a".padEnd(2 ** 24 + 1).length); } catch (e) { r = "caught " + e.name; } throw new Error("pad:" + r);
  ironhorse: InternalError: ironhorse halted: Refused("String.prototype.pad:result-too-large")
  node: Error: pad:16777217
i2_heap_regexp.js: let r = "no"; try { r = String(/^a+$/.test("a".repeat(65537))); } catch (e) { r = "caught " + e.name; } throw new Error("re:" + r);
  ironhorse: InternalError: ironhorse halted: HeapExhausted
  node: Error: re:true
```

A Refused cap is exactly as uncatchable as the HeapExhausted regexp cap.

**Recommendation:**

1. **Fix the guest-visible behaviour through RGX-1:**
   - clamp quantifier bounds above 2^31-1 to `0x7FFF_FFFF`, as XS does;
   - re-examine the 65,536-state cap. Either charge matcher state to the configured chunk ceiling
     or represent single-character greedy loops without one state per iteration.
2. **Fix the naming here:**
   - amend the `interp.rs:1638` rustdoc to cover release-fixed deterministic storage ceilings, or
     choose one class for fixed caps deliberately and apply it to both the capture cap and the
     state and storage caps;
   - do not relabel the regexp limits as Refused. That would move the 452 cases into
     Category::Refused (`report.rs:180`), the deliberate-restriction bucket, and present a defect
     as policy.
3. **Name the halt kind in the runner.** Replace the `_ =>` arms at `xst.rs:761` and `:880` with
   an explicit match that names the halt kind in the reason, for example
   `ironhorse-aborted-limit:heap`, `:meter`, `:stack`, `:reentry` or `:regexp`. Send
   HostAllocationFailed to Infrastructure and unknown Panic kinds to Fail.

**Verification:**

- **Code-evidence verifier (kept high):**
  - re-opened all 13 locations;
  - confirmed that the state cap is a fixed constant independent of the configured ceilings, with
    an exact threshold: 65,536 passes, 65,537 halts;
  - confirmed that the quantifier refusal departs from XS's clamp, and that `is_panic` makes it
    uncatchable;
  - confirmed that raising both ceilings to their maxima changes nothing;
  - spot-checked 24 of the 452 cases and ran 5 under the oracle;
  - found that `ARCHITECTURE.md:334` and `WASM-BLOCKERS.md` partly sanction the broad use, so the
    conflicting doc is the rustdoc;
  - called "misfiled" too strong.
- **Consequence-and-intent verifier (low):**
  - showed that the uncatchable halt comes from the cap, not the name, since a Refused cap is
    equally uncatchable and both reach Panicked at the embedder seam;
  - found that no embedder reacts to HeapExhausted by raising ceilings;
  - noted that the guest-visible defect and the anonymous reason are already filed as RGX-1 and
    T262-7;
  - showed that the "three names" are deliberate, tested layering;
  - noted that the 904 rows are pinned and documented;
  - noted that the finder's Refused-label recommendation would make the report worse;
  - found that what survives is the rustdoc drift plus the in-file two-way classification of
    fixed regexp caps.

### ONT-7 — 'Result too large' is one condition classified three ways at three thresholds: Refused at private 2^24 caps (pad, generic join, String.raw, RegExp replace, BigInt), catchable RangeError above 2^31-1 (reserve_units), HeapExhausted at the configured chunk ceiling; is_panic and the test262 report then split them again

**Severity:** low, lowered from medium. The finder proposed medium; the code-evidence verifier
rated it medium; the consequence-and-intent verifier rated it low.

**Category:** taxonomy.

**Same defect as:** NVAL-9 (medium), the primary.
ONT-7 is low on its own and medium as merged.

**Locations:**

- In `rust/engine/ironhorse-vm/src/interp/natives/`:
  - `string.rs:738`, `:740`, `:741`, `:148`, `:606`;
  - `array.rs:2397`, `:2398`, `:2411`;
  - `regexp.rs:1664` (a capture-count cap, not an output-size cap, despite its label);
  - `bigint.rs:265`, `:640`.
- `rust/engine/ironhorse-vm/src/interp/admission.rs:128`.
- `rust/engine/ironhorse-vm/src/value.rs:15`.
- `rust/engine/ironhorse-vm/src/interp.rs:1683`, `:1796`.
- `rust/engine/ironhorse-vm/src/halt_labels.rs:78`.
- `rust/engine/ironhorse-262/src/xst.rs:761`, `:917`.
- `rust/engine/ironhorse-262/src/report.rs:100`, `:207`.

Added by verifiers:

- `bigint.rs:233`, `:308` and `:628`: the BigInt caps are 64 Ki bits, not 2^24.
- `bigint.rs:305-307`: the documented metering rationale for the pow cap.
- `array.rs:2391-2396`: the documented rationale for the generic join cap.
- `xst.rs:673` and `:880`.
- `rust/endo/src/ironhorse_engine.rs:370-382`.
- `rust/endo/src/engine/js_machine.rs:348`.
- `rust/engine/ironhorse-262/tests/error_messages_numeric_string.rs:115-138`.

**Excerpt:**

```
string.rs:736-745  // Allocation is an implementation limit, not a guest
    // RangeError. XS also aborts at its chunk-size limit. ...
    const STRING_PAD_UNIT_CAP: u64 = 1 << 24;
    if target > STRING_PAD_UNIT_CAP {
        return Err(Step::Host(Halt::Refused("String.prototype.pad:result-too-large")));
array.rs:2397 `const GENERIC_JOIN_CAP: u64 = 1 << 24;`
admission.rs:128-133  if units > 0x7fff_ffff {
        return Err(self.catchable_range_error_msg("result too large".into()));
    }
    if !self.chunks.can_allocate(units * 2) {
        return Err(Step::Host(Halt::HeapExhausted));
report.rs:100 `/// A supported operation rejected by the execution profile or resource limits.`
```

**Mechanism:** The engine has one shared admission helper for string results,
`reserve_units` (`admission.rs:128`). It has two outcomes:

- above `0x7fff_ffff` units, it throws a catchable guest `RangeError`;
- above the configured chunk ceiling (`value.rs:15`), it raises HeapExhausted, which is a panic.

Several built-ins check private fixed caps before that helper and raise `Halt::Refused` labels
instead:

| Built-in | Cap | Location |
|---|---|---|
| `padStart` / `padEnd` | 1<<24 units | `string.rs:738-743` |
| generic `Array.prototype.join` | 1<<24 | `array.rs:2397-2411` |
| `String.raw` | 1<<24 | `string.rs:148` |
| BigInt shift, `asIntN`/`asUintN`, `**` | 64 Ki bits | `bigint.rs:233`, `:308`, `:628` |
| RegExp replace | 1<<24 captures | `regexp.rs:1664` |

None of these caps is registered in `xs_departures.rs`.
Because the pad cap comes first, the `RangeError` in `reserve_units` cannot be reached from
`padEnd`.
`repeat` reaches its catchable 2^31 `RangeError` through its own count check (`string.rs:606`), not
through `reserve_units`.

The comment justifying the pad cap ("XS also aborts at its chunk-size limit") is contradicted by
the XS oracle.
XS completes `padEnd(2^24+1)` and resource-aborts only at 2^31.
The cap is also unrelated to the configured 256 MiB chunk ceiling.

Which class a guest gets depends on the call path, not on the condition.
`repeat`, string concatenation and the dense join fast path build results up to the configured
chunk ceiling and then halt with HeapExhausted.
Inside BigInt, `*` builds a 120,001-bit result, while `<<`, `**` and `BigInt.asUintN` refuse one.

Some of this is a recorded decision.
`Halt::Refused` documents "a resource-size ceiling" as one of its members (`interp.rs:1683`), and so
does `REFUSED_LABELS` (`halt_labels.rs:78`).
A test pins the uncatchability of the pad refusal: `error_messages_numeric_string.rs:115-138`
asserts that `'x'.padEnd(Infinity,'y')` halts with Refused and must not be caught.
The BigInt `**` cap and the generic join cap have written rationales (`bigint.rs:305-307`,
`array.rs:2391-2396`).
What is not decided anywhere is the arbitrary set of thresholds, and the false comment.

**Consequence:** At the default 256 MiB ceiling, which Endo uses because it never sets one, results
of the same size get different treatment:

- `repeat`, `+` and dense join build a 16,777,217-unit string (34 MB), as XS and Node do;
- `padStart`/`padEnd`, generic join and `String.raw` of the same size halt uncatchably, and even
  `try { } finally { }` cannot observe the halt;
- `padEnd(2^31)` halts with Refused, while `repeat(2^31)` throws a catchable `RangeError` (Node
  throws `RangeError` for both);
- BigInt `**`, `<<` and `asIntN`/`asUintN` halt above 65,536 bits, while `*` builds larger results.

XS and Node complete every case listed above.
Within `join`, the halt class (Refused or HeapExhausted) depends on the array's representation.

The downstream splits the finder named do not change any decision in practice:

- the only production commit seam, `ExecutionOutcome::classify`
  (`rust/endo/src/ironhorse_engine.rs:370-382`), maps both Refused and HeapExhausted to Panicked;
- the JsMachine Unavailable/Halt split (`js_machine.rs:348`) has zero production callers;
- the test262 report split is hypothetical: the pinned sweep has no case with a size-cap Refused
  label, and its only 5 Refused cases are weak-symbol oracle-version cases;
- HostAllocationFailed is not reachable on the native sweep host.

The Endo seam renders the two classes differently: "execution refused: … (an engine profile
limit)" against "halted: HeapExhausted".
Under the deployment ceilings that `WASM-MEMORY.md` recommends (32 MiB native worker, 4 MiB
Cloudflare), no path reaches 2^24 units, and only the label differs.

**Evidence:** The finder's probes are in `probes/ontology/vocabulary/` and
`probes/ontology/taxonomy/`:

```
[vocabulary] sz2.js: `const n = 17000000; out.repeat = "a".repeat(n).length; out.concatLoop = ((s="a".repeat(n-1)) => (s+"b").length)(); out.denseJoin = Array.from({length:17}, () => "a".repeat(1000000)).join("").length;`. ironhorse: `Error: {"repeat":17000000,"concatLoop":17000000,"denseJoin":17000000}`, identical to Node.

sz3.js: `throw new Error(String("a".padEnd(17000000).length));`. ironhorse: `InternalError: ironhorse halted: Refused("String.prototype.pad:result-too-large")`. Node: `Error: 17000000`.

sz4.js: `Array.prototype.join.call({length: 17000001, 0: "x"}, "").length`. ironhorse: `Refused("join:oversized-array-like")`. Node: `Error: 1`.

sz.js, each expression in try/catch with none caught: `'a'.repeat(200*1024*1024).length` gives HeapExhausted; `'ab'.padEnd(200*1024*1024).length` gives Refused("String.prototype.pad:result-too-large"); `Array(70*1024*1024).join('ab').length` gives Refused("join:oversized-result") (Node 146800638); `['a'.repeat(1<<20)].concat(Array(200).fill('a'.repeat(1<<20))).join('').length` gives HeapExhausted (Node 210763776).

Rust probe zz_audit_ont_1 output: `classify(RunSkip, "ironhorse-aborted-limit") = Unsupported`, `classify(RunSkip, "refused:join:oversized-array-like") = Refused`.

[taxonomy] p22c_repeat_concat.js: const n = 2 ** 24 + 1; r = "repeat:" + "x".repeat(n).length + " concat:" + ("x".repeat(n - 1) + "x").length
  ironhorse: Error: repeat:16777217 concat:16777217   node: same
p22b_padend_2p24p1.js: r = "padEnd:" + "x".padEnd(n, "x").length (inside try/catch)
  ironhorse: InternalError: ironhorse halted: Refused("String.prototype.pad:result-too-large")
  node:      Error: padEnd:16777217
p22a (adds Array(n + 1).join("x")): ironhorse: InternalError: ironhorse halted: Refused("join:oversized-array-like"); node: ... join:16777217
p23_pad_catch.js: try { "x".padEnd(2 ** 24 + 1, "x"); r = "completed"; } catch (e) { r = "caught " + e; } finally { r += " +finally"; }
  ironhorse: InternalError: ironhorse halted: Refused(...)   node: Error: completed +finally
p22d_repeat_big.js: "x".repeat(2 ** 31) -> ironhorse: caught RangeError: count too big (catchable); p02_repeat.js: "x".repeat(2**30) -> ironhorse: halted: HeapExhausted
XS oracle (zz_audit_ont_1.rs):
  ORACLE padEnd-2^24+1: completed=true result="16777217"   IRONHORSE: halt=Refused("String.prototype.pad:result-too-large")
  ORACLE repeat-2^24+1: completed=true result="16777217"   IRONHORSE: completed=true result="16777217"
zz_audit_ont_3.rs: bigint-shift `1n << 10000000000n` -> XS: completed=false resource_abort=true; IRONHORSE: Refused("bigint-shift:result-too-large"). BigInt.asUintN(2**40,-1n) -> XS resource_abort=true; IRONHORSE Refused("BigInt.asN:result-too-large").
endot-ih on a private root: padend-2p24p1.js -> run-skip "refused:String.prototype.pad:result-too-large" (Category refused); repeat-2p24p1.js -> covered.
```

The code-evidence verifier's probes are in `probes/ontology/verify-ont7/` (`outputs.txt`).
These are the JS probes:

```
v7_padend_2p31.js: "x".padEnd(2 ** 31, "x") in try/catch
  IH:   InternalError: ironhorse halted: Refused("String.prototype.pad:result-too-large")   node: Error: caught RangeError: Invalid string length
v6_repeat_2p31.js: "x".repeat(2 ** 31) in try/catch
  IH:   Error: caught RangeError: count too big   node: Error: caught RangeError: Invalid string length
b1_bigint_mul.js: const x = 1n << 60000n; const y = x * x; const z = y * y; -> IH: Error: mul bits:120001 240001  node: same
b2_bigint_shl.js: (1n << 120000n) -> IH: Refused("bigint-shift:result-too-large")  node: shl bits:120001
b3_bigint_pow.js: (2n ** 120000n) -> IH: Refused("exponentiation:result-too-large")  node: pow bits:120001
b4_bigint_asn.js: BigInt.asUintN(120001, -1n) -> IH: Refused("BigInt.asN:result-too-large")  node: asUintN bits:120001
```

Its Rust probe, `zz_audit_ont_71.rs`, compared the XS oracle with IronHorse:

```
ORACLE padEnd-2^24+1: completed=true result="16777217" resource_abort=false
IRONHORSE padEnd-2^24+1: completed=false halt=Refused("String.prototype.pad:result-too-large") is_panic=false
ORACLE holey-join-2^24+2: completed=true result="16777217"; IRONHORSE: halt=Refused("join:oversized-array-like") is_panic=false
ORACLE bigint-shl-120000: completed=true result="120001"; IRONHORSE: halt=Refused("bigint-shift:result-too-large")
ORACLE bigint-mul-120001: completed=true result="120001"; IRONHORSE: completed=true result="120001"
ORACLE padEnd-2^31: completed=false resource_abort=true; IRONHORSE: halt=Refused("String.prototype.pad:result-too-large")
ORACLE repeat-200MiB: completed=true result="209715200"; IRONHORSE: halt=HeapExhausted is_panic=true
```

The consequence-and-intent verifier's census of the pinned sweep is in
`probes/ontology/verify-ont7-intent/test262_census.txt`:

```
by_category {'covered': 39860, 'ironhorse-failure': 1064, 'unsupported': 3256, 'refused': 5, 'skipped': 7614, 'infrastructure': 177}
cases with a size-cap Refused label: 0
refused reasons: Counter({'refused:collection-constructor:weak-symbol-oracle-version': 5})
aborted-limit cases: 452
```

**Recommendation:**

1. **Derive or register every cap.** Derive each fixed cap from the configured ceiling or the
   meter budget. Where a cap stays fixed, register it as a named profile constant with a
   departure row in `xs_departures.rs`.
   - The Refused size class is a recorded design choice, so this is not a recommendation to
     abolish it.
   - The point is that one condition should meet one threshold, whichever built-in reaches it.
2. **Fix the pad comment.** Delete or correct the false comment at `string.rs:737-738`.
3. **Name limits consistently in the harness.** Map each resource halt to a named limit reason
   under one category, and map HostAllocationFailed to Infrastructure.

**Verification:**

- **Code-evidence verifier (kept medium).**
  - Re-opened all 20 locations and confirmed the probes.
  - Found that not every cap is 2^24: BigInt is 64 Ki bits, and RegExp is a capture count.
  - Found that the supervisor consequence is overstated, because both classes reach Panicked at
    the commit seam. The real split is the unwired JsMachine classifier and the rendered text.
  - Attributed `repeat`'s 2^31 `RangeError` to its own count check.
  - Added the BigInt `*` versus `<<`/`**`/`asUintN` evidence.
- **Consequence-and-intent verifier (low).**
  - Found that Refused-for-size is a declared class, that its uncatchability is pinned by a test,
    and that two of the caps have written rationales.
  - Found that the is_panic, JsMachine and report splits change nothing live.
  - Restated what survives as an inconsistent set of thresholds plus a false comment: a
    deterministic, named, loud halt on very large results only, with no wrong values.

### ONT-8 — test262 module-path classification: 'a real compile rejection' is defined three ways (a module-path regexp resource stop is credited as a covered SyntaxError), and every module:* run-skip family is unclassified and defaults to Infrastructure, so 164 IronHorse module gaps, and any module compiler panic, are reported as 'not an IronHorse gap'

**Severity:** low, lowered from medium. The finder proposed medium; the one verifier rated it low.
No consequence-and-intent pass ran, because the code-evidence verifier left the finding below
medium.

**Category:** taxonomy.

**Same defect as:** T262-5 (medium), the primary; it also overlaps T262-14 (low), where two
compile-error classifiers disagree about which failures are SyntaxErrors.
ONT-8 is low on its own and medium as merged.

**Locations:**

- `rust/engine/ironhorse-262/src/lib.rs:117`, the doc comment; `compile_failure_name` itself is at
  `:118`.
- `rust/engine/ironhorse-262/src/lib.rs:398`, `:408`.
- `rust/engine/ironhorse-262/src/xst.rs:1376`, `:1768`, `:1782`, `:1795`, `:1815`, `:1826`,
  `:1852`, `:1853`, `:2039`. Line `:1782` is a closing brace; the catch_unwind `Err(_)` arm is at
  `:1783`.
- `rust/engine/ironhorse-262/src/report.rs:107`, `:225`, `:226`.
- Added by the verifier:
  - `xst.rs:1813-1816`: resolution-linking returns before the compile result is inspected.
  - `xst.rs:2048`, `:2051`.
  - `rust/engine/ironhorse-262/scripts/README.md:89-96`.

**Excerpt:**

```
xst.rs:1768-1795 `let ironhorse_rejected = match &ironhorse { Ok(Err(error)) => { if matches!(error.kind, ParseErrorKind::Unsupported) { return ... "compiler-unimplemented:parse" } true } ... }; ... (false, true) => Verdict::Covered,`; xst.rs:1851-1853 `Ok(Err(_)) => Verdict::RunSkip("module:compiler-rejected".into()), Err(_) => Verdict::RunSkip("compiler-unimplemented:module".into()),`; report.rs:225-229 `} else { // Unknown run skips must not be charged to Ironhorse. New // reason families stay honest until explicitly classified. Category::Infrastructure`; xst.rs:1376 `IronhorseCompile::Panicked(_) => Verdict::Fail(format!("compiler-panicked:{}", neg.phase)),`
```

**Mechanism:** Three sites decide which `ironhorse-compile` error kinds count as a genuine early
error.

| Site | Rule |
|---|---|
| (a) `compile_failure_name` (`lib.rs:118`) | Exhaustive. `ParseErrorKind::MeterLimit`, Lex `MeterLimit`, `RegExpBudgetExceeded`, `RegExpResourceLimit`, `RegExpHostAllocationFailed` and `Overflow` are `InternalError`, not `SyntaxError`. |
| (b) The script dual run (`lib.rs:398-408`) | RegExp* and Unsupported are Unsupported, but a wildcard sends MeterLimit and Overflow to Rejected. |
| (c) The module path (`xst.rs:1768-1797`, `:1844-1853`, `:2030-2040`) | Excludes only `ParseErrorKind::Unsupported`, so any other error is a rejection. |

On the module path, a negative case is Covered if XS also rejects (`xst.rs:1795`).
A positive case becomes `module:compiler-rejected` (`xst.rs:1852`) without consulting
`oracle.compiled`.

Separately, `report::classify` lists the Unsupported reason families explicitly and sends every
other RunSkip to Infrastructure (`report.rs:225-229`).
Its doc (`report.rs:107-111`) describes Infrastructure as "explicitly not an Ironhorse gap".

The module runner emits six reason families, and none of them is classified:

- `module:resolution-linking`;
- `module:compiler-rejected`;
- `module:compiler-byte-divergence`;
- `module:harness-compiler-rejected`;
- `module:harness-oracle-rejected`;
- `module:harness-byte-divergence`.

All six fall through to the catch-all meant for unknown families.
Their twins are classified differently: `compiler-unimplemented:module` and
`unsupported-opcode:module:static-linking` are Unsupported.

`module:resolution-linking` returns before the compile result is even inspected
(`xst.rs:1813-1816`).

A compiler panic on module source is the catch_unwind `Err(_)` at `xst.rs:1704`.
It becomes `compiler-unimplemented:module` or `:parse`, which is Unsupported.
On the Script negative path, the same panic is a `compiler-panicked` Fail (`xst.rs:1376`).

**Consequence:** This is report taxonomy only. There is no engine or guest effect, `met_bar` is
unaffected, and the affected cases move between non-covered buckets.

In the `61cd656cb` sweep, 164 of the 177 Infrastructure cases are IronHorse's own module compiler
or linker outcomes:

- **98 `module:compiler-rejected`.** 87 are `language/import/import-defer`, 5 are
  `language/expressions/dynamic-import`, and 6 are `language/module-code/export-expname-*`. XS also
  fails to compile every one of them, so they are shared gaps. The Script analogue is
  `shared-positive-test-failure`, which is Unsupported.
- **34 `module:resolution-linking`.** 12 of these never reach the linker: 11 are compiler
  Unsupported results, and 1 is a Syntax rejection.
- **32 `module:compiler-byte-divergence`.** 24 are `language/module-code/top-level-await`, 4 are
  `await-using`, 3 are `using` and 1 is `namespace`.

Two of the claimed mechanisms are latent at this commit:

- **Resource stop credited as Covered.** All 198 test262 module parse-negative cases reject with
  Syntax (195) or Unsupported (3). No real case is over-credited; only a constructed probe shows
  it.
- **Module panic filed as a gap.** No panic occurs on any examined case.

`ironhorse-262/scripts/README.md:89-96` says loader-dependent module shapes "surface as named
gaps", never hidden.

**Evidence:** The finder's probes are in `probes/ontology/vocabulary/` and
`probes/ontology/taxonomy/`:

```
[vocabulary] Rust probe zz_audit_ont_1.rs (ironhorse-262, release, deleted after the run; source in probes/ontology/vocabulary/). It calls report::classify on each reason and xst::run_case(&Config::default(), ".", src) on these sources. Module: `flags: [module]`, negative parse SyntaxError, body `var r = /b{2147483648}/; export default 1; export default 2;`. Script: `flags: [raw]`, same negative, body `var r = /b{2147483648}/; let a; let a;`. Output:
`classify(RunSkip, "module:compiler-rejected") = Infrastructure`
`classify(RunSkip, "module:resolution-linking") = Infrastructure`
`classify(RunSkip, "module:compiler-byte-divergence") = Infrastructure`
`classify(RunSkip, "compiler-unimplemented:module") = Unsupported`
`classify(RunSkip, "unsupported-opcode:module:static-linking") = Unsupported`
`module compile kind: Some(Lex(LexError { line: 7, kind: RegExpResourceLimit }))`
`script compile kind: Some(Lex(LexError { line: 7, kind: RegExpResourceLimit }))`
`module negative verdict: Covered`
`script negative verdict: RunSkip("compiler-unimplemented:parse")`
The controls without the regexp are Covered in both goals.

Sweep rust/engine/target/test262-report/report.json (endo_sha 61cd656cb, completion complete): by_category infrastructure = 177, of which module:compiler-rejected 98, module:resolution-linking 34, module:compiler-byte-divergence 32. The committed whole-tree expectation lists carry the same 98/34/32 rows.

[taxonomy] Rust probe zz_audit_ont_1.rs (ironhorse-262/tests, deleted after the run) calling the public `ironhorse_262::report::classify`:
  CLASSIFY RunSkip "unsupported-opcode:module:static-linking" => unsupported
  CLASSIFY RunSkip "module:resolution-linking" => infrastructure
  CLASSIFY RunSkip "module:compiler-rejected" => infrastructure
  CLASSIFY RunSkip "module:compiler-byte-divergence" => infrastructure
  CLASSIFY RunSkip "module:harness-compiler-rejected" => infrastructure
  CLASSIFY RunSkip "compiler-unimplemented:module" => unsupported
  CLASSIFY RunSkip "shared-positive-test-failure" => unsupported
  CLASSIFY Fail "compiler-panicked:parse" => ironhorse-failure
Same probe: ORACLE module string-export-name (`var x = 1; export { x as "☿" };`): compiled=false; IRONHORSE: Err(ParseError { kind: Syntax, message: "missing identifier" }).
endot-ih on a private root (t262m/test/language/probe-mod): the valid module as a positive case -> run-skip "module:compiler-rejected" (Infrastructure); the same source marked parse-negative -> covered (both engines reject). The Script analogue of 'both reject a valid source' is shared-positive-test-failure (Unsupported).
Sweep report.json tally (q_module.py): 98 module:compiler-rejected (87 language/import/import-defer, 6 language/module-code/export-expname-*string*, 5 language/expressions/dynamic-import), 34 module:resolution-linking, 32 module:compiler-byte-divergence: all category infrastructure. 133 unsupported-opcode:module:static-linking: category unsupported.
```

The verifier's probe is `probes/ontology/verify-ont8/zz_audit_ont_801.rs`.
It re-classifies every reason and runs each of the 164 sweep cases through
`xs_oracle::compile_module` and `compile_module_atoms`:

```
module positive (regexp only) verdict: RunSkip("module:compiler-rejected")
oracle compiles regexp-only module: true
  32 module:compiler-byte-divergence | oracle.compiled=Some(true) | ironhorse=accepted
  98 module:compiler-rejected | oracle.compiled=Some(false) | ironhorse=Syntax
   1 module:resolution-linking | oracle.compiled=Some(false) | ironhorse=Syntax
   9 module:resolution-linking | oracle.compiled=Some(false) | ironhorse=Unsupported
   2 module:resolution-linking | oracle.compiled=Some(true) | ironhorse=Unsupported
  22 module:resolution-linking | oracle.compiled=Some(true) | ironhorse=accepted
```

`zz_audit_ont_802.rs` compiled all 198 test262 files that carry `flags: [module]` and
`phase: parse`.
The results were 195 Syntax and 3 Unsupported, with 0 resource-limit kinds and 0 panics.

**Recommendation:**

1. **One classifier for compile errors.**
   Write one exhaustive `classify_compile_error(kind) -> {EarlyError, Unported, ResourceStop,
   HostFailure}`, with no wildcard, in the style of `compile_failure_name`.
   Call it from all three sites.
2. **Invert the report default.**
   An unknown reason should fail classification, or count as Unsupported, so a new family must be
   classified before it can leave the IronHorse column.
   Add a test that scans `xst.rs` for emitted reason literals and requires `classify()` to name
   each family.
3. **Classify the module families explicitly.**
   - `resolution-linking` and `harness-compiler-rejected`: Unsupported.
   - `compiler-rejected`: Fail when `oracle.compiled`, otherwise a shared-gap Unsupported. Consult
     the oracle at `xst.rs:1852`, as the parse-negative branch does.
   - `byte-divergence`: the same bucket as the script path's compile-diff gate.
   - Inspect the compile result before returning `module:resolution-linking`.
4. **Treat module panics as failures.**
   Give the module `catch_unwind` `Err(_)` arms a `compiler-panicked:module` Fail, matching the
   Script path.

**Verification:**

- **Code-evidence verifier: low.** It re-opened every site and confirmed each part of the
  mechanism, and found no other consumer that reclassifies `module:*` reasons.
  - **Shared gaps.** All 98 `compiler-rejected` cases are shared gaps; only a constructed probe
    produces an IronHorse-only rejection.
  - **Latent paths.** The resource-stop-as-Covered and module-panic paths have zero instances at
    this commit.
  - **Early return.** `resolution-linking` masks 12 cases that never reach the linker.
  - **Doc contradiction.** `scripts/README.md` contradicts the code.
  - **Severity.** It lowered the finding to low: this is a harness taxonomy defect with no engine
    or guest effect, and medium would be defensible only if report-category integrity counts as a
    governance gate.

### ONT-10 — `Halt::Decode` / `parse-or-decode` conflates compiler gaps, compiler panics, guest-caused relink refusals and malformed bytecode, and the harness files them all as coverage gaps

**Severity:** low, lowered from medium. The finder proposed medium; the code-evidence verifier
rated it medium and the consequence-and-intent verifier low.

**Category:** taxonomy.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp.rs:2016`, `:2043`, `:1784`
- `rust/engine/ironhorse-262/src/lib.rs:395`, `:671`, `:730`, `:876`
- `rust/engine/ironhorse-262/src/xst.rs:678`, `:1276`, `:2085`
- `rust/engine/ironhorse-262/src/report.rs:202`

Added by verifiers:

- `xst.rs:558` (setup path)
- `xst.rs:1704`, `:1783-1785`, `:1853` (module catch_unwind arms)
- `xst.rs:2692` (where `MissingBytecode` is discarded)
- `lib.rs:182-184`, `:209-215`, `:470-479`
- `rust/engine/ironhorse-262/src/test262.rs:153-158`
- `rust/engine/ironhorse-vm/src/interp/dispatch.rs:291-295`
- `rust/engine/ironhorse-vm/src/interp/link.rs:1269-1271`
- `rust/engine/ironhorse-vm/src/compartment.rs:784-785`
- `rust/engine/ironhorse-compile/tests/corpus_compiler_totality.rs`

**Excerpt:**

```
interp.rs:1784-1787  /// `Decode` and the harness-only `StepLimit` are **provisional**
    /// members: they terminate-without-commit like a panic, but their
    /// provenance is supervisor/harness rather than guest behavior ...
interp.rs:2042-2043  /// Tooling had no bytecode to submit after source compilation failed.
    MissingBytecode,
xst.rs:678  Halt::Decode(_) => return Verdict::RunSkip("parse-or-decode".into()),
lib.rs:671  Err(error) => Halt::Decode(ironhorse_vm::DecodeError::Relink(error)),
```

**Mechanism:**

`DecodeError` is documented as "the bytecode was truncated or an opcode byte was invalid", but it
carries several different conditions:

1. **Genuinely malformed bytecode.** With `ironhorse-compile` as the default compiler, this is a
   compiler or VM defect.
2. **`MissingBytecode`.** The timeout-attribution helpers synthesize it (`lib.rs:730`, `:876`)
   for a failed or panicked compile.
3. **`Relink(TableFull)`.** Key-table exhaustion, which a guest can cause (ONT-2).
4. **`InvalidSymbols`.** The production compartment path (`compartment.rs:784-785`) maps every
   relink error to it, `TableFull` included, so it displays "invalid CESU-8 symbols atom".

How compile failures reach `Decode` on the Script path:

- `compile_for` (`lib.rs:384-421`) returns empty bytecode for both `IronhorseCompile::Unsupported`
  and `IronhorseCompile::Panicked`.
- Both `run_compiled_script` and `dual_run_with` special-case only `Rejected`.
- The empty bytecode therefore runs, and dispatch returns
  `Halt::Decode(ProgramCounterOutOfBounds{pc:0,len:0})` (`dispatch.rs:291-295`).
- `evaluate_positive` (`xst.rs:667-679`) never reads `run.ironhorse_compile`. It maps any
  `Decode` to RunSkip `parse-or-decode`, which `report::classify` puts in Unsupported.
- The setup path (`xst.rs:558`) and runtime-negative path (`xst.rs:1276`) have the same arm.

The authors saw the hazard for `Rejected`.
`lib.rs:470-479` says running empty bytecode "would decode past the end and surface a spurious
Halt::Decode ('parse-or-decode')".
They fixed it for `Rejected` only.

Panic handling is inconsistent across paths:

- `IronhorseCompile::Panicked`'s doc (`lib.rs:209-215`) promises a `compiler-panicked:<phase>`
  Fail.
- Only the Script parse-negative path honours that (`xst.rs:1376`).
- The module path catches compiler panics (`xst.rs:1704`) and files them as
  `compiler-unimplemented:module` or `:parse` (`xst.rs:1783-1785`, `:1853`).
- The `IronhorseCompile` header doc (`lib.rs:182-184`) contradicts the variant doc: it calls a
  panic a "compiler coverage gap".

One compile gap carries three different reason labels:

- `compiler-unimplemented:<phase>` on Script parse-negatives (`xst.rs:1358`);
- `compiler-unimplemented:module`, `:parse` or `:module-harness` on module paths;
- `parse-or-decode` on positive Scripts, setup and runtime negatives.

The `is_panic` rationale for `Decode` ("provenance is supervisor/harness rather than guest
behavior") does not hold for `Relink(TableFull)`.
`interp.rs:1784-1793` flags `Decode`'s membership as an open question.

**Consequence:**

The live effect is mislabelling.
The sweep has 3 `parse-or-decode` cases:

- `language/statements/class/static-init-scope-lex-close.js`
- `language/statements/class/static-init-scope-var-close.js`
- `language/statements/class/static-init-scope-var-open.js`

They are compiler-unimplemented gaps (lexical declarations in a static block) and land in the
correct category, Unsupported, but under a decode-sounding reason.
They are committed that way in the whole-tree expectations.

The panic-masking path is latent.
The sweep has no `compiler-panicked` case, and two gates would fail loudly anyway:

- the CI-required `corpus_compiler_totality.rs` compiles every test262 source in five goal and
  strictness modes and fails on any panic;
- the expectation ratchets always gate covered-to-skip and fail-to-skip.

`MissingBytecode` never reaches a sweep verdict, because its helper's result is discarded at
`xst.rs:2692`.
`relink_crank` hands embedders a typed `RelinkError::TableFull`; only the harness and the
compartment path wrap it in `Decode`.
Nothing here is guest-observable: the `ironhorse-xst` host reports the compile refusal by name.

**Evidence:**

The finder's evidence is static, plus Rust-probe output:

```
Static chain, from code read at 61cd656cb: lib.rs:395-421 `compile_for` returns `(Vec::new(), Vec::new(), IronhorseCompile::Panicked(..))` for a caught panic. run_compiled_script (lib.rs:650-671) only short-circuits `Rejected`, so empty bytecode is relinked and run. Dispatch at pc 0 >= len 0 returns `Halt::Decode(ProgramCounterOutOfBounds)` (dispatch.rs:291), or the relink fails into `Halt::Decode(Relink(..))` (lib.rs:671). evaluate_positive (xst.rs:671-679) matches only `run.ironhorse_halt` and returns RunSkip("parse-or-decode").
report::classify(RunSkip, "parse-or-decode") => unsupported (zz_audit_ont_1 CLASSIFY line), versus classify(Fail, "compiler-panicked:parse") => ironhorse-failure.
Sweep: the only 3 parse-or-decode cases are class static-init-scope-* (lib.rs:1249 names them as IronhorseCompile::Unsupported "static block with lexical declarations"). In the same sweep, the compile gap on parse-negative cases is reported as compiler-unimplemented:parse.
Guest-caused Decode: zz_audit_ont_2.rs output: 'CRANK "var someBrandNewIdentifier = 1; someBrandNewIdentifier": relink refused: TableFull', which ironhorse-262 run_compiled_script maps to Halt::Decode(Relink(TableFull)).
```

The code-evidence verifier's probe is `probes/ontology/verify-ont10/zz_audit_ont_1010.rs`:

```
SINGLE compile=Unsupported("line 1: static block with lexical declarations deferred")
SINGLE halt=Decode(ProgramCounterOutOfBounds { pc: 0, len: 0 }) bytecode_len=0
SINGLE oracle_completed=OracleOnlyComplete oracle_result="2"
PHASE 0: compile=Accepted halt=Return
PHASE 1: compile=Unsupported("line 1: static block with lexical declarations deferred") halt=Decode(ProgramCounterOutOfBounds { pc: 0, len: 0 })
SETUP-UNSUPPORTED phases=1 phase0 compile=Unsupported("line 1: static block with lexical declarations deferred") halt=Decode(ProgramCounterOutOfBounds { pc: 0, len: 0 })
CLASSIFY RunSkip "parse-or-decode" => unsupported
CLASSIFY RunSkip "compiler-unimplemented:parse" => unsupported
CLASSIFY Fail "compiler-panicked:parse" => ironhorse-failure
CRANK1 completed=true result="RangeError: property key space exhausted" halt=Return
CRANK2 relink refused: TableFull; harness halt=Decode(Relink(TableFull)) is_panic=true
```

The consequence-and-intent verifier's probe is
`probes/ontology/verify-ont10-intent/static_lex.js`.
It shows that the production script host names the refusal:

```
var p; class C { static { let x = 1; } static { p = 2; } }
if (p !== 2) throw new Error("p=" + p);
InternalError: line 1: static block with lexical declarations deferred
ironhorse exit=1
node exit=0
```

**Recommendation:**

1. **Stop routing compile outcomes through the decoder.**
   - In `evaluate_positive`, the setup path and `classify_run`, check `run.ironhorse_compile`
     first.
   - `Panicked` should give Fail `compiler-panicked:script`.
   - `Unsupported` should give RunSkip `compiler-unimplemented:script`.
2. **Give the module `catch_unwind` arms the same Fail**, as the `Panicked` doc promises.
3. **Remove `DecodeError::MissingBytecode`.** It is the harness's stand-in for "no compile
   happened".
4. **Move `RelinkError::TableFull` out of `DecodeError`.** Put it in the resource/refusal class
   chosen for key-space exhaustion (see ONT-2), and stop mapping it to `InvalidSymbols` at
   `compartment.rs:784-785`.
5. **Treat a residual `Decode` on `ironhorse-compile` output as a Fail**, not a skip.
6. **Fix the contradictory docs** at `lib.rs:182-184` and `test262.rs:153-158`.

**Verification:**

- **Code-evidence verifier (kept medium):**
  - confirmed the empty-bytecode path end to end with a probe;
  - confirmed that the 3 live cases are Unsupported compiles surfacing as `Decode`;
  - confirmed that guest-caused `TableFull` reaches `is_panic` as a decode;
  - found that the same `TableFull` is classified three ways: a catchable `RangeError` in eval
    relink (`link.rs:1269-1271`), `Decode(Relink)` in the harness, and `Decode(InvalidSymbols)`
    in the compartment path;
  - found that `MissingBytecode` never reaches a verdict;
  - added the doc contradictions.
- **Consequence-and-intent verifier (low):**
  - found that the headline consequence is latent and doubly gated, by the totality test and the
    ratchets;
  - found that the live effect is three cases correctly categorized under a wrong label;
  - found that `relink_crank` gives embedders a typed error;
  - found that `Decode`'s `is_panic` membership is a documented open question;
  - noted that the module path's panic-as-gap filing is the strongest evidence of inconsistent
    code.

### ONT-14 — The start compartment's eval/Function and the shared function-family constructors have no home realm and compile against the calling compartment, unlike ECMA-262, XS and SES; ARCHITECTURE.md and compartment.rs still describe the pinned default-realm model, and xs_departures.rs records no departure

**Severity:** low, lowered from medium.
The finder proposed medium. The code-evidence verifier rated it medium; the consequence-and-intent
verifier rated it low.

**Category:** spec-model.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/realm.rs:150`, `:854`, `:855`, `:869`, `:875`.
- `rust/engine/ironhorse-vm/src/interp/invoke.rs:238`.
- `rust/engine/ironhorse-vm/src/interp.rs:845`. This is the doc comment; the field is at `:846`.
- `rust/engine/ironhorse-vm/tests/realms.rs:648`.
- `rust/engine/ARCHITECTURE.md:113`, `:114`, `:115`.
- `rust/engine/ironhorse-vm/src/compartment.rs:15`, `:1220`.
- `rust/engine/ironhorse-runtime/tests/runtime_compile_meter.rs:448`, `:463`.
- `rust/engine/README.md:225`. The "records each deliberate departure" sentence is at `:227`.
- `rust/engine/ironhorse-262/tests/xs_departures.rs:38`.
- `c/moddable/xs/sources/xsLockdown.c:98`.

Added by verifiers:

- `realm.rs:856-859`: claims every compartment is minted a copy; false for start.
- `realm.rs:911-913`.
- `compartment.rs:1222-1224`: already states the correct rule.
- `runtime_compile_meter.rs:354`: the engine's own per-compartment-evaluator rule.
- `designs/ironhorse-ses-compartment-equivalence.md:15-24`, `:689`.
- `c/moddable/xs/sources/xsGlobal.c:329-330` and `xsFunction.c:266-267`.

**Excerpt:**

```
realm.rs:855-876: "// NO evaluator is pinned to the default global environment. ... Pinning it to the default global let a compartment compile against the default realm in both directions ... // Left NULL, `switch_environment` no-ops (`:201-203`) and the dynamic // function is created in whichever environment called for it. That is // the only answer that is not arbitrary here: compartments share one // realm and one frozen intrinsic graph, so a shared evaluator has no // realm of its own to belong to." vs ARCHITECTURE.md:113-115: "`Machine::set_source_compiler` configures the default Realm's evaluator service. Shared dynamic constructors reached through prototype links use that default global; compartment `eval` and `Function` objects are bound to their own globals."; compartment.rs:1220 `/// Configure the default Realm evaluator service, used by shared dynamic constructors.`
```

**Mechanism:**

`compartment_evaluator` (`realm.rs:150-176`) gives each non-default environment its own `eval`,
`Function` and `Compartment`, with `global_env` set to that environment's global.
It does so only once `shared_compartments` is true.
The default (start) environment is linked before that flag is set (`realm.rs:854`; for the guest
path, `natives/compartment.rs:110`), and `realm.rs:850-853` marks every start binding as already
installed.
So the start compartment's global `Function` and `eval` are the shared originals, with a NULL
`global_env`.
`call_native` then runs them in the caller's environment (`invoke.rs:229-238`; the NULL no-op is
at `realm.rs:911-913`).
This holds after `lockdown()` too.

`realm.rs:855-890` deliberately leaves the shared `%GeneratorFunction%`, `%AsyncFunction%` and
`%AsyncGeneratorFunction%` unpinned as well, and so the originals reached through a prototype.

The verifiers split the finding into two parts.

**(a) The start compartment's own bare `eval` and `Function`.**
No document owns this half.

- The comment at `realm.rs:856-859` claims `link_intrinsics` "mints each compartment a copy". That
  is false for start.
- The behaviour breaks the engine's own rule for every other compartment:
  `runtime_compile_meter.rs:354` pins that compartment a's evaluators keep a's global when shared.
- XS and SES both answer "start". XS's `fx_eval` and `fx_Function` fall back to `mxProgram` when
  the home module is NULL (`xsGlobal.c:329-330`, `xsFunction.c:266-267`).

**(b) The shared function-family constructors reached through a prototype.**
This half is a documented decision.

- `designs/ironhorse-ses-compartment-equivalence.md:15-24` says the change "no longer pins any
  evaluator to the default realm, closing a confinement hole", and that "un-pinning remains the
  right answer for every evaluator that stays reachable".
- The same document records it against XS (`:689`).
- `realm.rs:855-890` explains the rule.
- Two tests pin it: `realms.rs:648` and `runtime_compile_meter.rs:463`.
- After native lockdown the prototype route is closed. XS replaces `Function.prototype.constructor`
  (`xsLockdown.c:98-99`), and IronHorse poisons it too, so this half is observable only before
  lockdown.

The documentation is stale in three places:

- `ARCHITECTURE.md:113-115` says prototype-reached constructors use the default global.
- `compartment.rs:15-16` says the default compiler serves shared dynamic constructors.
- The first sentence of `compartment.rs:1220` says the same. Its second paragraph (`:1222-1224`)
  already states the correct rule: "reaches the default realm's environment and no other".

`xs_departures.rs` has no compartment rows at all, although README says every deliberate
departure is recorded.

ECMA-262 alone does not settle the question.
It has no compartments, and IronHorse defines every compartment as one shared Realm
(`compartment.rs:1`).
A program that creates no compartment cannot observe any of this.
The applicable references are XS, the adopted oracle, and SES.

**Consequence:**

For (a), the divergence is observable on the production frozen `Machine::new()` through a purely
guest route.

- START runs `new Compartment({globals:{se: eval}})`, and `se('answer')` in the child returns the
  child's value.
- A `var` run through the endowed start `eval` defines a global on the child, not on start. SES
  evaluates it in the start global.

The consequence is narrow:

- any start-defined wrapper (`function w(s){return (0,eval)(s)}`) restores the start answer on the
  frozen Machine;
- no caller in `rust/endo` or `packages/` endows a bare `eval` or `Function`;
- none of the three Compartment suites exercises it;
- the departure gives the endowed evaluator less authority, not more, so it is not a capability
  escape.

For (b), the only observable effect is before lockdown, through a bare `Interp`,
`Machine::unfrozen_with_start_global_names` or the SES-shim route.
There, `(function(){}).constructor('return x')()` compiles against the child, unlike XS.

An embedder reading `ARCHITECTURE.md:113-115` would believe a compartment can reach the start
global through `({}).constructor.constructor`, when the code deliberately does the opposite.

The `ironhorse-xst` evidence (`c2`, `e4`, `e5`, `p2` and the zzprobe oracle cases) is confounded.
On that bare-`Interp` host, even start-defined functions created before the first
`new Compartment` are caller-homed, which is ONT-30's lead.
The frozen-Machine Rust probes below are the clean evidence for this finding.

**Evidence:** These are the finder's probes, from `probes/ontology/vocabulary/`,
`probes/ontology/spec-model/` and `probes/ontology/doc-model/`:

```
[vocabulary] c2.js (no lockdown): `const F = c.evaluate("(function(){}).constructor"); out.sameObject = F === Function.prototype.constructor; out.outerCallGlobalIsOuter = F("return globalThis")() === globalThis; c.globalThis.F = F; out.innerCallGlobalIsOuter = c.evaluate("F('return globalThis')()") === globalThis;`. ironhorse: `{"sameObject":true,"outerCallGlobalIsOuter":true,"innerCallGlobalIsOuter":false,"outerClosureFromInnerIsOuter":true}`.
e4.js: `globalThis.tag="start"; const c = new Compartment({ globals: { tag: "c", startEval: eval, startFunction: Function } }); out.startEvalCalledFromC = c.evaluate("(0, startEval)('tag')"); out.startFunctionCalledFromC = c.evaluate("startFunction('return tag')()"); out.cEvalCalledFromStart = (0, c.evaluate("eval"))("tag");`. Output: `{"startEvalIsProtoCtorFamily":true,"startEvalCalledFromC":"c","startFunctionCalledFromC":"c","cEvalCalledFromStart":"c"}`. The child's evaluator is homed to the child; the start compartment's is not homed to the start compartment.
e5.js, the same after lockdown(): `{"startFunctionLocal":"start","startEvalCalledFromC":"c","startFunctionCalledFromC":"c","startEvalWritesFromC":"number","leakedOnStart":"undefined"}`.

[spec-model] JS probe ../probes/ontology/spec-model/p2.js:
  globalThis.marker='START'; lockdown();
  const c = new Compartment({ globals: { marker: 'CHILD', startEval: eval, startFunction: Function } });
  r.childEvalOfStartEval = c.evaluate(`startEval('globalThis.marker')`);
  r.childStartFunction = c.evaluate(`startFunction('return globalThis.marker')()`);
  r.childDefinesViaStartEval = c.evaluate(`startEval('var definedByChild = 1'); typeof globalThis.definedByChild`);
  r.startSeesIt = typeof globalThis.definedByChild;
ironhorse-xst: {"startFnIsProtoCtor":false,"childEvalOfStartEval":"CHILD","childStartFunction":"CHILD","childDefinesViaStartEval":"number","startSeesIt":"undefined","startCallsChildEval":"CHILD"}
Oracle probes run with endot-ih --test262-dir $SCRATCH/.../t262:
  zzprobe/start-eval-from-child.js asserts START/START: 'ironhorse failed a harness assertion the oracle passed: Expected SameValue(«CHILD/CHILD», «START/START»)'.
  zzprobe/proto-ctor-from-child.js, before lockdown, (function(){}).constructor and %GeneratorFunction% from a child: 'ironhorse failed a harness assertion the oracle passed: Expected SameValue(«CHILD/CHILD», «START/START»)'.
  zzprobe/direct-eval-in-compartment.js: XS throws 'ReferenceError: get local: undefined variable' because the start eval runs in START, where 'local' is unbound; IronHorse returns the child's 'GLOBAL'.
```

The doc-model finder's dual-run probe is
`probes/ontology/doc-model/t262/test/language/zzprobe/proto-function-realm.js`, run with
`endot-ih --test262-dir <probes>/t262 zzprobe`:

```
var secret = 'start'; var out = [];
var c = new Compartment({ globals: { secret: 'compartment' } });
out.push('own=' + c.evaluate('Function("return secret")()'));
out.push('proto=' + c.evaluate('(function(){}).constructor("return secret")()'));
out.push('protoIsOwn=' + c.evaluate('(function(){}).constructor === Function'));
c.evaluate('(function(){}).constructor("leaked = 1")()');
out.push('leakedInStart=' + (typeof leaked));
out.push('leakedInC=' + c.evaluate('typeof leaked'));
throw new Test262Error(out.join(' '));
```

```
Observed: `abort-value-differs: oracle="Test262Error: own=compartment proto=start protoIsOwn=false leakedInStart=number leakedInC=undefined" ironhorse="Test262Error: own=compartment proto=compartment protoIsOwn=false leakedInStart=undefined leakedInC=number"`. With `--ses-mode l` the case does not diverge: both engines throw the same way. The repo pins the IronHorse behavior in runtime_compile_meter.rs:463-498 (`shared_dynamic_constructors_use_the_calling_compartments_evaluator_service`: `(()=>{}).constructor('return answer')()` in compartment a returns a's 42 while start keeps 17). `grep -i compartment ironhorse-262/tests/xs_departures.rs` finds no rows.
```

The code-evidence verifier ran a Rust probe on the production frozen `Machine::new()`,
`probes/ontology/verify-ont14/zz_audit_ont_14.rs`.
It mirrors `runtime_compile_meter.rs:354` with the start compartment added as a source:

```
frozen: true
from b: evalS=99 FunctionS=99 evalA=42 FunctionA=42
b var via evalS: number
start sees it: undefined
start eval is proto ctor: false
```

Compartment a's evaluators keep a's global (42), while the start compartment's take the caller's
global (99).
The same verifier ran the SES reference under Node, `probes/ontology/verify-ont14/ses_node2.mjs`:

```
SES output: {"evalType":"function","inC":"function","startEvalCalledFromC":"start","startFunctionCalledFromC":"start","startEvalWritesFromC":"undefined","leakedOnStart":"number","cEvalCalledFromStart":"c"}
```

The consequence-and-intent verifier's probe,
`probes/ontology/verify-ont14-consequence/zz_audit_ont_141.rs`, also runs on a frozen
`Machine::new()`:

```
frozen: true
host-endowed, from b: bare eval=99 bare Function=99 wrapped eval=17 wrapped Function=17 map(eval)=99
pump: Return
job result in b: 99
guest route: bare eval=5 bare Function=5 wrapped=17
```

**Recommendation:**

1. **Home the start evaluators.** Give the start environment an explicit home for its
   evaluators. Either set `global_env = default_global` for the default environment's `eval` and
   `Function`, or mint them through `compartment_evaluator` as for the other environments. That
   matches XS, SES and the engine's own per-compartment-evaluator rule. It also closes ONT-5 on
   frozen machines.
2. **Keep the shared constructors caller-homed.** Homing them to the default global would reopen
   the pre-lockdown route into the start global that the design deliberately closed.
3. **Correct the stale prose.** Fix `ARCHITECTURE.md:113-115`, `compartment.rs:15-16`, the first
   sentence of `compartment.rs:1220`, and `realm.rs:856-859`.
4. **Record the departures.** Add rows for the compartment departures. `xs_departures.rs`
   currently has none, so this is a scope gap in the ledger, not a row omitted from a covered
   area.
5. **Make "home" a type.** Replace the NULL sentinel in `FuncInfo`, `CallerState` and
   `SavedFrame` with an explicit type, for example
   `enum Home { Environment(EnvironmentId), RealmDefault }`, so that "ambient" cannot be
   expressed (see ONT-30).

**Verification:**

- **Code-evidence verifier: medium.**
  - Confirmed the linking order, the NULL homes, the stale docs and the absent departure row.
  - Re-ran every cited probe and confirmed the oracle failures with and without native lockdown.
  - Added the SES reference under Node (start/start).
  - Added a frozen-Machine Rust probe showing the start evaluators alone take the caller's
    global.
  - Noted that the prototype-route half is owned by the design, that
    `compartment.rs:1222-1224` already corrects its own first sentence, and that the departure
    gives less authority, not more.
- **Consequence-and-intent verifier: low.**
  - Rejected ECMA-262 as grounds, because there are no compartments in the spec.
  - Showed that the shared-constructor half is a documented decision that cannot be observed
    after lockdown.
  - Confirmed that the start-evaluator half is unowned and guest-observable on the frozen Machine,
    but narrow: wrappers fix it, there are no in-repo callers, and no suite coverage exists.
  - Showed that the `xst` evidence is confounded by the bare-`Interp` host.
  - Withdrew the recommendation to home the shared constructors.

### ONT-16 — Guest Compartment.prototype.evaluate is a strict eval program, not the Script its doc and the adopted XS model say: top-level var/function/let vanish

**Severity:** low, lowered from medium. The finder proposed medium, the code-evidence verifier
rated it medium, and the consequence-and-intent verifier rated it low.

**Category:** spec-model.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:396`. The doc comment starts at
  `:395`; `:396` holds the word "Script".
- `rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:412`.
- `designs/ironhorse-guest-compartment.md:187`.

Added by verifiers:

- `designs/ironhorse-guest-compartment.md:320-323`, `:707`, `:907-909`.
- `rust/engine/ironhorse-vm/src/compartment.rs:631`, `:638-645` (the host evaluate path).
- `rust/engine/ironhorse-vm/tests/realms.rs:23-24`.
- `rust/engine/ironhorse-compile/src/coder.rs:1103-1105`, `:1524`.
- `c/moddable/xs/sources/xsModule.c:3170`.
- `packages/ses/src/make-evaluate.js:93-101`.

**Excerpt:**

```
/// `Compartment.prototype.evaluate(source)`: compile and run `source` as a
/// Script in the receiver's environment.
...
let result = self.eval_source(&units, true);
```

**Mechanism:** `compartment_evaluate` runs the source through `eval_source` with `strict = true`.
That calls `compile_eval_units` (`ironhorse-runtime/src/lib.rs:107-124`), which compiles with
`Goal::Eval` (`coder.rs:1524`).

Under ECMA-262 19.2.1.3 EvalDeclarationInstantiation, a strict eval program gets its own variable
environment.
Its `var` and function declarations and its lexical declarations are therefore local to that one
evaluation.
The compiler's own doc states the difference: for a strict program, "the Script goal hoists the
declaration to the global object where the eval goal keeps it a frame local" (`coder.rs:1103-1105`).

XS's evaluate is `fxRunScript` with `mxStrictFlag | mxProgramFlag` against the realm global and
the realm closures (`xsModule.c:3170`).
A top-level `var` or function there becomes a non-configurable property of the compartment
global, and a `let` persists in the realm closures.

`designs/ironhorse-guest-compartment.md:187` records "Decision: build XS's Compartment".
The doc comment says "Script", and the design (`:320-323`) says the guest method is "the same
operation" as the host `Compartment::evaluate` path.
That host path really is a Script that retains globals (`compartment.rs:631`, pinned by
`realms.rs:23-24`).
So "evaluate" names two different operations in this engine.

The implementation instead matches SES's strict direct `eval` inside `with` scopes
(`make-evaluate.js:93-101`).
The design notices the behaviour only in passing (`:907-909`: "declarations become frame locals
that shadow correctly").
It is not in the oracle-divergence table that `:707` says every such divergence must enter.
Strict mode itself is correct, and both engines agree on strictness.

**Consequence:** Guests can see the difference, and the XS oracle disagrees.

- `c.evaluate('var v = 1; function f() {}')` creates no global `v` or `f`, and a later
  `c.evaluate('typeof v')` returns `'undefined'`.
- A helper declared in one `evaluate` and called from the next one throws `ReferenceError`; XS
  returns the helper's value.

IronHorse's answers are byte-identical to an emulation of SES's evaluator on Node.
HardenedJS code that is portable to SES therefore cannot depend on declarations persisting, and is
unaffected.
Only programs written for XS's Script semantics are affected; no in-repo caller was found.
The common failure is a loud `ReferenceError`; only `typeof` and descriptor reflection give a
quiet wrong answer.
No hardened262 case, Rust test or harness script declares a binding in one evaluate and reads it in
another, so nothing catches the divergence.

**Evidence:** These are the finder's oracle probes, from `probes/ontology/spec-model/t262/`:

```
Oracle zzprobe/evaluate-var-configurable.js:
  const c = new Compartment(); c.evaluate('var v = 1; function f() {}');
  dv/df = getOwnPropertyDescriptor(c.globalThis, 'v'/'f'); thisIsGlobal = c.evaluate('this') === c.globalThis; later = c.evaluate('typeof v');
  assert JSON.stringify([dv && dv.configurable, df && df.configurable, thisIsGlobal, later]) === '[false,false,true,"number"]'
Result: 'ironhorse failed a harness assertion the oracle passed: Expected SameValue(«[null,null,true,"undefined"]», «[false,false,true,"number"]»)'.
Oracle zzprobe/evaluate-script-lexicals.js: c.evaluate('let cl = 5'); c.evaluate('typeof cl'), then redeclaring. Result: 'ironhorse failed a harness assertion the oracle passed: Expected SameValue(«undefined/ok», «number/SyntaxError»)'.
```

The code-evidence verifier's six test262-shaped cases are in `probes/ontology/verify-ont16/`.
The "converse" cases assert IronHorse's eval-local answer, so they fail on the oracle:

```
endot-ih: total=6 covered=1 failed=5
language/zzv16/v16-func-across.js
  ironhorse failed a harness assertion the oracle passed: Test262Error: Expected SameValue(«ReferenceError», «7») to be true
language/zzv16/v16-let-eval-model.js
  over-acceptance: ironhorse completed a source the oracle rejected: Test262Error: Expected SameValue(«number/SyntaxError», «undefined/ok») to be true
language/zzv16/v16-let-xs-model.js
  ironhorse failed a harness assertion the oracle passed: Test262Error: Expected SameValue(«undefined/ok», «number/SyntaxError») to be true
language/zzv16/v16-var-eval-model.js
  over-acceptance: ironhorse completed a source the oracle rejected: Test262Error: Expected SameValue(«[false,false,true,"number"]», «[null,null,true,"undefined"]») to be true
language/zzv16/v16-var-xs-model.js
  ironhorse failed a harness assertion the oracle passed: Test262Error: Expected SameValue(«[null,null,true,"undefined"]», «[false,false,true,"number"]») to be true
```

The consequence-and-intent verifier's probes are in `probes/ontology/verify2-ont16/`.
`direct.js` on `ironhorse-xst` and `ses-shape-node.cjs` (an SES-shaped evaluator on Node) printed
the same output:

```
ironhorse-xst: Error: ["0","undefined","undefined","undefined","ReferenceError","","split:ReferenceError"]
SES-shaped evaluator on node: ["0","undefined","undefined","undefined","ReferenceError","","split:ReferenceError"]
```

**Recommendation:**

1. **Decide which model `evaluate` implements**, and state the decision in one place.
2. **If the SES semantics stay**, which is cheaper and matches the project's precedent in
   `designs/ironhorse-native-lockdown.md` ("Open by decision" rows):
   - add the row to the oracle-divergence table;
   - fix the word "Script" at `natives/compartment.rs:395-396` and in
     `designs/ironhorse-guest-compartment.md:320-323`.
3. **If evaluate should follow the adopted XS model instead**, run it as a Script in the
   compartment's environment. That depends on ONT-15's declarative record. Keep strict mode.
4. **In either case**, add a corpus case that pins the chosen answer, flagged for the XS/SES
   split.

**Verification:**

- **Code-evidence verifier (medium).**
  - Followed the compile path to `Goal::Eval`, and confirmed from `xsModule.c:3170` that XS runs a
    strict Script.
  - Found that the design has no row for the divergence.
  - Confirmed that the hardened262 corpus has no cross-evaluate declaration case.
  - Re-ran the oracle probes in both directions: the converse probes fail on the oracle and pass
    on IronHorse.
  - Confirmed that strictness agrees between the engines, so the goal is the only difference.
- **Consequence-and-intent verifier (low).**
  - Showed that IronHorse matches an SES evaluator byte for byte, so SES-portable code is
    unaffected.
  - Noted that the common failure is loud.
  - Recast the defect as an unrecorded oracle divergence plus a homonym: the host and guest
    "evaluate" disagree, while the design says they are the same operation.
  - Rated it low as documentation drift and maintainability.

### ONT-20 — No persisted identifier covers guest-visible engine semantics: SIGN/METR accept a heap across native or in-tree Intl behaviour changes, and INTL_DATA_VERSION, documented as identifying the in-tree Intl profile, hashes only the ICU lockfile graph

**Severity:** low, lowered from medium. The finder proposed medium, and the code-evidence verifier
rated it low. The consequence-and-intent pass did not run, because the code-evidence verifier
already rated the finding low.

**Category:** identity-versioning.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/boot.rs:115`, `:157`, `:2097`
- `rust/engine/scripts/intl-profile.py:20`, `:50`. The return statement quoted below is at `:52`.
- `rust/engine/ironhorse-vm/src/intl_profile.rs:2`
- `rust/engine/DETERMINISM-METERING.md:128`
- `rust/engine/ARCHITECTURE.md:389`
- `rust/engine/ironhorse-snapshot/src/versions.rs:58`, `:65`, `:69`
- `rust/engine/ironhorse-meter/src/lib.rs:6`
- Added by the verifier:
  - `versions.rs:70-72` and `:80-82`
  - `DETERMINISM-METERING.md:125-126`
  - `rust/engine/ironhorse-snapshot/src/format.rs:443-452` (`Signature::check_boot`)
  - `.github/workflows/ci.yml:757`
  - `designs/ironhorse-engine.md:577-579`
  - `designs/ironhorse-snapshot-store-seam.md:3089`
  - `rust/endo/src/ironhorse_engine.rs:860-864`

**Excerpt:**

```
versions.rs:62-67: "so a snapshot written before resumes after with a matching boot fingerprint and a different answer for the same program. The fingerprint does not move because INTL_DATA_VERSION binds the ICU DEPENDENCY graph and these tables are ours"
intl-profile.py:52: return "ironhorse-intl-2026a" if digest == BASELINE else f"ironhorse-intl-2026a:{digest}"
ARCHITECTURE.md:389: "`INTL_DATA_VERSION` ... Identifies the in-tree Intl profile plus the locked ICU dependency graph ... The label participates in the boot fingerprint and therefore the persisted SIGN gate."
```

**Mechanism:**

Endo and the docs treat the persisted identity as the engine identity.
That identity is made of five parts:

- the meter release name and digest;
- the boot fingerprint;
- the format version;
- the store version;
- the row version.

`derive_boot_fingerprint` (`boot.rs:115`) hashes only a freshly booted heap: slot Debug strings,
chunk bytes, `FuncInfo` (including native variant names), the proto tables and the key-order
tables.
It does not hash native code, link-time install policy or the in-tree locale tables.
`Signature::check_boot` (`format.rs:443-452`) compares only that digest.

`INTL_DATA_VERSION` is generated by `intl-profile.py::fingerprint` (`:20-48`).
It is computed from the `Cargo.lock` package records reachable from the `icu_*` roots alone
(`intl_profile.rs:2`: "Locked ICU dependency graph").
So it covers none of the in-tree locale tables or Intl algorithms, although `ARCHITECTURE.md:389`
says it identifies "the in-tree Intl profile".

`identity()` can emit only the BASELINE alias or a digest suffix.
CI rejects any `intl_profile.rs` that differs from the generated text (`ci.yml:757`).
`DETERMINISM-METERING.md:127-128` requires a "deliberate profile release" for in-tree locale,
calendar or zone changes, but no mechanism produces one short of changing the generator.

The label reaches the fingerprint only indirectly.
It is the string value of the guest-visible debug property `Intl.__ironhorseDataVersion` in
`proto_data` (`boot.rs:2095-2099`), which `boot.rs:157` hashes.
`versions.rs:70` is accurate that the fingerprint hashes the label.
Its conclusion at `:71-72` ("SIGN therefore refuses incompatible profiles before execution") is
false for in-tree changes.
So are `ARCHITECTURE.md:389` and `DETERMINISM-METERING.md:125-126`.

The project has decided that execution determinism is scoped "per release binary per platform"
(`versions.rs:80-82`, `designs/ironhorse-engine.md:577-579`,
`designs/ironhorse-snapshot-store-seam.md:3089`).
`HeapStoreOptions` promises refusal only for an incompatible host or engine layout
(`rust/endo/src/ironhorse_engine.rs:860-864`).
So the broader claim, that no identifier covers native semantics, is documented scope.
`versions.rs:56` and `:66-67` reserve in-tree table changes "for review rather than for
automation".

**Consequence:**

Two binaries whose guest-visible Intl behaviour differs carry identical identities.
The project has already recorded one such case, Intl compact notation (`12,345` becoming `12K`):
"a snapshot written before resumes after with a matching boot fingerprint and a different answer
for the same program" (`versions.rs:62-67`).
The verifier repeated that event with a one-character edit to an in-tree CLDR affix: the guest
output changed, and the boot fingerprint, meter name and meter digest stayed byte-identical.

An operator trusting the ARCHITECTURE table expects SIGN to refuse resuming across an Intl data
change; only a manual release review catches one.
Removing the non-standard `Intl.__ironhorseDataVersion` property would silently drop Intl identity
from the fingerprint.
Replicas running different binaries are outside the supported configuration, so this is
documentation and compatibility-gate drift with a recorded consequence, not replica divergence in
a supported setup.

**Evidence:**

The finder's evidence, from `probes/ontology/identity/` and static reading:

```
[identity] Probe zz_audit_ont_4.rs was built twice: in a copy of 61cd656c with aaec6a06's VM diff reverted (date.rs, json.rs, keys.rs, halt_labels.rs; diff in probes/ontology/identity/aaec6a06-revert.patch), and in the repo. The old build writes a crank-1 snapshot ("var d = 0; 0"). The new build reads it with from_snapshot_bytes.
Output:
[old] boot_fingerprint=d3068e26f51f0ad6 meter=ironhorse-meter-9 digest=4d9abebe68c732f0 format=26 store=38 row=6
[old] wrote 46276 bytes
[new] boot_fingerprint=d3068e26f51f0ad6 meter=ironhorse-meter-9 digest=4d9abebe68c732f0 format=26 store=38 row=6
[new] ADOPTED the old build's snapshot
So every identifier is blind to a VM source change. That particular change turned out to be behavior-neutral; see ONT-4. The behavior-changing case is the project's own record at versions.rs:58-68.
xst probe i01: [Intl.__ironhorseDataVersion, compact 12345, ...] -> ["ironhorse-intl-2026a","12K",...]; node -> [null,"12K",...].
xst probe i02: the property is an own, writable, configurable, non-enumerable data property of Intl; node has none.
Static: derive_boot_fingerprint has no term for code, native semantics or INTL_DATA_VERSION apart from the proto_data Debug string.

[doc-model] static: intl-profile.py:20-48 (fingerprint over lockfile records only); intl_profile.rs:2 ("Locked ICU dependency graph (versions, checksums, edges and root features)"); versions.rs:58-68 (release review, 2026-09-16).
```

The finder's "old"/"new" probe is weak evidence for two reasons.
First, its "behavior-neutral" remark is contradicted by ONT-4's refutation, which found that
`aaec6a06` does change guest-visible behaviour: a later crank's first `JSON.stringify` of a Date.
Second, that probe was built in the shared target directory, where the copy and the repository
alias one artifact (see Method), so "old" and "new" may have linked the same build.
The verifier's probe below does not depend on it.

The verifier's probe is `probes/ontology/verify-ont20/zz_audit_ont_20.rs`.
It ran first in the repository, then in a tar copy of `rust/engine` with one edit
(`sed -i '825s/=> "K",/=> "k",/' ironhorse-vm/src/intl_number.rs`):

```rust
use ironhorse_vm::{parse_symbols, Interp};
fn evaluate(source: &str) -> String { let (code, names) = ironhorse_compile::compile_atoms(source).unwrap(); let mut vm = Interp::new(); vm.link_intrinsics(&parse_symbols(&names)); let result = vm.run(&code); assert!(result.completed, "{:?}", result.halt); result.result }
#[test] fn zz_audit_ont_20() {
  let boot = Interp::boot_fingerprint(); let hex: String = boot.iter().map(|b| format!("{b:02x}")).collect();
  let digest: String = ironhorse_vm::cost_table::digest().iter().map(|b| format!("{b:02x}")).collect();
  println!("boot_fingerprint={hex} meter={} digest={} provider={}", ironhorse_vm::COST_TABLE_VERSION, &digest[..16], ironhorse_vm::MATH_PROVIDER);
  println!("guest: {}", evaluate("[Intl.__ironhorseDataVersion, new Intl.NumberFormat('en',{notation:'compact'}).format(12345)].join('|')"));
}
```

```
repository:
boot_fingerprint=d3068e26f51f0ad62c62c9803e7740d403586d70943951ec008112480710b78d meter=ironhorse-meter-9 digest=4d9abebe68c732f0 provider=platform
guest: ironhorse-intl-2026a|12K
mutated copy:
boot_fingerprint=d3068e26f51f0ad62c62c9803e7740d403586d70943951ec008112480710b78d meter=ironhorse-meter-9 digest=4d9abebe68c732f0 provider=platform
guest: ironhorse-intl-2026a|12k
```

**Recommendation:**

1. **Fix the over-claiming sentences.** These are `ARCHITECTURE.md:389`, `versions.rs:71-72` and
   `DETERMINISM-METERING.md:125-126`. At minimum, say that the label covers only the ICU
   dependency graph until the identity is extended.
2. **Give the in-tree profile a real input.** Either add to `intl-profile.py` a digest of the
   in-tree locale, calendar and zone tables (and the Intl source), or give it a manual release
   suffix. Alternatively, reword "profile release" in `DETERMINISM-METERING.md:128` as "release
   review".
3. **Hash `INTL_DATA_VERSION` as its own fingerprint term** rather than through a debug property.
4. **Optionally, add an engine-semantics release identifier.** Hash it into the SIGN boot term next
   to `MATH_PROVIDER`, and bump it, or the meter release, on guest-visible behaviour changes. This
   is a design trade-off, not a fix: it would refuse heaps on every behaviour fix, and
   mixed-binary replicas are outside the documented scope.

**Verification:**

- **Code-evidence verifier (low).** It confirmed the following:
  - the fingerprint has no term for native code or in-tree Intl tables;
  - the label is hashed only through the `proto_data` debug property, which stays populated after
    boot;
  - `intl-profile.py` reads only lockfile records, and CI rejects hand edits;
  - `check_boot` compares only the boot digest;
  - the three sentences contradict the release record eight lines above them in `versions.rs`.
- **Its own probe.** It reproduced the recorded event with a one-character in-tree edit under
  byte-identical identities.
- **Why it lowered the severity.** The "no identifier covers native semantics" half is documented
  scope, per-binary determinism. The in-tree Intl changes are deliberately reserved for review.
  "Cannot be produced" is overstated, since a change to `identity()` would produce a release.

### ONT-22 — ROW_SCHEMA_VERSION's gate fingerprints only snapshot_rows.rs and intl_data.rs while 10-13 public capture/restore rows are bare tuples in persist.rs/restore.rs; format 26 already added a field to the ArrayBuffers row as 'encoding-only' with no row release

**Severity:** low, lowered from medium. The finder proposed medium; the code-evidence verifier
rated it low.

**Category:** identity-versioning.

**Locations:**

- `rust/engine/ironhorse-vm/src/snapshot_api.rs:3`, `:11`
- `rust/engine/ARCHITECTURE.md:150`, `:388`
- `rust/engine/ironhorse-snapshot/tests/row_schema.rs:60`, `:64`
- `rust/engine/ironhorse-vm/src/interp/restore.rs:394`, `:403`, `:545`
- `rust/engine/ironhorse-vm/src/interp/persist.rs:983`
- `rust/engine/ironhorse-snapshot/src/versions.rs:43`
- `rust/engine/ironhorse-vm/src/interp/snapshot_rows.rs:6`
- `rust/engine/ironhorse-snapshot/tests/fixtures/row_schema_releases.tsv:7`

Added by the verifier:

- `rust/engine/ironhorse-vm/src/interp.rs:1171`: `VIEW_LENGTH_TRACKING`, a public row constant
  outside the fingerprint.
- `row_schema.rs:18-21`: the gate's own rationale for fingerprinting `pub const`.
- `rust/engine/ironhorse-snapshot/src/image.rs:268-274`, `:1857-1860`, `:1861-1926`: the wire row
  and its codec.
- `rust/engine/ARCHITECTURE.md:386-388`.

**Excerpt:**

```
snapshot_api.rs:3-6: "Field additions, removals, order or type changes require a row-schema release and corresponding container/store versions."  versions.rs:43-47: "Container format 26 and store schema 37 → 38 are an encoding-only release within row release 6: the buffer and view rows gain a resizable buffer's maximum and the length-tracking view sentinel"  persist.rs:983: `pub fn array_buffers_snapshot(&self) -> Vec<(u32, u32, u32, u8, u32)>`  restore.rs:403-406: `pub fn restore_typed_array_family(&mut self, buffers: Vec<(u32, u32, u32, u8, u32)>, views: Vec<(u32, u8, u32, u32, u32)>, data_views: Vec<(u32, u32, u32, u32)>)`
```

**Mechanism:**

The documented "capture/restore row contract" covers everything that `RestoreSession` and the
`*_snapshot` methods exchange.
The gate meant to enforce it is `tests/row_schema.rs:60-66` together with
`scripts/check-row-schema.py`.
It hashes only `interp/snapshot_rows.rs` and `interp/intl_data.rs`.

Three of the rows have `pub type` aliases in `snapshot_rows.rs` and so are covered:
`ArraySnapshot`, `IndexPropsSnapshot` and `CollectionSnapshot`.
The rows for the following are anonymous tuples in `persist.rs` and `restore.rs`, which the gate
never sees:

- errors, array buffers, typed arrays, data views;
- wrappers, regexps, dates;
- Temporal instants, durations, plains and zoneds;
- symbol-key pairs and the symbol registry.

The tuple-returning capture methods are at `persist.rs:926`, `983`, `1009`, `1031`, `1200`,
`1250`, `1495`, `3735` and `4324`.
`restore.rs:394-441`, `545-557`, `571-575` and `588-594` take the matching tuples.

Format 26 changed two of these rows:

- it added a fifth field (`max_length`) to the ArrayBuffers row;
- it gave the TARR/DVIW lengths a sentinel meaning, `VIEW_LENGTH_TRACKING` at `interp.rs:1171`.
  That is a public constant outside the fingerprint, which contradicts the gate's own reason for
  fingerprinting `pub const` (`row_schema.rs:18-21`: "renumbering one silently changes every
  stored row's meaning").

`ROW_SCHEMA_VERSION` stayed 6, and the ledger still records row 6 as format 25, store 37.
The project's own documents therefore classify one change two ways.
`snapshot_api.rs:3-5` says a field addition needs a row release.
`versions.rs:43-46` calls this one "encoding-only".

**Consequence:**

`ROW_SCHEMA_VERSION` 6 names two incompatible ArrayBuffers row shapes and two signatures of
`restore_typed_array_family`.
The row ledger therefore does not identify the capture/restore contract for those rows.
A future change to any tuple row (dates, regexp) passes the row gate and the CI ledger check.
It is then forced only by a hand bump or a populated golden, not by the "advance both wire
versions" step that the ledger and `check-row-schema.py` exist to force.

Three things keep the harm small:

- **No consumer keys on `ROW_SCHEMA_VERSION`.** Only `row_schema.rs` and
  `check-row-schema.py` read it, so the finder's harm to surgery and migration tools is
  hypothetical.
- **The wire was never under this gate.** The wire row is `BufferImage` and its codec in
  `image.rs`, which is not fingerprinted either. Format 26 bumped both wire versions by hand.
- **The format-26 encoding is backward-compatible.** `max_length` is written only when flag bit 2
  is set ("a table with no resizable buffer encodes exactly as format 25 did", `image.rs:1859-1860`),
  and decode refuses unknown flag bits.

There is no persistence or compatibility hole, and the `state_golden` byte vectors would see an
encoding change.

**Evidence:**

From the finder (static, plus one test run):

```
[identity] `cargo test -p ironhorse-snapshot --test row_schema` -> ok (2 passed) at HEAD, with ledger tail `6	25	37	fd8f0073...`, IRONHORSE_FORMAT_VERSION=26 and STORE_SCHEMA_VERSION=38. Static: row_schema.rs:60-66 include_str! only the two files; persist.rs:926, 983, 1009, 1031, 1200, 1250, 1347, 1495, 3735 and 4324 declare tuple rows.

[doc-model] static: row_schema.rs:60-66 builds the fingerprint from `include_str!("../../ironhorse-vm/src/interp/snapshot_rows.rs")` and `include_str!("../../ironhorse-vm/src/interp/intl_data.rs")` only. `grep 'pub fn [a-z_]*(&self) -> Vec<(' persist.rs` lists 8 tuple-returning capture methods (errors_snapshot:926, array_buffers_snapshot:983, typed_arrays_snapshot:1009, data_views_snapshot:1031, wrappers_snapshot:1200, regexps_snapshot:1250, dates_snapshot:1495, symbol_registry_snapshot:4324). restore.rs:394-441, 545-557, 571-575 and 588-594 take the matching tuples. The ledger (tests/fixtures/row_schema_releases.tsv) records row 6 at format 25 / store 37, and the code is at format 26 / store 38 with a 5-tuple buffer row.
```

The verifier's probe, `probes/ontology/ont22-verify/probe.sh`, produced:

```
60:    let mut schema = declarations(include_str!(   [snapshot_rows.rs]
64:    schema.push_str(&declarations(include_str!(   [intl_data.rs]
68:    let ledger = include_str!("fixtures/row_schema_releases.tsv");
u32, u32, u32, u8, u32: 0
u32, u8, u32, u32, u32: 0
u32, u64): 0
u32, i128: 0
Vec<u8>, u32: 0
ironhorse-vm/src/interp.rs:1171:pub const VIEW_LENGTH_TRACKING: u32 = u32::MAX;
6	25	37	fd8f0073a1293be23cccca2f44db5be5b6888165976363e05f186f80cb6cf6d6
246:pub const IRONHORSE_FORMAT_VERSION: u32 = 26;
128:pub const STORE_SCHEMA_VERSION: u32 = 38;
11:pub const ROW_SCHEMA_VERSION: u32 = 6;
consumers: scripts/check-row-schema.py, ironhorse-vm/src/snapshot_api.rs, ironhorse-snapshot/src/versions.rs, ironhorse-snapshot/tests/row_schema.rs
386:| `IRONHORSE_FORMAT_VERSION` | Snapshot `format.rs`: 24 ...
387:| `STORE_SCHEMA_VERSION` | Snapshot `store.rs`: 36 ...
388:| `ROW_SCHEMA_VERSION` | VM `snapshot_api.rs`: 5 ...
```

The `persist.rs:1347` site in the finder's list (`arguments_brands_snapshot`) returns `Vec<u32>`,
not a tuple.
Counts of "13 tuple row types" hold only if the native-names pair is excluded.

**Recommendation:**

1. **Name every row.** Give every capture/restore row a named `pub struct` or `pub type` in
   `snapshot_rows.rs`, so the fingerprint covers it.
2. **Use the names.** Change the `persist.rs` and `restore.rs` signatures to use those names, or
   fingerprint the capture and restore signatures too.
3. **Bring `VIEW_LENGTH_TRACKING` inside the fingerprint.**
4. **Resolve the format-26 question.** Either declare format 26 row release 7 in the ledger, or
   document precisely why a field addition or a new sentinel meaning counts as "encoding-only".
   The latter is defensible here, given the backward-compatible encoding.

**Verification:** The code-evidence verifier:

- re-ran the gate (2 passed) and confirmed that none of the tuple shapes appears in either
  fingerprinted file;
- confirmed the doc contradiction between `snapshot_api.rs:3-5` and `versions.rs:43-46`;
- found `VIEW_LENGTH_TRACKING` outside the fingerprint and the stale ARCHITECTURE table (ONT-31);
- lowered the severity to low, because no consumer keys on `ROW_SCHEMA_VERSION`, the wire encoding
  is a backward-compatible extension that format 26 bumped by hand, and goldens would catch
  encoding changes;
- dropped the claim about surgery and migration tools;
- noted that a shallow checkout prevented viewing the pre-26 four-tuple directly.

### ONT-23 — 'completed' / 'crank' means 'END reached and job queue drained' in the docs, but Compartment evaluation reports completed=true and is_quiescent()=true with promise jobs still pending

**Severity:** low (proposed low; verifier low).

**Category:** synonym-homonym.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp.rs:1898`, `:3170`
- `rust/engine/ironhorse-vm/src/interp/persist.rs:4517`
- `rust/engine/ARCHITECTURE.md:99`

Added by the verifier:

- `interp.rs:2882`, `:2886-2895`, `:3163-3165`, `:3242`
- `rust/engine/ironhorse-vm/src/interp/state.rs:1592-1597`, `:2925`
- `rust/engine/ironhorse-vm/src/interp/boundary.rs:64-66`
- `rust/engine/ironhorse-vm/src/compartment.rs:631-632`, `:644`, `:712`, `:1314-1338`
- `rust/endo/src/ironhorse_engine.rs:762-768`, `:1489-1497`
- `rust/engine/ironhorse-262/src/lib.rs:667`, `:1134-1162`

**Excerpt:**

```
interp.rs:1898-1900 `/// true if the program completed normally: the dispatch reached END and the job queue drained. ... agrees with Interp::is_quiescent by construction.`; persist.rs:4517-4519 `the last_crank_completed latch: the most recent crank ran to its own END and drained its job queue.`; interp.rs:3170 `let completed = halt == Halt::Return;`
```

**Mechanism:**

The engine has two kinds of crank.

- **Pumping:** `run`, `run_shared` (`run_operation(.., true, true, ..)`, `interp.rs:2882`),
  `run_promise_jobs`, and the Machine-level crank
  `evaluate_compartment_with_symbols_continuing_meter_shared` (`compartment.rs:1319-1338`). These
  drain the job queue.
- **Non-pumping:** `run_script_shared` (`interp.rs:2889`), which every `Compartment::evaluate*`
  method uses (`compartment.rs:644`, `:712`). It never drains the queue, as
  `ARCHITECTURE.md:99` and `compartment.rs:631-632` state.

Both kinds compute the completion flag and the quiescence latch the same way:
`halt == Halt::Return` (`interp.rs:3170`), then `last_crank_completed = completed` (`:3242`).
Several docs say this flag means "job queue drained":

- `RunOutcome.completed` (`interp.rs:1898-1901`);
- the comment in `run_inner` (`interp.rs:3163-3165`);
- the `last_crank_completed` field doc (`state.rs:1592-1597`);
- the `is_quiescent` doc (`persist.rs:4517-4520`).

That meaning holds only for the pumping kind.
The `RunOutcome` doc also claims `completed` "agrees with Interp::is_quiescent by construction".
On a standalone `Interp`, `run_script_shared` with a queued reaction falsifies that claim.

The finder also named the Endo seam's `EvalOutcome.completed` as an instance.
It is not one: the seam calls the pumping Machine-level crank, so its doc is accurate.

**Consequence:**

The docs promise a guarantee to anyone who reads `completed` or `is_quiescent()` as "this crank's
microtasks ran", and the non-pumping entry points do not give it.
Their effects appear only after a later explicit pump, so observable state depends on which entry
point was used.

The consequence stops at the docs:

- **No persistence hole.** In shared-compartment mode quiescence deliberately admits queued jobs
  (`boundary.rs:64-66`), and `promise_jobs` is a serialized snapshot table (`state.rs:2925`).
- **No in-tree host is misled.** The non-pumping entry points say so in their own docs, and
  `has_pending_jobs()` (`interp.rs:2892-2895`) already exists and is documented as "distinct from
  quiescence".
- **The non-test callers of the non-pumping path are harmless.** `ironhorse-262`'s `run_setup`
  (`lib.rs:667`) is deliberate. `compartment_dual_run` (`lib.rs:1148`) has no callers.

**Evidence:** The finder's Rust probe:

```
Rust probe zz_audit_ont_3.rs (ironhorse-vm, deleted after the run): `eval(&start, "globalThis.x = 0; Promise.resolve().then(() => { globalThis.x = 1; }); 'done'")`, then `m.with_persistence(|i| i.is_quiescent())`, read x, `m.run_promise_jobs()`, read x. Output:
`completed=true halt=Return result="done"`
`is_quiescent after completed crank = true`
`x before pump = 0`
`run_promise_jobs completed=true`
`x after pump = 1`
```

The verifier's probe is `probes/ontology/ont23-verify/zz_audit_ont_923.rs`:

```rust
use ironhorse_vm::{parse_symbols, Interp, Machine};
const SRC: &str = "globalThis.x = 0; Promise.resolve().then(() => { globalThis.x = 1; }); 'done'";
#[test]
fn ont23_verify() {
    let (code, symbols) = ironhorse_compile::compile_atoms(SRC).unwrap();
    let (rcode, rsyms) = ironhorse_compile::compile_atoms("globalThis.x").unwrap();
    // A: Compartment-level evaluate
    let m = Machine::new(); let start = m.start_compartment();
    let o = start.evaluate_with_symbols(&code, &symbols);
    println!("A compartment.evaluate: completed={} halt={:?} result={:?}", o.completed, o.halt, o.result);
    println!("A is_quiescent={:?} has_pending_jobs={:?}", m.with_persistence(|i| i.is_quiescent()), m.with_persistence(|i| i.has_pending_jobs()));
    println!("A x before pump = {}", start.evaluate_with_symbols(&rcode, &rsyms).result);
    let p = m.run_promise_jobs();
    println!("A pump completed={} ; x after pump = {}", p.completed, start.evaluate_with_symbols(&rcode, &rsyms).result);
    // B: Machine-level crank (what rust/endo calls)
    let m2 = Machine::new(); let start2 = m2.start_compartment();
    let o2 = m2.evaluate_compartment_with_symbols_continuing_meter_shared(&start2, code.clone().into(), &symbols, ironhorse_vm::Meter::new(), None);
    println!("B machine.evaluate_compartment_*: completed={} result={:?}", o2.completed, o2.result);
    println!("B is_quiescent={:?} has_pending_jobs={:?} x={}", m2.with_persistence(|i| i.is_quiescent()), m2.with_persistence(|i| i.has_pending_jobs()), start2.evaluate_with_symbols(&rcode, &rsyms).result);
    // C: standalone Interp, run_script_shared
    let mut vm = Interp::new();
    let c = vm.relink_crank(&code, &parse_symbols(&symbols)).unwrap();
    let o3 = vm.run_script_shared(std::rc::Rc::from(c));
    println!("C standalone run_script_shared: completed={} is_quiescent={} has_pending_jobs={}", o3.completed, vm.is_quiescent(), vm.has_pending_jobs());
}
```

```
A compartment.evaluate: completed=true halt=Return result="done"
A is_quiescent=Ok(true) has_pending_jobs=Ok(true)
A x before pump = 0
A pump completed=true ; x after pump = 1
B machine.evaluate_compartment_*: completed=true result="done"
B is_quiescent=Ok(true) has_pending_jobs=Ok(false) x=1
C standalone run_script_shared: completed=true is_quiescent=false has_pending_jobs=true
```

**Recommendation:**

1. Reword the four docs so they say what each entry point guarantees. For example: "dispatch
   reached END; for the pumping entry points (`run`, `run_shared`, `run_promise_jobs`,
   `Machine::evaluate_compartment_*`) the queue also drained; quiescence in shared-compartment
   mode admits queued jobs, which are persisted".
2. Delete the "by construction" claim.
3. Optionally, add a `jobs_drained` field to `RunOutcome`. A pending-job query already exists, so
   no new API is required.

**Verification:**

- **Re-checked:** the verifier re-opened every location and traced which run path each entry
  point takes.
- **Reproduced:** it reproduced the finder's result (probe A).
- **Narrowed:** it showed the Endo seam drains (probe B), so the seam is removed from the
  mechanism. It showed quiescence deliberately admits persisted jobs, so the persistence framing
  is dropped.
- **Strengthened:** it found the standalone case (probe C) that falsifies "agrees with
  `is_quiescent` by construction".
- **Kept low:** as documentation drift on public items.

### ONT-24 — 'Realm' names three different things; the VM crate docs say each Compartment has a Realm and the graph is always frozen, but intrinsics are shared and can be unfrozen

**Severity:** low (proposed low; verifier low).

**Category:** synonym-homonym.

**Same root as:** INT-4 (low) is a near neighbour.
The ephemeral endo Machine documents a fresh Realm per evaluation but shares one never-reclaimed
key table, another place where "Realm" promises a separation the code does not give.

**Locations:**

- `rust/engine/ironhorse-vm/src/lib.rs:13`, `:14`
- `rust/engine/ironhorse-vm/src/interp/realm.rs:22`, `:896`, `:82`
- `rust/engine/ironhorse-vm/src/compartment.rs:874`, `:918`
- `rust/engine/ironhorse-runtime/tests/runtime_compile_meter.rs:326`
- `rust/engine/ARCHITECTURE.md:72`. The verifier found this line consistent with the single-Realm
  model.

Added by the verifier:

- `compartment.rs:352`, `:360`, `:905-915`, `:308-311`
- `rust/engine/ironhorse-vm/tests/realms.rs:1`, `:49`
- `rust/engine/ARCHITECTURE.md:75-76`

**Excerpt:**

```
lib.rs:13-14: "[`Machine`] owns one frozen intrinsic graph and shared heap. Each [`Compartment`] retains a [`Realm`] with independent globals and compiler policy."  realm.rs:22: "The machine's single Realm: shared primordials and its default environment."  realm.rs:896 (on CompartmentEnvironment::global_object): "This realm's actual global object"
```

**Mechanism:**

ECMA-262's Realm consists of intrinsics, a global object and a global environment. IronHorse
splits it across two types:

- `Realm`, one per Machine, holding the intrinsics and the default global;
- `CompartmentEnvironment`, holding a global object, its bindings and its policy.

The word "realm" is still used for both:

- "start realm" and "default realm" in `realm.rs` comments;
- the test file `tests/realms.rs` and the test `sibling_realms_keep_independent_source_compilers`,
  both of which concern compartments;
- the rustdoc front page, which says each Compartment retains a Realm.

A Compartment actually holds `machine: Rc<MachineState>`, the single shared Realm, plus its own
environment.

The docs also call the shared graph frozen without condition:

- `lib.rs:13`;
- `compartment.rs:352`, `:360`, `:874`;
- `tests/realms.rs:1`;
- `ARCHITECTURE.md:75-76` ("Boot initializes and freezes the graph once").

None of these mentions `Machine::unfrozen_with_start_global_names` (`compartment.rs:918`), which
builds the shared graph unfrozen.

**Consequence:** This is documentation drift and a naming homonym; no guest-visible or code-level
defect was shown.

- The crate-level docs state an unconditionally frozen graph and never mention the unfrozen
  constructor.
- On the default constructors (`Machine::new()` and `with_start_global_names`) the graph is frozen.
  A write in one compartment reaches neither a sibling nor the start compartment;
  `tests/realms.rs:49` asserts this.
- Writable sharing happens only with the opt-in unfrozen constructor. Its own doc
  (`compartment.rs:905-915`) warns about exactly that window, and says to lock down before
  admitting a second compartment.

The finder's claim that an embedder would expect per-compartment intrinsics does not hold:
`lib.rs:13` already says "one … intrinsic graph".

**Evidence:**

The finder's probe is `probes/ontology/doc-model/compartment_shared_intrinsics.js`, run on
`ironhorse-xst`:

```
const a = new Compartment({ globals: {} }); const b = new Compartment({ globals: {} });
out.sameArrayProto = a.evaluate('Array.prototype') === b.evaluate('Array.prototype');
out.frozen = Object.isFrozen(Array.prototype);
a.evaluate('Array.prototype.leak = "from-a"');
out.seenInB = b.evaluate('typeof [].leak === "string" ? [].leak : "none"');
out.seenInStart = [].leak === undefined ? 'none' : [].leak;
a.evaluate('var answer = 42'); out.globalInB = b.evaluate('typeof answer');
```

```
Observed: `{"sameArrayProto":true,"frozen":false,"seenInB":"from-a","seenInStart":"from-a","globalInB":"undefined"}`. Globals are independent; intrinsics are shared and mutable.
```

That probe does not exercise `Machine` or `Compartment`.
`ironhorse-xst` runs a bare `Interp::new()` (`ironhorse-262/src/lib.rs:58-63`).
On a guest that has not locked down, guest compartments sharing mutable intrinsics is ordinary
XS/SES behaviour.

The verifier's probe, `probes/ontology/ont24-verify/zz_audit_ont_24.rs`, exercises the real
Machine API:

```rust
use ironhorse_vm::{Compartment, Machine};
fn eval(c: &Compartment, s: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(s).unwrap();
    let out = c.evaluate_with_symbols(&code, &symbols);
    if out.completed { out.result } else { format!("HALT {:?}", out.halt) }
}
fn probe(label: &str, machine: Machine) {
    let a = machine.new_compartment(); let b = machine.new_compartment();
    let start = machine.start_compartment();
    let frozen = eval(&a, "String(Object.isFrozen(Array.prototype))");
    let write = eval(&a, "try { Array.prototype.leak = 'from-a'; } catch (e) { e.name } String(Array.prototype.leak)");
    let in_b = eval(&b, "String([].leak)");
    let in_start = eval(&start, "String([].leak)");
    eval(&a, "var answer = 42; answer");
    let global_in_b = eval(&b, "typeof answer");
    println!("{label}: frozen={frozen} writeInA={write} seenInB={in_b} seenInStart={in_start} globalInB={global_in_b}");
}
#[test] fn ont24() {
    probe("Machine::new", Machine::new());
    probe("Machine::unfrozen", Machine::unfrozen_with_start_global_names(None));
}
```

```
Machine::new: frozen=true writeInA=undefined seenInB=undefined seenInStart=undefined globalInB=undefined
Machine::unfrozen: frozen=false writeInA=from-a seenInB=from-a seenInStart=from-a globalInB=undefined
```

**Recommendation:**

1. Reserve "Realm" for the shared `Realm` struct and say "compartment environment" everywhere
   else.
   - Rename `tests/realms.rs` and the `sibling_realms` test.
   - Fix `realm.rs:896`, `realm.rs:82-83` and `lib.rs:13-14`.
2. State in the crate docs and `ARCHITECTURE.md:75-76` that intrinsics are shared machine-wide.
   Say they are frozen when the Machine is built frozen or after lockdown has run, and name the
   unfrozen constructor.

**Verification:**

- **Doc text and naming confirmed.** The verifier confirmed every quoted line and found three more
  unconditional "frozen" sites.
- **Probe replaced.** It showed the `xst` probe runs on a bare `Interp`, and that the behaviour it
  shows is standard pre-lockdown Compartment behaviour. It ran the Machine probe above instead:
  frozen with no leak by default, and leaking only with the opt-in unfrozen constructor, as that
  constructor's doc warns.
- **Claims dropped.** It dropped the per-compartment-intrinsics expectation from the consequence
  and did not verify the link to ONT-14.
- **Confidence corrected.** It changed the confidence from "confirmed by probe" to high (static).

### ONT-25 — Deliberate host-policy refusals ('compartment:heap-endowment', 'eval:no-compiler') are classified Halt::NotImplemented (implementation gap) while sibling provenance and missing-service checks are Halt::Refused; the surrounding code and prose call them refusals

**Severity:** low (proposed low; verifier low).

**Category:** taxonomy.

**Same root as:** BOOT-12 (low) is a near neighbour.
Among other public-surface defects, it reports heap endowments refused late and as
`NotImplemented`, which is this finding's `compartment:heap-endowment` case.

**Locations:**

All paths below are under `rust/engine/` unless stated otherwise.

- `ironhorse-vm/src/compartment.rs:268`, `:473`, `:602`, `:625`, `:1785`, `:1792`. The test that
  contains `:1785` and `:1792` is `heap_backed_endowments_are_refused_before_anything_runs`; the
  finder cited `:1820`, which is a comment inside it.
- `ironhorse-vm/src/interp/eval.rs:84`.
- `ironhorse-vm/src/interp/natives/compartment.rs:192`.
- `ironhorse-vm/src/halt_labels.rs:7`, `:45`, `:51`, `:95`.
- `ironhorse-vm/src/interp.rs:1683`.
- `ironhorse-vm/src/interp/host.rs:263`.
- `ironhorse-vm/src/interp/shared_persist.rs:758`.
- `ARCHITECTURE.md:88`.
- `README.md:426`, `:427`.

Added by the verifier:

- `ironhorse-vm/src/compartment.rs:120`, `:470-478`, `:731-742`.
- `ironhorse-vm/src/interp.rs:2657`.
- `ironhorse-262/src/lib.rs:53`.
- `ironhorse-vm/src/interp/host.rs:258-263`.
- `designs/ironhorse-guest-compartment.md:542-547`, `:1043`.
- `rust/endo/src/ironhorse_engine.rs:380`.
- `rust/endo/src/engine/js_machine.rs:348`.

**Excerpt:**

```
compartment.rs:602 `fn refused(skip: CompartmentSkip) -> RunOutcome` ... :625 `Halt::NotImplemented("compartment:heap-endowment")`, vs compartment.rs:473 `return Err(Halt::Refused("compartment:foreign-machine-value"));`; eval.rs:84 `None => return Err(Step::Host(Halt::NotImplemented("eval:no-compiler")))`; natives/compartment.rs:192 `Halt::NotImplemented("eval:no-compiler") -- a host-shaped refusal`; ARCHITECTURE.md:88 "Raw heap-backed Slot endowments remain refused."; README.md:426-427 "`Halt::NotImplemented(label)` names an implementation gap. `Halt::Refused(label)` names a deliberate execution-profile restriction."
```

**Mechanism:**

The project defines its two halt classes the same way in three places: `halt_labels.rs:7-8`,
`README.md:426-427` and `interp.rs:1683-1687`.

- `NotImplemented` names an unported opcode, built-in or value shape.
- `Refused` names a deliberate policy limit, including a "host-policy restriction … distinct from
  an implementation gap".

The rule refusing a heap-backed `Slot` endowment that lacks machine provenance is a permanent
safety rule, not unported work:

- `ARCHITECTURE.md:88` says such endowments "remain refused".
- The provenance-checked replacement, `define_global_value(&RootedValue)`
  (`compartment.rs:470-478`), already exists.
- The function that emits the halt is named `refused`.

Yet the halt is `NotImplemented("compartment:heap-endowment")` (`compartment.rs:625`;
`NOT_IMPLEMENTED_LABELS`, `halt_labels.rs:45`).
The replacement's own provenance check is `Refused("compartment:foreign-machine-value")`
(`compartment.rs:473`; `REFUSED_LABELS`, `halt_labels.rs:95`).
So two checks of the same property sit in different classes.

`eval:no-compiler` (`halt_labels.rs:51`) is a deliberate choice, but its classification is
contested:

- **For `NotImplemented`.** `interp.rs:2657` calls it "an honest `Halt::NotImplemented` until it
  is armed", and `ironhorse-262/src/lib.rs:53` calls it "the honest `eval:no-compiler` gap".
  Tests pin `Refused("eval:no-compiler")` as a misclassification:
  `rust/engine/ironhorse-262/src/xst.rs:4474`, `rust/engine/ironhorse-262/src/lib.rs:1454` and
  `rust/engine/ironhorse-fuzz/src/lib.rs:2386`.
- **For `Refused`.** Every sibling host-service check is `Refused`: `host:missing-service` and
  `host:service-owner-dropped` (`host.rs:258-263`), `machine:missing-restored-compiler`
  (`shared_persist.rs:758`) and `machine:compiler-policy-owner-dropped` (`compartment.rs:120`).
- **Still open.** The design lists the halt's shape as an open decision:
  `designs/ironhorse-guest-compartment.md:542-547` and the TODO at `:1043`.

The prose argument is weak.
The same `refused()` helper (`compartment.rs:602-628`) also produces the genuine gap
`compartment:dynamic-import`, so "refusal" is used loosely for both classes.

**Consequence:**

- **No runtime difference.** Both classes behave the same at every runtime branch:
  `ExecutionOutcome::classify` maps both to Panicked (`rust/endo/src/ironhorse_engine.rs:380`),
  and `js_machine.rs:348` maps both to Unavailable. There is no guest-visible, commit or
  persistence effect.
- **Neither label is reachable today.**
  - In the test262 harness and the Endo seam, a compiler is always installed
    (`ironhorse-262/src/lib.rs:58`; `ironhorse_engine.rs:707`, `:762`, `:1182`, `:1298`).
  - No harness or Endo code passes heap `Slot`s to `define_global`; the only such call passes
    integers.
  - Guest-created and nested compartments inherit the compiler.
- **Where the class still matters.** The engine's own taxonomy files a permanent safety rule as
  unported work.
  - For a hypothetical caller, `describe_halt` (`ironhorse_engine.rs:286`) would render it as
    "unsupported opcode `compartment:heap-endowment` (a named, unlanded engine gap)".
  - The differential would report it as an implementation gap (`test262.rs:133-136`).
  - Someone "closing the gap" under the README's definition would admit raw arena coordinates,
    which the rule exists to prevent. That last risk is speculative.

**Evidence:** The finder's evidence is static.

```
[vocabulary] Static, plus the existing unit test at compartment.rs:1775-1793, which names the case a refused endowment (`panic!("refused endowment must not call host")`) and asserts NotImplemented. The sibling classes are visible in halt_labels.rs:96-122 (REFUSED_LABELS includes compartment:foreign-machine-value, host:missing-service, machine:missing-restored-compiler) and halt_labels.rs:28-71 (NOT_IMPLEMENTED_LABELS includes compartment:heap-endowment, eval:no-compiler).

[doc-model] static: halt_labels.rs:28-77 (NOT_IMPLEMENTED_LABELS) contains "compartment:heap-endowment" (:45) and "eval:no-compiler" (:51). REFUSED_LABELS (:80-) contains "compartment:foreign-machine-value" (:95) and "host:foreign-machine-value". The test at compartment.rs:1820 is named `heap_backed_endowments_are_refused_before_anything_runs` and asserts `Halt::NotImplemented("compartment:heap-endowment")`.
```

The verifier's probe is `probes/ontology/ont25-verify/p1.js`:

```
const c = new Compartment();
const inner = c.evaluate('new Compartment()');
const r = [c.evaluate('1+1'), inner.evaluate('2+2'), c.evaluate('eval("3+3")'), inner.evaluate('Function("return 4")()')];
throw new Error(JSON.stringify(r));
ironhorse-xst: Error: [2,4,6,4]   (exit=1, the intended reporting throw)
```

**Recommendation:**

1. Reclassify `compartment:heap-endowment` as `Refused` and move it to `REFUSED_LABELS` next to
   `compartment:foreign-machine-value`.
2. Rename `CompartmentSkip::HeapEndowment` and the `refused()` helper to match.
3. Settle the shape of `eval:no-compiler` as part of the open guest-compartment decision.
   Treat the compiler as the host service it is: either `Refused`, perhaps renamed
   `host:missing-compiler`, alongside `host:missing-service`, or document why it differs.
   Then update the tests that pin it.
4. Keep `NotImplemented` for surfaces meant to be implemented.
5. Make `describe_halt` say "label" rather than "opcode".

**Verification:**

- The verifier re-read every cited line.
- It confirmed the `heap-endowment` half: a permanent provenance rule whose replacement exists
  and whose sibling check is `Refused`. This contradicts the project's own definitions in three
  places.
- It restated the `eval:no-compiler` half as a deliberate but contested choice, pinned by tests,
  documented as an "honest gap", and flagged in the design as an open decision.
- It showed the two classes are behaviourally identical everywhere, and that neither label is
  reachable in the harness or the Endo seam (probe `p1.js`).
- It noted that "refusal" is used loosely in the code for both classes.
- It kept the finding at low.

### ONT-26 — Store-side halt mapping sends every non-invariant halt, including the non-deterministic HostAllocationFailed, to `StoreFailure::Refused` ('deterministic, retry is a busy-loop')

**Severity:** low (proposed low; verifier low).

**Category:** taxonomy.

**Locations:**

- `rust/engine/ironhorse-snapshot/src/machine.rs:2995`, `:3006`.
- `rust/engine/ironhorse-snapshot/src/machine.rs:3141`. The `MachineSnapshot` impl begins at
  `:3140`; `:3141` is its `persist_gate` method.
- `rust/engine/ironhorse-snapshot/src/store.rs:295` (the arm spans `:295-296`), `:268`.
- `rust/engine/ironhorse-vm/src/compartment.rs:954`.
- `rust/engine/ironhorse-vm/src/interp.rs:1649`.
- Added by the verifier:
  - `compartment.rs:93-157`, `:125`, `:1301-1312`;
  - `rust/engine/ironhorse-vm/src/interp/realm.rs:932-972`, `:966-969`;
  - `rust/endo/src/ironhorse_engine.rs:1100-1113`;
  - `rust/engine/ironhorse-vm/src/value.rs:1233-1239`.

**Excerpt:**

```
machine.rs:3003-3006  other @ (ironhorse_vm::Halt::EngineInvariant(_) | ironhorse_vm::Halt::Panic(_)) => {
            StoreError::EngineInvariant(format!("{other:?}"))
        }
        other => StoreError::MachineOperation(format!("{other:?}")),
store.rs:268-276  /// A deterministic refusal: the answer will not change on its own. ... Retrying is a busy-loop.
    Refused,
```

**Mechanism:**

`shared_access_error` converts the Halt returned by `Machine::with_persistence`,
`with_collection` or `from_restored_interpreter` into a `StoreError`.
It names only three halts: `MachineBusy`, `EngineInvariant` and `Panic`.
The wildcard at `:3006` turns every other halt into `MachineOperation(String)`.
`StoreError::classify` puts `MachineOperation` in `StoreFailure::Refused`, which `store.rs:268-271`
documents as "A deterministic refusal … Retrying is a busy-loop".

`with_persistence` first runs `prepare_persistence` (`compartment.rs:954`).
That function materializes pending host compartments through `create_environment`
(`compartment.rs:125`).
`create_environment` catches resource unwinds and returns `resource_halt`, which is either
`HeapExhausted` or `HostAllocationFailed` (`realm.rs:966-969`).

`Halt::HostAllocationFailed` is documented as not deterministic (`interp.rs:1649-1663`).
Its doc tells the embedder to restore from the last committed state, recycle the instance and
re-drive.
The snapshot crate never mentions `HostAllocationFailed` or `is_host_failure`.
`MachineError::store_failure` (`rust/endo/src/ironhorse_engine.rs:1100-1113`) passes `classify()`
through unchanged, with the rule "never retry a StoreFailure::Refused".

A second mapping exists for the same failures.
The `impl MachineSnapshot for ironhorse_vm::Machine` (`machine.rs:3140-3159`) maps every
`with_persistence` error to `MachineSnapshotError::NotQuiescent` via `.map_err(|_| ...)`.
That variant is documented as "its last crank halted".
It covers `Refused("machine:unapplied-endowments")`, `HeapExhausted` and `HostAllocationFailed`.
So the two translations disagree for the same failure.

Mapping `HeapExhausted` to `Refused` agrees with `HeapExhausted`'s documented determinism.
Only the `HostAllocationFailed` part contradicts the Halt contract.

**Consequence:**

A supervisor that follows the store taxonomy is told something false about a host-memory failure
during checkpoint.
It is told the failure is a permanent refusal: do not retry, and do not recycle the instance.
That is the opposite of the Halt contract.
In the verifier's probe, the same checkpoint retried without the memory cap succeeds (`Ok(2)`).

Reach is narrow.
It is limited to checkpoints that must first materialize pending environments under host memory
pressure.
The in-tree supervisor (Endo `PersistentMachine`) never has an unmaterialized pending
environment.
Its only compartment comes from `start_compartment()`, which presets the environment
(`compartment.rs:1301-1312`).
So only an embedder of the public `SharedStoreSession` API can reach it, by creating a host
compartment and checkpointing before evaluating in it.

**Evidence:** The finder's evidence is static:

```
static: shared_access_error (machine.rs:2995-3008) has three arms, MachineBusy, (EngineInvariant|Panic), and `other`. StoreError::classify (store.rs:295-304) lists MachineOperation(_) under StoreFailure::Refused. compartment.rs:948-954: `with_persistence` calls `self.machine.prepare_persistence(&mut interpreter)?`. prepare_persistence (compartment.rs:93-157) calls `interp.create_environment(..)?`, and create_environment (interp/realm.rs:932-972) returns `resource_halt(&*payload)` as Err, i.e. Halt::HeapExhausted or Halt::HostAllocationFailed. interp.rs:1649-1657 documents HostAllocationFailed as 'Not deterministic ... Never commit ... Restore from the last committed state ... Recycle the instance'.
```

The verifier's probe is `probes/ontology/ont26-verify/zz_audit_ont_26v.rs`.
It uses a thread-capped `#[global_allocator]` copied from
`ironhorse-vm/tests/host_allocation_failure.rs`.
It fills the slot arena close to a growth boundary, creates a pending compartment, then
checkpoints with the host allocator capped:

```
test heap_exhausted_during_pending_materialization ... HEAP: error=MachineOperation("HeapExhausted") class=Refused
test host_failure_via_slot_vector_growth ... filled: len=8125 live=8125
VECTOR headroom=150000: error=MachineOperation("HostAllocationFailed") class=Refused; Halt::HostAllocationFailed.is_host_failure()=true
RETRY uncapped: Ok(2)
test measure ... before: (3173, 3173, 106528)
after materialize: (3249, 3249, 106528)
```

**Recommendation:**

1. Make the Halt-to-StoreError translation exhaustive, with no wildcard.
2. Keep that translation in one function used by both `shared_access_error` and the
   `MachineSnapshot` impl.
3. Map `HostAllocationFailed` to a transient or host-failure class, for example a new
   `StoreFailure::Host`, so `StoreError::classify` follows `Halt::is_host_failure` instead of
   contradicting it.
4. Give `HeapExhausted` its own variant. This is optional, because its determinism is consistent
   with `Refused`.

**Verification:**

- **Code paths confirmed.** The verifier re-opened every cited site and confirmed the wildcard,
  the classification, the materialization path and the Halt contract. It found nothing
  downstream that fixes the result up.
- **Reproduced end to end.** Under a capped allocator, the checkpoint gives
  `MachineOperation("HostAllocationFailed")` classified as `Refused`. The same checkpoint then
  succeeds when retried, which undercuts the "deterministic" label.
- **Second mapping confirmed.** It confirmed that the `MachineSnapshot` impl maps the same
  failures to `NotQuiescent`.
- **Reach and severity.** It scoped reach to embedders of the public session API, noted that
  `HeapExhausted` → `Refused` is consistent, and kept the severity at low.

### ONT-27 — The side-table ledger has no 'unsupported' class: guest_compartments, refused at persist, is filed as a SATELLITE and SideTable::pending() reports nothing left to carry

**Severity:** low. The finder proposed low and the verifier agreed.

**Category:** taxonomy.

**Same root as:** SNI-10 (low) is a near neighbour.
The persistence-refusal error reports every admission refusal as a pending side table,
conflating policy, unrepresentable and not-yet-carried state.

**Locations:**

- `rust/engine/ironhorse-snapshot/src/sidetable.rs:716`, `:1054`, `:181`
- `rust/engine/ironhorse-vm/src/interp/persist.rs:639`
- `rust/engine/ARCHITECTURE.md:300`

Added by the verifier:

- `sidetable.rs:24-30`, `:127-131`, `:711`, `:980`
- `rust/engine/ironhorse-vm/src/interp/state.rs:1800-1831`
- `rust/engine/ironhorse-snapshot/src/machine.rs:80`
- `rust/engine/ARCHITECTURE.md:422`
- `persist.rs:673`
- `rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:112-175`

**Excerpt:**

```
sidetable.rs:1055-1058: let pending = SideTable::pending(); assert_eq!(pending.len(), 0, "the design's Remaining ledger count: every row is carried");
persist.rs:639-642: if !self.guest_compartments.is_empty() { return Some("a live guest `Compartment`, whose environment binding no snapshot carries") }
```

**Mechanism:**

`ARCHITECTURE.md:300-301` names four classes: serialized, boot-derived, transient and unsupported.
The code disagrees in two ways:

- the `Coverage` enum has six variants;
- the reconciliation test uses a different set of six groups: LEDGER_ROWS, ARENAS, SATELLITES,
  TRANSIENTS, HOST_WIRING and BOOT_DERIVED.

None of those groups means "unsupported".

`guest_compartments` holds cross-crank state that no atom carries.
It is `#[snapshot_table(none)]` and `#[quiescent(retained)]` (`state.rs:1800-1831`).
The persist gate refuses any machine holding one, with the generic suffix "that side table does
not travel yet" (`machine.rs:80`).
By the ledger's own definition at `sidetable.rs:181`, that is `Coverage::Pending`.
It is filed in SATELLITES instead (`sidetable.rs:716`).

The file's own definitions make the misfiling explicit:

- `sidetable.rs:127-131` defines a satellite as a set that "rides its primary row's coverage", and
  says a set that stops riding "must graduate to a row";
- the comment at `sidetable.rs:711` admits that `guest_compartments` "rides NO section";
- the reconciliation failure text at `:980` says a field that can hold cross-crank state belongs
  "to the ledger itself".

No table uses `Coverage::Pending` or `Coverage::BootDerived`.
SATELLITES mixes five treatments:

- FUNC-carried;
- flag-carried;
- rebuilt;
- boot-derived but not fingerprinted (`pending_surfaces`, `intrinsic_key_ranks`);
- refused.

The module doc's list of what still refuses persistence (`sidetable.rs:24-30`) names a runtime
native, `$262` and a host module graph.
It omits guest compartments, `globalLexicals` and `shared_compartments`.

**Consequence:**

`ARCHITECTURE.md:422` names the "SideTable descriptors and `is_quiescent`" as the authority on
"What may persist?".
Neither of them encodes this refusal.
`SideTable::pending()` reports complete coverage, and a test enshrines that.

Meanwhile, on a default (non-shared-realm) machine, any machine that has ever constructed a guest
Compartment cannot checkpoint, even after the compartment is dropped and collected:

- while the instance is live, the `guest_compartments` row refuses;
- after GC prunes that row, the `shared_compartments` flag refuses (`persist.rs:673`). That flag is
  set by `construct_compartment`, never cleared on success (`natives/compartment.rs:112-175`), and
  is also filed in SATELLITES.

That is a refusal of a core Endo feature which the machine-readable ledger hides.
`ARCHITECTURE.md:300-316` does say that unsupported live state refuses admission and that
`persist_gates.rs` tests it, so the prose points readers to the gate.
`pending()` and the descriptors have no runtime consumer, so the effect is maintainability and
documentation drift, not wrong behaviour.
The shared-realm case was not probed.

**Evidence:** The finder's probe source is `probes/ontology/identity/zz_audit_ont_2.rs`.

```
Probe zz_audit_ont_2.rs output:
SideTable::pending() = []
coverage histogram = {"EmptyAtBoundary": 4, "InArena": 1, "RebuiltAtRestore": 2, "Serialized": 38}
any descriptor naming guest_compartments: false
"var c = 0; 0": snapshot ok (46276 bytes)
"var c = new Compartment(); 0": snapshot REFUSED: heap holds live a live guest `Compartment`, whose environment binding no snapshot carries: that side table does not travel yet
"var c = new Compartment(); c = null; 0": snapshot REFUSED: (same)
A field cross-tabulation (fields.tsv) of 206 roster fields against the six groups finds each field classified exactly once, and the #[quiescent] attributes are consistent with the groups.
```

The finder's `c = null` case never ran GC, so it showed nothing about dropping.
The verifier's probe, `probes/ontology/ont27-verify/zz_audit_ont_27v.rs`, adds `collect_garbage()`:

```
SideTable::pending() = []
coverage histogram = {"EmptyAtBoundary": 4, "InArena": 1, "RebuiltAtRestore": 2, "Serialized": 38} (total 45)
tables with Pending: 0
tables with BootDerived: 0
any descriptor naming guest_compartments: false
"var c = 0; 0": snapshot ok (46276 bytes)
  collect_garbage -> Ok("ok")
  after GC: snapshot ok (46276 bytes)
"var c = new Compartment(); 0": snapshot REFUSED: heap holds live a live guest `Compartment`, whose environment binding no snapshot carries: that side table does not travel yet
  collect_garbage -> Ok("ok")
  after GC: snapshot REFUSED: (same)
"var c = new Compartment(); c = null; 0": snapshot REFUSED: (same guest_compartments refusal)
  collect_garbage -> Ok("ok")
  after GC: snapshot REFUSED: heap holds live a guest `Compartment` built on a machine with no shared-realm primordial profile, whose image no restore would accept: that side table does not travel yet
```

**Recommendation:**

1. Add an explicit Refused or Unsupported coverage class, or give `guest_compartments` a ledger
   row with `Coverage::Pending`. Do the same for `shared_compartments`, host module graphs and the
   `$262` host.
2. Derive the persist gate's refusal list from those rows, and stop calling non-side-table
   refusals "side tables" in `machine.rs:80`.
3. Split SATELLITES into its real classes.
4. Align `ARCHITECTURE.md:300-301` and `:422` and `sidetable.rs:24-30` with the code.

**Verification:**

- The verifier confirmed every cited location, the empty `pending()` result, and that no table
  uses `Pending` or `BootDerived`.
- It found the file's own satellite definition and the "rides NO section" comment, and found that
  nothing decides persistence from the ledger.
- It corrected the "after dropping" claim: a GC run moves the refusal to the `shared_compartments`
  flag rather than clearing it.
- It softened "the docs hide it" to the specific drift at `ARCHITECTURE.md:422` and
  `sidetable.rs:24-30`.
- It kept the finding at low because there is no runtime consumer.

### ONT-28 — README names the native-recursion halt as Halt::StackOverflow; the code emits ReentryLimit, and the harness classifies the two sides of that stop asymmetrically

**Severity:** low (the finder proposed low and the verifier agreed).

**Category:** taxonomy.

**Locations:**

- `rust/engine/README.md:168`, `:170`, `:432`
- `rust/engine/ironhorse-vm/src/interp/frames.rs:60`
- `rust/engine/ironhorse-vm/src/interp.rs:381`
- `rust/engine/ironhorse-262/src/xst.rs:436`
- `rust/engine/xs-oracle/csrc/xs_shim.c:118` (the function spans `:116-121`)
- `c/moddable/xs/sources/xsMemory.c:271`

Added by the verifier:

- `rust/engine/ironhorse-vm/tests/native_recursion_budget.rs:4-5`
- `interp.rs:1714-1722`
- `xst.rs:421-428`, `:431-435`, `:1297-1300`, `:761`, `:880`, `:3143-3167`, `:3333-3337`
- `rust/engine/ironhorse-262/src/test262.rs:202`
- `c/moddable/xs/tools/xst262.c:1314-1316`
- `c/moddable/xs/sources/xsAPI.c:1311-1324`
- `rust/endo/src/ironhorse_engine.rs:296-305`

**Excerpt:**

```
README.md:168-170: "Past the ceiling the crank halts with `Halt::StackOverflow`, the abort-to-host XS raises from `fxCheckCStack`"  frames.rs:60-64: `return Err(Step::Host(Halt::ReentryLimit { depth: self.native_depth + cost, limit: NATIVE_DEPTH_LIMIT }))`  interp.rs:381: "[`Halt::ReentryLimit`] — distinct from the value-stack abort XS raises from `fxCheckCStack`"
```

**Mechanism:**

The stop for native recursion exhaustion is described three ways:

1. README says it is `Halt::StackOverflow`, and its halt taxonomy (`README.md:432`) lists
   StackOverflow but not ReentryLimit (nor MachineBusy).
2. The code emits `Halt::ReentryLimit` (`frames.rs:59-64`, `:196`, `render.rs:21`).
3. The interp.rs doc (`:380-382`) calls `fxCheckCStack` a "value-stack abort".

The third account is wrong.
`fxCheckCStack` (`xsMemory.c:271-277`) is XS's native C-stack check, which exits with
`XS_NATIVE_STACK_OVERFLOW_EXIT`.
The value-stack abort is `fxOverflow` (`xsAPI.c:1311-1324`, `XS_JAVASCRIPT_STACK_OVERFLOW_EXIT`),
and that is what `Halt::StackOverflow` models.
`tests/native_recursion_budget.rs:4` correctly calls ReentryLimit the `fxCheckCStack` analogue,
which contradicts `interp.rs:381`.
`ARCHITECTURE.md:332` and `:345` list both halts correctly, so README is the stale document.

The harness credits stops asymmetrically:

- The oracle side counts `XS_NATIVE_STACK_OVERFLOW_EXIT` as a resource abort that satisfies an
  expected RangeError (`xs_shim.c:116-121`, `oracle_negative_ok` at `xst.rs:421-428`). This
  mirrors XS's own runner (`xst262.c:1314`).
- `ironhorse_negative_ok` (`xst.rs:436-441`) accepts StackOverflow and MeterAbort only, never
  ReentryLimit.
- The test at `xst.rs:3150-3159` pins the IronHorse side deliberately, on the rationale that "an
  implementation recursion budget is not evidence that the guest threw the expected RangeError".
  That rationale applies equally to XS's host-dependent C-stack margin, but it is applied to one
  engine only.

The credit sets do not line up beyond the stack case either.
MeterAbort is credited although XS does not credit `XS_TOO_MUCH_COMPUTATION_EXIT`.
HeapExhausted, the analogue of `XS_NOT_ENOUGH_MEMORY_EXIT`, is not credited.
Yet the doc comment at `xst.rs:431-435` claims the credits "map to XS's memory/stack-exit
acceptance".

ReentryLimit on a runtime-negative case falls into `negative-type-unmatched` (`xst.rs:1297-1300`),
whose comment says the label marks an incomplete Error surface.
On the positive path, the same halt is labelled `ironhorse-aborted-limit` (`xst.rs:761`, `:880`).

**Consequence:**

The differential treats unbounded recursion inconsistently.
Plain JS recursion against a runtime RangeError negative is covered.
The same recursion through a native callback becomes a skip.

In that probe, XS's stop is its value-stack abort (`stack overflow (-2)!` is `fxOverflow`'s report
string), not its native-stack exit.
So the probe shows the same program crossing different limits in the two engines.
The asymmetry in the native stops themselves is established by the two pinned unit tests.

Impact today is latent:

- The pinned whole-tree sweep has 0 `negative-type-unmatched:RangeError` cases.
- The in-repo embedder handles ReentryLimit explicitly (`rust/endo/src/ironhorse_engine.rs:296-305`),
  and `is_panic` includes it.
- An embedder following README would miss it only if it matched exhaustively on
  `Halt::StackOverflow`.

**Evidence:**

The finder's probes are in `probes/ontology/doc-model/`:

```
ironhorse-xst probes: native_depth63.js (63 nested `[0].forEach` callbacks) -> `Error: completed 63`; native_depth.js (64) -> `InternalError: ironhorse halted: ReentryLimit { depth: 2064, limit: 2048 }`.
Dual-run (endot-ih --test262-dir <probes>/t262 zzprobe --json deep.json), two cases with `negative: {phase: runtime, type: RangeError}`, flags [raw]:
  deep-plain-rangeerror.js `function nest() { nest(); } nest();` -> {"outcome": "covered"}
  deep-callback-rangeerror.js `function nest() { [0].forEach(nest); } nest();` -> {"outcome": "run-skip", "reason": "negative-type-unmatched:RangeError"} (XS printed `stack overflow (-2)!`).
```

The verifier's probes are in `probes/ontology/ont28-verify/`:

```
plain_deep.js `function nest() { nest(); } nest();` -> `InternalError: ironhorse halted: StackOverflow(4060)`
callback_deep.js `function nest() { [0].forEach(nest); } nest();` -> `InternalError: ironhorse halted: ReentryLimit { depth: 2064, limit: 2048 }`
- deep-plain-rangeerror.js `function nest() { nest(); } nest();` -> covered
- deep-callback-rangeerror.js `function nest() { [0].forEach(nest); } nest();` -> run-skip "negative-type-unmatched:RangeError" (run alone, XS stderr: `stack overflow (-2)!`, which is fxOverflow's value-stack report)
- deep-json-rangeerror.js `JSON.parse("[".repeat(100000) + "]".repeat(100000));` -> run-skip "negative-type-unmatched:RangeError" (XS: `stack overflow (-1)!`)
- deep-callback-positive.js, positive nest(64) -> run-skip "ironhorse-aborted-limit"
```

**Recommendation:**

1. Correct `README.md:168-175` and the taxonomy at `README.md:426-438` to name ReentryLimit and
   MachineBusy.
2. Fix `interp.rs:381` to say ReentryLimit is the analogue of `fxCheckCStack`'s native-stack abort.
3. Make one decision on which resource stops satisfy a RangeError negative, and apply it to both
   engines.
4. Fix the `xst.rs:431-435` comment so it describes the credit set the code actually applies.
5. Give ReentryLimit on the negative path a limit label instead of `negative-type-unmatched`.

**Verification:**

- **Confirmed.** The verifier confirmed the README text, the emitting sites, and the wrong XS
  attribution in `interp.rs:381`. It found the contradicting test comment. It confirmed the
  credit asymmetry is deliberate and pinned on one side only, and re-ran both probes.
- **Corrected.** The probe's XS stop is `fxOverflow`, not the native exit. The embedder
  consequence is hypothetical, and there is no current test262 impact.
- **Added.** The mislabel on the negative path, and the mismatched credit sets.
- **Severity.** Kept low.

### ONT-29 — Module record model lacks [[EvaluationError]]: a failed evaluation leaves modules 'Evaluating' forever, re-import silently succeeds, and snapshot admission is permanently refused

**Severity:** low (proposed low; verifier low).

**Category:** spec-model.

**Same root as:** BOOT-7 (medium), within which this finding falls.
BOOT-7 limits module execution to self-contained bodies and finds `ModuleGraph` an unconnected
host-side model with no errored state.

**Locations:**

- `rust/engine/ironhorse-vm/src/module.rs:177`, `:641`, `:668`
- `rust/engine/ironhorse-vm/src/compartment.rs:570`
- `rust/engine/ironhorse-vm/src/module_snapshot.rs:25`
- Added by the verifier:
  - `rust/engine/ironhorse-vm/src/interp/persist.rs:581-589`
  - `module.rs:428-495` (`inner_link`; the early return for `Linking` is at `:433-437`)
  - `rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:116`

**Excerpt:**

```
/// ECMA-262 CyclicModuleRecord `[[Status]]` ... `EvaluatingAsync` is not reachable in the static half.
pub enum ModuleStatus { New, Unlinked, Linking, Linked, Evaluating, Evaluated }
...
ModuleStatus::Evaluating | ModuleStatus::Evaluated => return Ok(()),
...
self.execute_body(module, trace)?;
```

**Mechanism:**

ECMA-262 16.2.1.5.3 Evaluate handles an abrupt completion of InnerModuleEvaluation as follows:

- every module on the DFS stack becomes "evaluated";
- each of them gets [[EvaluationError]] set to the error;
- every later Evaluate of those modules returns the same abrupt completion.

IronHorse departs from this in four ways:

- `ModuleRecord` (`module.rs:150-171`) has no error slot.
- `inner_eval` propagates the error with `?` (`module.rs:668`). That returns before the SCC pop
  loop at `:675-681`, so every module on the DFS stack stays `Evaluating`.
- No error path resets the status.
- The next `evaluate` hits the early return at `module.rs:641` and returns `Ok`.

`inner_link` has the same shape for Link.
A bind or resolve error propagates with `?` and leaves the stack in `Linking`.
Under the spec those modules return to "unlinked", but `inner_link` returns `Ok` for `Linking` on a
retry (`:433-437`).

**Consequence:**

The defect is visible through the host API:

- **Re-import reports success.** `Compartment::import_static` (`compartment.rs:568-570`) returns
  `Ok(id)` the second time, for a module whose body never finished. `import_static("b")` also
  returns `Ok`, and the namespace bindings stay in TDZ.
- **Persistence is refused.** `ModuleGraph::snapshot_admitted` (`module_snapshot.rs:25`) refuses
  any module in `Evaluating`, and `persist.rs:581-589` then refuses persistence for every live
  environment whose graph fails that check.

The finder said a failed static import makes the machine "permanently unsnapshottable".
That is too strong: the refusal lasts as long as the compartment that holds the failed graph is
reachable.
A collect while the handle is alive does not clear it.
Dropping the handle and collecting does, so the machine never returns to admissible on its own.

No guest path reaches this.
Guest `new Compartment` creates an empty `ModuleGraph` (`natives/compartment.rs:116`), and the VM
does not execute module bytecode.

**Evidence:**

The finder's probe is in `probes/ontology/spec-model/`:

```
Rust probe (temporary rust/engine/ironhorse-vm/tests/zz_audit_ont_2.rs, now deleted; copy in $SCRATCH/.../spec-model/). The cyclic graph is a: import {y} from 'b', init x, read y; and b: import {x} from 'a', read x, then init y. Calls: g.instantiate(a); evaluate(a); status; evaluate(a) again.
Observed:
  first evaluate : Err(Tdz { name: "x" })
  status a=Evaluating b=Evaluating
  second evaluate: Ok(0)
  namespace(a).x = Err(Tdz { name: "x" })
  namespace(b).y = Err(Tdz { name: "y" })
```

The verifier's probe is `probes/ontology/verify-ont29/zz_audit_ont_29v.rs`:

```
[graph] first evaluate : Err(Tdz { name: "x" })
[graph] status a=Evaluating b=Evaluating
[graph] second evaluate: Ok(0)
[graph] evaluate(b) direct: Ok(0)
[graph] namespace(a).x = Err(Tdz { name: "x" })
[graph] namespace(b).y = Err(Tdz { name: "y" })
[ctrl] import_static(a) = Ok(ModuleId(0))
[ctrl] unpersistable = Ok(None)
[bad] before import unpersistable = Ok(None)
[bad] import_static(a) #1 = Err(Tdz { name: "x" })
[bad] import_static(a) #2 = Ok(ModuleId(0))
[bad] import_static(b)    = Ok(ModuleId(1))
[bad] ns(a).x = Err(Tdz { name: "x" })
[bad] unpersistable = Ok(Some("an active or heap-backed host module graph"))
[bad] unpersistable again = Ok(Some("an active or heap-backed host module graph"))
[bad] after dropping compartment handle, unpersistable = Ok(Some("an active or heap-backed host module graph"))
[gc] unpersistable (handle alive) = Ok(Some("an active or heap-backed host module graph"))
[gc] collect (handle alive) = Ok(())
[gc] unpersistable after collect, handle alive = Ok(Some("an active or heap-backed host module graph"))
[gc] collect (handle dropped) = Ok(())
[gc] unpersistable after drop+collect = Ok(None)
```

**Recommendation:**

1. Add `evaluation_error: Option<ModuleError>` to `ModuleRecord`, or an
   `Evaluated(Result<..>)` state.
2. On an abrupt InnerModuleEvaluation, mark every module on the stack Evaluated with the error,
   and rethrow that error on re-evaluation.
3. On a Link failure, reset the stack to `Unlinked`.
4. Carry the error through `module_snapshot`, so a failed module is admissible at rest, as the
   spec allows.
5. Add `EvaluatingAsync` before top-level await lands.

**Verification:**

- The verifier re-opened every location and confirmed the missing error slot and the `?` exit
  before the SCC pop.
- It confirmed that nothing resets the status, against the ECMA-262 text.
- It reproduced the finding through the host Compartment path and the persistence gate.
- It corrected "permanently unsnapshottable" to "for as long as that compartment lives", using a
  drop-and-collect probe.
- It added the dependents' TDZ consequence and the parallel `inner_link` defect.
- It kept the severity at low, since the defect is reachable only through the host API.

### ONT-30 — One sentinel, three documented meanings: docs disagree with each other and with the code about which environment an unhomed function, a compartment evaluate, and lockdown's reach use

**Severity:** low. The finder proposed low and the verifier agreed.

**Category:** doc-code-drift.

**Locations:**

- `rust/engine/ARCHITECTURE.md:114`, `:337`.
- `rust/engine/ironhorse-vm/src/interp.rs:845`, `:2139`, `:2314`.
- `rust/engine/ironhorse-vm/src/interp/realm.rs:875`, `:311`.

The verifier added:

- `realm.rs:903-909` (`capture_global_environment`) and `realm.rs:911-914` (`switch_environment`).
- `rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:98-101`, `:112-114`.
- `rust/engine/ironhorse-vm/src/interp/persist.rs:657-677`.
- `rust/engine/ironhorse-vm/src/interp/restore.rs:113-118`.
- `rust/engine/ironhorse-vm/tests/realms.rs:648`.
- `rust/engine/ironhorse-runtime/tests/runtime_compile_meter.rs:463`.

**Excerpt:**

```
ARCHITECTURE.md:114  Shared dynamic constructors reached through prototype links use that default global;
interp.rs:845        /// Captured compartment global; NULL derives the standalone default.
realm.rs:875-876     // Left NULL, `switch_environment` no-ops ... and the dynamic function is created in whichever environment called for it.
realm.rs:311-313     // a machine that can hold compartments is already locked down, ... and an unfrozen machine does not bind `lockdown` at all.
ARCHITECTURE.md:337  Yield/await are internal DispatchOutcome control outcomes, not `Halt` variants.
```

**Mechanism:** Three fields hold a bare `SlotIndex`: `FuncInfo.global_env`, `CallerState.global_env`
and `SavedFrame.global_env`. In each, NULL is a sentinel, and the docs describe that sentinel
three different ways:

- as the default global (`ARCHITECTURE.md:114`);
- as "the standalone default" (the field docs at `interp.rs:845`, `:2139` and `:2314`);
- as whichever environment called (`realm.rs:875`).

The code does a fourth thing.
NULL's only consumer is `switch_environment`, whose NULL branch returns early (`realm.rs:911-914`).
So the effective meaning is the environment that is ambient at the moment of the call: the caller
for a direct call, and the pump's environment for a job (ONT-5).
The tests (`realms.rs:648`, `runtime_compile_meter.rs:463`) pin the calling-compartment rule.

The "standalone default" doc fails for ordinary closures, not only for evaluators.
`capture_global_environment` returns NULL whenever `shared_compartments` is false
(`realm.rs:903-909`).
On the `ironhorse-xst` host, a guest `new Compartment()` sets that flag
(`natives/compartment.rs:112-114`).
Every function created before that point, including hoisted declarations, is therefore NULL-homed.

Separately, `realm.rs:311-313` justifies dropping lockdown's environment check by an invariant
that is false on the guest path.
`ironhorse-xst`'s unfrozen `Interp` binds `lockdown` and allows `new Compartment()` before
`lockdown()`.
Other code already knows this: `natives/compartment.rs:98-101` says a default `Interp::new()`
"now can" hold a compartment, and `persist.rs:657-677` and `restore.rs:113-118` handle the
shared-but-not-locked-down case.

`ARCHITECTURE.md:337` names a `DispatchOutcome` type that does not exist.
The control-outcome enum is `Step` (`interp.rs:1858`).
The comment block around `realm.rs:875` also cites stale line numbers (`:201-203`,
`invoke.rs:171`, `:186`).

**Consequence:**

- **The ambiguity has already produced inconsistent code twice.**
  - `realm.rs:306-309` records an earlier lockdown check that "read the AMBIENT environment, which
    a guest steers by queueing a promise job".
  - ONT-5 is the same class of bug, and it is still live in `eval` and `Function`.
- **An embedder can be misled.** Reading `ARCHITECTURE.md:114`, an embedder would believe a
  compartment's prototype-chain constructors reach the default global. The tests pin the
  opposite.
- **Pre-flip closures run in the child.** On the `ironhorse-xst` host, a closure created before
  the first guest Compartment reads the child's globals and defines globals on the child when the
  child calls it. A closure created afterwards reads START, and SES answers START for both.
  The coverage review verified this consequence as COV-5 (medium). It holds on every bare
  `Interp::new()` host with the native Compartment, including for closures created after
  `lockdown()`, which does not set the flag; `Machine::new()` sets it at construction and is
  unaffected (`rust/engine/ironhorse-vm/src/interp/realm.rs:854`; full entry: ../COVERAGE.md).
- **The stale lockdown justification is harmless.** A child compartment calling `lockdown()`
  freezes the realm in both `ironhorse-xst` and SES.

**Evidence:** The finder's evidence:

```
Static: the five sites quoted above. Behaviour: probes p1.js and p2.js and zz_audit_ont_1.rs (ONT-5 and ONT-14) show that the actual meaning is caller-or-pump. p0.js on an unfrozen ironhorse-xst gives typeof lockdown === 'function' and typeof Compartment === 'function', and p1.js constructs a Compartment before calling lockdown(), contradicting realm.rs:311-313. 'grep -rn DispatchOutcome rust/engine --include=*.rs' finds no matches; the only hit is ARCHITECTURE.md:337.
```

The verifier's probe `probes/ontology/verify-ont30/p4.js`:

```
globalThis.marker = 'START';
const readBefore = function () { return globalThis.marker; };
const defineBefore = function () { globalThis.definedByBefore = 1; };
const c = new Compartment({ globals: { marker: 'CHILD' } });
const readAfter = function () { return globalThis.marker; };
const defineAfter = function () { globalThis.definedByAfter = 1; };
const callIn = c.evaluate('(f) => f()');
const r = {};
r.readBefore = callIn(readBefore);
r.readAfter = callIn(readAfter);
callIn(defineBefore); callIn(defineAfter);
r.startHasBefore = typeof globalThis.definedByBefore;
r.childHasBefore = c.evaluate('typeof globalThis.definedByBefore');
r.startHasAfter = typeof globalThis.definedByAfter;
r.childHasAfter = c.evaluate('typeof globalThis.definedByAfter');
throw new Error(JSON.stringify(r));
- ironhorse-xst: {"readBefore":"CHILD","readAfter":"START","startHasBefore":"undefined","childHasBefore":"number","startHasAfter":"number","childHasAfter":"undefined"}
- node22 + packages/ses (p4_ses_node.mjs, same body): {"readBefore":"START","readAfter":"START","startHasBefore":"number","childHasBefore":"undefined","startHasAfter":"number","childHasAfter":"undefined"}
```

The verifier's probe `p5.js` (a child calls `lockdown()`):

```
- ironhorse-xst: {"childTypeofLockdown":"function","startFrozenBefore":false,"childLockdown":"ok","startFrozenAfter":true,"startLockdown":"threw TypeError: lockdown already called"}
- SES/node: {"childTypeofLockdown":"function","startFrozenBefore":false,"childLockdown":"ok","startFrozenAfter":true,"startLockdown":"threw TypeError: Already locked down ..."}
```

**Recommendation:**

1. Once ONT-5 and ONT-14 are fixed, delete the NULL meaning altogether by replacing it with an
   explicit `Home` type.
2. Rewrite `ARCHITECTURE.md:114` to state the rule the code implements.
3. Correct the field docs at `interp.rs:845`, `:2139` and `:2314`.
4. Restate the `realm.rs:311-313` justification. The conclusion stands on its SES-faithfulness
   ground; the invariant it cites does not hold on the guest-constructed shared-compartment path.
5. Fix the stale line references near `realm.rs:875`.
6. Rename `DispatchOutcome` to `Step` in `ARCHITECTURE.md:337`.

**Verification:**

- **What it confirmed.** The verifier confirmed every quoted site, and that `switch_environment`
  is the only consumer of NULL.
  - It re-ran `p1`, which shows the prototype route compiling against CHILD before lockdown.
  - It re-ran the ONT-5 job probes, which confirm the pump half of "caller-or-pump".
  - It confirmed with grep that `DispatchOutcome` exists only in `ARCHITECTURE.md`.
- **What it narrowed.** It showed with `p5` that the stale `realm.rs:311-313` justification has
  no harmful consequence.
- **What it added.** It added `p4`, showing the "standalone default" doc is false for ordinary
  pre-flip closures, against SES. It flagged that case as an uncovered correctness lead, listed
  under the leads below; the coverage review has since verified it as COV-5.
- **Severity.** It kept the finding at low as doc and comment drift.

### ONT-31 — Identifier documentation gives stale values: ARCHITECTURE.md's 'current value' table says format 24 / store 36 / row 5 (code: 26 / 38 / 6), the row contract still documents a FromAsync refusal, designs/README.md says store 36, and the harness reports a 'version-4 meter pin'

**Severity:** low (proposed low; verifier low).

**Category:** doc-code-drift.

**Locations:**

- `rust/engine/ARCHITECTURE.md:386`, `:387`, `:388`
- `rust/engine/ironhorse-snapshot/src/format.rs:246`
- `rust/engine/ironhorse-snapshot/src/store.rs:128`
- `rust/engine/ironhorse-vm/src/snapshot_api.rs:11`
- `rust/engine/ironhorse-snapshot/tests/fixtures/row_schema_releases.tsv:7`
- `rust/engine/ironhorse-vm/src/interp/snapshot_rows.rs:371`
- `rust/engine/ironhorse-262/src/xst.rs:619`
- `designs/README.md:1567`. The verifier refuted this location: the line is correct history (see
  below).
- Added by the verifier:
  - `snapshot_rows.rs:436-449`
  - `rust/engine/ironhorse-vm/src/interp/persist.rs:678-707`, `:2897-2900`, `:3228-3238`
  - `rust/engine/ironhorse-meter/src/releases.rs:19`
  - `rust/engine/ironhorse-262/tests/w2_meter_support/mod.rs:1`, `:13`, `:15`
  - `rust/engine/ironhorse-snapshot/tests/row_schema.rs:96`
  - `rust/engine/ironhorse-snapshot/tests/documentation_contract.rs`

**Excerpt:**

```
ARCHITECTURE.md:386 `IRONHORSE_FORMAT_VERSION | Snapshot format.rs: 24`; :387 `STORE_SCHEMA_VERSION | Snapshot store.rs: 36`; :388 `ROW_SCHEMA_VERSION | VM snapshot_api.rs: 5`. Code: format.rs:246 `pub const IRONHORSE_FORMAT_VERSION: u32 = 26;`, store.rs:128 `pub const STORE_SCHEMA_VERSION: u32 = 38;`, snapshot_api.rs:11 `pub const ROW_SCHEMA_VERSION: u32 = 6;`. snapshot_rows.rs:371-374 "Bytes 7–10 (the four FromAsync*s) name Array.fromAsync machinery no row carries, so the persist gate refuses a machine holding one ... and the decoder refuses the byte."
```

**Mechanism:**

ARCHITECTURE.md's "Release and compatibility identifiers" table is headed "Owner and current
value" and is presented as the authoritative map.
The code has moved past it by two format bumps, two schema bumps and one row-schema bump:

- format 25 / store 37 added WKRF/FNRG (WeakRef and FinalizationRegistry rows) with row schema 6;
- format 26 / store 38 added resizable buffers (`format.rs:238-246`; `versions.rs:39-47`).

The meter row (`ironhorse-meter-9`) is current, which makes the stale rows next to it look
authoritative too.
Nothing checks the table: `documentation_contract.rs` reads only `sidetable.rs`, `row_schema.rs`
never reads ARCHITECTURE.md, and `check-row-schema.py` reads no `.md` file.

The FromAsync note at `snapshot_rows.rs:371-374` is false today.

- The persist gate whitelists all four FromAsync kinds (`persist.rs:678-707`: they "all resume").
- The encoder writes kinds 7 to 10 (`persist.rs:2897-2900`), and the decoder accepts them
  (`persist.rs:3228-3238`, "carried in `ASYN` since format 24").
- The same file contradicts itself: the `FromAsyncRow` doc at `snapshot_rows.rs:436-449`
  describes the arena that travels.
- The row ledger's fingerprint ignores doc comments (`row_schema.rs:96`), so the row-schema gate
  cannot catch this drift.

`xst.rs:619`, `:625` and `:629` report a "version-4 meter pin" while checking for
`ironhorse-meter-9` and the prefix `ironhorse-meter-9-raw-`.
`ironhorse-meter-4` is a real, different pinned release (`releases.rs:19`), so the message names
the wrong release.
The same stale label recurs in `ironhorse-262/tests/w2_meter_support/mod.rs:1` ("Version-2 costs"),
`:13` and `:15` ("version-4 pin"), around a meter-9 assertion.

`designs/README.md:1567` ("phase 13 (#1331, store schema 36) moved it to a trusted store") is
accurate history, not a claim about the current version, and is dropped.
ARCHITECTURE.md's "Release 3 …" note is also accurate history; it is incomplete rather than wrong.

**Consequence:**

ARCHITECTURE.md:375-404 sends readers to this table for compatibility decisions, and the table
misstates three of the five compatibility identifiers.
A reader who uses it to judge whether a stored heap is current gets it wrong:

- a schema-38 store looks newer than the "current" schema 36;
- a row-schema-6 image looks unknown.

A reviewer asking whether a heap holding WeakRef, FinalizationRegistry or resizable buffers can
be persisted gets the pre-WeakRef answer.
Under format 24 / row 5, such machines were refused at the persist gate.
The row contract still documents a refusal that no longer exists.

None of this has a runtime effect, because the engine's gates never consult the table.

**Evidence:**

From the finders (static):

```
[vocabulary] static: the constants at the listed lines vs the table. versions.rs:42-45 documents the 36→37→38 steps; format.rs:238-246 documents formats 25 and 26.

[identity] Static: grep for `pub const` gives IRONHORSE_FORMAT_VERSION: u32 = 26 (format.rs:246), STORE_SCHEMA_VERSION: u32 = 38 (store.rs:128) and ROW_SCHEMA_VERSION: u32 = 6 (snapshot_api.rs:11). persist.rs:3235 `7 => ReactionKind::FromAsyncNext(r.a)`. No documentation_contract test checks the table.

[doc-model] static: format.rs:246, store.rs:128, snapshot_api.rs:11; ledger row `6	25	37	fd8f…`; versions.rs:39-47 documents the 25/37 and 26/38 releases.
```

From the verifier's probe, `probes/ontology/ont31-verify/probe.sh` (output abridged):

```
== doc table ==
384:| `COST_TABLE_VERSION` | `ironhorse-meter/src/lib.rs`: `ironhorse-meter-9` |
386:| `IRONHORSE_FORMAT_VERSION` | Snapshot `format.rs`: 24 | ...
387:| `STORE_SCHEMA_VERSION` | Snapshot `store.rs`: 36 | ...
388:| `ROW_SCHEMA_VERSION` | VM `snapshot_api.rs`: 5 | ...
== code ==
246:pub const IRONHORSE_FORMAT_VERSION: u32 = 26;
128:pub const STORE_SCHEMA_VERSION: u32 = 38;
11:pub const ROW_SCHEMA_VERSION: u32 = 6;
15:pub const COST_TABLE_VERSION: &str = "ironhorse-meter-9";
== ledger tail ==
6	25	37
== row-contract note vs gate/decoder ==
/// request. Bytes 7–10 (the four `FromAsync*`s) name `Array.fromAsync`
/// machinery no row carries, so the persist gate refuses a machine holding
/// one ([`Interp::stored_unpersistable_row`]) and the decoder refuses the
/// byte. ...
                        | ReactionKind::FromAsyncNext(_)      <- persist gate whitelist
                        | ReactionKind::FromAsyncElem(_)
                        | ReactionKind::FromAsyncMap(_)
                        | ReactionKind::FromAsyncClose(_)
                                7 => ReactionKind::FromAsyncNext(r.a),   <- decoder accepts
                                8 => ReactionKind::FromAsyncElem(r.a),
                                9 => ReactionKind::FromAsyncMap(r.a),
                                _ => ReactionKind::FromAsyncClose(r.a),
== harness wording ==
617:            || ironhorse_vm::meter::COST_TABLE_VERSION != "ironhorse-meter-9"
619:            return Verdict::Fail("invalid or incompatible version-4 meter pin".into());
622:            .strip_prefix("ironhorse-meter-9-raw-")
625:            return Verdict::Fail("invalid version-4 raw meter pin".into());
629:                "version-4 meter violation: expected={expected} actual={} raw",
```

**Recommendation:**

1. Update the three stale cells, and add the row release 6 note (format 25 / store 37, with
   26 / 38 as an encoding-only step).
2. Generate the value column from the constants, test it against them in
   `documentation_contract.rs` or the `row_schema` test (as is done for the side-table ledger),
   or drop the values and keep only owner and bump rule.
3. Fix the reaction-kind note at `snapshot_rows.rs:371-374`.
4. Rename the harness messages, and the `w2_meter_support` comments, to the meter release they
   check.

**Verification:**

- The verifier re-opened every location.
- It confirmed the three stale cells beside a current meter row, and that nothing guards the
  table.
- It confirmed the FromAsync note is false against the gate, the encoder and the decoder, and
  that the file contradicts itself.
- It confirmed the "version-4" mislabel and found it spread to the `w2_meter_support` tests.
- It refuted the `designs/README.md:1567` location as correct history.
- It reclassified the evidence from "confirmed by probe" to confirmed static comparison.
- It kept the severity low: documentation drift with no runtime effect.

### ONT-32 — The VERS stamp does not identify container content for formats 25 and 26: an older stamp carrying WeakRef, FinalizationRegistry or resizable-buffer state is accepted, so one machine has several canonical encodings

**Severity:** low (proposed low; verifier low).

**Category:** identity-versioning.

**Same root as:** SNI-9 (low) is a near neighbour: other accepted-but-meaningless degrees of
freedom break "one machine, one container encoding".

**Locations:**

- `rust/engine/ironhorse-snapshot/src/snapshot_roster.rs:2550` (the trailer check for format 23),
  `:2723` (the WKRF decoder)
- `rust/engine/ironhorse-snapshot/src/image.rs:1896`, `:5173`
- `rust/engine/ironhorse-snapshot/src/format.rs:180` (the quoted sentence runs over `:180-181`)
- Added by the verifier:
  - `snapshot_roster.rs:2555` (the trailer check for format 24)
  - `image.rs:1891-1906` (`decode_buffers`), `:1955-1980` (`decode_typed_arrays`), `:5196-5254`
    (where the stamp is raised), `:5438` (the canonical check)
  - `rust/engine/ironhorse-snapshot/src/machine.rs:861`
  - `rust/engine/ironhorse-snapshot/src/store.rs:2070`

**Excerpt:**

```
snapshot_roster.rs:2550: if !section.1.is_empty() && version.format_version < 23 { return Err(... "async generators: trailer in a pre-format-23 container") }
(no analogue for WKRF/FNRG at :2723 or for ABUF flag bit 2 at image.rs:1896)
```

**Mechanism:**

The reader and the writer each tie some content to a minimum container format.

- **Reader.** It refuses a section that the container's stamp could not carry. It does this for
  format 23 content (`:2550`) and format 24 content (`:2555`).
- **Writer.** `encode_machine` (`image.rs:5196-5254`) raises the stamp for format 15, 17, 18, 19,
  23 and 24 content.

Neither side was extended for formats 25 and 26:

- **Format 25:** the WKRF and FNRG atoms. Their decoders take no version argument.
- **Format 26:** the ABUF resizable bit and maximum (`decode_buffers`), and the TARR/DVIW
  `u32::MAX` length-tracking sentinel (`decode_typed_arrays`). Neither decoder checks the version.

The canonical check at `image.rs:5438` re-encodes the image under its own stamp.
When the writer raises the stamp, that check also acts as the reader's gate.
For example, a plain machine re-stamped to 16 is refused as "non-canonical", because the
re-encode raises it to 18.
For format 25 and 26 content nothing raises the stamp, so a down-stamped container round-trips
and is admitted.

**Consequence:**

- **What is admitted.** A stamp can understate the container's content:
  - containers stamped 16 to 24 that carry WKRF or FNRG;
  - containers stamped 16 to 25 that carry a resizable ABUF row or the TARR/DVIW sentinel.

  An actual reader for the stamped format would refuse them, so the stamp no longer tells a
  reader or tool which older readers can accept the bytes.
- **What the finder overstated.** The finder concluded that "one machine has several canonical
  encodings", contradicting `format.rs:180-181`. That is not caused by this gap. Every machine is
  accepted under every stamp from its content's floor up to 26: a plain machine is accepted under
  15, 20, 24, 25 and 26, each with a different SHA-256. The recommended fix would not change that.
- **Who reaches it.** Only crafted containers, or tooling that republishes them:
  - IronHorse writers stamp `Version::current()` (`machine.rs:861`).
  - The image-batch manifest (`store.rs:2070`) copies `image.version`, but an honest older image
    cannot hold this content.
  - The restored machine behaves correctly: resize and deref both work.

**Evidence:**

The finder's probe is in `probes/ontology/identity/`:

```
Probe zz_audit_ont_3.rs: snapshot a machine, rewrite the 4 version bytes after `IRON` in VERS, then read_machine and from_snapshot_bytes.
control (suspended async generator, ASYN trailer): stamp 22 -> refused: async generators: trailer in a pre-format-23 container; stamp 23 -> accepted
"var t = {}; var w = new WeakRef(t); var b = new ArrayBuffer(4, { maxByteLength: 16 }); var u = new Uint8Array(b); 0":
  writer stamp 26 sha256[..16]=3a8eebbbc91908b9
  stamp 20: ACCEPTED (sha256[..16]=6753856068fe8ce3); observe "b.resize(12); [w.deref() === t, b.resizable, b.maxByteLength, u.length].join()" -> "true,true,16,12"
  stamp 24: ACCEPTED (b1fc9ee2a41789e1) -> same
  stamp 25: ACCEPTED (89e405c22d5accc3) -> same
```

The verifier's probe is `probes/ontology/ont32-verify/zz_audit_ont_932.rs`:

```
=== plain machine (no format-specific content)
  writer stamp-26 sha256[..16]=a7dbb26e44b1c5ae atoms=[]
  stamp 15: ACCEPTED (image.version=15, sha256[..16]=772331a9932f1868) observe -> "Return" "1"
  stamp 16: refused: corrupt payload: non-canonical machine encoding
  stamp 20: ACCEPTED (image.version=20, sha256[..16]=9df2fe6f55a45edc) observe -> "Return" "1"
  stamp 24: ACCEPTED (image.version=24, sha256[..16]=5595f62c7f60ba5f) observe -> "Return" "1"
  stamp 25: ACCEPTED (image.version=25, sha256[..16]=4abacc5cb8b955b6) observe -> "Return" "1"
=== control: suspended async generator (ASYN format 23 trailer)
  stamp 16: refused: corrupt payload: async generators: trailer in a pre-format-23 container
  stamp 22: refused: corrupt payload: async generators: trailer in a pre-format-23 container
  stamp 23: ACCEPTED (image.version=23, sha256[..16]=c250003f859ae242) observe -> "Return" "object"
=== WeakRef only (WKRF, format 25)
  stamp 16: refused: corrupt payload: non-canonical machine encoding
  stamp 24: ACCEPTED (image.version=24, sha256[..16]=a6db042eaee96aec) observe -> "Return" "true"
=== FinalizationRegistry only (FNRG, format 25)
  stamp 16: refused: corrupt payload: non-canonical machine encoding
  stamp 24: ACCEPTED (image.version=24, sha256[..16]=15609d2dc13e915e) observe -> "Return" "function"
=== resizable ArrayBuffer + length-tracking view (ABUF bit 2 / TARR sentinel, format 26)
  writer stamp-26 atoms=[ABUF,TARR]
  stamp 16: refused: corrupt payload: non-canonical machine encoding
  stamp 24: ACCEPTED (image.version=24, sha256[..16]=336ce666c8c21000) observe -> "Return" "true,16,12"
  stamp 25: ACCEPTED (image.version=25, sha256[..16]=fa3f84d093a53008) observe -> "Return" "true,16,12"
```

**Recommendation:**

1. **Raise the stamp in `encode_machine`.** Raise it to 25 for WKRF and FNRG content, and to 26
   for a resizable ABUF row or the sentinel. The canonical re-encode check then refuses lower
   stamps from 16 up.
2. **Add explicit reader gates as defence in depth.** These would be analogues of
   `snapshot_roster.rs:2550` for formats 25 and 26.
3. **Drive both sides from one table.** A single table mapping each atom or feature to its minimum
   format means a new format cannot skip either side.

**Verification:**

- The verifier confirmed the format 23 and 24 reader checks.
- It confirmed that the format 25 and 26 decoders take no version, and that the writer raises the
  stamp for the earlier formats only.
- Its probe showed WKRF, FNRG and resizable-buffer state admitted under understated stamps, while
  the ASYN control is refused.
- It also showed that a plain machine is accepted under several stamps. The multiplicity of
  encodings therefore does not come from this gap, and that part of the consequence was dropped.
- It identified the writer-side raise as sufficient for stamps from 16 up.
- It noted that the claim "a pre-26 reader rejected flag bit 2" cannot be verified at this
  checkout, because history is squashed into root commit `503400ed`.

### ONT-33 — The store-schema migration ladder sits behind the boot-fingerprint gate, which moves with every new built-in, so its steps run only on states the tests synthesize

**Severity:** low (proposed low; verifier low).

**Category:** identity-versioning.

**Same root as:** SNS-7 (low) is a near neighbour: migration-ladder steps are tested only on
stores the current build synthesizes, and every real-bytes fixture stops at the boot gate.

**Locations:**

- `rust/engine/ironhorse-snapshot/src/store.rs:1679` (`migrate_store`), `:1745` (`migrate_step`)
- `rust/endo/ironhorse-store-sqlite/tests/migration_fixtures.rs:193`
- `rust/engine/ARCHITECTURE.md:387`

Added by the verifier:

- `store.rs:1690-1691` (the boot checks), `:1732-1735` (the ladder)
- `rust/engine/ironhorse-snapshot/src/format.rs:444-452` (`check_boot`)
- `rust/engine/ironhorse-vm/src/interp/boot.rs:110-240` (the fingerprint)
- `migration_fixtures.rs:150-151`, `:204-221`
- `rust/engine/ironhorse-snapshot/src/versions.rs:23`
- `rust/engine/ARCHITECTURE.md:408-410`
- `rust/endo/src/ironhorse_engine.rs:1171` and `rust/thixotrope-ironhorse-worker/src/main.rs:274`
  (production callers)

**Excerpt:**

```
store.rs:1690-1691: from.signature.check_boot()?; expected_sig.check_boot()?;  (before the 5→38 ladder at store.rs:1732-1735)
migration_fixtures.rs:196-199: "only a build with the boot layout that wrote it could migrate it, and no build since ... has that layout"
```

**Mechanism:**

Two identifiers overlap in scope: `STORE_SCHEMA_VERSION` (the representation) and the boot
fingerprint (the engine layout).

- **The gate runs first.** `migrate_store` checks `from.signature.check_boot()` and
  `expected_sig.check_boot()` (`store.rs:1690-1691`) before the ladder runs (`:1732-1735`).
  `check_boot` compares against `Interp::boot_fingerprint()` for the running engine, and nothing
  bypasses it.
- **The fingerprint moves often.** It hashes every boot slot, function, intrinsic and key-order
  table. The visible history has three boot-moving restamps: meter-8, meter-9 and the key order.
  None of them changed `STORE_SCHEMA_VERSION`, which is 38 throughout.
- **So a ladder step serves one layout only.** It can upgrade only a store that a binary with
  today's exact boot layout wrote.

`STORE_SCHEMA_VERSION` was already 38 at the oldest visible commit, `503400ed`.
`Float16Array` (`9e7fb7d4`) entered the boot layout after that commit.
Every build that ever wrote a schema below 38 therefore has a different boot fingerprint.
At this commit, every ladder step (5 to 38) is unreachable for any store a real build wrote.

The same holds for the legacy code that only the ladder uses: the small-state decoders
(`store_sections.rs`, `decode_legacy`) and `names_to_cesu8`.
It serves only states the tests create by restamping current-layout stores to older schemas.

**Consequence:**

- **No genuine fixture migrates.** All six committed old-schema fixtures (file, SQLite and
  container forms at schemas 5 and 35, plus `compat-8047.sqlite`) are refused by the boot gate.
- **Every successful migration test is synthetic.** Each one first writes a fresh current-layout
  store and then restamps it down.
- **Production callers stop before the ladder.** Callers exist (`rust/endo/src/ironhorse_engine.rs:1171`,
  `rust/thixotrope-ironhorse-worker/src/main.rs:274`), but for any real older store they can only
  stop at the boot gate or at the schema-equals-current check.
- **The docs only partly warn.** `versions.rs:23` and `ARCHITECTURE.md:408-410` do say that boot
  identity gates old state independently. Neither says that `migrate_store` checks boot before
  the ladder, so that a ladder step serves only one boot-layout generation. The
  `STORE_SCHEMA_VERSION` row at `ARCHITECTURE.md:387` names only meter semantics as excluded.
- **A test comment contradicts its own test.** `migration_fixtures.rs:150-151` says the stage-1
  fixture is "Frozen for stage 2, which migrates it", while the test 50 lines later asserts that it
  is refused.

**Evidence:**

From the finder (static):

```
migration_fixtures.rs:204-221 (test `stage1_sqlite_fixture_refuses_a_later_boot_layout`) asserts BootLayoutMismatch for the committed schema-35 SQLite fixture. The migrating twin `stage1_history_at_schema_35_migrates_and_resumes` (:231-) writes a fresh store under the current layout and restamps its manifest to schema 35. Static: store.rs:1690-1691 precede the ladder.
```

The verifier's runs are saved in `probes/ontology/ont-33-verify/migration-tests.out` and
`history.out`:

```
cargo test -p ironhorse-snapshot --test migration -- historical_unfingerprinted stage1_file_store_fixture_refuses stage1_history_at_schema_35
test historical_unfingerprinted_store_and_container_refuse_without_migration ... ok
test stage1_file_store_fixture_refuses_a_later_boot_layout ... ok
test stage1_history_at_schema_35_migrates_and_resumes ... ok
test result: ok. 3 passed; 0 failed

## schema at oldest visible commit 503400ed
128:pub const STORE_SCHEMA_VERSION: u32 = 38;
## Float16Array in VM src at 503400ed (count lines):
0
## at 61cd656c:
61cd656c:rust/engine/ironhorse-vm/src/interp.rs:3
61cd656c:rust/engine/ironhorse-vm/src/interp/intrinsic_order.rs:3
61cd656c:rust/engine/ironhorse-vm/src/interp/tests.rs:1
## boot-moving commits since 503400ed
8af3bbc9 chore(ironhorse-snapshot): restamp the persisted identities for the intrinsic key order
392502d3 chore(ironhorse-snapshot): restamp the persisted identities for meter-9
20a43524 chore(ironhorse-snapshot): restamp the persisted identities for meter-8
```

**Recommendation:**

1. **State the coupling.** In `ARCHITECTURE.md` and `versions.rs`, say that a store migration is
   usable only within one boot-layout generation, and that `migrate_store` checks boot first.
2. **Retire or separate.** Either retire ladder steps older than the last fingerprint move, or
   separate a layout-independent store identity from the execution identity, so representation
   migrations stay meaningful.
3. **Fix the contradicting comment** at `migration_fixtures.rs:150-151`.

**Verification:**

- **Confirmed.** The verifier re-opened the gate and the ladder and confirmed the order. It
  confirmed that `check_boot` compares against the running engine's fingerprint with no bypass.
- **Reproduced.** It re-ran the three tests: the genuine fixtures are refused, and only the
  restamped twin migrates. It used history to show that schema 38 predates the current boot
  layout, so every step is unreachable for real stores. That is stronger than the finder's
  "common case" estimate.
- **Narrowed.** It narrowed the documentation claim, since `versions.rs:23` and
  `ARCHITECTURE.md:408-410` do warn about boot identity.
- **Added.** It added the stale `ARCHITECTURE.md:387` value (see ONT-31) and the contradicting
  fixture comment.

### ONT-34 — Symbol property-key ids are bump-allocated and never returned after GC proves them dead, so garbage symbols permanently consume the shared 16-bit key space

**Severity:** low. The finder proposed low and the verifier agreed.

**Category:** identity-versioning.

**Same defect as:** PROP-2 (medium), the primary.
ONT-34 is low on its own and medium as merged.

**Locations:**

- `rust/engine/ironhorse-vm/src/interp/property/keys.rs:199`.
- `rust/engine/ironhorse-vm/src/interp/gc_tables.rs:958`.
- `rust/engine/ironhorse-vm/src/interp/state.rs:1522`. That line is the `#[snapshot_table(none)]`
  attribute; the doc comment is at `:1523-1531` and the field itself at `:1532`.
- `rust/engine/ARCHITECTURE.md:349`.
- `rust/engine/ironhorse-vm/src/interp/link.rs:1270`.
- Added by the verifier:
  - `rust/engine/ironhorse-vm/src/interp/symbol_keys.rs:37-49`;
  - `rust/engine/ironhorse-vm/src/interp/gc_tables.rs:868-893`;
  - `rust/engine/ironhorse-vm/src/interp/realm.rs:1283`;
  - `rust/engine/ironhorse-vm/src/interp/persist.rs:4216-4224`, `:4244`, `:4252`, `:4288`;
  - `link.rs:1346`;
  - `c/moddable/xs/tools/xst.h:111`;
  - `c/moddable/xs/sources/xsMemory.c:504-515`.

**Excerpt:**

```
keys.rs:196-200: `let id = self.next_symbol_key_id; ... self.next_symbol_key_id -= 1; self.symbol_key_ids.insert(desc, id);`
gc_tables.rs:958-962: "An intern whose descriptor stayed unmarked through the fixpoint has no live property using its id and no other reference: drop the mapping (the sweep reclaims the descriptor slot itself)." `$vm.$field.retain(|d, _| $slots.is_marked(*d));`
```

**Mechanism:**

A Symbol has two identities with different lifetimes:

- its value identity, the descriptor slot, which the GC can collect;
- its property-key identity, a `u16` taken from a counter that only moves down
  (`intern_symbol_key_reserved`, `keys.rs:187-201`).

Only three places write `next_symbol_key_id`: the decrement at `keys.rs:199`, realm boot
(`realm.rs:1283`), and snapshot restore, which copies the persisted value exactly
(`persist.rs:4288`).

The `symbol_keys` GC trace (`gc_tables.rs:868-893`) scans the stored key ids of marked slots.
It proves that no live record names an id.
The prune arm (`gc_tables.rs:958-962`) then removes the descriptor-to-id mapping.
`SymbolKeys::retain` (`symbol_keys.rs:37-49`) removes the forward and reverse entries and nothing
else.
No free list exists, and the SYMB row saves and restores the counter unchanged.

The model therefore treats keyed symbols as garbage, while their key ids stay consumed for the
machine's lifetime, across snapshots too.

XS's own `xst` build reclaims key ids through keyholes (`xst.h:111` sets `mxKeysGarbageCollection 1`;
`xsMemory.c:504-515`).
The default XS build does not.

Tagged-template site keys take one id per compiled site, but from the upward name table:
`apply_template_site_ids` interns a `"\0ironhorse-template-site:N"` name through `append_name_key`
(`link.rs:1346`).
They share the 16-bit space but are name-table growth, not symbol-key ids.

**Consequence:**

A guest that uses throwaway symbols as property keys exhausts the 16-bit space it shares with
string names after about 64.4K uses in the machine's lifetime.
An example is `o[Symbol()] = v` on short-lived objects.
This happens even if every one of those symbols and objects has been collected.

After that:

- any novel string or symbol key throws `RangeError`;
- `relink_crank` refuses every later crank whose source introduces a novel identifier, with
  `TableFull`, so the machine can no longer load new code that introduces a name.

The failure is handled gracefully: a catchable `RangeError` for guests and `TableFull` for the
host, with no panic or corruption.

`ARCHITECTURE.md:349-353` already says guest string and symbol keys get "exhaustion handling, not
reclamation or an unlimited lifetime key budget".
It does not say that GC prunes the symbol mapping yet keeps the id consumed, nor that relink then
fails for good.

**Evidence:**

The finder's probe is `probes/ontology/types/zz_audit_ont_1.rs`, plus two JS probes:

```
Rust probe ../probes/ontology/types/zz_audit_ont_1.rs, run as ironhorse-vm/tests/zz_audit_ont_1.rs with CARGO_TARGET_DIR=$SCRATCH/audit-target and deleted afterwards:
  const MINT = "var n=0; var err='none'; try { for (var i=0;i<40000;i++){ var o={}; o[Symbol('s')]=i; n=i+1; } } catch(e){ err=e.name+':'+e.message; } 'minted='+n+' err='+err";
  crank1 = run(MINT); m.collect_garbage(); crank2 = relink+run(MINT); m.collect_garbage(); crank3 = relink("var k='fresh'+1; var o={}; ... o[k]=1 ...")
Observed:
  crank1: completed=true result=minted=40000 err=none
  gc: GcStats { slots_reclaimed: 119997, slots_live: 1107, ... } free_list 0 -> 119997
  crank2 (after GC): completed=true result=minted=24412 err=RangeError:property key space exhausted
  thread panicked at zz_audit_ont_1.rs:31:39: relink: TableFull   (crank3 cannot even be linked)
In a single xst run, p6d_symkeys.js gives `caught=RangeError:property key space exhausted n=64409`. In p12d_private_budget.js, private names do not consume ids: 64403 symbol keys could still be minted after 20000 class evaluations.
```

The verifier's probes are in `probes/ontology/ont-34-verify/`.
The first is `p6d_symkeys.js`:

```
var caught = 'none', n = 0;
try { for (var i = 0; i < 200000; i++) { var o = {}; o[Symbol('s')] = i; n = i; } } catch (e) { caught = e.name + ':' + e.message; }
throw new Error('caught=' + caught + ' n=' + n);
- ironhorse-xst: `Error: caught=RangeError:property key space exhausted n=64409`
- node: `Error: caught=none n=199999`
```

The second is `zz_audit_ont_34.rs`, in which FRESH uses only identifiers MINT already interned:

```
crank1: completed=true result=minted=40000 err=none
gc1: GcStats { slots_reclaimed: 119997, slots_live: 1107, chunk_bytes_before: 257340, chunk_bytes_after: 196614 } free_list 0 -> 119997
crank2 (after GC): completed=true result=minted=24412 err=RangeError:property key space exhausted
gc2: GcStats { slots_reclaimed: 73242, slots_live: 1106, ... }
crank3 (fresh runtime string key, no novel identifier): completed=true result=RangeError:property key space exhausted halt=Return
crank4 relink (novel identifier): TableFull
```

The verifier's JS probes also show:

- `p12b_tagged.js`: 70,000 calls of `eval('tag`x`')` stop at 64,407 on IronHorse, while Node runs
  all 70,000. This is name-table growth.
- `p12d_private_budget.js`: private names do not consume ids.
- `p12c_symbol_noskey.js`: a symbol used only as a Map key consumes no id; only key use does.

**Recommendation:**

1. Have the `symbol_keys` prune arm put the proven-dead ids on a free list. The `stored_key_id`
   scan already shows they are unreferenced.
2. Persist the free list with the SYMB row, and allocate from it before decrementing
   `next_symbol_key_id`.
3. Adjust the restore validator. It currently rejects any persisted pair whose id is not above the
   counter (`persist.rs:4244`, `:4252`).
4. Alternatively, document a lifetime budget for symbol keys and for tagged-template sites next to
   the name-table note in `ARCHITECTURE.md`. State that `relink_crank` fails permanently once the
   budget is used up.

**Verification:**

- **Confirmed.** The verifier re-opened every site:
  - the counter only ever moves down;
  - the prune arm only removes mappings;
  - no free list exists;
  - the SYMB row persists the counter as is.
- **Checked against XS.** It confirmed the XS comparison in `xst.h` and `xsMemory.c`.
- **Reproduced.** It re-ran every probe. After a full GC that leaves 1,107 live slots, only
  24,412 more symbol keys can be minted. A fresh string key then throws, and a novel identifier
  cannot be relinked.
- **Corrected.** Tagged-template sites come from the name table, not the symbol-key range, and
  `state.rs:1522` is an attribute line.
- **Noted.** The limit is partly documented, and a free list needs a change to the restore
  validator.
- **Severity.** It kept low: a lifetime resource bound handled gracefully.

## Leads that did not survive

### Refuted findings

- **ONT-4 — A later crank's first JSON.stringify of a Date returns "{}" on the standalone
  Interp/relink_crank path; the fix commit aaec6a06 changed nothing observable and its own
  regression test fails at HEAD** (identity; proposed high).
  - **Refuted by:** the code-evidence verifier.
  - **What a fresh build shows:** a fresh build of pristine `61cd656cb` passes `name_floor_carry`
    11 of 11. Every case in the finder's probes, including `JSON.stringify([new Date(0)])`, gives
    the ISO string.
  - **Where the finder's output came from:** a copy with `aaec6a06` reverted. Because the copy and
    the repository share one artifact in the shared `CARGO_TARGET_DIR` (see Method), the
    repository's tests linked that reverted copy. Applying the revert patch reproduces the
    finder's assertion byte for byte, so `aaec6a06` does fix the bug.
- **ONT-18 — Two production SourceCompiler adapters: the thixotrope worker's lacks
  compile_eval_units, so direct eval of new.target/super/#x is a SyntaxError there** (doc-model;
  proposed medium).
  - **First verifier:** kept it at medium. It ran the real worker binary without boot files.
  - **Refuted by:** the consequence-and-intent verifier. In the worker's only production
    configuration, `boot.js` runs SES `lockdown()`, which replaces the start compartment's
    `eval` with the safe evaluator. Guest `eval(` is then rejected with `SES_EVAL_REJECTED`.
  - **What survives is low:** through the tamed evaluator, Node plus SES also throws
    `SyntaxError` for `#x` and `super`. The surviving residue (`compartment.evaluate('typeof
    new.target')`) is an artifact of the SES shim, and the adapter duplication is low-severity
    documentation drift. The worker's adapter is at
    `rust/thixotrope-ironhorse-worker/src/main.rs:17-116`; a third copy is at
    `rust/engine/wasm-worker-spike/src/session.rs:25`.

### Open leads raised during verification

This lens did not verify these leads as findings.
The coverage review has since settled all five (full entries: ../COVERAGE.md).

- **`new.target` in direct eval inside non-constructors** (raised by the ONT-18
  consequence-and-intent verifier).
  - **Mechanism:** `rust/engine/ironhorse-vm/src/interp/eval.rs:66` derives `new_target` from
    `slot_is_constructor(caller)`. ECMA-262 PerformEval allows `new.target` in any non-arrow
    function.
  - **Observed:** `({ m() { return eval('typeof new.target') } }).m()`, and the same from a
    getter or generator, gives `SyntaxError: invalid new.target` on `ironhorse-xst` and
    `"undefined"` in Node (`probes/ontology/verify2-ont-18/method_newtarget.js`).
  - **Scope:** the verifier suggests this is a medium edge-case divergence on every embedder.
  - **Settled:** COV-15 (low). Direct eval takes its early-error context from XS's flags, not
    from PerformEval, so `super()` in eval code also always fails. IronHorse is faithful to XS's
    `fxRunEval` here, and the divergence is already a ratcheted row of the `SHARED` table in
    `rust/engine/ironhorse-262/tests/xs_departures.rs:660`
    (`../probes/coverage-review/hol2-verify/p.js`).
- **Pre-flip closures are caller-homed** (raised by the ONT-30 verifier).
  - **Mechanism:** on the `ironhorse-xst` host, every function created before the first guest
    `new Compartment()` captured a NULL `global_env`, hoisted declarations included.
  - **Observed:** such a function, called from a child, reads and defines the child's globals.
    SES answers START (`probes/ontology/verify-ont30/p4.js`).
  - **Scope:** if ONT-14 is fixed only for the shared evaluators, this case stays open; the
    verifier suggests medium.
  - **Settled:** COV-5 (medium). Functions created before the first guest `Compartment` stay
    unhomed for life on every bare `Interp::new()` host, including closures created after
    `lockdown()`; a child can redefine the free globals such a function consults, so an
    authorization check passes for a user the child picks. `Machine::new()` and the SES-shim
    worker are unaffected (`../probes/coverage-review/verify-hol3/v1.js`).
- **Compartment evaluators not frozen after `lockdown()`** (raised by the ONT-30 verifier).
  - **Observed:** on `ironhorse-xst`, a compartment's own minted `Function`, `eval` and
    `Compartment` copies are not frozen after `lockdown()`, whether the compartment was built
    before or after it. SES freezes them (`verify-ont30/p6`, `p7`, `p6_ses_node.mjs`).
  - **Not checked:** the frozen `Machine::new()` path.
  - **Settled:** COV-16 (low). The copies stay mutable and extensible on every host, including
    the frozen `Machine::new()` path, so a copy handed to a peer compartment is shared mutable
    state. The XS oracle freezes copies minted after `lockdown()` and, like IronHorse, leaves
    those of a compartment built before it unfrozen
    (`rust/engine/ironhorse-vm/src/interp/realm.rs:150-176`;
    `../probes/coverage-review/verify-handed-off-4/a.js`).
- **Prototype-reached `%Function%` scheduled as a promise job** (raised by the ONT-14
  consequence-and-intent verifier).
  - **Observed:** on `ironhorse-xst` before lockdown, a child that schedules the
    prototype-reached `%Function%` as a promise reaction compiles against START. It also defines
    a global on start (`probes/ontology/verify-ont14-consequence/`, `proto-ctor-job.js`).
  - **Scope:** the caller-homing rule closes the confinement route only for direct calls there.
    This is a lead for ONT-5.
  - **Settled:** ONT-5, before lockdown only. After `lockdown()` the route throws `TypeError`,
    so it is not a post-lockdown escape (`../probes/coverage-review/handed-off-leads/l8_proto_ctor_job.js`,
    `l8b_after_lockdown.js`).
- **Dead harness comparator** (raised by the ONT-23 verifier).
  - **Observed:** `rust/engine/ironhorse-262/src/lib.rs:1134-1162` (`compartment_dual_run`) has
    no callers. It compares a non-pumping compartment evaluate against an oracle that pumps jobs.
  - **Settled:** T262-12 (low), the harness's dead and legacy code; no caller exists anywhere
    under `rust/`.

### Finders' own leads that did not survive

**vocabulary**

- **Key-space exhaustion classification.** It is classified two ways: a catchable `RangeError`
  at the soft ceiling (`ironhorse-vm/src/interp/property/keys.rs:56`, `interp/link.rs:1270`) and
  `Halt::Refused("property-key:id-space-exhausted")` at the hard latch (`interp/dispatch.rs:289`,
  `interp.rs:3118`, `natives/promise.rs:876`). This two-tier design is documented
  (`ARCHITECTURE.md:349-354`) and consistent; it is not a misclassification.
- **XS_M container magic.** The magic is shared with XS snapshots, but the IRON discriminator in
  VERS (`ironhorse-snapshot/src/format.rs:194`, `:306`) refuses foreign snapshots. There is no
  identity collision.
- **Side-table Coverage vs `ARCHITECTURE.md:301`.** No table is `Coverage::Pending` at
  `61cd656cb`, and the quiescence gates enforce refusal. This is wording drift only. ONT-27
  later found a concrete consequence in the same area.
- **"quarantine".** It names a worker-failure reason prefix (`report.rs:194`, `:921`) and an
  expectation-list known-failure entry (`expectations.rs:421`, `endot_ih.rs:365`). The completion
  computation keys only on the `quarantine:` prefix, and no code path confuses the two.
- **"checkpoint".** It means a meter check point, a store checkpoint, or the harness's
  `dual_run_scripts_checkpoint`. No site mixes them up.
- **"ledger".** It means the side-table coverage ledger, the side-storage charge ledger, or the
  release ledgers. This is naming only.
- **Budget, allowance, raw and computron units.** Raw 16.16 units and whole computrons are
  converted consistently at every checked site (`meter.rs:143-165`, `interp/eval.rs:86-95`,
  `natives/regexp.rs:327-341`, endo `eval_outcome` raw >> 16).
- **`Halt::is_panic` doc.** The doc (`interp.rs:1774-1777`) says the `ExecutionOutcome`
  superset absorbs NotImplemented plus a catch-all, and omits Refused, which the classifier also
  maps to Panicked. This is a doc omission; the outcome is identical.
- **StepLimit as a memory bound.** StepLimit is also raised by the live-slot bound
  `BOUNDED_RUN_SLOT_CEILING` (`interp/dispatch.rs:278-280`), so a memory bound is reported as a
  step ceiling. This applies only when `step_limit != u64::MAX` (the fuzz harness), so there is no
  production consequence.
- **"realm" for compartments.** Tests and comments use "realm" for compartments; the code keeps
  exactly one `Realm` struct. The finder judged this naming taste. ONT-24 later reported the
  crate-doc drift in the same area.
- **Sloppy `this` and global resolution.** These are consistent for functions created by
  compartment evaluators once they exist (`t1.js`).
- **Three "refusal" types.** `Halt::Refused`, `value::CeilingRefused` and the endo `Refusal` sit
  in different layers. They are distinct Rust types and cannot be passed for one another.
- **Slot layout claims.** `ARCHITECTURE.md:59` (24-byte resident `Slot`) and the 20-byte
  `SLOT_RECORD_BYTES` (`slot_codec.rs:34`) agree with `store.rs:20`.
- **Error-name closed set.** The set at `interp.rs:1583-1596` and restore decoding use a single
  consistent list.
- **Default keys.** `ironhorse-vm/src/default_keys.rs` re-exports `ironhorse-meter`'s keys, so
  there is one definition and no drift.

**taxonomy**

- **Guest catch observing a host stop.** Refused halts raised inside an async function, a sort
  comparator, and `try`/`finally` were all uncatchable, and no `finally` ran (`p33`-`p35`). Stack
  exhaustion is always a Halt (StackOverflow or ReentryLimit), never a guest `RangeError`.
- **`halt_labels` disjointness.** The NotImplemented, Refused and EngineInvariant lists are
  sorted, disjoint and test-enforced. The dynamic regexp `CompileError::Unsupported` label is
  never constructed.
- **`ExecutionOutcome::classify` doc.** Its doc omits Refused, and `MachineBusy` would hit
  `debug_assert!(false)`. There is no live consequence, because the classifier has no non-test
  caller in this tree.
- **`compile_failure_name` count.** Its comment says it names "all seventeen" `LexErrorKind`
  variants; there are 18. All are named, so the no-wildcard guarantee still holds.
- **Seven hand-maintained `ParseErrorKind` classifiers.** They disagree on
  `LexErrorKind::Overflow` and `ParseErrorKind::MeterLimit`. `Overflow` is never constructed, and
  `compile_atoms` uses a `u64::MAX` budget, so the divergence is latent: duplication worth
  consolidating. ONT-8 reports the module-path consequence.
- **`ironhorse_negative_ok` versus `oracle_negative_ok`.** The first credits StackOverflow and
  MeterAbort but not ReentryLimit or HeapExhausted; the second credits any XS memory or stack
  abort. The asymmetry is real but affects one runtime-negative RangeError case. ONT-28 later
  reported it with the README drift.
- **Two spellings of a caught Rust panic.** They are `Halt::Panic(PanicKind::EngineFault)`
  (embedders only) and `Halt::EngineInvariant("host:*-panicked")`. Every consumer treats them
  identically.
- **Two-tier key-space exhaustion.** The design is deliberate. The defect is the index interning
  that drives guests into it (ONT-2).
- **SnapshotSection, SmallSection and SideTable.** These are generated from one macro roster
  with persisted ids, plus an independent hand ledger. No duplicate or divergent taxonomy was
  found.
- **Integer-keyed ordinary objects and dense arrays.** With 100K to 200K keys they do not intern
  indices; only the generic Array paths do (`p14`-`p17`).
- **Regexp storage ceiling at compile time.** It is consistent within the runtime: `new RegExp`
  and `eval` both give HeapExhausted. Top-level literals report `InternalError` via
  `compile_failure_name`, the same class under a host-specific spelling.
- **Module string export names.** XS also rejects them, so IronHorse's `SyntaxError` is a shared
  gap; only its report category is wrong (ONT-8).

**identity**

- **`pending_surfaces`.** It is not persisted, and it is reset to every holder on restore.
  Live and resumed twins agree on values, computrons and final container bytes.
- **`39421086`'s bitwise `Payload` equality.** No guest-visible dependence was found
  (defineProperty on frozen NaN/-0/+0, `Reflect.defineProperty`, Map NaN/-0 keys, `includes`,
  `indexOf`).
- **Cost-table name versus digest.** `MeterImage::decode` validates both, so they cannot disagree
  silently.
- **`MATH_PROVIDER` identity.** It is bound to Cargo `libm "=0.2.16"` and pinned by
  `math_profile.rs`. Endo builds with `consensus`.
- **Opcode header pin `48ee02d8cfe0` versus the gitlink.** The 246 names are identical today;
  only the header is stale. This is folded into ONT-21.
- **`DEFAULT_KEYS` against the gitlink's `gxIDStrings`.** The finder judged them identical
  except `sliceToImmutable`, which XS compiles only under `mxImmutableArrayBuffers`.
  That comparison holds only under flag 1, and the oracle builds with flag 0, the default.
  Under flag 0, `DEFAULT_KEYS` has two extra names (`immutable` and `transferToImmutable`) and
  lacks none, so it matches neither configuration (532 XS keys under flag 0, 535 under flag 1,
  534 in `DEFAULT_KEYS`).
  The coverage review verified the drift as COV-17 (low): table membership decides whether a
  property creation or runtime intern charges the key remainder, a measured 280 raw (1/234
  computron) per affected creation, and computron parity with XS is a declared non-goal
  (`rust/engine/ironhorse-meter/src/default_keys.rs:1-9`, `:535-536`; full entry:
  ../COVERAGE.md).
- **Field classification.** All 206 Interp roster fields are classified exactly once across the
  six reconciliation groups, and the quiescence and boot-derived attributes are consistent.
- **`n_dispatched` and `step_limit`.** They are host wiring and not persisted, but StepLimit uses
  a per-run delta, so resuming cannot shift it.
- **Store manifest VERS versus `store_schema`.** These can differ after migration, but every
  checkpoint restamps them. No decoder branch depends unsafely on the pair.
- **Implicit-read members in single-script runs.** 19 of 20 `xst` probes match Node. The odd one
  out is `Function.prototype.toString` formatting, which is XS-style and outside this lens.
- **Deleting a not-yet-installed intrinsic member, then relinking.** The member does not come
  back, live or resumed.
- **`releases::PINNED`.** It is append-only by comment only, but no runtime consumer reads old
  pins.
- **`eval_program_hoist`.** It is listed as a per-activation register in the docs but as host
  wiring in the test. It is armed only by the oracle-framing harness, whose machines are refused
  at persist anyway.
- **`Intl.__ironhorseDataVersion`.** It is a non-standard own property, which ECMA-262 permits.
  Its identity role is in ONT-20.
- **Duplicated words in a refusal message.** "heap holds live a live guest `Compartment`" is
  cosmetic.

**spec-model**

- **After lockdown.** All five function-family prototype routes throw `TypeError: secure mode`,
  matching XS `fx_lockdown_aux`.
- **Shared intrinsics.** Compartments share intrinsics by identity and get their own `eval`,
  `Function` and `Compartment`, matching XS `fxPrepareCompartmentFunction`.
- **One promise queue.** A single ordered queue shared by all compartments matches ECMA-262's
  single agent queue, and FIFO order is pinned by a test.
- **`lockdown` in compartment globals.** Binding it there matches SES `permits.js`.
- **Compartment constructor errors.** The guest constructor throws a catchable `TypeError` where
  the host API gives a Refused halt. These are different boundaries, not a misclassification.
- **`Halt::Return` on a completed `RunOutcome`.** This is a naming oddity only.
  `ExecutionOutcome::classify` maps it to Quiesced.
- **Compartment global descriptors.** `this` at the top level of evaluate is the compartment
  global, and the `globalThis`/`NaN` descriptors agree with XS, except for the prototype (ONT-17).
- **Unhandled-rejection attribution through jobs.** It is correct for closures and `.then`. Only
  contrived native-handler chains would be misattributed; this is folded into ONT-5.
- **The Endo daemon's crank goal.** It is `Goal::Eval`, so per-crank lexicals are
  eval-conformant. ONT-15 is shown on the host Script path instead.
- **Direct eval inside a compartment through its own `eval`.** The XS result was masked by
  another throw in the same probe, so this was not established as a divergence.

**types**

- **Lone surrogates.** They are lossless everywhere checked: property keys, `defineProperty`,
  globals, symbol descriptions, `Symbol.for`/`keyFor`, Error messages, JSON (including keys),
  RegExp, eval and Function literals, template raw/cooked, and 25 string natives.
- **Astral identifiers, escaped named groups, and NUL in keys and `Symbol.for`.** All are
  correct.
- **-0 through integer slots.** It is correct everywhere checked except `parseInt` (ONT-12).
- **The Integer and Number dual representation at equality sites.** It is correct everywhere
  checked (Map/Set, `includes`/`indexOf`, `===`, `Object.is`, `switch`, SameValue, Proxy
  invariants, TypedArray `includes`, `Atomics.compareExchange`).
- **Integer-index encoding.** It is correct at the 2^32-1, 2^32 and 2^53 boundaries, for odd
  keys, for Proxy key spelling and for key order.
- **BigInt.** No operation produces a negative-zero BigInt.
- **The `Payload::Reference` homonym.** 47 natives classify Symbols correctly. Weak-key
  rejection is deliberate XS parity; ONT-9 reports its inconsistent classification.
- **Stray key ids leaking into side-table rows.** None were found after 25 copy-out paths.
- **Second-order attribute leakage.** Reduce seeds and Map/Set built from frozen sources are
  clean; only `apply` leaks (ONT-3).
- **`value.rs:623`.** It says `id` doubles as argc on frame slots. That is stale, and nothing
  relies on it.
- **`Function.prototype.toString` for user functions.** It gives XS-style output.
- **Lone-surrogate Error `.stack` frame names.** They render as a literal `\ud800`. The property
  is non-standard.
- **Lazy materialization of global intrinsics.** It does not hide them from reflection.
- **Private names.** They do not consume key ids, and key-space exhaustion is a catchable
  `RangeError`.
- **Reserved, unadmitted intern paths.** They take `&'static str`, so a guest cannot drain the
  1,024-id reserve.
- **The slot codec does not cross-check the kind byte against the payload tag.** The store-seam
  trust model trusts the store, and no guest path produces a mismatched pair.
- **`CompartmentId` versus `EnvironmentId` for the same compartment.** This synonym pair is
  visible only to the embedder; ONT-19 covers `EnvironmentId`.
- **RegExp `@@replace` with a subclass `flags` getter returning `'g'`.** Over a non-global
  matcher it loops until HeapExhausted. ES2024+ loops too.
- **`%TypedArray%.prototype.toReversed` is absent.** This is a skipped feature, outside this
  lens.

**doc-model**

- **Claims that matched the code:**
  - workspace member count;
  - 24-byte `Slot`;
  - meter release and shared digests;
  - the 63/64 native-depth threshold;
  - guest key exhaustion as a catchable `RangeError` with a 1,024-id reserve;
  - `Temporal.Now` at the epoch with UTC;
  - parser, tree and regexp nesting refusals as `SyntaxError`s;
  - `unsafe` forbidden in all non-oracle library roots;
  - the fuzz target roster;
  - the recursion-budget constants;
  - the `GcHooks` method set;
  - `xs-oracle` never linked into a shipped engine;
  - Endo installing `IronhorseSourceCompiler`;
  - shipped crates enabling `consensus`;
  - canonical NaNs at slot construction and in the codec.
- **The format-26 `decode_buffers` is not version-aware.** That is sound for honest writers.
  ONT-32 later found the reader also accepts the new bits under older stamps.
- **The regexp crate's "named `CompileError::Unsupported`" claim.** It is vacuously true, since
  the variant is never constructed.
- **`DispatchOutcome` at `ARCHITECTURE.md:337`.** The type is `Step`. This is cosmetic and is
  folded into ONT-30.
- **`README.md:407` names a nonexistent `harness` bin.** It fails loudly.
- **Seam 4's four treatments against six `Coverage` variants.** This is cosmetic here; ONT-27
  covers the consequence.
- **`ARCHITECTURE.md:331-333` omits `MachineBusy`.** `MachineBusy` is also reused for
  `GcAdmissionError::NotQuiescent`.
- **`README.md:50`'s GC precondition.** `admit_collection` also admits a shared machine at the
  shared boundary. The only effect found is extra conservative roots.
- **Contradictory status ledgers in README and the design Status.** Cosmetic.
- **"Determinism per release binary" against "deterministic-math carries cross-host".** This is
  a conservative contradiction with no code consequence.
- **Cosmetic drift with no consequence:**
  - `README.md:232-233` on GAPS;
  - the fuzz crate's target count;
  - the `ironhorse-262` Cargo description's "computron agreement";
  - the "version-4 meter pin" wording (later reported in ONT-31);
  - `ARCHITECTURE.md:26` on `ironhorse-unicode`.
- **`test262.rs` `classify_run`.** It is now used only inside an `xst` test.
- **First unhandled rejection retained per environment.** This is consistent with the format and
  store docs.
- **The shared-`%Function%` probe under `--ses-mode l`.** It agrees on both engines, which
  confirms that the divergence exists only before lockdown.

### Region-map ontology notes that no lens carries

The region maps' ontology inventories record these notes, and no lens carried their
consequences.
The coverage review's lost-content sweep restored them (../COVERAGE.md).
This lens has not verified them; they are leads in the types and documentation-model areas.

**types**

- **Raw heap coordinates across a rewind.** `EvalOutcome::unhandled_rejection`
  (`Option<(SlotIndex, Slot)>`) and `Halt::Throw.value` are raw heap coordinates whose validity
  depends on the heap epoch. On the persistent path they are returned after a rewind into a
  discarded heap (`../maps/integration-fuzz-oracle.md:607`).
- **Positional native op codes.** `Native::TypedArray(idx)`, `NativeMethod::TypedArrayReadonly(u8)`
  and `Atomic(u8)` are defined by list position in `boot.rs`, so an insertion renumbers every
  later entry. The hazard is noted only in a code comment
  (`rust/engine/ironhorse-vm/src/interp/boot.rs:752-754`; `../maps/vm-natives-objects.md:543-544`).
  The map says the TypedArray position is persisted. The coverage review's blind-spots sweep
  found instead that natives persist by boot-image identity and that raw discriminants are not
  written (medium confidence; ../COVERAGE.md, "Blind spots"), so whether a renumbering can reach
  stored state is unsettled.
- **`PromiseFnData` and `PromiseReaction` field reinterpretations.** `PromiseFnData.promise` is
  either the promise to settle or a hidden capture home, and `guard` is either an index into
  `promise_guards` or a reserved tag selecting executor or finally semantics. `PromiseReaction`
  reuses `on_fulfilled` and `on_rejected` for `FinallyReturn` and `FinallyAwait`. Snapshot
  validation must know each reinterpretation (`../maps/vm-functions-async.md:757-765`).

**doc-model**

- **`FuncInfo.is_generator`.** It is documented as "Recorded for clarity/diagnostics"
  (`rust/engine/ironhorse-vm/src/interp.rs:896`), but `slot_is_constructor` relies on it
  (`rust/engine/ironhorse-vm/src/interp/function.rs:656`; `../maps/vm-functions-async.md:776`).
- **`STRING_METERING`.** It is documented as "one code unit of string concatenation"
  (`rust/engine/ironhorse-vm/src/meter.rs:54-56`), but concatenation never charges it: `concat_add`
  charges the chunk cost, and the constant is charged only by a few natives (`uri.rs`,
  `annex_b.rs`, `base64.rs`, `regexp.rs`) (`../maps/vm-memory-gc-meter.md:719`).
- **"Metered" in `new_string_metered`.** It means ticked but never checked, while
  `alloc_str_text_metered` means charged and checked, so a call site cannot tell from the name
  whether a host check point occurs (`rust/engine/ironhorse-vm/src/interp/strings.rs:103-122`;
  `../maps/vm-natives-values.md:752`).

## What this lens did not read

These blind spots merge the six finders' `not_read` fields.
The finder that left each gap is named in parentheses.
Where a verifier later covered part of a gap, that is noted.

- **Excluded by the independence rule (all finders).**
  - `rust/engine/architecture-review/2026-09-06/`
  - `rust/engine/architecture-review/2026-09-20/`
  - `rust/engine/reviews/`
- **VM interpreter.**
  - **Dispatch and GC.** Most of `dispatch.rs` beyond the cited blocks, `gc.rs` and `bulk.rs`
    (vocabulary). GC internals beyond the `symbol_keys` arms (types).
  - **Restore and environment code.** The interiors of `restore.rs`, `environment.rs`, `eval.rs`
    and `realm.rs` (types).
  - **Suspension.** `suspend.rs`, and `frames.rs` beyond lines 395-430: how generators and async
    functions capture `global_env` across suspension (spec-model).
  - **Boot and link.** `boot.rs` and `link.rs` `install_intrinsic_bindings`, including the exact
    moment `shared_compartments` flips for the start environment (spec-model). The ONT-14 and
    ONT-30 verifiers later located it at `realm.rs:854` and `natives/compartment.rs:112-114`.
  - **Function and module Environment Records.** Function Environment Records ([[ThisBindingStatus]],
    arguments objects, class fields), and module Environment Records on any real bytecode path,
    which the VM does not execute (spec-model).
  - **Job environments.** The FinalizationRegistry cleanup-job environment was inferred to share
    ONT-5's mechanism but not probed. `HostCallContext` environment selection was not read
    (spec-model), and the host-callable claims at `ARCHITECTURE.md:157-173` were not exercised
    (doc-model).
  - **Other runtime paths.** `GcHooks` behaviour beyond the method names (doc-model). Whether
    `Halt::MachineBusy` can reach `ExecutionOutcome::classify`'s `debug_assert` (vocabulary).
- **Natives.**
  - Most built-ins other than the cited functions (vocabulary).
  - Intl and Temporal native bodies beyond the `GET_PROPERTY` arms (taxonomy, types).
  - Individual `NotImplemented` and `Refused` label sites were sampled, not exhaustively checked
    for consistency (taxonomy).
- **Snapshot and store.**
  - **`image.rs` codecs.** Not read beyond the version-gated, UTF-8 and stored-id sites (all
    finders).
  - **Other snapshot files.** `snapshot_roster.rs`, `store_file.rs` and `store_suite.rs`; most of
    `store.rs` (commit, validate), except where findings cite it (vocabulary, taxonomy, types).
    The legacy `store_sections.rs` decoders were sized only (identity).
  - **Persistence of environments, jobs and module cells.** `shared_persist.rs`, `restore.rs` and
    `persist.rs` were grep-read only (spec-model). The restore-side refusal sites beyond
    `is_quiescent` were not read (taxonomy).
  - **Shared-profile identity check.** The check in `shared_persist.rs` and `realm.rs` was noted,
    not verified (identity). The GC hook roster attributes were not reviewed (identity).
  - **Slot decoding and restore admission.** Kind versus payload-tag consistency in
    `decode_slot` was noted, not probed (types). Restore admission (`MachineRestorePolicy`) was
    not exercised by its finder (doc-model); the ONT-19 verifiers later exercised it.
  - **Store trust model and lazy open.** `ARCHITECTURE.md:225-239` was checked only by symbol
    existence (doc-model).
  - **Boot fingerprint variants.** Whether the boot fingerprint, computed from `Interp::new()`,
    distinguishes frozen, unfrozen or `global_names`-filtered Machine boots was not followed
    (doc-model).
  - **The `aaec6a06` toJSON miss.** The root cause of the first implicit `toJSON` miss was not
    traced (identity). It is moot after ONT-4's refutation.
- **Compiler and regexp.**
  - `ironhorse-compile` beyond its error kinds, opcode generation and meter aliases (vocabulary,
    identity, types).
  - The scoper's handling of Script versus Eval declarations (spec-model).
  - The regexp crate beyond the cited functions (vocabulary, types).
  - The two `u16` id spaces (program-local compiler ids versus canonical key ids) were not
    audited for a concrete misbinding (vocabulary).
- **Harness, fuzz, oracle and meter.**
  - **Fuzz and oracle crates.** `ironhorse-fuzz`, including its `differential_check` verdict arms
    (vocabulary, taxonomy). `xs-oracle` (vocabulary).
  - **Unread parts of `xst.rs`.** The async-case and module-execution arms after line 2100,
    except the cited spots, and about 4,800 further lines not read by spec-model (taxonomy,
    spec-model). `compile_diff.rs`, `corpus_to_262.rs`, and `tests/halt_label_registry.rs`
    beyond its header, so the mechanical label scan was not re-verified (taxonomy).
  - **Skip list and negative-runtime path.** The test262 skip-feature list and the harness
    negative-runtime path (vocabulary). The ONT-28 verifier later read the latter.
  - **Meter releases.** `ironhorse-meter` `releases.rs` (vocabulary). Whether every
    charging-point change got a release bump was not checked against golden vectors
    (doc-model). `DEFAULT_KEYS` was compared mechanically, not semantically (identity).
  - **Untested paths.** The full cargo test suites were not run, and `HostAllocationFailed`
    paths were not probed (taxonomy). The ONT-26 verifier later probed one under a capped
    allocator. The XS oracle binary was not run by its finder for `parseInt('-0')` or the
    RegExp accessors (types). The ONT-6 and ONT-12 verifiers compared against Node and the
    report instead.
- **Embedders.**
  - The Endo daemon crate beyond `ExecutionOutcome` and `describe_halt` (taxonomy).
  - The `PersistentMachine` lifecycle and SQLite backend beyond spot checks (identity,
    doc-model).
- **Documents.**
  - **Read only as grep hits:** `README.md`, `WASM-MEMORY.md` and most design documents
    (vocabulary); `designs/*.md` beyond hits for version numbers (identity).
  - **Not read:**
    - `RECLAMATION.md`;
    - `DETERMINISM-*.md`, except `DETERMINISM-METERING.md` lines 90-140, which identity read;
    - `STACK-DEPTH-REFACTOR.md`, `WASM-BLOCKERS.md`, `CHANGELOG.md` and `CRATE-GRAPH.md`;
    - the schema-perspective designs;
    - `designs/ironhorse-engine.md` beyond its Status and Determinism sections;
    - the rest of `designs/ironhorse-guest-compartment.md` (vocabulary, doc-model, spec-model).
  - Several verifiers later cited specific lines of these files; each such citation is noted in
    its finding.
  - The README acceptance-table measurements were not re-measured (doc-model).
- **Semantics sampled only for id types.**
  - The realm, compartment and environment model was sampled only for its id types; its
    semantics were left to other finders (types).
  - Snapshot trust (kind versus payload tag) was noted but not probed, because the store is
    trusted by design (types).
