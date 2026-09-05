# Passable Databases with `@endo/exo-db`

| | |
|---|---|
| **Created** | 2026-09-05 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Motivation

Endo has guarded exos, a passable-value and pattern vocabulary, an ordered
encoding for passable keys, and SQLite bindings for both the Node and Endor
daemon paths. It does not have one package that combines those pieces into a
database capability. Applications consequently either expose a storage
engine directly, invent a bespoke table interface, or load a whole durable
collection before filtering it.

`@endo/exo-db` supplies a capability-safe database, table, and row model. Its
first implementation, `@endo/exo-db/sqlite`, runs unchanged under Node or
Endor. The public model is deliberately limited to operations that can also be
implemented by DynamoDB. DynamoDB is the chosen portability floor because a
hosted daemon deployment (for example on Minion Town) wants a managed,
serverless, horizontally scaling key-value store rather than a single-file
engine it must operate itself, and DynamoDB is the narrowest widely available
such target; constraining the model to it keeps an application portable onto
that managed substrate without any provider-aware code. This is API
portability, not file-format portability: moving a deployment between providers
requires a row-copy migration, but does not require application code or schemas
to change.

This design builds on:

- `@endo/exo` and `@endo/patterns` for guarded remotable interfaces and
  schema-derived validation;
- `@endo/marshal`'s `makeEncodePassable({ format: 'compactOrdered' })` and
  rank-cover machinery for ordered keys;
- the three-export pattern in the [`@endo/platform` filesystem types and
  adapters design](platform-fs.md): a condition-selected module, a portable
  `lite` contract, and explicit platform modules;
- the Node/Endor SQLite parity surface in [SQLite Host Methods for Endo Rust
  (XS)](daemon-endo-rust-sqlite.md) and [Streaming SQLite Rows for
  endor](daemon-endor-sqlite-iterate-streaming.md); and
- the body-versus-rank distinction and formula retention requirements in
  [Persistent Stores in the Endo Pet
  Daemon](../packages/daemon/designs/daemon-persistent-stores.md).

## Goals and non-goals

The package must:

1. expose separate read, write, and administrative capabilities for databases
   and tables;
2. carry immutable rows as pass-by-copy records, including durable references
   in cells declared as passable;
3. support exact native scalar columns, JSON document columns, and opaque
   passable columns as three explicit schema bands;
4. provide point reads, conditional single-row writes, projection, native
   predicates, and partition-scoped ordered range queries; and
5. give Node and Endor the same SQLite behavior while leaving a credible
   DynamoDB implementation path.

The first version does not expose SQL, joins, foreign keys, multi-row
transactions, unbounded table scans, live queries, triggers, stored
procedures, or arbitrary provider expressions. It also does not make SQLite
files portable to DynamoDB. These omissions are the portability boundary, not
an implementation backlog.

## Capability and value model

There is intentionally no `Row` exo. A row is a hardened `CopyRecord`, and a
query yields row snapshots through an existing `@endo/exo-stream`
`PassableReader`. A remotable or promise inside a passable cell remains a
capability passed by presence, but the enclosing row is still a plain
pass-by-copy value. Database, table, and reader identities are capabilities.

The package exports these `M.interface` guards:

```js
export const DatabaseReadInterface = M.interface('DatabaseRead', {
  describe: M.callWhen().returns(M.record()),
  listTables: M.callWhen().returns(M.arrayOf(M.string())),
  openTable: M.callWhen(M.string()).returns(M.remotable('TableRead')),
});

export const DatabaseWriteInterface = M.interface('DatabaseWrite', {
  readOnly: M.callWhen().returns(M.remotable('DatabaseRead')),
  openTable: M.callWhen(M.string()).returns(M.remotable('TableWrite')),
});

export const DatabaseAdminInterface = M.interface('DatabaseAdmin', {
  readOnly: M.callWhen().returns(M.remotable('DatabaseRead')),
  readWrite: M.callWhen().returns(M.remotable('DatabaseWrite')),
  createTable: M.callWhen(M.string(), M.record()).returns(
    M.remotable('TableWrite'),
  ),
  dropTable: M.callWhen(M.string()).returns(),
});

export const TableReadInterface = M.interface('TableRead', {
  describe: M.callWhen().returns(M.record()),
  get: M.callWhen(M.record()).returns(M.or(M.record(), M.undefined())),
  query: M.callWhen(M.record()).returns(M.remotable('PassableReader')),
});

export const TableWriteInterface = M.interface('TableWrite', {
  readOnly: M.callWhen().returns(M.remotable('TableRead')),
  insert: M.callWhen(M.record()).returns(),
  put: M.callWhen(M.record()).returns(),
  update: M.callWhen(M.record()).returns(),
  delete: M.callWhen(M.record()).returns(M.boolean()),
});
```

