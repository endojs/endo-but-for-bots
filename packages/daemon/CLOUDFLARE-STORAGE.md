# Cloudflare storage platform for the Endo daemon

Status: DESIGN, with a runnable toy scaffold on this branch.
Scope: the daemon's **storage** powers on Cloudflare primitives. The
Workers/Durable-Object *execution* story (worker spawning, sockets, CapTP
ingress) is surfaced but deliberately out of scope.

This document is a peer of the AWS storage-platform design
(`design-endo-daemon-aws-storage`); both implement the same pre-existing
daemon storage seams and stay symmetric where the platforms allow.

## 1. The storage interface as it actually is

The daemon core is platform-agnostic and receives `DaemonicPowers` from a
platform entry module. This repository already runs that seam across three
platforms — Node (`daemon-node-powers.js`), Go-supervised
(`daemon-go-powers.js`), and XS-on-Rust (`bus-daemon-rust-xs-powers.js`) —
and the storage half of the seam has already been factored for
portability:

- **`daemon-database.js`** owns the SQLite schema (formulas, daemon state
  including the root nonce and root keypair, agent keys, remote agent
  keys, pet-store entries, retention, synced-store tables) and all
  prepared statements, over an **injected better-sqlite3-compatible
  constructor**: `new Database(path)`, `db.pragma`, `db.exec`,
  `db.prepare(sql).run/get/all`, `db.close`, all **synchronous**. Two
  backends exist: Node's native `better-sqlite3`
  (`daemon-database-node.js`) and the XS-on-Rust shim
  (`better-sqlite3-xs.js`, host functions into rusqlite).
- **`daemon-persistence-powers.js`** is the shared
  `DaemonicPersistencePowers` for every daemon flavour: nonce, keypair,
  formulas, agent keys, and retention delegate to the `DaemonDatabase`;
  the **SHA-256 content store** streams through `FilePowers`
  (temp-file spool → hash → atomic rename to the hash-named path, plus
  `statPath` sizes and `readFileRange` windows), wrapped by
  `makeSnapshotStore` from `@endo/platform`.
- **`pet-store.js`** keeps its in-memory bidirectional multimap and
  change topics, persisting through the `DaemonDatabase` pet-store-entry
  statements; construction reloads synchronously from
  `listPetStoreEntries`.
- **`CryptoPowers`** requires a **synchronous incremental SHA-256**
  digester, async `randomHex256`, async Ed25519 keypair generation, and
  **synchronous** `ed25519Sign`.

So "port the daemon's storage to Cloudflare" means, concretely: give
`daemon-database.js` a third backend, give the shared content store an
object-store `FilePowers`, and inject Workers-compatible crypto. The
daemon core — including `daemon-database.js`, `pet-store.js`, and
`daemon-persistence-powers.js` — stays untouched, and this branch's toy
proves that literally: those modules run unmodified over the new
adapters.

Semantics the platform must preserve:

| Semantic | Here (node/XS) | Requirement on Cloudflare |
| --- | --- | --- |
| Synchronous prepared statements | better-sqlite3 / rusqlite | a sync SQL surface; an async engine cannot back this seam |
| Root nonce/keypair once-only | get-then-set on `daemon_state`, safe under one process | same, safe under one instance |
| Content-store commit | temp spool + atomic rename; reader never sees a partial blob under a hash name | atomic visibility at the final key |
| Content addressing | SHA-256 of the exact byte stream | identical hashing; dedup free; races benign |
| Ranged blob reads | `readFileRange` windows | ranged gets |
| Single writer | one daemon process (pid discipline) | one instance, platform-enforced |
| Write serialization | sync SQLite + `makeSerialJobs` | same, given a single-threaded instance |

## 2. Mapping onto Cloudflare primitives

- **Durable Object SQLite storage** (`ctx.storage.sql`): the closest
  analog Cloudflare has — an actual SQLite database with a
  **synchronous** API, implicit per-turn atomicity plus
  `transactionSync`, colocated with a **single named instance**
  worldwide. It is the only Cloudflare SQL surface that can honestly
  back `daemon-database.js`'s synchronous prepared-statement seam.
  **Chosen.**
