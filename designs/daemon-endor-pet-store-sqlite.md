# SQLite Bindings for endor: Pet-Store Surface Parity

| | |
|---|---|
| **Created** | 2026-05-03 |
| **Updated** | 2026-05-03 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Draft |
| **Builds on** | designs/daemon-endo-rust-sqlite.md |

## Status

Draft.
The Rust + XS SQLite host functions described in
`daemon-endo-rust-sqlite.md` are already present
(`rust/endo/xsnap/src/powers/sqlite.rs` + the JS-side
`packages/daemon/src/endor-sqlite.js` shim).
This document narrows the contract to the surface the daemon's
pet-store system actually depends on, identifies the small
generalisations the existing bindings still need, and pins down
the better-sqlite3 idioms we keep verbatim.

## Motivation

`packages/daemon/src/pet-store.js` is the durable name -> formula
identifier registry that every host, guest, mailbox, and
directory in an Endo daemon ultimately leans on.
On the Node daemon it persists via better-sqlite3.
On the Rust + XS daemon it must persist via the host SQLite
bindings, with the same operational semantics, the same wire
shape on disk, and the same observable behaviour from
`pet-store.js` and `daemon-database.js` upstream.

The first integration of the Rust SQLite bindings landed for the
broader daemon-database surface (formulas, agent keys,
retention, synced-store) but the pet-store-specific path is the
hot one: every `provideX` and every `lookup(petName)` call
touches it.
The pet-store table layout and statements are already defined in
`packages/daemon/src/daemon-database.js`; the goal here is
parity, not redesign.

The driving constraint, repeated from the prompt: **change as
little of the existing pet-store / daemon-database code as
possible**.
The XS shim must satisfy the same calls the Node implementation
already makes; any difference between platforms is a cost paid
in test surface and reviewer attention, and we want both
minimised.

## Surface contract: what pet-store actually uses

`packages/daemon/src/daemon-database.js` constructs the
following statements at startup and `pet-store.js` invokes them
at runtime:

```js
const stmtWritePetEntry = db.prepare(
  'INSERT OR REPLACE INTO pet_store_entry ' +
    '(store_number, store_type, name, formula_id) VALUES (?, ?, ?, ?)',
);
const stmtDeletePetEntry = db.prepare(
  'DELETE FROM pet_store_entry ' +
    'WHERE store_number = ? AND store_type = ? AND name = ?',
);
const stmtRenamePetEntry = db.prepare(
  'UPDATE pet_store_entry SET name = ? ' +
    'WHERE store_number = ? AND store_type = ? AND name = ?',
);
const stmtListPetEntries = db.prepare(
  'SELECT name, formula_id AS formulaId FROM pet_store_entry ' +
    'WHERE store_number = ? AND store_type = ?',
);
const stmtDeleteAllPetEntries = db.prepare(
  'DELETE FROM pet_store_entry WHERE store_number = ? AND store_type = ?',
);
```

The wrapper-level entry points are:

```ts
writePetStoreEntry(storeNumber, storeType, name, formulaId): void
deletePetStoreEntry(storeNumber, storeType, name): void
renamePetStoreEntry(storeNumber, storeType, fromName, toName): void
listPetStoreEntries(storeNumber, storeType):
  Array<{ name: string, formulaId: string }>
deletePetStore(storeNumber, storeType): void
```

The required methods on the `Database` and `Statement` objects
are exactly:

* `new Database(path: string)`
* `db.pragma(text: string)` — at startup only; sets
  `journal_mode = WAL` and `foreign_keys = ON`.
* `db.exec(sql: string)` — at startup, for `SCHEMA_SQL`.
* `db.prepare(sql: string) -> Statement` — at startup, once per
  statement, cached on the `daemonDb` closure.
* `stmt.run(...args) -> { changes: number, lastInsertRowid: number }`
* `stmt.get(...args) -> object | undefined`
* `stmt.all(...args) -> object[]`
* `db.close()` — at daemon shutdown.

`db.transaction(fn)` is **not** used by the pet-store path
today; see "Generalisations" below for whether to add it.

All `args` are positional `?` placeholders, all bound types are
text or short integers, and all returned columns are text.
No JSON columns, no BLOBs, no streaming `iterate()`, no
multi-row binds, no user-defined functions.

## Mapping to host functions

The host-function surface defined in
`daemon-endo-rust-sqlite.md` covers everything the contract
above needs:

| better-sqlite3 surface | host function | already in design? |
|---|---|---|
| `new Database(path)` | `hostSqliteOpen(path)` | yes |
| `db.close()` | `hostSqliteClose(db)` | yes |
| `db.exec(sql)` | `hostSqliteExec(db, sql)` | yes |
| `db.pragma(stmt)` | `hostSqliteExec(db, "PRAGMA " + stmt)` | shimmed in JS |
| `db.prepare(sql)` | `hostSqlitePrepare(db, sql)` | yes |
| `stmt.run(args)` | `hostSqliteStmtRun(stmt, paramsJson)` | yes |
| `stmt.get(args)` | `hostSqliteStmtGet(stmt, paramsJson)` | yes |
| `stmt.all(args)` | `hostSqliteStmtAll(stmt, paramsJson)` | yes |
| `stmt.<gc>` | `hostSqliteStmtFinalize(stmt)` | yes (called from `prepare` path) |

The XS shim
(`packages/daemon/src/endor-sqlite.js`) translates each
better-sqlite3 method into one host call.
The shim already exists; this design doesn't reinvent it.

### Why the shim layer stays

The pet-store and daemon-database code is written against
better-sqlite3.
We could rewrite that code to call host functions directly, but
that fragments the platform — Node-side code would still use
better-sqlite3 and XS-side code would diverge into a custom
ABI.
A tiny adapter (~200 lines, the size of
`endor-sqlite.js`) keeps the upstream code uniform across
Node and XS, which matches the prompt's "as little difference
from the current code as possible" constraint exactly.

## Generalisations needed

The prompt asks to "presumably include a generalisation of the
DSL used for creating statements".
The pet-store contract above is already covered by the existing
DSL (positional `?` placeholders in textual SQL, JSON-tagged
parameter encoding for bigints / blobs).
What the existing layer *does not* cover well, and what the
pet-store path will eventually need, is the next item below:

### Transactions (Phase 2)