The concrete guards are generated from each table schema, so a method guarded
as `M.record()` above also checks the exact row, key, query, and projection
shape before touching a backend. The generated guards pass an explicit `limits`
argument derived from the same versioned size limits (see the DynamoDB
portability target) rather than inheriting `defaultLimits`; a bare `M.record()`
or `M.string()` would otherwise silently impose the pattern defaults (80
properties, 100000 code units, 100000 bytes) as an undeclared contract. The
static interfaces show the capability boundary; `makeTableGuardKit(schema)`
supplies the narrower per-instance guards. Interface-guard exports use the
repository's `<Name>Interface` naming convention.

`makeExoDatabase` uses `defineExoClassKit` for the `read`, `write`, and
`admin` facets. Opening a table returns a read or write table facet according
to the database facet used. A holder cannot amplify a read facet into a write
facet. The creator receives the admin facet and may distribute attenuated
facets. Raw SQLite connections, DynamoDB clients, physical names, continuation
tokens, and durable reference identifiers never cross an exo boundary.

The method semantics are:

- `insert(row)` atomically fails if the primary key already exists;
- `update(row)` atomically fails if it does not exist;
- `put(row)` atomically inserts or replaces; and
- `delete(key)` returns whether a row existed.

The mutation contract is that an acknowledged mutation is durable, while two
concurrent writes to one key take some serial order. The update-only mutator is
spelled `update` rather than `replace` deliberately: SQLite's `REPLACE INTO` is
an upsert (the role `put` fills here), so a `replace` method would read as `put`
to anyone who knows either backend.

No version claims a multi-row transaction. A later transaction interface must
first identify a useful limit and isolation contract shared by both providers.

## Schema and the three type bands

A database schema and every method argument are pass-by-copy values. A table
schema is closed and immutable after `createTable`; migration creates a new
table and copies rows. Logical names are well-formed strings. Rows contain
exactly the declared columns, and every primary or index key source is
required and non-null.

```ts
type Column =
  | { kind: 'boolean'; nullable?: boolean }
  | { kind: 'int64'; nullable?: boolean }
  | { kind: 'float64'; nullable?: boolean }
  | { kind: 'string'; nullable?: boolean }
  | { kind: 'bytes'; nullable?: boolean }
  | { kind: 'json'; nullable?: boolean; shape?: Pattern }
  | { kind: 'passable'; nullable?: boolean; shape?: Pattern };

type Selector = readonly [column: string, ...jsonPath: (string | number)[]];

type Index = {
  partition: Selector;
  sort?: Selector;
  // Columns this secondary index materializes (a storage-cost policy),
  // distinct from a query's presentation `project`.
  materialize?: Readonly<Record<string, Selector>>;
};

type TableSchema = {
  columns: Readonly<Record<string, Column>>;
  primary: Index;
  indexes?: Readonly<Record<string, Index>>;
};
```

The three bands are deliberate:

| Band | Accepted values | SQLite representation | DynamoDB representation | Native operations |
|---|---|---|---|---|
| Narrow | `boolean`, signed 64-bit `bigint`, finite binary64 `number`, well-formed `string`, passable bytes, and explicit `null` | `INTEGER`, `REAL`, `TEXT`, `BLOB`, with `STRICT` tables and checks | `BOOL`, `N` (except `float64`, see below), `S`, `B`, `NULL` | Exact validation, keys, comparisons, projection |
| JSON | Hardened JSON values: null, booleans, finite numbers, strings, arrays, and string-keyed records | Canonical JSON text checked with JSON1 | Native map/list/scalar attributes | Declared JSON-path indexes, projection, and the predicate subset below |
| Passable | Every durably passable value, including copy data, errors, promises, remotables, and references nested in copy data | Smallcaps body plus formula-identifier slots | Opaque body plus formula-identifier slot list | Whole-cell read/write only; a `Key` value may additionally serve as an encoded key |

