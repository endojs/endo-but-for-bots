# Snapshot schema requirements from the GC perspective

|             |                                                                             |
| ----------- | --------------------------------------------------------------------------- |
| **Created** | 2026-09-08                                                                  |
| **Updated** | 2026-09-08                                                                  |
| **Author**  | kumavis (prompted)                                                          |
| **Status**  | Proposed                                                                    |
| **Source**  | Relocated from `rust/endo/ironhorse-store-sqlite/GC_SCHEMA_REQUIREMENTS.md` |

Part of the [snapshot schema design](ironhorse-snapshot-schema.md).

Status: proposed requirements and research directions, not a selected physical schema.
Written 2026-09-08 against experiment branch revision `58d42d961` and its `llm` base.
This is a separate perspective from [snapshot surgery](ironhorse-snapshot-schema-surgery.md).
For inspection and debugger interoperability, see
[the debugging perspective](ironhorse-snapshot-schema-debugging.md).
The aim is to make collection correct, deterministic, and economical for large, mostly cold heaps.
No collector or store implementation changes are included in this document.

## What efficient collection should mean

A schema should let a collector decide what can be reclaimed without routinely loading every
object, decoding every side-state section, moving every live byte, or rewriting all metadata.
That does not imply that every collection can have constant cost or that SQL removes graph work.
A reachable graph can itself be the whole heap; an exact tracing pass must account for that work.

Distinguish four operations with different requirements:

1. Reachability: determine which objects or regions must survive.
2. Reclamation: update allocation state and remove dead owner-associated state.
3. Relocation: move storage and repair references if compaction is chosen.
4. Physical storage cleanup: recover space occupied by obsolete database pages or old snapshots.

Freeing VM slots need not shrink the database file.
Conversely, deleting storage still referenced by a retained snapshot is not valid VM collection.
Backend vacuuming and retained-artifact policy require their own measurements and ownership rules.

## Current mechanisms and their limits

| Mechanism                | What exists                                                                                                                                 | Limit relevant to schema design                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full GC                  | Slot mark/sweep, owner-associated side-state edges, ephemeron fixpoint, chunk compaction and reference rewriting.                           | Content traversal and chunk relocation can defeat cold-heap residency; there are scans over slot capacity.                                                 |
| Partial GC               | At a clean checkpoint boundary, traces persisted page summaries from VM roots and side-state reference pages, then frees unreachable pages. | A reachable page retains co-resident garbage. Treating side-state references as roots also retains values of dead owners until a more precise pass.        |
| Generational summary GC  | Reverse-edge seeds plus reachability restricted to pages changed since the session's last collection.                                       | `gen_dirty` is session-local and resets on resume. The code explicitly says it is test-only and must not replace scheduled partial GC until this is fixed. |
| SQLite graph queries     | `edge_pairs(target,page)` plus a forward index support indexed reachability and incoming-edge queries.                                      | Reduced result transfer does not bound internal query work. The derived index is rebuilt at open.                                                          |
| Integrity and allocation | Sealed page summaries, row hashes, Merkle-root maintenance, segmented free-list state, epoch/seal checks.                                   | Collection must keep all these consistent; free-list order affects future allocation and canonical state.                                                  |
| Side-state storage       | Arrays, collections, functions, promises and continuations are represented in decoded VM tables and encoded small-state sections.           | The store does not offer independently keyed persistence/query operations for each of these semantic rows.                                                 |

These statements follow the implementation, not every historical aspiration in the large
[store-seam design](ironhorse-snapshot-store-seam.md).
In particular, the generational collector's current resume limitation is explicit in
[machine.rs](../rust/engine/ironhorse-snapshot/src/machine.rs).
Partial collection avoids heap-content reads, but still performs metadata work: summary inventory,
root-page projection, traversal, and enumeration of the full page range to find unreachable pages.
It is not generally proportional only to the garbage reclaimed.
Freeing pages also prunes side-state and compacts code/reaction metadata; unchanged arena slot
bytes do not mean that only the free list changes in the next checkpoint.
The side-reference page projection allocates a bitmap over total pages and walks additional tables;
debug/integrity configurations can add a full side-reference enumeration.

