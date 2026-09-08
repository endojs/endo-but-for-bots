# Ironhorse snapshot schema design

|             |                    |
| ----------- | ------------------ |
| **Created** | 2026-09-08         |
| **Author**  | kumavis (prompted) |
| **Status**  | Reference          |

## Purpose and status

This index collects requirements for the snapshot schema from different uses of the same heap.
It separates observed experiments, proposed logical requirements, and future physical-layout choices.
The existing [snapshot store seam](ironhorse-snapshot-store-seam.md) remains the implementation design;
these contributions do not replace its format, store interface, migration rules, or integrity model.

The surgery experiments are implemented in the experiment branch.
The GC and debugging documents are analyses and implementation proposals, not new collectors or
working debugger integrations.
No physical schema redesign is selected here.

## Perspectives

| Perspective              | Document                                                                                   | Evidence and open work                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot surgery         | [Surgery requirements and upgrade experiments](ironhorse-snapshot-schema-surgery.md)       | Scalar/state edits, anonymous and named function replacement, prototype methods, captures, and suspended activations. Distinguishes successful fixtures from missing compatibility metadata.          |
| Efficient GC             | [GC requirements](ironhorse-snapshot-schema-gc.md)                                         | Root/edge completeness, conditional ownership, conservative summaries, durable collection state, atomic reclamation, and backend costs. Proposed requirements grounded in the current collector.      |
| Debugging and inspection | [Debugging requirements and implementation sketch](ironhorse-snapshot-schema-debugging.md) | A semantic graph, read-only queries, Chrome heap export, and optional CDP/DAP adapters. Separates existing state from missing identity, size, source, and historical metadata.                        |
| Performance              | Deferred; no separate design yet                                                           | Define workloads and measurement requirements before choosing layouts. F106/F122 provide the proposed benchmark/baseline infrastructure; they do not themselves establish schema performance results. |

For running the experiments, use the [surgery tool guide](../rust/endo/ironhorse-store-sqlite/VAT_SURGERY.md).
For the executable recipes, see [the upgrade tests](../rust/endo/ironhorse-store-sqlite/examples/vat_surgery/upgrades.rs).

## Shared design questions

The perspectives converge on a backend-independent logical model: allocated entities, stable
identification within an image, complete reference roles, roots, ownership, and conditional edges.
Function/capture layouts and code/continuation versions matter for both inspection and safe surgery.
GC and inspection need the same tracing definitions, with precision and approximation made explicit.

These requirements do not imply one permanent SQL row per object, property, or reference.
A derived graph or disposable query workspace can supply visibility without becoming a second
source of truth.
An authoritative table split must justify its migration, transaction, integrity, and checkpoint costs
across memory, file, and SQLite backends.
The documents keep that physical-layout choice open.

## Performance follow-up

The architecture review assigns
[F106](../rust/engine/architecture-review/2026-09-06/ARCHITECTURE-REVIEW.md#f106---the-performance-envelope-has-no-instrument-low-high)
to W6 and the related
[F122](../rust/engine/architecture-review/2026-09-06/ARCHITECTURE-REVIEW.md#f122---the-performance-envelope-has-no-machine-checked-expression-low-high)
to W7.
Together their proposed work includes recorded baselines, automated comparisons, a nightly lane,
the Ironhorse daemon-benchmark arm, and scaling checks.
These references are to the architecture-review findings, not the separately numbered known-defects list.

A future schema performance contribution should measure cold resume, warm access, incremental
checkpoint, full export, collection, incoming-reference queries, and candidate surgery.
Vary live heap size, side-state volume, mutation locality, graph sharing, and checkpoint cadence
independently; report bytes read/written, peak memory, latency, and index maintenance cost.
Record backend, runtime revision, machine, cache state, and benchmark configuration with results.
We can specify those workloads now, but should defer comparative layout conclusions until the
instrumentation and reproducible baselines exist.

## Dependencies and implementation order

| Related design                                                       | Relationship                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Ironhorse engine](ironhorse-engine.md)                              | Value model, execution semantics, snapshot requirements, and performance envelope.                      |
| [Snapshot store seam](ironhorse-snapshot-store-seam.md)              | Existing canonical image, backend abstraction, integrity, paging, checkpoint, and migration mechanisms. |
| [Debugger recovery](ironhorse-debugger-recovery-and-uncaught.md)     | Related live-debugger proposal; offline snapshot inspection has a distinct execution contract.          |
| [Vat replacement](../packages/thixotrope/designs/vat-replacement.md) | Application-level upgrade motivation and obligations beyond heap validity.                              |

First reconcile the shared logical requirements against the existing schema and source seams.
Then prototype derived views and bounded queries, validate their semantics with the existing
surgery/GC fixtures, and add debugger export compatibility tests.
Measure those prototypes before selecting persistent indices or physical normalization.
Each perspective contains its own proposed experiments and acceptance criteria.
This index adds no separate runtime implementation milestone or completion claim.

## Prompt

> ok rewrite the schema doc contributions so they are in the ironhorse designs dir.
> make a schema design index that references the other documents.
> squash previous doc only commits if appropriate. force push to branch