The narrow band is intentionally stricter than either engine's coercions.
`int64` never silently becomes REAL, `float64` rejects `NaN` and infinities,
and booleans do not accept `0` or `1` at the exo boundary. This gives callers
the precise cell types expected of a relational schema while retaining an
honest common mapping to DynamoDB.

`float64` is the one narrow type that does not map to a DynamoDB `N`. DynamoDB's
`N` is a base-10 decimal capped at 38 significant digits with an exponent range
of roughly [-130, +125], so common binary64 values (`0.1`, `1e300`, `5e-324`)
are not exactly representable and would round-trip lossily, and `lt`/`between`
on a `float64` path would diverge from the SQLite side. A `float64` cell
therefore stores its eight IEEE-754 bytes as `B` (and `REAL` on SQLite) under an
order-preserving transform (flip the sign bit for non-negative values, flip all
bits for negative values) so that unsigned byte comparison matches numeric
comparison. Comparison on `float64` is thus by canonical bytes, not DynamoDB's
native `N` ordering, but it remains exact for validation, keys, and ranges. This
keeps `float64` inside the portable narrow band rather than making it a
provider-specific loss.

JSON is not treated as merely another opaque blob. An index selector may walk
through a `json` column, and a query may project or predicate on a declared
JSON path. SQLite compiles these operations to JSON1 expressions and
expression indexes; DynamoDB uses document paths, projection expressions, and
key/filter expressions. Shapes are checked before write and after read.
Property order is not observable, and JSON numbers use the finite JavaScript
number subset.

A `passable` cell uses the daemon's Smallcaps body-and-slots model. The write
is accepted only if every by-presence leaf can be assigned a durable reference
identifier by the supplied `ReferenceIdentity` (the identify/revive half of the
reference interfaces defined in the Compact ordered key encoding); an ephemeral
reference that the host cannot formulate causes the write to reject before
mutation. The body is opaque to the database. This is how the Passable band
covers all durably passable values without pretending that a database can
natively index capability graphs.

Patterns in schemas must themselves be pass-by-copy and must not contain
remotables. They refine a band but cannot widen it. For example, an
`{ kind: 'int64', shape: M.gte(0n) }` column remains an int64 column.

## Portable key and query model

Every table has one partition-key selector and may have one sort-key selector.
Secondary indexes have the same shape. This matches DynamoDB's native access
path and maps directly to a composite SQLite index. A primary-key argument is
a copy record with `partition` and, when declared, `sort` fields. Each field
must be an Endo `Key`: promises and errors are passable cells but are not keys;
remotables and copy data containing remotables are keys when the
`ReferenceIdentity` can assign stable identities.

`query` has the following plain-value request:

```ts
type Bound = { key: Key; inclusive?: boolean }; // inclusive defaults to true

type Predicate =
  | { op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'; path: Selector; value: JsonScalar }
  | { op: 'between'; path: Selector; low: JsonScalar; high: JsonScalar }
  | { op: 'beginsWith'; path: Selector; value: string | Uint8Array }
  | { op: 'exists'; path: Selector }
  | { op: 'and' | 'or'; args: readonly Predicate[] }
  | { op: 'not'; arg: Predicate };

type Query = {
  index?: string;                 // omitted means primary
  partition: Key;                 // equality is mandatory
  low?: Bound;                    // inclusive-by-default low sort-key bound
  high?: Bound;                   // inclusive-by-default high sort-key bound
  reverse?: boolean;              // flips yield order only, not bound roles
  where?: Predicate;
  project?: Readonly<Record<string, Selector>>;
};
```

