# Portable Compare-and-Swap for Endo Storage

| | |
|---|---|
| **Created** | 2026-09-28 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Builds on** | [cask-rust-content-store](cask-rust-content-store.md), [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md) |

## What is the Problem Being Solved?

Endo writes values into storage on several platforms with several different
consistency stories, and today the daemon's own metadata writes have none:
`writeFormula` is `INSERT OR REPLACE` with no condition and no transaction, so
two writers of the same formula number or pet-name binding last-write-win
silently. Meanwhile the platforms Endo intends to run on each offer a
*different* conditional-write primitive: POSIX has atomic rename but no
conditional rename, SQLite has transactions, S3 has conditional PUTs on
ETags, DynamoDB has condition expressions, Cloudflare Durable Objects
serialize by construction, and D1 and R2 sit somewhere between. Code written
against any one of these does not port.

This design specifies one portable compare-and-swap capability, the failure
and ambiguity semantics every backend must honor, and the realization on each
platform. [cask-rust-content-store](cask-rust-content-store.md) consumes it as
the sole mutation primitive (cell writes, formula writes, batch-as-root-CAS);
it stands alone for any other Endo storage writer.

## The portable contract

One operation, expressed as a capability over a single addressable slot (a
CASK cell, a formula row, a platform object):

```
casWrite(slot, expected, next) -> { ok: true,  committed }
                                | { ok: false, current }
```

- `expected` and `next` are 32-byte values (content hashes or the absent
  sentinel, the all-zero value): `expected = absent` means create-if-absent;
  `next = absent` means delete-if-current. Larger values are stored as
  content and CASed by hash, which keeps the conditioned comparison
  fixed-size on every platform.
- **Linearizability per slot.** All `casWrite` operations on one slot behave
  as if executed in some total order consistent with real time. There is no
  ordering guarantee across slots; multi-slot atomicity is composed as CAS on
  an enclosing root (the CASK batch pattern), never as a transaction
  spanning slots.
- **Failure is a value, not an exception.** A mismatch returns
  `{ ok: false, current }` so the caller can rebase its reducer on `current`
  and retry. Exceptions are reserved for authority failure (revoked facet)
  and storage failure.
- **Read-your-own-committed-writes.** After `{ ok: true }`, a `get` on the
  same slot through the same backend returns `next` or a later value, never
  an earlier one. An `ok` reply also implies durability to the backend's
  declared durability level (fsync, WAL commit, replicated write; each
  backend states its level).
- **Write implies read.** Holding a CAS-capable facet on a slot implies the
  ability to read it (the `current` return leaks the value on mismatch, and a
  probe CAS can binary-search it regardless). Per CASK's honesty analysis, no
  write-only facet is offered.

### Ambiguity

Every networked backend has a window where a write may have committed but the
acknowledgment was lost. The contract makes this explicit rather than
pretending it away:

- `casWrite` may raise `AmbiguousOutcome`. The slot is then in one of two
  known states: `expected` (the write did not land) or `next` (it did).
- **Recovery is a read.** Because the operation is a CAS and `next` is a
  specific value, re-reading the slot resolves the ambiguity: if the slot is
  `next`, the write won; if `expected`, retry; if any third value, another
  writer intervened after the outcome and the caller rebases as for an
  ordinary mismatch. This self-resolution is the reason the portable
  primitive is CAS and not blind write or increment: CAS retries are
  idempotent by construction when `expected != next`, and the degenerate
  `expected == next` write is a no-op. No client-generated idempotence token
  is needed at this layer, and none is specified.
- Backends that can exclude ambiguity (in-process SQLite, Durable Objects
  single-threading) never raise it.

### What the contract deliberately excludes

- **Multi-slot transactions.** DynamoDB and SQLite could offer them; POSIX
  rename and S3 cannot. Exposing them would make the portable contract a lie
  on half the platforms. Composite-root CAS covers the need.
- **Watch/notify.** Observation of slot changes is a separate capability
  (the observe facet sketched in the main design), layered on backends that
  push and polled on backends that do not.
- **Fairness or wait-freedom.** A hot slot under contention makes losers
  retry; a backoff policy belongs to callers (reducers), not the contract.

## Per-platform realizations

