# Endo Daemon AWS Storage Platform

| | |
|---|---|
| **Created** | 2026-07-08 |
| **Updated** | 2026-07-08 |
| **Author** | Kriscendo Bot (prompted) |
| **Status** | Proposed |

## Status

Design plus a runnable scaffold. Built in this change:

- `packages/daemon/src/daemon-database-aws.js` — `makeDaemonDatabaseAws`,
  a `DaemonDatabase`-compatible storage engine over DynamoDB: an async
  warm boot loads the whole structured state into an in-memory mirror,
  every read is served synchronously from the mirror, and every mutation
  applies to the mirror synchronously and flushes to DynamoDB through a
  serialized write-behind queue.
- `packages/daemon/src/content-store-s3.js` — `makeS3ContentStore`, the
  `@endo/platform/fs/lite` `ContentStore` contract (sha-256 addressing,
  `size`, `readRange`) over S3.
- `packages/daemon/src/daemon-aws-sdk.js` — adapters from AWS SDK v3
  clients to the two narrow client powers the engines consume. The SDK
  module namespaces arrive as parameters, so `@endo/daemon` takes no AWS
  dependency.
- `packages/daemon/test/aws-emulator.js`,
  `test/daemon-database-aws.test.js`, `test/content-store-s3.test.js` —
  in-memory emulations of the client powers and a test suite that proves
  the engines against them, including a parity run of the same
  specification against the SQLite `makeDaemonDatabase` when
  `better-sqlite3` is loadable.

Not yet built (see § Phased implementation): the daemon-flavour wiring
(`makeDaemonicPowers` variant taking an injected engine and content
store), the provisioning script, and the reference deployment.

## What is the Problem Being Solved?

The daemon's durable state has exactly two homes today, both local:

1. **Structured, mutable state** — formulas, agent keys, pet-name
   graphs, retention sets, synced-store entries — lives in SQLite behind
   the `DaemonDatabase` interface (`daemon-database.js`), with two
   engines already: Node's `better-sqlite3`
   (`daemon-database-node.js`) and rusqlite through XS host functions
   (`better-sqlite3-xs.js`).
2. **Content-addressed blobs** live on the filesystem behind the
   `ContentStore` contract (`@endo/platform/fs/lite`), built inside
   `daemon-persistence-powers.js`.