The sort-key bounds are named `low` and `high` (matching the `between`
predicate's own `low`/`high` fields) and are range-oriented, not
iteration-oriented: `low` is always the lesser bound and `high` the greater,
regardless of `reverse`. `reverse` flips only the order in which rows are
yielded, so `low`/`high` never swap roles. Each `Bound`'s `inclusive` defaults
to `true` when omitted.

The reader yields full rows unless `project` is present, in which case it
yields a record whose property names are the projection aliases. Selectors
below a column are allowed only for `json`; a passable cell may only be
selected whole. Predicate paths must select narrow cells or JSON scalars. When
a query names a secondary index that only partially materializes its columns
(`Index.materialize`), its `project` and predicate paths may reference only
materialized or key columns; a path outside that set is a `QueryError` rather
than a silent full-row fetch. Adapters compile the AST to parameterized native
expressions and reject a query they cannot compile; they do not fetch opaque
rows and silently emulate an unsupported predicate.

Query order is the selected index's sort-key rank order, ascending by default.
The required partition equality makes every ordered traversal native on both
providers. A table without a sort key has at most one primary row per
partition. Applications needing a logically global ordered table may use a
constant partition key, knowingly accepting the corresponding DynamoDB hot
partition. There is no ordered cross-partition scan.

Primary `get` and primary-index `query` are strongly consistent. Secondary
index queries have the portable weaker contract: a completed write may become
visible later, because DynamoDB global secondary indexes do not provide strong
reads. SQLite may observe it immediately, but callers cannot depend on that.

The reader pulls bounded pages with keyset continuation; it never materializes
an unbounded result array. Because a secondary index's `(partition, sort)` is
not required to be unique, the continuation is not the sort key alone but the
total tuple `(index partition, index sort, base primary key)`; the trailing
primary key breaks ties so resumption across a page boundary neither skips nor
repeats a row and `reverse` traversal is an exact mirror of forward. This
mirrors DynamoDB's own `LastEvaluatedKey`, which carries the base-table primary
key on a GSI for exactly this reason. Early return closes the local SQLite
statement or abandons the DynamoDB continuation through the established
exo-stream reader protocol.

### Worked example

A small "messages" table keyed by conversation and timestamp, with a JSON
`meta` cell and a secondary index over `meta.author`:

```js
const schema = {
  columns: {
    conversation: { kind: 'string' },
    at: { kind: 'int64' },
    meta: { kind: 'json', shape: M.splitRecord({ author: M.string() }) },
    body: { kind: 'passable' },
  },
  primary: { partition: ['conversation'], sort: ['at'] },
  indexes: {
    byAuthor: {
      partition: ['meta', 'author'],
      sort: ['at'],
      materialize: { at: ['at'] },
    },
  },
};

// one row (a plain CopyRecord; `body` may hold a durable reference)
const row = {
  conversation: 'welcome',
  at: 1725500000n,
  meta: { author: 'alice' },
  body: attachmentRef,
};
table.insert(row);

// point read
table.get({ partition: 'welcome', sort: 1725500000n }); // yields row or undefined

// range query on the primary index, newest first, projecting two columns
table.query({
  partition: 'welcome',
  low: { key: 1725000000n },
  reverse: true,
  project: { when: ['at'], who: ['meta', 'author'] },
}); // yields a reader of { when, who } records
```

The same `p`/`s`/materialized columns from the SQLite physical schema store this:
`conversation` encodes into `p`, `at` into `s`, and the `byAuthor` index orders
by its partition `meta.author`, then its sort `at`, then the base primary key
`(conversation, at)` as the trailing tiebreak, so its ordering is total even
when one author has several messages at the same `at`.

## Compact ordered key encoding

The daemon supplies durable-reference authority through two separate
interfaces, so encoding never carries lifecycle power:

- `ReferenceIdentity` maps a reference to a durable formula identifier and
  revives an identifier back to a reference. It is a pure identify/revive
  capability and is the only reference power handed to the codecs and to the
  read facet (which must revive but must never retain or release).
- `ReferenceRetainer` retains an identifier on behalf of the database formula
  and releases that retention. It is a stateful mutation of the daemon's
  formula graph and is held only by the write path (protocol steps 2 and 4 in
  the Daemon formulas section).

Splitting them keeps the Capability and value model's "a holder cannot amplify a
read facet into a write facet" honest: a read facet holding the codec cannot
reach retain/release.

`@endo/exo-db` exports a versioned `makeOrderedKeyCodec(referenceIdentity)`. It
stands on `@endo/marshal` rather than defining another PassStyle order:

1. Validate the input with `M.key()`.
2. Call `makeEncodePassable({ format: 'compactOrdered',
   encodeRemotable })`. `encodeRemotable` emits `r` followed by a recursively
   encoded durable reference identifier. Promise and error encoders are absent
   because those values are not Keys.
3. Prefix the format version and transcode every JavaScript UTF-16 code unit of
   the resulting string to two unsigned big-endian bytes.

The final UTF-16BE step is necessary. For copy and scalar values,
`makeEncodePassable` preserves Endo's JavaScript rank order (as defined by
`compareRank`), including UTF-16 code-unit string order. Durable identifiers
provide the otherwise-missing order between distinct remotables. SQLite
`BINARY` text collation and DynamoDB string keys compare their stored
encodings, so storing a binary key avoids a disagreement for astral versus
high-BMP strings. Concretely, the one-code-unit string `U+FFFF` sorts after the
astral string `U+10000` (surrogate pair `U+D800 U+DC00`) under JavaScript
code-unit comparison, because `0xFFFF` is greater than the leading surrogate
`0xD800`. But their UTF-8 encodings order the opposite way: `U+FFFF` is bytes
`EF BF BF` while `U+10000` is `F0 90 80 80`, and `EF` sorts before `F0`. A
SQLite `TEXT`/UTF-8 or DynamoDB native string key would therefore order the two
the opposite way from the value model. Encoding both keys as UTF-16BE bytes
(`FF FF` versus `D8 00 DC 00`) restores the code-unit order. Bytewise comparison
of the versioned UTF-16BE result is thus the same as JavaScript code-unit
comparison, including prefix-shorter-first.