- **D1** (serverless SQLite): evaluated first per the mandate, and the
  nearest *service-shaped* analog — but its API is **async-only**
  (`prepare(...).bind(...).run()/all()` return promises, transactions
  only via `batch()`), so it cannot back the synchronous
  `DaemonDatabase` contract without forking daemon-database.js and
  every consumer into an async variant — a large, drift-prone change
  the XS backend proves unnecessary. D1 also runs as a separate service
  rather than colocated state, weakening the single-writer story the
  daemon relies on. **Rejected for the daemon's database; admissible
  later for offline inspection/export tooling** (the schema is plain
  SQLite either way).
- **R2** (S3-compatible object storage): the content-addressed blob
  store. Streamed and ranged `get`s, per-key atomic visibility (a put
  is visible all-or-nothing; R2 is strongly consistent), multipart
  uploads for large objects. Missing piece: no server-side rename in
  the Workers binding — § 4.2 designs around it. **Chosen.**
- **Workers KV**: eventually consistent (reads elsewhere may lag
  writes), so it cannot hold authoritative daemon state. Admissible
  later as a read-through cache for immutable content-addressed blobs
  only. **Rejected as a source of truth.**

### 2.1 The single-writer argument decides the topology

The daemon assumes exclusive ownership of its state by one live
instance: synchronous SQLite access, in-memory pet-store multimaps and
formula memos, `makeSerialJobs` serialization, and on node a pid file
that arrogates the role. Plain Workers are the opposite — many
concurrent isolates, none authoritative. **A Durable Object is exactly
the missing primitive**: one named instance globally, single-threaded,
with serialized event delivery. The daemon therefore lives in a DO, its
database in that DO's SQLite storage, and its blobs in R2. This is
strictly stronger than the node arrangement — the platform enforces the
singleton instead of a kill-the-predecessor pid protocol.

## 3. The design (what this branch scaffolds)

Three small platform modules, mirroring how the Go and XS platforms
joined the family:

### 3.1 `src/better-sqlite3-do.js`

The third `Database` backend for `daemon-database.js`, exactly parallel
to `better-sqlite3-xs.js`: a factory `makeDatabaseConstructor(storage)`
that closes a better-sqlite3-compatible class over a Durable Object's
SQLite storage handle and emulates the same strict subset the XS shim
emulates (`prepare().run/get/all`, `exec`, `pragma`, `close`). Because
the DO SQL API is synchronous, the adaptation is honest — no queueing,
buffering, or async seams. Differences from the XS shim, both principled:

- The XS shim reaches its engine through ambient host functions; a DO's
  storage handle is an **injected capability**, so the constructor is
  produced by a factory rather than imported.
- `pragma` is best-effort: the platform manages journaling itself and
  rejects most PRAGMAs; `daemon-database.js` issues them as
  fire-and-forget tuning hints (`journal_mode = WAL`, `foreign_keys`),
  so unsupported ones are swallowed.

`new Database(path)` ignores the path: the Durable Object *is* the
database's identity and location. `close()` is a soft flag; the
platform owns the connection lifecycle.

### 3.2 `src/daemon-cloudflare-powers.js`

A derivative of `daemon-node-powers.js` the way `daemon-go-powers.js`
is — it replaces only the substrate:

- **`makeR2FilePowers(bucket)`** — `FilePowers` over an R2 bucket
  binding, sufficient for the shared content store to run unchanged:
  buffered streaming writes (`makeFileWriter`), streaming and ranged
  reads, `statPath` sizes from `head`, prefix-scoped directory
  listings, force-semantics `removePath`, and `renamePath` as
  copy-then-delete (the binding has no server-side rename; the copy
  lands at the target key atomically, which is the property the
  temp-then-rename commit protocol actually needs — the source delete
  is cleanup, and a bucket lifecycle rule on the temp prefix reaps
  orphans from crashed stores). Members with no object-store analog
  resolve trivially or follow the documented `FilePowers` fallback
  (`watchDirectory` terminates immediately).
- **`makeCloudflareCryptoPowers({ makeSha256, generateEd25519Keypair,
  ed25519Sign })`** — randomness from the host WebCrypto
  `getRandomValues` (Workers and modern node alike); the synchronous
  digester and signer are injected because WebCrypto's one-shot async
  `subtle` API cannot provide them. A Workers deployment injects
  `@noble/hashes` and `@noble/curves` (pure JS, sync, auditable);
  node-side tests inject the node implementations from
  `daemon-node-powers.js`.
