# SQLite `pragma()` Simple-Result Parity

| | |
|---|---|
| **Created** | 2026-08-06 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | [PR #124 review](https://github.com/endojs/endo-but-for-bots/pull/124#discussion_r3548823737) |
| **Builds on** | [daemon-endo-rust-sqlite.md](daemon-endo-rust-sqlite.md) |

## Motivation

The XS `better-sqlite3` shim presently implements `db.pragma(source)` by passing `PRAGMA ${source}` to `sqliteExec`, which applies the pragma but discards any rows it produces. That is enough for daemon startup's `journal_mode = WAL` and `foreign_keys = ON` settings, but it is not compatible with callers that inspect a pragma.

`better-sqlite3` 11.10.0 returns row objects by default and supports `db.pragma(source, { simple: true })` for the common one-value case. The latter returns the first column of the first result row. This design gives the XS shim that same observable contract without adding a one-off Rust host ABI.

## Scope

This design extends only `packages/daemon/src/better-sqlite3-xs.js`. It does not change daemon startup, SQLite configuration defaults, the database schema, or the general statement API.

The extension is intentionally a parity surface for code shared by the Node and XS daemon paths. A caller continues to supply a pragma source such as `cache_size` or `journal_mode = WAL`, not a complete `PRAGMA` statement.

## API Contract

```js
db.pragma(source);
// -> Array<Record<string, SqliteValue>>

db.pragma(source, { simple: true });
// -> SqliteValue | undefined
```

The default result is every row produced by the pragma, decoded with the same rules as `Statement#all()`. With `simple: true`, the result is the first SQL column of the first row, or `undefined` when the pragma produces no rows. It is not the first property in a JavaScript object: SQL column position controls the result.

This follows better-sqlite3's behavior, including validation:

- `source` must be a string.
- Omitted or `null` options mean `{}`.
- Any other non-object options value throws `TypeError`.
- When present, including through the prototype chain, `options.simple` must be a boolean; otherwise the shim throws `TypeError`.
- SQLite prepare or execution failures throw through the existing FFI error conversion.

No additional options are introduced. In particular, this does not add better-sqlite3's unrelated `safeIntegers` setting or make pragmas parameterized.

## Shim Design

`XsDatabase#pragma(source, options)` validates its arguments before allocating a statement, then uses the ordinary statement path for exactly one `PRAGMA ${source}` query. It finalizes that temporary statement in a `finally` block whether the query succeeds or throws.

For the default form, the shim returns `statement.all()`. For `{ simple: true }`, it obtains one row with `statement.get()`. If there is no row, it returns `undefined`; otherwise it uses the first name returned by `statement._columns()` and returns `row[firstColumn.name]` after the normal FFI value decoding.

The first-column lookup must use `_columns()[0]`, rather than `Object.values(row)[0]`. JSON object member order is not the SQL result-column contract, particularly across the Rust JSON boundary. `XsStatement#_columns()` is a small internal shim method over the already-registered `sqliteStmtColumns` binding; it exposes the names in SQLite column order for this internal use. It is underscore-prefixed to match this file's private-member convention (`_handle`, `_finalized`, `_params()`) and to avoid colliding, with only a partial contract, with real better-sqlite3's richer public `Statement#columns()`.

Illustrative control flow:

```js
pragma(source, options = {}) {
  // validate source and options as better-sqlite3 does
  const statement = this.prepare(`PRAGMA ${source}`);
  try {
    if (!options.simple) return statement.all();
    const row = statement.get();
    if (row === undefined) return undefined;
    const [firstColumn] = statement._columns();
    return row[firstColumn.name];
  } finally {
    statement.finalize();
  }
}
```

The implementation must preserve the existing closed-database failure behavior by routing through `prepare()`. It must also leave the existing fire-and-forget startup calls valid: they now compute and ignore the same result that Node's better-sqlite3 computes.

### Action pragmas and repeated preparation

The host re-prepares the stored SQL on each statement call: `get()` and `_columns()` each issue a fresh `sqlitePrepare` from the retained SQL rather than reusing one prepared statement. SQLite applies a pragma's effect at prepare time, not step time, so the `{ simple: true }` path prepares the pragma SQL twice: once for `get()` and once for `_columns()`. For the informational and setting pragmas this API targets (`cache_size`, `journal_mode`, `foreign_keys`, `table_info`, and the like), preparation is idempotent and the observable result is identical to Node's single execution.

It is not idempotent for *action* pragmas whose effect is a side effect of preparation (`wal_checkpoint`, `incremental_vacuum`, `optimize`, `shrink_memory`, and similar), which would apply their effect twice under `{ simple: true }` (for example `wal_checkpoint(TRUNCATE)` would checkpoint twice, `incremental_vacuum(N)` would free up to `2N` pages) and so diverge from Node's better-sqlite3, which runs the action once. This surface therefore does **not** promise `{ simple: true }` parity for action pragmas; a caller that needs a single value from an action pragma on the XS shim must read it from the default array form, which prepares only once (`all()`), rather than through `{ simple: true }`. Removing the limitation for the simple form as well would require a single-prepare path that reuses one prepared statement for both the row and its column names, which is out of scope here because it needs a new or revised host binding (see Alternatives Considered).

## Host-Binding Behavior

No callback, alias, or Rust-side handle type is added. The shim composes the existing bindings:

| Shim operation | Existing host binding | Required behavior |
|---|---|---|
| Create temporary pragma statement | `sqlitePrepare(dbHandle, 'PRAGMA ...')` | Retain the SQL and database handle as for other prepared statements. |
| Default result | `sqliteStmtAll(statementHandle, '[]')` | Return all pragma rows through the ordinary JSON row encoding. |
| Simple result | `sqliteStmtGet(statementHandle, '[]')` | Return the first row or `"null"`; decoded `"null"` becomes `undefined`. |
| Identify the simple column | `sqliteStmtColumns(statementHandle)` | Return names in SQLite result-column order; the first element names the scalar column. |
| Release temporary handle | `sqliteStmtFinalize(statementHandle)` | Remove the statement-map entry on every exit path. |

`sqliteExec` is deliberately not used for `pragma()`: `execute_batch` applies a pragma but exposes none of its result rows. The existing Rust implementation already re-prepares stored SQL for each `get` or `all` call, so a pragma statement has the same lifetime and lock ordering as every other temporary statement.

The Rust work is limited to making the existing `sqliteStmtColumns` ordering guarantee explicit and covered by tests. The host must return the SQLite column names in ordinal order even though row JSON objects do not promise that order.

## Verification Plan

Add XS-shim tests alongside the existing SQLite adapter coverage and run the same cases against Node's `better-sqlite3` constructor as the oracle.

1. A read pragma, such as `cache_size`, returns a one-row object array by default and its scalar value with `{ simple: true }`.
2. A setting pragma, such as `journal_mode = WAL`, returns its reported row in both forms; `foreign_keys = ON` covers the no-row case and returns `undefined` in simple mode.
3. `table_info` on a fixture table verifies that simple mode returns the first SQL column (`cid`), not an alphabetically or insertion-ordered object property.
4. Invalid source and option shapes, a non-boolean `simple`, and an invalid pragma match Node's observable failures.
5. A throwing query still finalizes the temporary statement; a subsequent query and database close succeed, proving that no statement-map entry leaked.
6. An action pragma such as `wal_checkpoint` confirms the default array form applies the action exactly once, matching Node. Because the host re-prepares the SQL for each statement call, the `{ simple: true }` form is documented as outside the parity guarantee for action pragmas (it would apply the action twice) and is not asserted to match Node for this class; the test locks in that scoping so the divergence is intentional and covered rather than latent.

## Alternatives Considered

### Add `sqlitePragma` as a new host callback

Rejected for the pragmas this surface targets. It would duplicate the existing prepare, query, column-metadata, and finalization protocol for one SQL statement family, increasing the snapshot alias surface without capability benefit; for the informational and setting pragmas this design targets it also costs nothing observable. The claim of no *performance* benefit holds only for that idempotent-pragma case: a dedicated binding doing the query and first-column pluck in one Rust-side execution would in fact avoid the double preparation the composed `{ simple: true }` path incurs (see Action pragmas and repeated preparation), so it does carry a real benefit for the non-idempotent action-pragma subclass. This design handles that subclass by scoping the `{ simple: true }` parity guarantee to idempotent pragmas rather than by adding a binding, keeping the surface minimal; a future single-prepare path would revisit this if action-pragma simple-result parity ever becomes a requirement.

### Derive the simple value from object enumeration

Rejected. It accidentally relies on JSON member ordering instead of the SQL first-column rule that better-sqlite3 implements with `pluck().get()`.

### Keep pragma writes fire-and-forget

Rejected. It preserves today's startup behavior but leaves shared callers unable to use an established better-sqlite3 convenience API. Returning rows does not alter the effect of callers that ignore them.

## Implementation Phases

1. Add `XsStatement#_columns()` and replace the fire-and-forget `pragma()` shim with the specified temporary-statement flow.
2. State and test the `sqliteStmtColumns` column-order guarantee in the Rust host binding; no callback registration changes.
3. Add Node-versus-XS parity tests for default, simple, no-row, validation, error-cleanup, and multi-column cases.

## Files to Modify

- `packages/daemon/src/better-sqlite3-xs.js`: implement result-bearing `pragma()` and the internal column metadata helper.
- `rust/endo/xsnap/src/powers/sqlite.rs`: document and test ordinal column-name results from `sqliteStmtColumns`.
- `packages/daemon/test/` SQLite adapter coverage: add the parity cases in the verification plan.
- `designs/daemon-endo-rust-sqlite.md`: update the host-binding contract when the implementation lands.

## Open Questions

No unresolved design question remains. Supporting further better-sqlite3 database or statement APIs requires a separate compatibility design rather than expanding this small surface opportunistically.

## Prompt

> Design the `db.pragma()` `simple: true` extension deferred as an open question: better-sqlite3's `pragma(stmt, { simple: true })` returns a scalar rather than a row set. Specify the shim and host binding behavior.