SQLite stores the result as `BLOB` and uses its bytewise order. DynamoDB stores
it as `B`; binary sort keys compare as unsigned bytes. Partition keys use the
same canonical bytes for equality, and sort keys use them for both equality
and range order. Key components are separate columns/attributes, so no new
tuple delimiter is required.

The codec must satisfy these invariants:

- `keyEQ(a, b)` implies identical encoded bytes;
- when `compareKeys(a, b)` gives a non-`NaN` order, byte comparison gives the
  same order; when distinct remotables make the keys incommensurate, their
  durable identifiers supply the deterministic total-order tie-break;
- decoding round-trips to a `keyEQ`-equal key and revives the same references;
- the output contains no process-local ordinal; and
- a format version is never compared in the same physical index with another
  version. Re-encoding an index is an explicit table migration.

`compactOrdered` is the rank encoding, not the row body encoding. JSON and
Smallcaps bodies do not acquire ordering meaning, and canonical CBOR would not
be a substitute: canonical encoding is not an order-preserving encoding.

## `@endo/exo-db/sqlite` and platform selection

`@endo/exo-db` contains the interfaces, schema compiler, query AST, codecs,
attenuation kit, and backend contract. `@endo/exo-db/sqlite` supplies the
backend. The native binding itself belongs in `@endo/platform`, following the
existing filesystem provision shape:

```jsonc
{
  "exports": {
    "./sqlite": {
      "xs": "./src/sqlite-endor/index.js",
      "node": "./src/sqlite-node/index.js"
    },
    "./sqlite/lite": "./src/sqlite/index.js",
    "./sqlite/node": "./src/sqlite-node/index.js",
    "./sqlite/endor": "./src/sqlite-endor/index.js"
  }
}
```

`@endo/platform/sqlite/lite` exports types and validation only. The default
specifier is condition-selected and has no browser/default fallback: selecting
an unsupported platform is a build error. The Endor bundler already supplies
the `xs` condition; `sqlite-endor` names the host contract rather than one JS
engine so IronHorse can provide the same contract later. Explicit `/node` and
`/endor` exports exist for adapter agreement tests, not application feature
detection.

The low-level power both provisions expose is:

```ts
type SqliteValue = null | bigint | number | string | Uint8Array;
type SqliteParams = SqliteValue[] | [Record<string, SqliteValue>];

interface StatementSync {
  run(...params: SqliteParams): { changes: bigint; lastInsertRowid: bigint };
  get(...params: SqliteParams): Record<string, SqliteValue> | undefined;
  all(...params: SqliteParams): Array<Record<string, SqliteValue>>;
  columns(): Array<{ name: string; type: string | null }>;
  finalize(): void;
}

interface DatabaseSync {
  readonly open: boolean;
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

interface SqlitePowers {
  openDatabase(path: string): DatabaseSync;
}
```