## Requirements on the logical schema

### GC-1: Account for the complete graph, with ownership and edge semantics

Every reference-bearing state family must have a defined tracing rule, including arena properties,
arrays, maps, closure environments, bound functions, prototypes, private state, promise reactions,
saved frames, symbol-key state, buffers and runtime/host-held roots.
Distinguish slot references from chunk references and non-reference integers.
Describe whether an entry is a root, an edge owned by an object, weak, or conditional.
External capabilities root their local representatives according to the host/VM contract;
the heap schema does not determine remote distributed liveness by itself.

For an exact pass, a dead owner's side-state must not keep its children alive merely because its
row remains stored.
For a conservative pass, such retention is acceptable only as an explicit approximation with a
defined route to eventual precise collection.
A WeakMap needs its owner/key condition and fixpoint behavior; flattening every key/value pair
into unconditional strong edges changes collection semantics.
Ordinary reference counts alone cannot reclaim arbitrary cycles or implement these conditions.

Desired logical information: entity identity and kind, owner, target, edge role/strength, conditional
key where applicable, and root category.
This is a semantic contract, not a requirement to materialize one SQL row per edge.
The tracing definitions should be shared with snapshot validation and derived-index construction
so adding a persistable state family cannot silently omit its GC edges.

### GC-2: Support conservative summaries with a path to exact refinement

Page-level reachability is useful because it is small and cheap to maintain.
It cannot distinguish a live object from unrelated garbage on the same page, and aggregate
side-state roots lose ownership relationships.
The schema should identify the precision of each summary and permit refinement of a selected
region using object-level edges or decoded content.

Measure retained dead slots/bytes against a precise reference pass on the same graph.
No bound on total retained garbage independent of heap size follows from page summaries: one
live object per page can keep garbage throughout the entire page range.
Report both absolute retained bytes and dead/live amplification.
Collector policy must specify when broader or more precise work becomes necessary.

Current `derive_page_edges` visits all encoded slot records without an allocation-status argument.
Because freeing a slot leaves its bytes unchanged, stale edges in free records on a reachable page
can also retain other pages.
An occupancy-aware summary would need allocation-state changes, not just payload writes, to trigger
recomputation and integrity updates.

### GC-3: Make incremental collection state survive suspension

A recent-write set, remembered set, collection generation, or last-collection position that changes
reclamation decisions is semantic state, not merely a cache.
Persist it at the atomic checkpoint or derive it deterministically from durable information that
is retained for that purpose.
Candidate information must include relevant reference changes and allocations, including changes
inside side-state; arena dirty pages alone are not a complete semantic mutation log.

For the current generational experiment, investigate a durable candidate bitmap/set or per-region
last-change generation plus a collection watermark.
Specify initialization, advancement, crash recovery, and what container export/import preserves.
Putting it only in SQLite would leave another backend or exported snapshot with different history.
Where exact reconstruction is impossible, a reset policy must be explicit and consistent with the
supported determinism contract; it cannot silently depend on whether a process happened to restart.

### GC-4: Tie graph evidence and reclamation to one committed state

Content, summaries, ownership, allocation metadata and any semantic GC state must describe the
same generation.
Reject missing/stale evidence rather than interpreting an absent summary as an edgeless page.
An allocation identity must not silently be reused while old summary entries still refer to it.
Current slot/page indices can remain sufficient within a generation if invalidation and reuse
rules guarantee this; globally unique object IDs are not an unconditional requirement.

Collection reads need a consistent view and a freshness check before committing reclamation.
The current single-writer, clean-boundary discipline is one implementation.
Concurrent collection would additionally require a specified write barrier and snapshot protocol;
adding generation columns alone would not make concurrent tracing correct.
On crash, restore a complete old or new state, including owner-row cleanup and free-list changes.

### GC-5: Make the useful graph queries cheap without binding the VM to SQL

The backend-neutral operations should support forward reachability, incoming references from
outside a candidate region, and traversal restricted to that region.
More precise collection may also need owner-conditioned edges and conditional-edge rounds.
Specify results and consistency semantics first, then provide indexed and reference implementations.
Compare equivalent queries on the same graph and roots.

