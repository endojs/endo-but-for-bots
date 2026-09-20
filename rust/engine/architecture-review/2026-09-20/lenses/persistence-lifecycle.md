# Lens: persistence and lifecycle

Reviewed at `62b907421`.

## Assessment

IronHorse's persistence data plane is carefully defended.
The central gate authenticates and validates state before adoption, backends
cannot bypass commit admission, and snapshot/store tests exercise a wide range
of corruption and continuation cases.

The remaining weaknesses are in compatibility coverage and the operational
meaning of failures, not in an observed path that silently adopts malformed heap
rows.

## Compatibility identity

The boot fingerprint is structurally broad but only as complete as its inputs.
The Intl input represents the locked ICU dependency graph, not every in-tree
table and algorithm.
The recorded compact-notation output change under an unchanged fingerprint is
direct evidence that the compatibility predicate is incomplete.

## Failure classification

The public supervisor contract gives three actions: retry transient, stop on
refusal, and abandon poisoned storage.
The underlying variants do not currently support that promise precisely.

SQLite's blanket `Io` conversion includes retryable lock contention, permanent
foreign-database refusal, and malformed durable content.
At the core layer, `BaselineMismatch` includes both a legitimate foreign lineage
and a root recomputation disagreement caused by tamper or bit rot.
An early shared-profile check can also interpret canonical tampered section data
before the manifest root is checked.

These should be one workstream because they all answer the same supervisor
question incorrectly, even though fixes occur at different layers.

## Ambiguous commit outcome

Atomic publication does not imply unambiguous acknowledgement.
The file backend can rename successfully before a later sync/reopen error, and a
SQLite COMMIT can become durable before the caller observes its result.

The current binary result cannot tell the worker to reconcile.
The worker assumes every error means the prior epoch is still durable, rewinds,
and returns an error that can trigger redelivery.
The right abstraction needs an outcome-unknown state plus epoch/seal
reconciliation, or an end-to-end delivery-id contract.

## Verification gap

Example and property tests cover stores extensively, and fuzz targets cover
several components independently.
The missing composition is a coverage-guided state machine that drives live
reference-bearing execution through incremental checkpoint, fault, durable
reopen, restore, and continuation.
SQLite needs its own daemon-workspace target because it is outside the safe
engine workspace and has storage-specific dynamic-type/schema behavior.

## Deliberate refusals

The persistence gate correctly refuses live phase-1 guest compartments and
their lexical state rather than dropping them.
Those refusals should remain until the instance/environment ownership, lexical
rows, primordial profile, and compiler reattachment have durable forms.

## Evidence

- `ironhorse-snapshot/src/versions.rs:42-65`
- `ironhorse-snapshot/src/store.rs:181-195,256-310,1841-1988`
- `ironhorse-snapshot/src/store_file.rs:803-829`
- `rust/endo/ironhorse-store-sqlite/src/lib.rs:46-59,108-181,240-267,1278-1288`
- `rust/endo/src/ironhorse_engine.rs:1087-1120,1290-1318,1525-1539`
- `ironhorse-vm/src/interp/persist.rs:542-603`