The Node and Endor provisions each provide exactly this synchronous low-level
power. The Node provision wraps the existing `better-sqlite3` dependency. The
Endor provision moves the existing `makeXsSqlitePowers` adapter over the Rust
`hostSqlite*` functions into `@endo/platform`. The daemon and exo-db then both
consume `@endo/platform/sqlite`; neither imports a native binding directly.
Parameter and result conversion, especially int64 and bytes, is tested once as
part of the platform contract. The contract fixes that an `INTEGER` cell always
surfaces as a `bigint` (never the safe-integer-sized plain `number` that
`better-sqlite3` and today's XS shim default to), and that a BLOB cell is always
decoded, because exo-db stores every key as a BLOB and depends on the `int64`
band's exactness above 2^53 on both platforms. Transactions use
`exec('BEGIN IMMEDIATE')`, `COMMIT`, and `ROLLBACK`; no provider object escapes
the adapter.

### SQLite physical schema

Each logical table gets a `STRICT` SQLite table whose physical identifiers are
generated from schema ordinals, never interpolated logical names. A metadata
table maps logical names to ordinals and stores the canonical schema and codec
version. A representative table contains:

- ordered primary-key bytes in `p BLOB NOT NULL`, plus `s BLOB NOT NULL` when
  the table declares a sort key;
- one native SQLite column for each narrow cell;
- canonical JSON `TEXT CHECK(json_valid(...))` for each JSON cell;
- Smallcaps body and slot-list columns for each passable cell; and
- materialized binary partition/sort columns for every secondary index, each
  followed by the base table's primary-key columns as a trailing index tiebreak.

The primary key is `(p, s)` or `(p)`. Every secondary index begins with its
encoded partition and sort columns and ends with the base primary-key columns,
so its ordering is total even when `(partition, sort)` repeats and keyset
continuation on that index cannot skip or duplicate a row. JSON index sources
are extracted and type checked during the write, then encoded into those
materialized columns; query planning never depends on SQLite and DynamoDB
having identical JSON collation. Prepared statements bind every value. Schema
ordinals are the only source of SQL identifiers.

`query` repeatedly executes a bounded `LIMIT` statement using the last emitted
`(index partition, index sort, primary key)` tuple as continuation, applies the
compiled JSON/narrow predicate in SQLite, and yields through `PassableReader`.
This avoids requiring an Endor cursor handle for the first implementation;
`StatementSync.iterate` can replace the bounded page loop after the
streaming-SQLite design lands without changing exo-db.

## DynamoDB portability target

A later `@endo/exo-db/dynamodb` adapter maps one logical table to one DynamoDB
table. Physical names derive from the daemon deployment plus database formula
identifier and logical-table ordinal. Items carry binary `p` and `s`
attributes, native narrow/JSON attributes, opaque passable bodies and slots,
and materialized binary attributes for declared secondary indexes.

The portable interface intentionally leaves these provider features
unreachable:

| SQLite-only surface omitted | DynamoDB-only surface omitted | Reason |
|---|---|---|
| SQL text, joins, foreign keys, views, triggers, CTEs, arbitrary collations, virtual tables, PRAGMAs | PartiQL, full-table `Scan`, streams, TTL, global tables, capacity controls, provider condition strings | They have no faithful peer and would make the application provider-aware |
| Arbitrary expression indexes and JSON1 functions | Arbitrary document/update expressions | Only declared selectors and the query AST can be validated and compiled on both providers |
| Unbounded transactions and SQLite isolation modes | Transaction APIs and batch APIs with provider-specific limits | There is no stable shared size, failure, and isolation contract yet |
| Ordered traversal across the whole database | Ordered traversal across partitions | DynamoDB only orders within one partition |
| In-place `ALTER TABLE` freedom | Online table/index provisioning details | Immutable schemas plus copy migration have one portable lifecycle |

The package exports conservative, versioned limits derived from the DynamoDB
side, including encoded item and key size. The SQLite adapter enforces the same
limits before commit. Provider throttling, unavailable resources, and
conditional-write conflicts are distinct error classes; retry policy remains
with the caller. Query page size is an implementation choice and not visible in
the reader's item sequence.

## Daemon formulas and durable references

The daemon adds an abstract formula type:

```ts
type ExoDatabaseFormula = {
  type: 'exo-database';
  format: 1;
};
```

The formula contains no SQLite path or DynamoDB resource name. On formulation,
the daemon's configured `DatabaseStorageProvider.open(formulaId)` (the
host-configured backend seam that owns physical storage) reconstructs the
admin/read/write exo kit. A new `provideDatabase(petName)` host/guest method
follows the daemon's `provide*` create-or-retrieve convention: if `petName` is
unbound it assigns the formula identifier, creates the provider storage under
that identifier, writes the formula, binds it in the caller's pet store, and
returns the admin facet; if `petName` already names a database formula it
returns that same admin facet without minting a second formula. `lookup([petName])`
returns the same database capability at its admin facet (the creator holds
admin; attenuated facets are distributed explicitly). The name is
`provideDatabase`, not `makeDatabase`, precisely because `make*` on this surface
means mint-new. The ordinary formula and pet-name graph therefore controls who
can rediscover the database capability.