| Backend | Mechanism | Linearizable | Ambiguity | Durability on ok | Notes |
|---|---|---|---|---|---|
| SQLite (in-process, WAL) | `UPDATE slots SET value=? WHERE id=? AND value=?`, check `changes()=1`, inside a transaction; `INSERT` with unique key for create | yes | never | WAL commit | the reference implementation; formula and pet-store rows condition the same way |
| Local FS (single daemon) | serialize through the store's single writer (the supervisor owns the state directory, the same single-owner assumption `endo.sqlite` already makes); slot file written as temp-then-rename after an in-memory compare under the slot's lock | yes, by single-writer serialization | never in-process; crash between write and rename leaves `expected` (temp files are ignored on recovery) | fsync + rename | a multi-process filesystem CAS (flock plus lockfile protocols) is deliberately not offered: NFS and container bind mounts make flock semantics unreliable, and Endo's process model does not need it |
| S3 | `PUT` with `If-Match: <etag>` (replace) and `If-None-Match: *` (create); the store keeps the slot-to-etag mapping and maps 412 Precondition Failed to `{ ok: false }` with a follow-up GET for `current` | yes (S3 conditional writes are strongly consistent) | on timeout/5xx after PUT | replicated | `current` costs an extra GET on mismatch; delete-if-current needs a GET-recheck loop because conditional DELETE support lags conditional PUT, and the loop must be documented as such in the backend |
| DynamoDB | `UpdateItem`/`PutItem`/`DeleteItem` with `ConditionExpression: value = :expected` (or `attribute_not_exists` for create); `ConditionalCheckFailedException` with `ReturnValuesOnConditionCheckFailure` yields `current` in one round trip | yes | on timeout after the call | replicated | the closest native fit; also the natural slot store for the AWS platform design when it lands |
| Cloudflare Durable Object | the DO is the slot's serializer: compare and write inside the single-threaded actor with `state.storage.put` under `blockConcurrencyWhile` or the implicit input gate | yes | client-to-DO ambiguity only; the DO itself never sees a race | DO storage commit | the simplest correct realization; per-slot DO or a DO sharding many slots are both admissible |
| Cloudflare D1 | as SQLite (conditioned UPDATE in a transaction) over the D1 API | yes | on API timeout | D1 commit | |
| Cloudflare R2 | conditional PUT with etag preconditions, as S3 | yes | on timeout | R2 commit | |

Backend selection is a deployment concern of the store
([cask-rust-content-store](cask-rust-content-store.md) section Rust
architecture); the capability a holder sees is identical everywhere, and a
program written against `casWrite` moves across all seven rows unchanged.

## Use for formula and value writes

- **Formula creation** becomes create-if-absent on the formula-number slot.
  A collision on a random 256-bit number indicates a bug or replay, and
  surfacing it as `{ ok: false }` is strictly better than silently replacing
  a live formula's body.
- **Pet-name binding** becomes CAS on the name's slot (`expected` = the
  binding the agent observed, including absent). This gives the daemon
  first-class "rename only if unchanged" semantics, ending the
  read-modify-write race between two hosts of one agent.
- **Cell writes** in the CASK store are the primitive's home: retention
  transfers atomically with the CAS, per the main design's GC section.
- **Reducers** (any pure state transition) run as: read root, compute new
  root, `casWrite(root slot, old, new)`, rebase and retry on `ok: false`.

## Dependencies

| Design | Relationship |
|---|---|
| [cask-rust-content-store](cask-rust-content-store.md) | consumes this contract as its sole mutation primitive |
| [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md) | the SQLite realization rides its FFI and pragma decisions |

## Phased implementation

Phases here are subsumed by the main design's phases 2, 4, and 6: the SQLite
realization lands with the store backend (phase 2), the capability surface
and the formula/pet-store conditioning with the cell bank (phase 4), and the
cloud realizations with their backends (phase 6). No independent job is
proposed.

## Design Decisions

1. **CAS, not blind write, not versions.** A version-counter API
   (write-if-version) needs a version store on platforms that lack one;
   comparing 32-byte values needs only the value, and hashes make every
   comparison fixed-size. ETag and condition-expression backends store the
   mapping internally.
2. **Ambiguity is surfaced and self-resolving by re-read**, exploiting CAS
   idempotence; no client idempotence tokens.
3. **Per-slot linearizability only; multi-slot atomicity by composite-root
   CAS.** The weakest contract every target platform can honor strictly,
   which is what makes it portable.
4. **No multi-process filesystem CAS.** Single-writer serialization in the
   supervisor, matching the state-directory ownership the daemon already
   assumes; lockfile protocols over network filesystems are a reliability
   tarpit with no consumer.
5. **Mismatch returns `current`** (one round trip to rebase), following
   CASK's `CAS` signature and DynamoDB's return-values-on-failure.

## Open questions

None. Genuine forks in this area (whether pet stores move onto CASK
structures, the price of storage writes) belong to
[cask-rust-content-store](cask-rust-content-store.md)'s open questions.

## Prompt

> Somewhat orthogonal but related: Endo needs better compare-and-swap
> facilities for writing values into storage, and CAS semantics may differ
> across filesystem and storage platforms (local FS, SQLite, S3 conditional
> writes, DynamoDB conditional expressions, Cloudflare Durable Objects / D1 /
> R2). Design a portable CAS capability and its per-platform realizations. It
> can be a section of the CASK design or a companion design file, whichever
> reads better. (kriskowal, 2026-09-28)