`renamePetStoreEntry` runs as a single `UPDATE`, so it is
atomic on its own.
But pet-store callers higher up the stack (e.g. `move` across
two stores, the host's `provideGuest` chain) compose multiple
writes that should commit or roll back together.
Today they don't, because better-sqlite3's `db.transaction(fn)`
helper is not used in `daemon-database.js`.

The minimum increment is to add the better-sqlite3 transaction
shape verbatim:

```js
const tx = db.transaction((...args) => {
  // body uses prepared statements; throws roll back
});
tx(...args);
// optional better-sqlite3 modes:
tx.deferred(...args);
tx.immediate(...args);
tx.exclusive(...args);
```

On the Rust side this maps to `BEGIN [DEFERRED|IMMEDIATE|EXCLUSIVE]
TRANSACTION` / `COMMIT` / `ROLLBACK` exec'd through the existing
`hostSqliteExec` host function.
The XS shim wraps the user-supplied function in a try/catch that
emits `ROLLBACK` on throw and `COMMIT` on return.
No new host function is required — this is a **JS-side** addition
to `endor-sqlite.js`.

For the Node side the upstream better-sqlite3 already provides
this; nothing changes.

### Returning `lastInsertRowid` for pet-store

`writePetStoreEntry` ignores the return value, but
`hostSqliteStmtRun` already returns
`{ changes, last_insert_row_id }` which the shim re-shapes to
`{ changes, lastInsertRowid }` — better-sqlite3-compatible.
Pet-store does not depend on this; documenting it because future
additions (e.g. an `id INTEGER PRIMARY KEY` rowid column) will
want it.

### Bigint round-trip on pet-store columns

All pet-store columns are `TEXT` per the schema, so the
`$bigint` FFI tag never fires on this path.
Documented for review of the wider daemon-database surface
(formula `node` is text, `agent_id` is text, retention numbers
are text); only `synced_store_meta` uses INTEGERs and clocks
small enough to fit in a Number.

### Iterators (Phase 3, optional)

better-sqlite3's `stmt.iterate(...args)` yields rows lazily.
Pet-store calls `listPetStoreEntries` which reads every row of
`(storeNumber, storeType)` into memory at startup (see
`pet-store.js` line ~76).
A 50k-name store loads in a single allocation today, which is
fine for current scale; if it stops being fine the path is to
add `hostSqliteStmtNext(stmt)` returning one row at a time and
expose it from the shim as `stmt.iterate()`.
Out of scope for v1.

### What we explicitly do NOT generalise

* **JSON1 / FTS5 / R-tree extensions** — pet-store needs none.
* **User-defined functions** (`db.function(...)`) — pet-store
  needs none.
* **Backup API** — daemon backup is at the file level, not the
  SQL level.
* **Multiple-database `ATTACH`** — pet-store lives in the same
  database as the rest of `daemon-database.js`.
* **Custom collations** — pet-store names compare with binary
  equality.

The design intent is that everything not on the "Generalisations
needed" list above stays exactly as
`daemon-endo-rust-sqlite.md` already specified.

## Schema parity

The `pet_store_entry` table is created by `SCHEMA_SQL` in
`daemon-database.js`:

```sql
CREATE TABLE IF NOT EXISTS pet_store_entry (
  store_number TEXT NOT NULL,
  store_type   TEXT NOT NULL,
  name         TEXT NOT NULL,
  formula_id   TEXT NOT NULL,
  PRIMARY KEY (store_number, store_type, name)
);
```

No covering index for `(store_number, store_type)` is necessary
beyond the implicit one from the primary key — the leftmost
prefix of the PK serves `listPetStoreEntries` and
`deletePetStore` queries.

Validation: cargo test `-p endo --lib` runs the schema against
the Rust-bundled SQLite at compile time via a fixture; running
the same `SCHEMA_SQL` at startup is idempotent under
`CREATE TABLE IF NOT EXISTS`, so a fresh XS daemon converges to
the same on-disk shape as a fresh Node daemon.

## Implementation phases

1. **Verify the existing host bindings are sufficient.**
   Run the Rust+XS daemon under `ENDO_BIN` against
   `packages/daemon/test/endo.test.js`'s pet-store-touching
   subset (`store value`, `lookup`, `move`, `remove`).
   Currently passes for Rust+Node, fails for Rust+XS for
   non-SQLite reasons (`makeBundle` / `makeUnconfined` host
   stubs) — none of which involve pet-store.

2. **Add `db.transaction(fn)` to the XS shim.**
   ~30 lines in `endor-sqlite.js`.
   Mirror better-sqlite3's mode-suffix variants
   (`tx.deferred`, `tx.immediate`, `tx.exclusive`).
   Test with a synthetic two-statement `renamePetStoreEntry`
   that throws between the (hypothetical) DELETE and INSERT.

3. **Lift the pet-store rename into a transaction.**
   Today `renamePetStoreEntry` runs a single `UPDATE`; if the
   PK-collision migration ever requires DELETE+INSERT it should
   land inside a `db.transaction(...)`.
   Tracked but not blocking parity.

4. **Iterator / `each` (deferred).**
   Only when a measurement shows the eager `listPetStoreEntries`
   load actually matters.

## Files to create or modify

* `packages/daemon/src/endor-sqlite.js` - append a
  `transaction()` method to the `Database` adapter.
* `packages/daemon/src/daemon-database.js` — no source change
  required for parity; lift to a transaction only when a real
  caller needs atomicity.
* `packages/daemon/test/endor-sqlite.test.js` - extend with
  pet-store-shaped CRUD tests + a transaction throw/commit
  test.
* `rust/endo/xsnap/src/powers/sqlite.rs` — no change required
  for pet-store parity.

## Open questions

* **Should `db.pragma()` accept a `simple: true` option?**
  better-sqlite3's `pragma(stmt, { simple: true })` returns a
  scalar.
  daemon-database's only pragma usage is `journal_mode = WAL`
  / `foreign_keys = ON`, which discard the result.
  Skip until a caller needs it.

* **Connection pooling?**
  better-sqlite3 is single-threaded.
  The Rust supervisor's SQLite connection lives on the daemon
  XS thread (single-threaded by construction), so no pooling is
  needed.

* **WAL checkpointing on shutdown?**
  Today neither Node nor XS does this explicitly.
  `journal_mode = WAL` + clean `db.close()` is sufficient on
  shutdown; aggressive checkpointing on startup is a separate
  perf question, out of scope.

## Prompt

(For provenance.)
> Please create a design in designs/ for sqlite bindings for
> endor (rust + XS) that are sufficient to satisfy the needs of
> the daemon's pet store system. That presumably includes a
> generalization of the DSL used for creating statements, but
> ideally, as little difference from the current code as
> possible, largely borrowing design patterns from
> better-sqlite3.
