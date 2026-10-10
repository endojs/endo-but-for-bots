# Phase 1G commissioned derived-machinery review

Reviewed 2026-09-09 against `96db92e2308f0a3712dd0faed7b8663f00c42d29`.
The Phase 1G documentation commit landed during testing; the inspected production
files were unchanged.
This is the scoped review commissioned by the Phase 1G decisions work, completed as
bounded static inspection and targeted oracle-free validation.
It is not an exhaustive invalidation proof or permission to bypass 2A's own tests.
No production files or architecture-review status lines were edited.

## Result

No new production correctness defect was confirmed in this bounded pass.
That result is limited to the constructs and tests below; it does not establish that
all mutation sites in the interpreter or all storage backends have been reviewed.
The remaining checks are specified below so a later workstream can extend the review
without treating missing evidence as a clean bill of health.

The performance branch already recorded adversarial reviews in
`architecture-review/2026-09-06/PERFORMANCE-FIXES.md` and
`architecture-review/2026-09-06/PERFORMANCE-TRADEOFFS.md`.
This commission supplies an additional scoped pass over the named machinery; it does
not repeat the premise that those changes had literally never received any review.
Read alongside the W3 persistence and W4 implementation companion documents.

## Inspected coverage

| Area | Content anchors inspected | Evidence and limits |
| --- | --- | --- |
| `ironhorse-vm/src/classification.rs` | `ClassIndex`, `ClassMap`, `ValueUpdate::drop`, `dirty_mask`, `retain_keys`, `copy_to` | Structural mutations maintain membership, refined mutable access is guarded, unwind refreshes refinement, and unrelated membership bits survive removal. Read interpreter construction and selected GC hook integration. Did not audit every exotic dispatch precedence branch. |
| `ironhorse-vm/src/property_index.rs` | `will_mutate`, `synchronize`, `drop_owner`, `free`, `find` | Read the full implementation and inline tests, then `SlotArena::{alloc,get_mut,free,sweep_each,find_property}` hooks in `value.rs`. Changes to name/link invalidate dependent owners; owner-head changes are observed directly; reuse invalidates cached owners. The first eight authoritative reads can return before index synchronization, but later indexed access still synchronizes pending mutations. No stale result was confirmed. |
| `ironhorse-vm/src/snapshot_dirty.rs` | `Tracked`, `SnapshotDirt`, `ArenaDirt`, `SnapshotBaseline` | Mutation marks precede mutable references, replacement marks, and baseline identity invalidates older acknowledgements. Read `Interp::{snapshot_dirty_sections,snapshot_baseline,acknowledge_snapshot}` and checkpoint selection/acknowledgement in `ironhorse-snapshot/src/machine.rs`. |
| `ironhorse-vm/src/bulk.rs` | `SideRefCounts`, `ArrayData`, `CollectionIndex`, `CollectionData::{find,remove_entry,clear_entries,prune_entries}` | Read refcount symmetry and poison handling, array descriptor counts, lazy append indexing, duplicate-key queues, weak physical deletion, generation reset, and chunk-remap escape hatches. Selected interpreter key canonicalization and GC chunk remapping were inspected. Inline tests cover duplicate restoration, weak frontiers, pruning, and refcount poison. |
| `ironhorse-vm/src/cost.rs` | Feature-off recorder, feature-on recorder/report, `WorkModel::evaluate`, `CostModel` | Read both feature branches, checked isolation intent and deterministic report ordering, and ran feature-off and feature-on tests. No disassembly equivalence or timing calibration was performed. Arithmetic in developer-only work models is not a runtime admission proof. |
| `ironhorse-vm/src/meter_consistency.rs` | Entire test module | Read independent cost laws for UTF-16 allocation, proxy forwarding, descriptor allocation, host cadence, and duplicate-key scan refusal. These tests ran through the VM library suite. They sample metering seams and do not cover every builtin. |
| `ironhorse-vm/src/source_scan.rs` | `code_only`, `literal_end`, `tokens`, token/path matching and balanced bodies | Read comment/raw-string handling, escaped literals, raw identifiers, and delimiter matching. This is a source-lock lexer with heuristic character-literal handling, not a Rust parser or proof that matched tests execute. Only its library test ran in this pass. |
| `ironhorse-meter` | Ordered `TABLE`, `DEFAULT_KEYS`, `digest`, allocation helpers, release pins, SHA-256 implementation | Inspected identity construction, release separation, saturation in allocation helpers, and streaming hash implementation/tests. Frozen release and hash vectors passed. No CPU calibration claim or comprehensive charging-point audit is made. |
| `ironhorse-text` | `SymbolName::{from_units,from_cesu8,units,to_text,as_str}`, equality and display | Read the complete implementation. Canonical re-encoding rejects noncanonical CESU-8; equality uses code units; diagnostic display is separate. The exhaustive single-code-unit round-trip test and malformed-input examples passed. Arbitrary multi-unit fuzzing was not performed. |
| Schema 28 | `store_sections.rs`, `migrate_v27_to_v28`, checkpoint section selection and acknowledgement | Read section framing, identity/hash domains, canonical supplied-payload validation, incremental leaves, sparse merge, old-root authentication, and byte-preserving restamp. Tested reference backend sparse acceptance and failed checkpoint recovery. SQLite transaction internals were not audited or run in this pass. |