A daemon hosted in AWS (the M5 hosted-gateway direction; compare
[gateway-aws-attuned](gateway-aws-attuned.md) on PR
[#356](https://github.com/endojs/endo-but-for-bots/pull/356), which
proposes S3 CAS and DynamoDB state for the *gateway*) should keep its
durable state in managed AWS services rather than instance-local disk:
instances become replaceable, state gets DynamoDB/S3 durability classes,
and backup/restore becomes a platform feature. This design adds an
**AWS storage platform** for the *daemon*: DynamoDB in place of SQLite,
S3 for the content store, behind the same two seams, with the daemon
core untouched.

A prior draft of this design, shaped against upstream `endojs/endo`
master (whose storage seam is the narrower filesystem-only
`DaemonicPersistencePowers` + `PetStorePowers` pair), lives on
`kriscendobot/endo` branch `design/endo-daemon-aws-storage`. This
document supersedes it for this repository.

## The seams, as they actually are

`DaemonicPowers` reaches storage through two members, and both bottom
out in `DaemonDatabase` plus a `ContentStore`:

- `daemon-persistence-powers.js` (shared by every daemon flavour) wraps
  a `DaemonDatabase` for formulas, daemon state (root nonce, root
  keypair), agent keys, and retention, and builds the filesystem
  content store.
- `pet-store.js` consumes the same `DaemonDatabase` directly for the
  pet-name graph.

The load-bearing constraint is that **the consumers are synchronous**:

- `pet-store.js` iterates `daemonDb.listPetStoreEntries(...)` without
  awaiting (its in-memory multimap load), and calls
  `writePetStoreEntry` / `deletePetStoreEntry` / `renamePetStoreEntry`
  without consuming a promise.
- The `DaemonicPersistencePowers` type is deliberately mixed:
  `readFormula`/`writeFormula`/`deleteFormula`/`listFormulas` are
  `Promise`-returning, but `getAgentKey`, `hasAgentKey`,
  `listAgentKeys`, `getRemoteAgentKey`, `listFormulaNumbersByNode`, and
  all five retention operations return plain values, and `daemon.js`
  uses those return values synchronously (for example
  `const retentionEntries = persistencePowers.listRetention(publicKey)`).

DynamoDB is unavoidably asynchronous, so no client-per-call adapter can
implement this surface. The design therefore serves the synchronous
surface from memory:

## Design: a mirrored, write-behind DynamoDB engine

`makeDaemonDatabaseAws({ tablePowers, onFlushError })` returns a
promise for an object implementing the `DaemonDatabase` method surface
plus `{ flushed, close }`:

1. **Warm boot (async, once).** A paginated scan of the DynamoDB table
   populates an in-memory mirror (a two-level map keyed the same way as
   the table). The factory is async; everything after it is not. The
   structured state is small (formulas, keys, names — not blobs), so a
   full mirror is cheap; this generalizes the pattern `pet-store.js`
   already uses (load the store into a multimap, serve reads from
   memory).
2. **Synchronous reads.** Every read method answers from the mirror.
   `readFormula` throws the same `ReferenceError` (`No formula exists
   for number ...`) as the SQLite engine.
3. **Synchronous mutation, asynchronous durability.** Every mutation
   applies to the mirror synchronously (so subsequent reads observe it,
   matching SQLite's read-after-write) and enqueues a remote write on a
   serialized flush queue (`makeSerialJobs`, the daemon's existing
   serializer). Remote writes therefore apply in mutation order.
   `renamePetStoreEntry` flushes as a DynamoDB
   `TransactWriteItems` delete-plus-put, preserving the atomic-replace
   semantics SQLite's two-statement rename provides under its
   transaction; `replaceRetention` likewise flushes as a single
   transaction.
4. **Drain and failure.** `flushed()` resolves when the queue is empty
   (shutdown awaits it; tests use it). A flush failure retries with
   backoff; on exhaustion the engine calls `onFlushError` (the flavour
   wiring should treat this as a daemon-fatal panic, since the mirror
   and the table have diverged).

This is the third engine behind an interface built for engine
injection: `daemon-database-node.js` injects `better-sqlite3`,
`bus-daemon-rust-xs.js` injects the rusqlite shim, and
`daemon-database-aws.js` injects a DynamoDB table capability.

### DynamoDB schema

One table, on-demand capacity, key schema `pk` (HASH, string) + `sk`
(RANGE, string), one string attribute `value`. Partitions mirror the
SQLite tables:

| SQLite table | pk | sk | value |
|---|---|---|---|
| `daemon_state` | `state` | key | value |
| `formula` | `formula` | number (64 hex) | JSON `{ node, body }` |
| `agent_key` | `agentKey` | publicKey | JSON `{ privateKey, agentId }` |
| `remote_agent_key` | `remoteAgentKey` | publicKey | daemonNode |
| `pet_store_entry` | `petStore` | `storeNumber:storeType:name` | formulaId |
| `retention` | `retention` | `guestPublicKey:formulaNumber` | `1` |
| `synced_store_entry` | `synced` | `storeNumber:name` | JSON `{ locator, timestamp, writer }` |
| `synced_store_meta` | `syncedMeta` | storeNumber | JSON `{ localClock, remoteAckedClock }` |
| `schema_version` | `state` | `schema_version` | version |

Composite sort keys use `:` as the delimiter, which cannot appear in
any component (store numbers, public keys, and formula numbers are
hex; pet names match `/^[a-z0-9][a-z0-9-]{0,127}$/`; store types are a
fixed kebab-case enum). `listFormulaNumbersByNode` and the per-store
pet-name listings filter the mirror, so no secondary index is needed.
Item sizes sit far below DynamoDB's 400KB cap.

### S3 content store

`makeS3ContentStore({ blobPowers, cryptoPowers })` implements the
`ContentStore` contract of `@endo/platform/fs/lite/types`
(`store`, `fetch`, `has`, `remove`, with `size` and `readRange` on the
fetched `ReadableBlob`); the flavour wiring wraps it with
`makeSnapshotStore` exactly as `daemon-persistence-powers.js` wraps the
filesystem store today. Content keys are
`store-sha256/<sha256hex>`.

- `store(readable)` cannot know the hash (the key) until the stream
  ends, so it mirrors the filesystem engine's
  temporary-file-then-atomic-rename dance: stream to
  `staging/<randomHex256>` while digesting (the SDK adapter uses
  `@aws-sdk/lib-storage` `Upload`, whose multipart completion is
  atomic), then server-side-copy to the content key (skipped when
  `has` already answers true — deduplication), then delete the staging
  object. Only complete, hash-verified content ever becomes visible at
  a content key, S3 PUT visibility being atomic per key.
- `fetch(sha256)` is lazy: `makeFileReader()` opens a streaming GET,
  `size()` maps to HeadObject ContentLength (as bigint), and
  `readRange(offset, length)` maps to a ranged GET clamped at EOF —
  the same clamp `filePowers.readFileRange` provides, and the fit that
  justifies S3 over alternatives: ranged, streaming reads of immutable
  blobs are S3's native shape.
- `remove` maps to DeleteObject (idempotent, like `rm -f`).

**Why S3 and not DynamoDB for blobs**: the 400KB item cap and the
absence of streaming or ranged reads rule DynamoDB out; the fork's own
`daemon-persistence-powers.js` states the same judgment about SQLite
("Large blobs do not belong in SQLite"). **Why not EFS**: a POSIX
mount is the existing filesystem engine with a network disk; it keeps
instance-attached operational surface without gaining the serverless
account shape. **Why not inline small blobs in DynamoDB**: it splits
one content identity across two stores for a latency win the daemon
does not need (blob reads stream over CapTP anyway); the `S3BlobPowers`
seam admits it later without interface change.

### Credentials and configuration as powers

No ambient AWS authority anywhere. The engines consume two narrow,
pre-authorized capability records — semantic operations, not SDK
command pass-throughs:

```js
// DynamoTablePowers — bound to one table.
{ put({pk, sk, value, ifAbsent}), get({pk, sk}), delete({pk, sk}),
  query({pk, cursor}), scan({cursor}),
  transact({deletes, puts}) }

// S3BlobPowers — bound to one bucket and key prefix.
{ putBlobStream({key, readable}), hasBlob({key}),
  getBlobStream({key}), getBlobRange({key, offset, length}),
  blobSize({key}), copyBlob({from, to}), deleteBlob({key}) }
```

`daemon-aws-sdk.js` produces these from AWS SDK v3 clients, receiving
the SDK **module namespaces as parameters** (the caller passes the
result of `import('@aws-sdk/client-dynamodb')` and friends), so
`@endo/daemon` carries no AWS dependency; only the eventual flavour
entry point dynamically imports the SDK, as an optional peer.
Credentials resolve wherever the client is constructed (the SDK's
standard provider chain, or explicit injection); region, table, and
bucket are configuration of the adapter, never of the engines. The
package is account-agnostic; the garden's AWS account can host the
reference deployment, but nothing in code names an account, and the
least-privilege IAM policy is exactly the operation list above scoped
to one table and one bucket.

## Semantic gaps, called out

| SQLite semantics | AWS mapping | Resolution |
|---|---|---|
| synchronous reads | in-memory mirror after async warm boot | read-after-write preserved within the daemon process; boot cost is one table scan |
| synchronous commit before return | mirror-then-write-behind | **durability lag**: an acknowledged mutation can be lost if the process dies before its flush; `flushed()` bounds it at shutdown, `onFlushError` escalates divergence; see Design Decision 3 |
| two-statement rename inside implicit transaction | `TransactWriteItems` delete+put | equivalent atomicity, remotely and in the mirror |
| one daemon owns `<statePath>/endo.sqlite` (OS file lock) | one daemon must own one (table, keyPrefix) pair | same exclusivity assumption, now unenforced; a lease item is future work |
| `schema_version` row | same, in the `state` partition | migration posture carries over |
| free local writes | every flush is a network round trip | mutations are low-rate and already serialized; reads never leave memory |

## Dependencies

| Design | Relationship |
|---|---|
| [gateway-aws-attuned](gateway-aws-attuned.md) (PR #356) | Sibling direction: AWS-native substitutes for *gateway* subsystems (S3 CAS, DynamoDB state). This design supplies the analogous substitution for the *daemon*; a hosted gateway's daemon would run on this platform. |
| [gateway-aws-deployment](gateway-aws-deployment.md) (PR #356) | The deployment automation a reference deployment of this platform would extend. |
| [daemon-256-bit-identifiers](daemon-256-bit-identifiers.md) | Identifier regime (64-hex numbers) the schema stores. |
| daemon CloudFlare storage platform (sibling job, in flight) | Same two seams over CloudFlare primitives; both designs keep the engine and content-store contracts identical so they read as two implementations of one abstraction. |

## Phased implementation

1. **Engines + proof (this change).** `daemon-database-aws.js`,
   `content-store-s3.js`, `daemon-aws-sdk.js`, emulators, tests
   (including SQLite parity where loadable). No daemon-core edits, no
   new dependencies.
2. **Flavour wiring.** A `makeDaemonicPowers` variant (parallel to the
   assembly in `daemon-node-powers.js`) that accepts an injected
   `DaemonDatabase` promise and content store, plus a `daemon-aws.js`
   entry that dynamically imports the SDK, builds the powers, and runs
   `makeDaemon`. Requires two small shared touches, both flagged for
   maintainer sign-off: (a) the `DaemonDatabase` type's `db` handle
   field becomes engine-private/optional (no consumer outside
   `daemon-database.js` uses `.db`), and (b) either the content-store
   maker inside `daemon-persistence-powers.js` becomes injectable or
   the AWS flavour carries a parallel persistence-powers module.
3. **Emulator fidelity + full-daemon run.** The same engine tests
   against dynamodb-local and MinIO through `daemon-aws-sdk.js`;
   boot a full daemon on the AWS platform and run the daemon suite.
4. **Reference deployment + operations.** Provisioning (table, bucket,
   least-privilege IAM policy), deployment docs on the
   gateway-aws-deployment stack, backup/restore posture (point-in-time
   recovery, bucket versioning), cost notes, and a lease item to
   enforce single-ownership.

## Design Decisions

1. **Implement `DaemonDatabase`, not the powers pair.** The fork
   already routes all structured state through one injectable engine
   interface with two engines behind it; a third engine keeps
   `pet-store.js`, `daemon-persistence-powers.js`, and `daemon.js`
   untouched. (The upstream-shaped draft implemented
   `DaemonicPersistencePowers` + `PetStorePowers` instead, the right
   seam *there*; the fork's richer, synchronous surface makes the
   engine seam strictly better here.)
2. **Mirror + write-behind rather than making the interface async.**
   Converting `DaemonDatabase` and its consumers to async would touch
   the daemon core everywhere and re-open the XS engine; the mirror
   preserves the synchronous contract and generalizes the in-memory
   pattern the pet store already relies on.
3. **Accept bounded durability lag, escalate divergence.** SQLite
   acknowledges after commit; the mirror acknowledges before the flush
   lands. The queue keeps remote order equal to mutation order,
   `flushed()` gives shutdown a drain point, and a failed flush after
   retries is daemon-fatal via `onFlushError` (a mirror that no longer
   matches the table must not keep serving). Considered and rejected:
   blocking mutations on flush (re-introduces async into a synchronous
   contract); write-ahead journaling to local disk (reintroduces the
   local-disk dependency the platform exists to remove).
4. **Semantic client powers, not SDK pass-throughs.** Keeps DynamoDB's
   expression grammar out of the trusted path, keeps the emulator
   honest and small, and makes the CloudFlare sibling's contract
   symmetrical.
5. **One table, single-table design.** The daemon's structured state is
   a handful of small record kinds; one table is one configuration
   value, one IAM resource, and the scope of every transaction.

## Known Gaps and TODOs

- [ ] Phase 2 flavour wiring and the two flagged shared touches.
- [ ] Lease/ownership enforcement for the one-daemon-per-table rule.
- [ ] Batching for the flush queue (BatchWriteItem) if mutation rates
      ever warrant it.
- [ ] `readRange` over 416 responses: the scaffold clamps by sizing
      first; a HEAD-free single-request clamp is possible.

## Prompt

> Design a new **AWS platform** for **Endo daemon storage** — a peer of
> the existing platform modules in `@endo/daemon`. Study the low-level
> storage interface FIRST — the daemon's persistence abstraction (the
> pet-store / formula store, the content-addressed blob store, and any
> reader/stream powers) and how the node platform implements it. The
> AWS platform must implement that same interface. DynamoDB in place of
> sqlite3 for the structured/mutable store. S3 for the
> content-addressed store — or a better-fit AWS primitive if the
> low-level interface argues for it. Parallel the node/web/endo module
> shape; keep the daemon core untouched. Consider the ocap/reader
> model, consistency semantics (DynamoDB's model against the sqlite
> transactions the daemon relies on — conditional writes,
> TransactWriteItems), credentials/config as powers (no ambient AWS
> auth). The package must be account-agnostic. A sibling job designs
> the analogous CloudFlare storage platform; both implement the SAME
> pre-existing daemon storage interface.
>
> (Maintainer redirect, 2026-07-08: target `endojs/endo-but-for-bots`
> branch `llm`; read `daemon-database-node.js` first — it is the
> pattern the AWS platform should parallel.)