- **`makeCloudflareDaemonicPowers({ config, storage, bucket,
  cryptoPowers, cancelled })`** — the assembly, mirroring
  `makeDaemonicPowers`: `daemon-database.js` over the DO shim,
  `pet-store.js` over that database, the shared
  `daemon-persistence-powers.js` over database + R2 file powers, and a
  stub `control` power that throws with a pointer here (worker
  spawning is an execution design, § 6).

### 3.3 Config and powers injection

No ambient authority, account-agnostic: Cloudflare **bindings are
already capabilities** — unforgeable handles injected into the
Worker/DO `env`, scoped by `wrangler.toml`, no account ids or keys in
code — which lines up exactly with the daemon's powers discipline.

```js
// wrangler.toml (deployment-owned, not code-owned):
//   [[r2_buckets]]               binding = "ENDO_BLOBS"  ...
//   [[durable_objects.bindings]] name = "ENDO_DAEMON" class_name = "EndoDaemon"
//   [[migrations]]               new_sqlite_classes = ["EndoDaemon"]

export class EndoDaemon /* extends DurableObject */ {
  constructor(ctx, env) {
    this.powersP = makeCloudflareDaemonicPowers({
      config,                      // paths degenerate to key prefixes
      storage: ctx.storage,        // SQLite-backed DO storage
      bucket: env.ENDO_BLOBS,      // R2 binding
      cryptoPowers,                // noble-backed, injected
      cancelled,
    });
    // makeDaemon(powers, ...) — execution track, § 6
  }
}
```

The node `Config`'s `statePath` degenerates to a key prefix (the
content store lives under `<statePath>/store-sha256/` in the bucket;
the database path is ignored by the DO constructor); `sockPath` has no
meaning and the ephemeral pid discipline is subsumed by DO identity.

## 4. Semantic gap analysis

| Concern | node | Cloudflare (this design) | Verdict |
| --- | --- | --- | --- |
| Sync prepared statements | better-sqlite3 | DO SQLite `exec` (sync) via the shim | preserved |
| Nonce/keypair once-only | get-then-set under one process | same statements under one single-threaded DO | preserved (platform-enforced singleton) |
| Pet rename | delete-target + update, sequential sync statements | identical statements through the shim | preserved |
| Content-store commit | temp file + atomic `fs.rename` | temp key + copy-to-final (atomic put) + delete | preserved; costs one extra read+write pass |
| Ranged reads | `readFileRange` | R2 ranged `get` | preserved |
| Blob size ceiling | filesystem | buffered path bounded by the 128 MiB Worker memory budget; R2 multipart spool path is build-phase work (§ 7) | gap, scheduled |
| `pragma` tuning | WAL etc. | platform-managed; hints swallowed | n/a (platform owns journaling) |
| Durability/backup | host filesystem | DO storage replication + point-in-time recovery; R2 replication | improved |
| `db.close()` | closes the handle | soft flag; platform owns lifecycle | acceptable (eviction closes) |

Two inherited behaviors worth noting, unchanged rather than worsened:
`renamePetStoreEntry` runs delete + update as two statements without an
explicit transaction (safe under the sync single-writer regime on every
backend, including this one — a DO processes each event to completion);
and the raw content store's `has()` reads the whole blob (`readFileText`)
— on R2 a `head` would do; a cheap upstream refactor, noted in § 7.

## 5. Toy scaffold and tests (on this branch)

- `src/better-sqlite3-do.js`, `src/daemon-cloudflare-powers.js` — the
  modules above, feature-complete for the storage seams.
- `test/cloudflare-mock-bindings.js` — in-memory stand-ins mirroring
  the binding API subsets the adapters use: a mock DO SQLite storage
  handle backed by **node's built-in SQLite** (real SQL semantics, no
  native build step) and a Map-backed mock R2 bucket with streaming
  bodies, ranged gets, and delimited listing.