For SQLite, every formula owns a separate file under the daemon state
directory:

```text
<statePath>/exo-db/<first two hex digits>/<remaining formula-number hex>.sqlite
```

The path helper accepts the full local formula identifier, validates its node
and number, and derives this path from the number component. It never accepts a
caller-provided filesystem path. Thus two assigned database formulas cannot
share a file, and moving or deleting pet names does not rename the file.
Formula collection closes the connection before removing the file and any
`-wal`/`-shm` companions. Under DynamoDB the same formula identifier is the
logical resource namespace instead.

The database formula must retain every formula referenced by a live row. The
daemon supplies the two reference interfaces from the Compact ordered key
encoding: `ReferenceIdentity` (map a reference to a formula identifier, revive
an identifier) for the codecs and read facet, and `ReferenceRetainer` (retain
an identifier on behalf of the database formula, release that retention) for the
write path. The row lives in the per-database SQLite sidecar, while both the
formula retentions *and* the per-database reference-count ledger live in the
daemon's main `endo.sqlite`. Keeping the ledger beside the retentions matters
for the DynamoDB path: the DynamoDB portability target omits transaction and
batch APIs, so a ledger stored in the (per-database) sidecar and a retention
stored in the main graph could not be committed atomically there, and the
crash-safety guarantee would be lost. With both in `endo.sqlite`, a
retain-and-ledger update is a single transaction on both providers. Updates then
use this crash-safe asymmetric protocol:

1. marshal the new row and compute old/new slot-count deltas;
2. in the main daemon database, atomically add all new formula retentions and
   increment the reference-count ledger for this database (retain and ledger
   commit together);
3. commit the row alone in the per-database sidecar;
4. in the main daemon database, atomically release removed retentions and
   decrement the ledger; and
5. on startup, reconcile the ledger against the committed rows in the sidecar
   before exposing the database exo, dropping any retention the surviving rows do
   not justify.

A crash can therefore leave an extra retention (the ledger says a row references
a formula that the sidecar never committed), never a committed row with a
dangling reference. Reconciliation removes that over-retention. Deleting the
database formula first stops new calls, then closes and removes provider
storage, then releases all ledgered references. All five steps of the update
protocol above run under a per-database-formula mutation queue (a lock scoped to
this one database formula, not the process-global formula-graph queue that also
serializes formula creation and pet-name binds) so two row mutations of the same
database cannot race retention accounting while writes to unrelated databases
proceed concurrently.

Changing the configured provider requires an explicit export/import tool that
streams schemas and rows through the public model, verifies counts and ordered
keys, then switches deployment configuration. The abstract formula format does
not claim that merely changing a provider setting migrates data.

## Errors and resource limits

Public failures are hardened errors with stable names:

- `SchemaError` for an invalid or non-portable schema;
- `RowShapeError` for a value outside its declared band or pattern;
- `KeyError` for a non-Key, missing component, or non-durable reference;
- `ConflictError` for failed `insert`/`update` existence conditions;
- `QueryError` for a selector or predicate outside the portable subset;
- `LimitExceededError` for a row, key, schema, or index over a versioned limit;
- `ThrottledError` for a retryable provider throttling or conditional-write
  contention failure the caller may retry with backoff; and
- `DatabaseUnavailableError` for a storage or resource failure that is not, by
  itself, known to be retryable.

Error details contain logical names and safe diagnostics, never SQL, physical
resource names, formula identifiers, row bodies, or reference slots.

## Implementation plan

1. Add ordered-key codec and property tests to `@endo/exo-db`, including
   Unicode order, nested keys, stable remotable identifiers, and version
   refusal.
2. Add schema types, schema-to-pattern guards, exo interface kits, the backend
   contract, and a small in-memory reference backend used only by the contract
   suite.
3. Land the common SQLite types and Endor adapter in `@endo/platform/sqlite`.
   This is a shape change, not a lift-and-shift: today's daemon path is
   better-sqlite3-shaped (a better-sqlite3-compatible constructor, `number`
   `changes`/`lastInsertRowid`, safe-integer INTEGER projection, and no BLOB
   decode), while the `DatabaseSync`/`StatementSync` surface above is
   node:sqlite-shaped (`bigint` `changes`/`lastInsertRowid`, a `columns()`
   method, always-`bigint` INTEGER, and always-decoded BLOB). The step therefore
   adapts the existing `makeXsSqlitePowers` and adds a Node provision to the new
   shape, migrates `endo.sqlite`'s current call sites onto it, and adds the
   int64/BLOB conversion contract; it is new Endor wire work, not a rename.