## Historical risk rechecked

`PERFORMANCE-TRADEOFFS.md` says reordering `SmallSection::ALL` would pass the
`section.id() == id` test and silently remap persisted identities.
That particular mutation is caught in the inspected tree: the enum has explicit
numeric discriminants, `id()` casts that discriminant, and the framing test compares
it with the array position.
Reordering `ALL` alone therefore fails the existing assertion.
Changing both the explicit discriminants and the inventory together is a different
mutation and still calls for compatibility evidence pinned independently of current
source declarations.
This observation neither edits the historical review nor claims that all schema
compatibility risks are closed.

## Follow-up obligations and limits

1. Before 2A narrows mutation ownership, preserve the existing property-cache owner
   prefilter, reverse dependencies, and free/reuse invalidation until their replacement
   has equivalence tests.
   Retained high-water memory is a carried cost, not a newly discovered defect.
   Add a randomized oracle-free sequence test comparing cache results with a bounded
   authoritative chain walk across shared tails, duplicate names, mutation, and reuse.
2. The collection index owns copies of string/BigInt key contents and assumes those
   contents are immutable while chunk offsets may move.
   `ChunkArena::slice_mut` is publicly reachable but documented for ArrayBuffer writes.
   This pass did not establish that arbitrary host edits to string/BigInt payloads are
   supported or that all restored cross-kind chunk aliases are refused.
   Resolve that boundary explicitly before claiming invalidation correctness for every
   public arena operation; test warmed collection keys against any admitted aliasing.
   This is an unresolved boundary question, not a confirmed guest-reachable defect.
3. `ClassMap` and `Tracked` make ordinary mutations visible, but the completeness of
   every snapshot-section mask depends on all extracted fields and cross-table reads.
   A future field-by-field reconciliation should compare a full fresh snapshot with
   sparse checkpoints after each admitted mutation, restore normalization, GC, and
   failed-commit retry, including the SQLite backend.
   The passing reference-backend acceptance test covers representative cases, not all
   32 sections under every mutation route.
4. Preserve the chunk-remap callback contract: it may change chunk offsets, but not
   slot references or array descriptor flags.
   A production caller violating that contract would bypass bulk refcount/attribute
   maintenance; the selected existing remapper only rewrites chunk references.
5. Extend source-lock tests with whitespace and punctuation character literals,
   lifetimes, nested/raw literals, and escaped Unicode forms before expanding reliance
   on the scanner.
   Source detection is corroboration; retain behavioral refusal tests.
6. No XS oracle, release-profile run, performance benchmark, native code comparison,
   SQLite lane, full corpus run, or independent SHA-256 implementation cross-check was
   performed in this commission.
   No repository-wide JavaScript changes were made or validated.

## Executed validation

Commands ran from `rust/engine` with rustc 1.91.1 on the local macOS environment.
All tests were oracle-free.
No checked-in fixture was regenerated and no test was added or modified.

| Exact command | Result |
| --- | --- |
| `cargo test -p ironhorse-vm --lib -- --test-threads=2` | 187 passed, including classification, property index, bulk, dirt, meter consistency, and source-scanner library tests. |
| `cargo test -p ironhorse-snapshot --test store_checkpoint --test migration -p ironhorse-meter -p ironhorse-text` | Selected snapshot integration targets: checkpoint 21 passed; migration 11 passed and 1 existing fixture-regeneration test ignored. The explicit target selectors did not run meter/text library tests. |
| `cargo test -p ironhorse-meter -p ironhorse-text` | Meter 4 passed; text 3 passed; both doctest targets contained zero tests. |
| `cargo test -p ironhorse-vm --features cost-calibration --lib cost::` | 4 passed; 187 unrelated tests filtered out. |
| `cargo test -p ironhorse-snapshot --lib store_sections::` | 4 passed; 107 unrelated tests filtered out. |
