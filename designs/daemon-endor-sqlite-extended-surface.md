# SQLite Extended Surfaces for endor: Beyond Pet-Store Parity

| | |
|---|---|
| **Created** | 2026-07-11 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Builds on** | designs/daemon-endo-rust-sqlite.md, designs/daemon-endor-pet-store-sqlite.md (endojs/endo-but-for-bots#124) |

## Motivation

`designs/daemon-endor-pet-store-sqlite.md` (PR #124) deliberately
narrowed the Rust + XS SQLite binding contract to what the daemon's
pet-store path uses, and listed five surfaces it explicitly does
**not** generalise:

* JSON1 / FTS5 / R-tree extensions
* User-defined functions (`db.function(...)`)
* The backup API
* Multiple-database `ATTACH`
* Custom collations

The review of that document asked for a follow-up design covering
those surfaces, because they will become a dependency of future
work — the original bindings design already names "FTS for agent
memory, event logs" as the reason SQLite was worth having
(`daemon-endo-rust-sqlite.md` § Motivation), and
`endo-agent-tools.md` (Open question 5, *Memory tools placement*)
is blocked on exactly the gap this document closes: genie's
`makeMemoryTools` stays host-path "because Node-specific FTS5 …
ha[s] no `Filesystem`-cap equivalent" — a cap-backed search
substrate needs FTS5 reachable from the XS daemon.

This document scopes each surface, names the future work that
depends on it, and sketches the host binding shape. It changes no
contract that `daemon-endor-pet-store-sqlite.md` pinned; everything
here is additive.

## The dividing line: SQL-text surfaces vs host-callback surfaces

The existing binding (`rust/endo/xsnap/src/powers/sqlite.rs`, nine
host functions, JSON-over-FFI; see `daemon-endo-rust-sqlite.md`)
passes SQL text through to rusqlite unmodified. That splits the
five surfaces into two very different classes:

| Surface | Reachable via | New host functions | Rust work | Future consumer |
|---|---|---|---|---|
| JSON1 | plain SQL, today | none | none (verify only) | structured event logs, formula metadata queries |
| FTS5 | plain SQL, today | none | none (verify only) | agent memory search (`endo-agent-tools.md`), event logs |
| R-tree | plain SQL, today | none | none (verify only) | none named; comes free with the same verification |
| `ATTACH` | plain SQL today — **to be gated** | 2 (`attach`, `detach`) | `limits` feature | store sharding / cross-db migration |
| Backup API | not reachable | 1 (v1 one-shot; +3 for stepped v2) | `backup` feature | live daemon state export (hot backup) |
| User-defined functions | not reachable | 1 (`registerFunction`) | `functions` feature | content-digest and normalisation functions in SQL |
| Custom collations | not reachable | 1 (`registerCollation`) | `collation` feature | user-facing name ordering |

The first three need **no binding change at all**: the `bundled`
feature of rusqlite 0.31 compiles SQLite 3.45.0 with
`SQLITE_ENABLE_FTS3`, `SQLITE_ENABLE_FTS5`, `SQLITE_ENABLE_JSON1`,
and `SQLITE_ENABLE_RTREE` unconditionally (libsqlite3-sys 0.28.0
`build.rs`; JSON functions are additionally part of the SQLite core
since 3.38, no compile flag needed). Every endor binary already
contains them; they are exercised entirely through the existing
`exec` / `prepare` / `run` / `get` / `all` host functions. What is
missing for those three is a *verified guarantee*, not a binding.

The remaining four need Rust-side work, and two of them (UDFs,
collations) run into the one genuinely hard problem: SQLite calls
*back into the caller* mid-query, and the XS FFI has no
Rust-to-JS re-entry path. The design answer throughout is a
**named registry**: a menu of Rust-implemented behaviours,
registered onto a connection by an explicit host call, so no JS
callback ever runs inside a query.

## Surface 1: JSON1 / FTS5 / R-tree — verify, don't build

No new host functions. Deliverables:

1. **A compile-options assertion test** in
   `packages/daemon/test/` (alongside the existing XS SQLite
   tests), run on both backends:
   * FTS5 and R-tree: `SELECT * FROM pragma_compile_options`
     must include `ENABLE_FTS5` and `ENABLE_RTREE`.
   * JSON1: absent from compile options on modern SQLite (it is
     core); probe behaviourally with `SELECT json_valid('{}')`.
   This turns "the bundled build happens to include them" into a
   CI-enforced contract, so a future rusqlite upgrade or a switch
   away from `bundled` cannot silently drop an extension a
   consumer depends on.
2. **Round-trip tests through the FFI type mapping** (the
   `$bigint` / `$bytes` envelope of `daemon-endo-rust-sqlite.md`
   § FFI serialization):
   * `json(...)` / `json_extract(...)` return TEXT → `string`;
     `jsonb(...)` returns BLOB → `Uint8Array`. Both already
     round-trip; the test pins it.
   * FTS5: `CREATE VIRTUAL TABLE ... USING fts5(...)`, insert,
     `MATCH` query, `bm25()` rank (REAL → `number`), `highlight()`
     (TEXT). Table-valued functions (`json_each`, `json_tree`)
     via `prepare` + `all`.
   * R-tree: `CREATE VIRTUAL TABLE ... USING rtree(...)`, a
     bounding-box query.

Notes and non-goals:

* **Custom FTS5 tokenizers are out of scope.** Registering a
  tokenizer is a C-level API (`fts5_api.xCreateTokenizer`,
  sqlite.org/fts5.html § 7); the built-in `unicode61` (with
  `remove_diacritics`) and `trigram` tokenizers cover the agent
  memory use case. If a consumer ever needs a custom tokenizer it
  joins the named-registry pattern below, as a Rust
  implementation.
* **No gating.** Unlike `ATTACH` (Surface 4), these extensions
  grant no authority beyond the already-open database file, so SQL
  reachability is capability-clean and stays ungated.
* **`load_extension` stays sealed.** The bundled build compiles
  `SQLITE_ENABLE_LOAD_EXTENSION`, but SQLite disables both the C
  entry point and the SQL `load_extension()` function at runtime
  unless explicitly enabled (sqlite.org/c3ref/enable_load_extension.html),
  and the binding never enables it. Loading arbitrary native code
  is permanently out of scope for the endor bindings; this is a
  standing decision, not a deferral.

## Surface 2: user-defined functions (`db.function(...)`)

**Problem.** better-sqlite3's `db.function(name, [options], fn)`
runs a JS function inside SQLite's query loop. On XS that would
mean Rust calling back into the machine mid-host-call: re-entrancy
the xsnap FFI does not support, plus metering-attribution and
snapshot-determinism hazards even if it did.

**Phase A (this design): a named menu of Rust-implemented
functions.** One new host function:

| Rust function | Registration name | argc | JS signature | Return |
|---|---|---|---|---|
| `host_sqlite_register_function` | `sqliteRegisterFunction` | 2 | `sqliteRegisterFunction(dbH, name)` | undefined or `"Error: ..."` |

Implementation: rusqlite's `functions` feature
(`Connection::create_scalar_function`). The `name` selects from a
Rust-side menu; unknown names error. Every menu entry registers
with `SQLITE_DETERMINISTIC | SQLITE_DIRECTONLY` flags unless the
entry specifically needs otherwise (`DIRECTONLY` keeps
host-registered functions out of reach of triggers and views
defined by hostile schema text; sqlite.org/c3ref/c_deterministic.html).

Initial menu, driven by named needs:

* `endo_sha512_v1(blob|text) → text` — hex digest aligned with
  the daemon's content addressing, so a content-store index can
  compute/verify identifiers in SQL.
* `endo_casefold_v1(text) → text` — Unicode simple case folding,
  for normalised lookups adjacent to FTS.

**The version suffix is load-bearing.** A function's output can be
baked into the database via generated columns and expression
indexes; changing its behaviour after the fact corrupts those
silently. Menu implementations are frozen once shipped — a fix or
behaviour change is a *new name* (`_v2`) plus an explicit
`REINDEX` / rebuild migration. The menu grows by amending this
design, not ad hoc.

**Platform parity.** The XS shim (`better-sqlite3-xs.js`) gains a
non-better-sqlite3 method `db.registerHostFunction(name)`. A small
shared helper (`registerBuiltinSqlFunctions(db)` in the daemon)
makes the platforms uniform: on XS it calls
`registerHostFunction`; on Node it calls better-sqlite3's
`db.function(name, { deterministic: true }, jsImpl)` with a JS
implementation of the same menu, tested for output equality
against the Rust one. Daemon code above the helper never branches
on platform.

**Phase B (deferred, explicitly): a JS-callback trampoline.**
Arbitrary `db.function(name, fn)` would require the Rust UDF shim
to marshal arguments, re-enter the machine on a reserved callback
global, and map a JS throw to `sqlite3_result_error`. Deferred
until a consumer actually needs arbitrary JS UDFs, and then only
with answers for re-entrancy, metering, and replay determinism.
Aggregate/window functions (`db.aggregate`) are likewise deferred
until a consumer names them (tracking: to be filed when one does).

## Surface 3: the backup API

**Available today, v0:** `VACUUM INTO ?` (sqlite.org/lang_vacuum.html
§ vacuuminto) through the existing `exec`/`prepare` surface writes
a compact, transactionally-consistent copy to a new file while the
source stays live. No binding change. Limits: not incremental, no
progress reporting, fails if the target exists.

**Why file-level copy is not enough.**
`daemon-endor-pet-store-sqlite.md` waved backup off as "at the
file level, not the SQL level" — which holds only for a *stopped*
daemon. A live WAL database is three files (`db`, `-wal`, `-shm`)
that cannot be copied coherently while open. Hot backup of a
running daemon needs the SQL-level path; that is the future work
this surface serves (live state export/snapshot, e.g. before a
deliberate upgrade).

**v1 (this design): one-shot host backup.**

| Rust function | Registration name | argc | JS signature | Return |
|---|---|---|---|---|
| `host_sqlite_backup` | `sqliteBackup` | 2 | `sqliteBackup(dbH, destPath)` | JSON `{"pages": n}` or `"Error: ..."` |

Implementation: rusqlite's `backup` feature
(`rusqlite::backup::Backup`, wrapping `sqlite3_backup_init` /
`sqlite3_backup_step` / `sqlite3_backup_finish`;
sqlite.org/backup.html). The Rust side runs the loop to
completion, stepping ~100 pages with brief sleeps between steps
(the pattern of sqlite.org/backup.html example 2) so the source
connection is not starved. Synchronous from JS, like every other
host call; daemon databases are megabytes, so a blocking one-shot
is acceptable.

**v2 (deferred): stepped backup with progress.** better-sqlite3's
`db.backup(dest, { progress })` reports
`{ totalPages, remainingPages }` between step cycles. Mirroring
that needs a `BACKUP_MAP` handle map and
`sqliteBackupInit(dbH, destPath)` / `sqliteBackupStep(backupH, pages)`
/ `sqliteBackupFinish(backupH)`. The known snag, named here so v2
doesn't rediscover it: `rusqlite::backup::Backup<'a, 'b>` borrows
both connections, so it cannot live in a static handle map (the
same self-referential-borrow problem `daemon-endo-rust-sqlite.md`
§ Statement lifetime solved by re-preparing — but a backup cannot
be "re-inited" without restarting). The v2 path is raw
`libsqlite3-sys` pointers (`sqlite3_backup*` in the map, dest
connection owned by the map entry), which is exactly the shape the
C API is designed to be held in across calls. Deferred until a
database is big enough that the one-shot's pause is observed to
matter.

**Path capability note.** `destPath` opens/creates a file, so
`sqliteBackup` is an authority-bearing host function on par with
`sqliteOpen` — granted by the same power that grants `open`, never
reachable from SQL text.

## Surface 4: multiple-database `ATTACH` — gate it, then mediate it

`ATTACH DATABASE ? AS ?` (sqlite.org/lang_attach.html) is plain
SQL, so it is reachable through the existing bindings *today* —
and that is the problem, not the feature. `ATTACH` converts
possession of a database handle (or the ability to inject SQL
text) into the ambient authority to open or create **any file the
daemon process can reach**. Endo treats opening a file as a
host-granted power; the SQL surface should not smuggle one.

Two moves, one small host surface:

1. **Close the ambient path.** `sqliteOpen` sets
   `SQLITE_LIMIT_ATTACHED` to 0 on every new connection
   (rusqlite `limits` feature, `Connection::set_limit`;
   sqlite.org/c3ref/c_limit_attached.html), so SQL-level `ATTACH`
   fails. Do this **early** — before any consumer grows a
   dependency on SQL-level `ATTACH`, removing it stops being a
   cheap change.
2. **Reopen it as a host-mediated act:**

| Rust function | Registration name | argc | JS signature | Return |
|---|---|---|---|---|
| `host_sqlite_attach` | `sqliteAttach` | 3 | `sqliteAttach(dbH, path, schemaName)` | undefined or `"Error: ..."` |
| `host_sqlite_detach` | `sqliteDetach` | 2 | `sqliteDetach(dbH, schemaName)` | undefined or `"Error: ..."` |

`sqliteAttach` raises the limit by one, executes
`ATTACH DATABASE ?1 AS ?2` with bound parameters (never
interpolated text), and lowers the limit again, so each attached
database is an explicit, auditable host grant. The shim exposes
`db.attach(path, schemaName)` / `db.detach(schemaName)`; on Node
the same helper implements them over better-sqlite3 `prepare` +
`run`, keeping daemon code uniform.

Considered and rejected: strict better-sqlite3 parity (leave
`ATTACH` reachable from SQL text). Reason: ambient filesystem
authority from SQL; parity is not worth an authority leak, and no
existing daemon code uses SQL-level `ATTACH`.

Future consumers: splitting stores across files (e.g. a bulky
content/FTS index beside the hot formula database) with cross-db
joins during migration; per-agent database sharding. None
committed today; the maintainer's review names this a dependency
of future work, and the gate is worth landing regardless.

## Surface 5: custom collations

Neither better-sqlite3 nor `node:sqlite` exposes collation
registration (better-sqlite3 users reach it via `loadExtension`,
which endor permanently seals — Surface 1). So there is no
upstream idiom to copy, and the design follows the named-registry
pattern from Surface 2:

| Rust function | Registration name | argc | JS signature | Return |
|---|---|---|---|---|
| `host_sqlite_register_collation` | `sqliteRegisterCollation` | 2 | `sqliteRegisterCollation(dbH, name)` | undefined or `"Error: ..."` |

Implementation: rusqlite's `collation` feature
(`Connection::create_collation`), menu of Rust comparators.

**Collations are the strictest determinism surface of the five.**
A collation's order is baked into every index, `PRIMARY KEY`, and
`UNIQUE` constraint that names it; if its behaviour shifts, those
indexes are silently corrupt (sqlite.org/c3ref/create_collation.html
warns exactly this). The version-suffix rule from Surface 2 is
mandatory here: implementations are frozen at birth
(`endo_unicode_nocase_v1`), a change is a new name plus `REINDEX`.
The menu must be pure functions of their inputs — no
locale-tailored, ICU-backed, or platform-`Intl` comparators, which
drift across library versions.

Initial menu:

* `endo_unicode_nocase_v1` — Unicode simple case folding
  comparison (built-in `NOCASE` is ASCII-only).

Pet-store names compare with binary equality and need none of
this; the consumer is future user-facing ordering (directory and
pet-store listings sorted for humans). No committed consumer
today.

## Common infrastructure: the named-registry pattern

Surfaces 2 and 5 share one shape, worth stating once:

* A **Rust-side menu** of frozen, version-named implementations.
* An **explicit per-connection registration host call** — nothing
  is pre-registered, so a connection's SQL can only reach what its
  holder deliberately armed.
* **Parity JS implementations** for the Node/better-sqlite3
  backend, equality-tested against the Rust ones, behind one
  daemon-side helper so `daemon-database.js` (which already
  targets "a better-sqlite3-compatible constructor") never
  branches on platform.

Host-function count grows from 9 to 14 (register-function,
register-collation, backup, attach, detach), each following the
existing error-string convention and `host_aliases.js` pattern of
`daemon-endo-rust-sqlite.md`.

## Cargo changes

```toml
rusqlite = { version = "0.31", features = [
  "bundled", "functions", "collation", "backup", "limits",
] }
```

All four added features are pure Rust-API wrappers over the
already-bundled SQLite; none change the compiled C.

## Implementation phases

1. **Extension verification tests** (Surface 1). No binding
   change; unblocks the agent-memory FTS5 design immediately.
2. **`ATTACH` gate + `sqliteAttach`/`sqliteDetach`** (Surface 4).
   Small, and it *removes* ambient authority — the longer it
   waits, the more it can break.
3. **Named-registry UDFs** (Surface 2, Phase A) with the two-entry
   initial menu and Node parity helper.
4. **Collation registry** (Surface 5) with
   `endo_unicode_nocase_v1`.
5. **One-shot backup** (Surface 3 v1). Stepped v2 and the UDF
   trampoline (Phase B) stay deferred behind named consumers.

Phases 3–5 are independent of each other and can land in any
order as their consumers materialise.

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md) | Base bindings this extends; its FFI type mapping and handle-map patterns are reused unchanged. |
| daemon-endor-pet-store-sqlite (endojs/endo-but-for-bots#124) | Sibling that scoped the pet-store contract and declined these five surfaces; this design is the follow-up its review requested. |
| [endo-agent-tools](endo-agent-tools.md) | Consumer: memory tools need an FTS5-capable, cap-backed search substrate (its Open question 5). |

## Design decisions

1. **Verify, don't rebuild, the compiled-in extensions.** JSON1 /
   FTS5 / R-tree are already in every endor binary via
   rusqlite's `bundled` build; the deliverable is a CI assertion,
   not a binding.
2. **No JS callbacks inside queries.** UDFs and collations are
   Rust-implemented menu entries registered by explicit host
   calls. The trampoline that would allow arbitrary JS is
   deferred behind a named consumer and named hazards.
3. **Version-suffixed, frozen menu names.** Anything whose output
   or ordering can be baked into the database (`_v1` functions,
   collations) never changes behaviour under an existing name.
4. **`ATTACH` is a host grant, not a SQL feature.**
   `SQLITE_LIMIT_ATTACHED=0` at open; `sqliteAttach` mediates.
   Deliberate parity break with better-sqlite3, for capability
   discipline.
5. **`load_extension` is permanently sealed.** Compiled in by the
   bundled build, runtime-disabled by SQLite's default, never
   enabled by the binding.
6. **Backup is one-shot first.** Daemon databases are small;
   the stepped/progress API waits for a database big enough to
   need it, with the rusqlite borrow snag documented ahead of it.
7. **Platform parity lives in one daemon helper.** XS-only shim
   methods (`registerHostFunction`, `attach`, `backup`) get Node
   equivalents behind a shared helper so code above
   `daemon-database.js` stays platform-blind.

## Open questions

* **UDF menu contents?** Is `endo_sha512_v1` the right digest for
  SQL-side content addressing, and does `endo_casefold_v1` earn
  its slot before the FTS work lands, or should the menu start
  empty and grow with the agent-memory design?
* **Does the agent-memory design need `bm25()` tuning or an
  auxiliary rank function** beyond FTS5 built-ins? If yes, it
  arrives as a menu UDF and should be named in that design.
* **Is one-shot backup's pause acceptable at projected database
  sizes,** or should v2's stepped API be pulled forward? A
  measurement on a realistic formula-graph database would settle
  it.
* **Should `sqliteAttach` constrain the destination path** (e.g.
  to the daemon's state directory) in the host function itself,
  or is the powers-layer grant boundary enough? `sqliteOpen`
  today takes any path; consistency says powers-layer, but
  `ATTACH` is being deliberately tightened anyway.
* **Aggregate/window UDFs (`db.aggregate`)** — deferred with no
  consumer named; tracking issue to be filed by whichever design
  first needs one.

## Prompt

(For provenance.)

> Please post a plan to follow-up with a design for these as they
> will become a dependency of future work.
> — review of `designs/daemon-endor-pet-store-sqlite.md`
> (endojs/endo-but-for-bots#124, discussion r3548818899, on the
> "What we explicitly do NOT generalise" list: JSON1 / FTS5 /
> R-tree extensions, user-defined functions (`db.function(...)`),
> the backup API, multiple-database `ATTACH`, custom collations)
