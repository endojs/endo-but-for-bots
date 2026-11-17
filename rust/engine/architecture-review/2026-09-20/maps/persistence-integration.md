# Region map: persistence and integration

Reviewed at `62b907421`.

## Architecture

`ironhorse-snapshot` owns the portable container and paged-store representations.
`GatedImage` admits a write, `ValidatedSnapshot` admits adoption, and the
side-table roster coordinates capture, validation, restore, and schema identity.

`HeapStore` exposes raw point reads plus metadata inventories.
The blanket `HeapStoreCommit` implementation validates succession, current and
proposed roots, geometry, section/row summaries, and the batch before handing a
backend a `VerifiedCommit`.
`MemoryStore` is the reference backend, `FileStore` publishes a complete file,
and `rust/endo/ironhorse-store-sqlite` applies batches in SQLite transactions.

`PersistentMachine` owns the live VM/store session.
It executes a bounded crank, checkpoints completed work according to cadence,
rewinds after terminal failure, and reattaches compiler, meter, global-name, and
host-callable policy on restore.

## Compatibility identity

Snapshots bind format/schema versions, callback signature, meter release/digest,
boot fingerprint, and deterministic provider identity.
The Intl portion covers the locked ICU dependency graph, but not every in-tree
algorithm/table that contributes to output.
The source records a compact-notation change that retained the same fingerprint,
which produced F001.

## Failure taxonomy and commit outcome

SQLite maps both actual medium errors and several deterministic malformed or
foreign states to `StoreError::Io`.
Core classifies all `Io` as transient.
`BaselineMismatch` separately combines a foreign lineage with recomputed
at-rest corruption and classifies both as refusal.
These mechanisms form F006.

The commit interface returns only success or error.
File publication can succeed at rename and then fail at directory sync/reopen;
SQLite can durably commit before the caller observes acknowledgement.
The worker assumes every error left the previous epoch durable and rewinds.
That unrepresented outcome is F007.

## Verification architecture

The store and snapshot suites are unusually strong in example-based coverage:
they cover canonical encodings, corrupted rows, sparse checkpoints, lazy faults,
fork/replay guards, host recipes, jobs, collection, resume equality, and file
reopen behavior.

Coverage-guided fuzzing is split across store mutation, image round trip, and
live differential cranks.
No one target composes execution with incremental durable checkpoint, fault,
reopen, restore, and continuation, and no target drives SQLite.
That residual composition gap is F009.

## Current gate result

The ordinary `ironhorse-262` package run completed 152 tests and failed three.
Eight compiler byte divergences and two covered arithmetic cases share the
numeric-oracle mechanism described in F004.
The rest of the engine workspace passed when that package was excluded.

## Deliberate limits

Live guest compartments, guest `globalLexicals`, and the shared-primordial
profile of a default `Interp` remain explicit write-side persistence refusals.
The module hook half of guest `Compartment` remains phase 2.
These are rollout limitations rather than silent state loss.

## Not read exhaustively

Every codec arm in `image.rs` and `snapshot_roster.rs`, all SQLite tests, every
Test262 expectation shard, and the full fuzz corpus were not read line by line.
No external daemon replay, nightly fuzz campaign, or crash-injection campaign
was run.