4. Implement `@endo/exo-db/sqlite`: metadata, strict tables, native/JSON/
   passable codecs, primary and secondary indexes, conditional writes, and
   bounded reader queries.
5. Add the `exo-database` formula, per-formula file placement, attenuation,
   reference-retention ledger, startup reconciliation, and collection cleanup.
6. Run the same behavioral suite on Node and Endor, including sequentially
   opening one database file with each binding. Add a DynamoDB plan compiler
   test that proves every accepted schema/query has a provider mapping even
   before the remote adapter is built.

## Verification plan

- Property-test `keyEQ`/encoded equality, `compareRank`/byte ordering, codec
  round trips, every PassStyle allowed by `Key`, Unicode boundary pairs
  (including astral versus high-BMP), `int64` values above 2^53, `float64`
  values spanning the full binary64 magnitude range (subnormals, `0.1`, `1e300`,
  negative and near-zero values that DynamoDB `N` cannot represent), and
  durable-reference identity.
- Run one backend-contract suite against the in-memory model, Node SQLite, and
  Endor SQLite for DDL, all three cell bands, each mutation condition,
  projections, predicates, forward/reverse bounds, and early reader return.
- Inspect SQLite query plans to prove primary and secondary range queries use
  their composite indexes and never sort all rows.
- Restart the daemon after each point in the retention protocol and prove rows
  never revive dangling references and reconciliation removes extra retains.
- Create two formulas, verify distinct state-directory files, mutate both,
  restart, delete one formula, and prove only its file and reference edges are
  removed.
- Differentially execute generated accepted schemas and query ASTs against the
  SQLite compiler and DynamoDB plan compiler; both must accept or reject the
  same inputs and produce the same logical ordering and projection. The
  generators must emit `float64` and large `int64` column values so the
  order-preserving `B` encoding is exercised against the DynamoDB numeric
  domain, not only representable decimals.
- Verify read facets cannot obtain write/admin facets and that no physical
  database handle or identifier appears in a returned value or error.

## Design decisions

1. **Rows are values, not capabilities.** Database and table authorities need
   identity and attenuation; immutable row snapshots do not.
2. **Three schema bands remain visible.** Collapsing everything into Smallcaps
   would discard the native indexing and projection advantage of both SQLite
   and DynamoDB, especially for JSON documents.
3. **Keys are `Key`, cells are `Passable`.** Promise and error cells remain
   supported without pretending they have stable key equality.
4. **Rank bytes and row bodies are separate.** `compactOrdered` determines
   traversal; native, JSON, and Smallcaps encodings determine reconstruction
   and queryability.
5. **Partition equality is mandatory for ordered queries.** This is the largest
   visible portability constraint and prevents SQLite's global order from
   leaking into the abstraction.
6. **SQLite binding provision belongs in `@endo/platform`.** Node and Endor
   select low-level powers once; exo-db and the daemon share the result.
7. **One SQLite file per database formula.** Isolation, backup, removal, and
   assigned-formula placement remain explicit instead of merging application
   rows into the daemon's own `endo.sqlite`.
8. **Retain before row commit; release after.** The retention and its
   reference-count ledger both live in the daemon's main `endo.sqlite`, so they
   commit atomically on both SQLite and DynamoDB (which omits multi-item
   transactions); only the row itself lives in the per-database sidecar. A crash
   between the atomic retain-and-ledger step and the row commit leaks retention
   toward over-retention, but never creates dangling authority.
9. **No raw provider language.** A small typed AST is auditable at the exo
   boundary and has a native implementation on both target providers.

## Open questions

None. Provider transactions and live-query/change-stream capabilities should
be proposed separately if a concrete cross-provider contract emerges.

## Prompt

> Introduce an `exo-db` package with exo database interfaces, and an
> implementation `exo-db/sqlite` based on platform-specific sqlite bindings
> (covering both node and endor), such that we can model databases, tables, and
> rows of passable data in Endo. Also propose formulas for durably persisting
> abstract passable databases in the daemon.

The expanded brief additionally requires compact ordered key encoding, the
narrow/JSON/broad-passable type bands, deliberate SQLite/DynamoDB portability,
and one SQLite database file per assigned daemon formula identifier.