For SQLite, forward and reverse indexes are useful existing foundations.
For other backends, adjacency records, sorted edge runs, or compact bitmaps may be better fits.
A small query result does not imply cheap execution: high fan-in, repeated conditional-edge rounds,
index scans and temporary sets can dominate.
Avoid claiming O(changed-region) total collection merely because the returned set is that size.

### GC-6: Make allocation and deletion economical and deterministic

Represent allocation status without requiring the collector to read every free slot's record.
Retain exact free-list ordering where the VM's allocator makes that observable through subsequent
allocation, accounting or canonical bytes.
Batch whole-region reclamation and associated owner-row deletion where possible.
Updating free metadata need not rewrite unchanged slot payloads; the existing segmented free list
already exploits this distinction.

If free regions are reused, refresh affected summaries before those summaries can justify another
collection.
Free-record bytes and their old edges must not become authoritative evidence about newly allocated
objects.
Pruning stale conservative edges is an optimization only when their retention cannot conceal a
missing new live edge.

### GC-7: Separate chunk identity from physical location when relocation dominates

Current chunk references encode offsets, so moving bytes requires rewriting all surviving holders,
including holders in side-state and runtime metadata.
The current collector avoids dirtying unchanged extents and identity remaps, but still performs
compaction work and may move a large live suffix.
Smaller checkpoint writes are not equivalent to smaller read/CPU costs.
`ChunkArena::compact` forces chunk residency and copies live blocks into another vector, so peak
memory must include the old and new storage as well as relocation metadata.
Today's partial collector does not reclaim chunk space.

Compare explicit alternatives: stable chunk IDs with a location directory, independently allocated
chunk rows, or region allocation with selective evacuation.
These can reduce reference rewriting or defer moving live bytes, at the price of indirection,
fragmentation, index maintenance and a versioned encoding change.
Shared buffer/view relationships and exact byte contents must survive any choice.
Require a measured win before choosing a different layout.