- `test/cloudflare-powers.test.js` — exercises, through those mocks,
  with the daemon's own modules unmodified: the shim backing the full
  `DaemonDatabase` surface (formulas, state, pet entries incl.
  rename-over-existing, reopen-over-same-storage), pet stores
  persisting and reloading (the eviction/wake path), the R2
  `FilePowers` filesystem contract (ENOENT shapes, streaming writer,
  rename commit, stat/range/list/force-remove), nonce and keypair
  once-only semantics across powers instances, the content store's
  content addressing (digest equality against an independent
  reference, dedup, no lingering temp spool, text/json/size/readRange),
  and the assembled powers end to end.

**Emulator statement:** this branch's tests run against the in-memory
mock bindings above — chosen so the toy runs inside the repo's stock
AVA setup with zero new dependencies. They mirror the Workers binding
call shapes, so the suite is designed to be re-pointed at **Miniflare /
workerd** (which emulate real DO SQLite and R2 locally) in the build
phase; that rig — plus `wrangler dev` against a real account as the
final proof — is the first build-job task, keeping heavyweight
Cloudflare tooling out of the dependency graph until maintainers opt
in.

## 6. Runtime implications (surfaced, out of scope)

Storage is the tractable half. A DO-hosted daemon also needs:

- **Worker spawning**: `DaemonicControlPowers.makeWorker` forks
  processes over netstring-CapTP pipes on node, and delegates to a
  supervisor on Go/XS. The Cloudflare analog — each Endo worker as its
  own DO or dynamically dispatched Worker, speaking CapTP over
  WebSocket or RPC bindings — is philosophically *closer* to Endo's
  isolate model than child processes, but it is a separate design.
  This scaffold stubs `control` with an explanatory throw.
- **Ingress**: no Unix sockets; the private CapTP surface becomes a DO
  `fetch`/WebSocket endpoint, with hibernation changing connection
  lifetime assumptions.
- **Eviction vs in-memory state**: everything persistent reloads
  correctly (the tests exercise exactly that path), but live
  subscriptions (`followNameChanges`, pubsub topics, CapTP sessions)
  are in-memory and drop on eviction; the session layer above storage
  must reconnect.
- **SES on workerd**: the daemon core runs under `@endo/init`;
  lockdown-on-workerd is its own compatibility track and gates a
  *hosted* daemon, not these storage powers (plain SES-clean modules).
- **Budgets**: 128 MiB isolate memory (drives the buffered-blob
  threshold), CPU-time limits per invocation, DO storage and R2
  object/statement limits to verify and guard-code at build time.

## 7. Phased build plan

1. **Real-runtime verification**: a Miniflare 3 / workerd harness
   running this suite against real local DO SQLite and R2; inject
   `@noble/hashes`/`@noble/curves`; verify and guard-code documented
   platform limits; decide packaging (in `@endo/daemon` vs a sibling
   package) with maintainers, jointly with the AWS sibling.
2. **Large-blob path**: R2 multipart spool for streams beyond the
   memory budget, lifecycle rule for the temp prefix, `has()` via
   `head` (upstream-friendly ContentStore tweak), threshold tuning.
3. **The daemon DO**: an `EndoDaemon` DO class booting `makeDaemon`
   over these powers on workerd; SES lockdown on workerd; WebSocket
   CapTP ingress; eviction/reconnect story for subscriptions.
4. **Control powers**: Endo workers as DOs / dynamic Workers —
   the platform stops being storage-only.

Phases 1–2 are pure storage work, independent of 3–4.

## 8. Consistency with the AWS sibling

Shared shape agreed on the garden message bus: same module convention
(`src/daemon-<platform>-powers.js` + a platform entry), clients and
credentials as injected narrow powers with no hard SDK dependency in
the factories, hermetic in-memory emulators of the exact client
subset, the same test matrix (nonce idempotence, formula round-trip
and missing-formula `ReferenceError`, content round-trip + dedup +
streaming, pet-store write/list/rename/remove/reload), and the design
doc + scaffold on a design branch of the bot fork with no PR. Where
the platforms diverge — AWS has no synchronous SQL, so its structured
store adapts *behind* `DaemonDatabase`'s consumers differently, while
Cloudflare's DO SQLite lets `daemon-database.js` itself run unchanged —
the divergence is stated here and in the sibling doc rather than
papered over. The content stores should converge: R2 is S3-compatible,
so key layout (`<statePath>/store-sha256/<hex>`, temp spool prefix)
and the ranged-read seam match S3's.