All reference holders must participate in relocation or be reconstructible against the relocated
image, including boot/runtime-held chunk references that are not ordinary guest slots.
The [unedited restore/GC regression](ironhorse-snapshot-schema-surgery.md#independent-restoregc-regression-found-by-the-probes)
shows why repeated compact/restore/collect cycles belong in acceptance tests.
Its suspected cause is not yet a proven schema defect or an argument for a particular chunk layout.

### GC-8: Distinguish authoritative state, verified summaries and disposable indexes

For each derived structure, name its source, schema version, integrity coverage, invalidation rule,
and rebuild/verification procedure.
The current `page_edges` summaries are integrity-covered; SQLite `edge_pairs` is rebuilt from them
and protected from competing writers while the store is in use.
A new index cannot become trusted for freeing data simply because its row count matches.
Hashes establish consistency of encoded evidence, not completeness of a forgotten tracing rule.

Measure open-time rebuilds and validation separately from steady-state collection.
The current SQLite rebuild is a metadata read-and-write pass, not just index lookup latency.
If faster warm opens are needed, consider transactionally maintained, verifiable index generations
or authenticated summaries; preserving detection of stale/corrupted data is a requirement.
Bulk side-state normalization must bring corresponding ownership, mutation and integrity rules.

### GC-9: Bound transient residency and metadata growth, not only payload reads

Track the heap graph, root sets, side-state decoding, worklists, visited sets, free lists and query
temporary storage in the memory budget.
An O(pages) metadata array may be inexpensive at one heap size and dominant at another.
Cold collection should not need to materialize all variable-sized side-state to obtain a small
region's incoming-reference answer.
Candidate options include keyed side-state summaries, sparse counted sets, streamed inventories
and batched queries; each must preserve complete tracing and deterministic results.

Incremental exact marking across multiple cranks would require a durable frontier/mark epoch and
mutation-barrier protocol, not just paged object storage.
That is a future algorithm choice, not a capability of today's clean-boundary summary collector.

### GC-10: Preserve behavior across storage and residency choices

For a fixed supported collector policy and runtime version, warm/cold residency, eviction order,
backend query plans, and suspend/resume must not change live/free accounting, future allocation,
metering or canonical output.
Use deterministic ordering whenever reclamation order affects the free list.
Collection scheduling must follow durable logical progress rather than host timing or cache misses.

Different collector policies may deliberately retain different amounts of garbage.
Do not demand byte equality between a conservative partial pass and an exact pass that reclaim
different sets; test the conservative pass's safety/retention relation separately.
Likewise, an optimization that changes reclamation decisions is not merely a transparent backend
index change, even if immediate JavaScript results happen to match.

## Evaluation plan before selecting physical tables

| Workload                                                                            | What it should expose                                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Large cold graph, small changed region                                              | Payload faults, metadata scans and work outside the candidate region.                    |
| Entire heap reachable; high fan-in                                                  | Real traversal cost when answers/adjacency are large; avoid tiny-answer-only benchmarks. |
| One live object per page; stale freed-slot edges; dead owners with large side-state | Conservative retention and the cost/effectiveness of exact refinement.                   |
| Cycles and WeakMap chains                                                           | Strong cycles, owner-conditioned edges and multi-round ephemeron handling.               |
| Large arrays, maps, promise graphs, saved frames                                    | Side-state costs and reference completeness beyond ordinary properties.                  |
| Front versus tail chunk garbage, shared views and long-lived strings                | Bytes read/moved/written, reference rewrites, fragmentation and peak residency.          |
| Suspend mid-collection window; repeated compact/restore                             | Durable candidate history, runtime-held offsets and allocation-order parity.             |
| Crash at checkpoint; stale/missing summaries; slot reuse                            | Atomicity, lineage checks and refusal before unsafe reclamation.                         |

Record wall time and tail latency, guest mutation overhead, payload and metadata bytes read,
rows/edges examined and returned, peak RAM, bytes moved, rows/WAL bytes written, storage retained,
and reclaimed slots/chunk bytes.
Separate cold open, decision, sweep, compaction, checkpoint and backend cleanup.
Compare no-store/full GC, reference stores and SQLite only where workloads and collector semantics
are comparable; repeat across heap size, candidate size, edge density and side-state fraction.
Existing [query benchmarks](../rust/endo/ironhorse-store-sqlite/tests/store_bench.rs), [query parity tests](../rust/endo/ironhorse-store-sqlite/tests/query_gc.rs),
[shared store suite](../rust/engine/ironhorse-snapshot/src/store_suite.rs) and
[GC tests](../rust/engine/ironhorse-snapshot/tests/gc_machine.rs) provide starting points.
No new performance measurements were taken for this document.

## Relationship to the surgery perspective

Both perspectives want complete typed references, explicit ownership and consistent versions.
Surgery additionally needs human-meaningful binding paths and before/after intent.
GC needs cheap mutation tracking, root/edge summaries, weak-edge semantics and predictable memory use.
A rich diagnostic SQL view can be built on demand; maintaining that same view on every mutation
must earn its runtime cost.
Use a shared semantic graph definition with projections appropriate to each consumer rather than
assuming the surgery workspace is already an efficient GC index.

The immediate research priorities are durable generational history, more precise side-state
ownership summaries, accounting for cold/open metadata costs, and chunk-relocation alternatives.
Full relational normalization remains a candidate implementation, not the requirement.

## Source map

- [Full tracing and compaction](../rust/engine/ironhorse-vm/src/gc.rs): strong/conditional edges,
  sweeping hooks and external chunk relocation.
- [VM roots and side-state hooks](../rust/engine/ironhorse-vm/src/interp.rs): `gc_roots`,
  `side_table_ref_page_bits`, `collect_garbage` and its hook implementation.
- [Store collectors](../rust/engine/ironhorse-snapshot/src/machine.rs): `partial_collect`,
  `generational_collect` and the documented resume restriction.
- [Logical store](../rust/engine/ironhorse-snapshot/src/store.rs): `HeapStore`, `CheckpointBatch`,
  `derive_page_edges`, integrity roots and free-segment records.
- [SQLite implementation](../rust/endo/ironhorse-store-sqlite/src/lib.rs): graph indexes, atomic batches and derived-index rebuilding.

## Prompt

> lets switch perspectives and analyze what we want from schema design for efficient GC in a new document
