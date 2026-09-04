// @ts-check
/**
 * Interface guards for `@endo/platform/fs/extended` (§4 of DESIGN.md).
 *
 * Every cap defined in §4 has an `M.interface` here. The passable
 * records crossing the surface (Qid, stat patches, open options, ...)
 * are validated against record shapes authored from the corresponding
 * types in `./types.ts`, so the guards enforce the same contract the
 * authored types document — and the exos' contextual parameter types
 * are derived from these shapes, not asserted.
 *
 * Naming convention follows `@endo/exo-stream` and the rest of the
 * repo: `<TypeName>Interface` exported alongside, no `Endo*` prefix
 * (which is `@endo/daemon`'s convention).
 */

import { M } from '@endo/patterns';

// Re-export exo-stream's interface guards so consumers of endo-fs can
// import the stream interfaces from one place.
export {
  PassableReaderInterface,
  PassableBytesReaderInterface,
  PassableBytesWriterInterface,
} from '@endo/exo-stream/type-guards.js';

// Record shapes for the passables crossing this surface, authored
// from the corresponding types in `./types.ts`. Input shapes are
// tolerant readers: `M.splitRecord` with no rest pattern admits
// unknown extra fields, matching the implementations
// (`narrowStatPatch` drops fields it doesn't know; `computeOpenMode`
// reads only its flags). Known fields still must match.

/**
 * `NodeStat` patch accepted by `setStat` / `setAttrs`. POSIX-only
 * fields (`mode`, `uid`, ...) pass the shape but are rejected at
 * runtime with a targeted EINVAL pointing at the future PosixFs cap.
 */
const NodeStatPatchShape = M.splitRecord(
  {},
  { size: M.bigint(), mtime: M.bigint(), atime: M.bigint() },
);
harden(NodeStatPatchShape);

/**
 * A node's identity triple (`Qid<K>` in `./types.ts`), parameterized by the
 * node's kind so a `Directory`'s guard accepts only `Qid<'directory'>` and a
 * `File`'s only `Qid<'file'>`. A custom backend returning the wrong
 * discriminator (e.g. a directory qid typed `'file'`) is rejected here,
 * before the read-only and caching wrappers trust `qid.type` to pick a
 * facet. Required keys only — a content-address backend may attach extra
 * fields through its `qidFor` hook.
 *
 * @param {'file' | 'directory'} type
 */
const makeQidShape = type =>
  M.splitRecord({
    type,
    pathId: M.bigint(),
    version: M.bigint(),
  });

const DirectoryQidShape = makeQidShape('directory');
harden(DirectoryQidShape);

const FileQidShape = makeQidShape('file');
harden(FileQidShape);

/** `OpenFileOptions` accepted by `Directory.create` / `File.open`. */
const OpenFileOptionsShape = M.splitRecord(
  {},
  {
    read: M.boolean(),
    write: M.boolean(),
    create: M.boolean(),
    truncate: M.boolean(),
    append: M.boolean(),
  },
);
harden(OpenFileOptionsShape);

/** `FileReadOptions` accepted by the one-shot `File.read` porcelain. */
const FileReadOptionsShape = M.splitRecord(
  {},
  { offset: M.bigint(), length: M.bigint() },
);
harden(FileReadOptionsShape);

/** `FileWriteOptions` accepted by the one-shot `File.write` porcelain. */
const FileWriteOptionsShape = M.splitRecord({}, { offset: M.bigint() });
harden(FileWriteOptionsShape);

/**
 * `LockOpts` accepted by `OpenFile.lock`. The canonical type declares no
 * `wait` member (conflicting requests fail immediately with `EAGAIN`), so
 * a `wait` extension is left to the open rest of the tolerant reader like
 * any other undeclared field, rather than singled out and typed here.
 */
const LockOptsShape = M.splitRecord(
  { type: M.or('shared', 'exclusive') },
  { start: M.bigint(), length: M.bigint() },
);
harden(LockOptsShape);

/** `LockQuery` accepted by `OpenFile.getLock`. */
const LockQueryShape = M.splitRecord(
  {},
  { start: M.bigint(), length: M.bigint() },
);
harden(LockQueryShape);

/**
 * Options bag on the verbs whose options no implementation reads yet
 * (`mkdir` / `makeDirectory` / `materialise` / `OpenFile.fsync`): any
 * copyRecord. Declared so the `materialiseViaWalk` convention
 * (`mkdir(seg, opts)`) and blindly-forwarding wrappers stay
 * guard-clean; tighten to a real shape when a field grows a reader.
 */
const OptionsRecordShape = M.record();
harden(OptionsRecordShape);

/** `existence` precondition accepted by `Xattrs.set`. */
const XattrSetOptionsShape = M.splitRecord(
  {},
  { existence: M.or('create', 'replace') },
);
harden(XattrSetOptionsShape);

/** The `{ cursor, watcher }` pair `Directory.watchFrom` resolves to. */
const WatchFromResultShape = harden({
  cursor: M.remotable('Cursor'),
  watcher: M.remotable('NodeWatcher'),
});

/** The `BlobInfo` triple `BlobRef.getInfo` reports. */
const BlobInfoShape = harden({
  algorithm: M.string(),
  hash: M.string(),
  size: M.bigint(),
});

const FilesystemMethods = {
  root: M.call().returns(M.eref(M.remotable('Directory'))),
  named: M.call(M.string()).returns(M.eref(M.remotable('Directory'))),
  statfs: M.call().returns(M.promise()),
  // Extractable identity for cross-CapTP cycle detection. Returns
  // the set of primitive-Filesystem brand IDs reachable through
  // this cap; wrappers union their participants' brands.
  // `bigint` survives marshalling, so a Filesystem cap that's
  // passed across CapTP and re-composed locally still reports the
  // same brand — letting the composer detect the cycle that the
  // local-Symbol check (per-cap-presence) would miss.
  // See ROADMAP §1.6.
  brands: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
};

export const FilesystemInterface = M.interface('Filesystem', FilesystemMethods);
harden(FilesystemInterface);

/**
 * Methods that every `Directory` and `File` exposes (§4.2 Node base).
 * Composed into the per-subtype interfaces below.
 *
 * The interface declares both the "narrow" portable shape
 * (`getStat`/`setStat`, accepting only `size`/`mtime`/`atime`) and
 * the "wide" legacy shape (`getAttrs`/`setAttrs`/`getQid`/`xattrs`,
 * the pre-seam-refactor surface). Both are real public methods on
 * wrapBackend-built exos; consumers can use either pair. POSIX-only
 * fields like `mode`/`uid`/`gid` live in a future `PosixFs`
 * companion cap rather than in the base.
 */
const NodeBaseMethods = {
  getStat: M.call().returns(M.promise()),
  setStat: M.call(NodeStatPatchShape).returns(M.promise()),
  getAttrs: M.call().returns(M.promise()),
  setAttrs: M.call(NodeStatPatchShape).returns(M.promise()),
  watch: M.call().returns(M.eref(M.remotable('NodeWatcher'))),
  xattrs: M.call().returns(M.eref(M.remotable('Xattrs'))),
  help: M.call().optional(M.string()).returns(M.string()),
};

export const DirectoryInterface = M.interface('Directory', {
  ...NodeBaseMethods,
  // `M.eref`: primitive backings answer `getQid` synchronously, but a
  // forwarding wrapper (`readOnly`, `cachedFilesystem`) over a remote
  // cap can only forward the promise; those wrappers must validate
  // the forwarded fulfillment themselves, since `M.eref` only checks
  // an unresolved promise's shape, not what it resolves to.
  getQid: M.call().returns(M.eref(DirectoryQidShape)),
  // Catalog `lookup`: resolve a path to its cap in one call. Accepts a
  // single name (`lookup('a')`) or a path array (`lookup(['a', 'b'])`),
  // walking the whole path and returning the deepest cap. This is the
  // same `string | string[]` calling convention `@endo/platform/fs`'s
  // `Directory.lookup` and the daemon's `EndoDirectory.lookup`
  // (`NameOrPathShape`) use, so a viewer calls `lookup` identically on
  // every backing. The one-segment form is also exposed under the
  // explicit name `lookupStep` for the CapTP-pipelining-optimized
  // single-step walk. See designs/fs-interface-reconciliation.md
  // §"Review findings incorporated" (F1).
  lookup: M.call(M.or(M.string(), M.arrayOf(M.string()))).returns(
    M.eref(M.or(M.remotable('Directory'), M.remotable('File'))),
  ),
  // One path segment, the pipelining-optimized walk:
  // `E(d).lookupStep('a').lookupStep('b')` collapses depth-N into one
  // round-trip via promise-chaining.
  lookupStep: M.call(M.string()).returns(
    M.eref(M.or(M.remotable('Directory'), M.remotable('File'))),
  ),
  // Narrow to a confined sub-tree: resolve `path` (which must name a
  // directory) and return its Directory cap. The result has no parent
  // reference, so it cannot navigate above the new root. Same
  // `string | string[]` convention as `lookup`.
  subView: M.call(M.or(M.string(), M.arrayOf(M.string()))).returns(
    M.eref(M.remotable('Directory')),
  ),
  list: M.call().returns(M.eref(M.remotable('Cursor'))),
  create: M.call(M.string())
    .optional(OpenFileOptionsShape)
    .returns(M.eref(M.remotable('OpenFile'))),
  // Catalog whole-blob `write`: create-or-overwrite the named child
  // with `value`, a UTF-8 `string`. The fire-and-forget whole-blob
  // form; `create` (above) stays the distinct range-I/O writer-stream
  // method. (The catalog also admits a `ReadableBlob` value for
  // streaming large content; that form is follow-up work — raw bytes
  // are not CapTP-passable, so they must arrive as a blob cap.) See
  // designs/fs-interface-reconciliation.md §Mutation (F2).
  write: M.call(M.string(), M.string()).returns(M.promise()),
  makeDirectory: M.call(M.string())
    .optional(OptionsRecordShape)
    .returns(M.eref(M.remotable('Directory'))),
  remove: M.call(M.string()).returns(M.promise()),
  // Legacy aliases for `makeDirectory` / `remove`. Kept declared
  // so the interface is honest about what wrapBackend's Directory
  // exos actually expose.
  mkdir: M.call(M.string())
    .optional(OptionsRecordShape)
    .returns(M.eref(M.remotable('Directory'))),
  unlink: M.call(M.string()).returns(M.promise()),
  // `rename(srcName, newParent, dstName)` is the cross-directory-cap
  // relocate primitive: `newParent` is a *Directory cap* (possibly a
  // different subtree, or — across filesystems — EXDEV). The catalog
  // `move(fromPath, toPath)` is built on top of it. 9p-server's Trename
  // (two independent fids) needs this cap form; path-to-path cannot
  // express a move between two unrelated directory caps.
  //
  // `newParent` is wrapped in `M.await` so a caller can pipeline a
  // `lookup → rename` chain without an intermediate await:
  //
  //   const newParent = E(host).lookup('newDir');       // promise
  //   await E(srcDir).rename('a', newParent, 'b');      // dispatched in
  //                                                      // the same batch
  //
  // The exo's async-shape dispatch (`M.callWhen`) awaits each
  // `M.await(...)` argument before invoking the method body. Without
  // this, the caller would need a serial round-trip. See DESIGN.md
  // §10.1 for the cost framework.
  rename: M.callWhen(
    M.string(),
    M.await(M.remotable('Directory')),
    M.string(),
  ).returns(M.undefined()),
  // Catalog `move(fromPath, toPath)`: within-tree path-to-path
  // relocate, matching `@endo/platform/fs`, the daemon `EndoDirectory`,
  // and the Mount (`string | string[]` for each path). `rename`
  // (below) is the distinct cross-directory-cap primitive that takes a
  // destination Directory *cap*; `move` is built on top of it. See
  // designs/fs-interface-reconciliation.md §Naming choices.
  move: M.call(
    M.or(M.string(), M.arrayOf(M.string())),
    M.or(M.string(), M.arrayOf(M.string())),
  ).returns(M.promise()),
  // Catalog `copy(fromPath, toPath)`: within-tree path-to-path copy
  // (recursive for directories), matching `@endo/platform/fs`, the
  // daemon `EndoDirectory`, and the Mount.
  copy: M.call(
    M.or(M.string(), M.arrayOf(M.string())),
    M.or(M.string(), M.arrayOf(M.string())),
  ).returns(M.promise()),
  fsync: M.call().returns(M.promise()),
  // Walk a path from this directory; for each segment, return the
  // existing Directory or `mkdir(seg)` it. The whole walk dispatches
  // in one round-trip per segment (the per-call branch is
  // server-side), so a deep materialise is one batch instead of
  // N serial lookup-then-mkdir round-trips. Compare DESIGN.md §10.1
  // [RT] item "No lookupOrCreate / materialise primitive".
  materialise: M.call(M.arrayOf(M.string()))
    .optional(OptionsRecordShape)
    .returns(M.eref(M.remotable('Directory'))),
  // Atomic snapshot + subscribe: returns a `Cursor` over the
  // directory's entries at the moment of subscription PLUS a
  // `NodeWatcher` that will receive every event from that point
  // onward — no gap between snapshot and subscribe. The standalone
  // `list()` + `watch()` pair has a TOCTOU race where mutations
  // between the two calls are invisible to both; `watchFrom`
  // closes that gap by materialising both halves in one method
  // invocation. See DESIGN.md §10.1. `watchFrom` is always async in
  // every implementation, so — unlike `getQid` — there is no sync
  // fast path to preserve; `M.callWhen` validates the fulfilled
  // `{ cursor, watcher }` record directly, catching a malformed
  // result forwarded from a remote backing.
  watchFrom: M.callWhen().returns(WatchFromResultShape),
});
harden(DirectoryInterface);

export const FileInterface = M.interface('File', {
  ...NodeBaseMethods,
  // See `DirectoryInterface.getQid` above.
  getQid: M.call().returns(M.eref(FileQidShape)),
  open: M.call()
    .optional(OpenFileOptionsShape)
    .returns(M.eref(M.remotable('OpenFile'))),
  read: M.call()
    .optional(FileReadOptionsShape)
    .returns(M.eref(M.remotable('PassableBytesReader'))),
  write: M.call()
    .optional(FileWriteOptionsShape)
    .returns(M.eref(M.remotable('PassableBytesWriter'))),
  snapshot: M.call().returns(M.eref(M.remotable('BlobRef'))),
});
harden(FileInterface);

// Cursor / OpenFile / Lock / Xattrs / NodeWatcher / BlobRef are
// non-evolving — their method set is stable; we declare every
// public method explicitly. Drift on these guards is a real bug we
// want CapTP to catch.

export const CursorInterface = M.interface('Cursor', {
  // Bounded page read for single-RTT directory listing. Returns
  // `{ entries: DirEntry[], atEnd: boolean }`. `limit` is optional;
  // omitted = drain the rest.
  read: M.call().optional(M.bigint()).returns(M.promise()),
  // Streaming reader over `DirEntry` for huge directories.
  stream: M.call().returns(M.eref(M.remotable('PassableReader'))),
  // Drain-everything convenience; do not use on unbounded listings.
  toArray: M.call().returns(M.promise()),
  skip: M.call(M.bigint()).returns(M.promise()),
  rewind: M.call().returns(M.promise()),
  // Release the cursor's iteration state (e.g. an open directory
  // handle on a lazy backing). Idempotent; after close, read/stream/
  // toArray yield nothing and skip/rewind are no-ops.
  close: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
harden(CursorInterface);

export const OpenFileInterface = M.interface('OpenFile', {
  // `read(offset, length)` returns a `PassableBytesReader` over the
  // requested slice. CapTP marshalling rejects raw mutable typed
  // arrays, so the wire shape stays a base64-streamed reader —
  // single-RTT pipelining via E gets the same effective cost as a
  // bare bytes return; see designs/endo-fs-backend-seam.md
  // "Design deviation". Both args optional so a 0-arg call is a
  // "from cursor to EOF" probe.
  read: M.callWhen()
    .optional(M.bigint(), M.bigint())
    .returns(M.eref(M.remotable('PassableBytesReader'))),
  // `write(offset)` returns a `PassableBytesWriter` whose chunks are
  // coalesced and pwritten at `offset` on close (no truncate of the
  // tail). `offset` is optional — defaults to the cursor.
  write: M.callWhen()
    .optional(M.bigint())
    .returns(M.eref(M.remotable('PassableBytesWriter'))),
  truncate: M.call(M.bigint()).returns(M.promise()),
  fsync: M.call().optional(OptionsRecordShape).returns(M.promise()),
  lock: M.call(LockOptsShape).returns(M.eref(M.remotable('Lock'))),
  getLock: M.call(LockQueryShape).returns(M.promise()),
  close: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
harden(OpenFileInterface);

export const LockInterface = M.interface('Lock', {
  release: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
harden(LockInterface);

export const XattrsInterface = M.interface('Xattrs', {
  get: M.call(M.string()).returns(M.eref(M.remotable('PassableBytesReader'))),
  set: M.call(M.string())
    .optional(XattrSetOptionsShape)
    .returns(M.eref(M.remotable('PassableBytesWriter'))),
  list: M.call().returns(M.eref(M.remotable('PassableReader'))),
  remove: M.call(M.string()).returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
harden(XattrsInterface);

/**
 * `Node.watch` returns a watcher cap whose `events()` yields a
 * PassableReader<Event> from `@endo/exo-stream`.
 */
export const NodeWatcherInterface = M.interface('NodeWatcher', {
  events: M.call().returns(M.eref(M.remotable('PassableReader'))),
  cancel: M.call().returns(M.promise()),
});
harden(NodeWatcherInterface);

/**
 * `BlobRef` is the content-addressed handle returned by
 * `File.snapshot()` (DESIGN.md §6). `getInfo()` returns
 * `{ algorithm, hash, size }`; `fetch(offset, length)` returns a
 * bytes stream over the immutable bytes captured at snapshot
 * time. `getInfo()` is a sync getter on the responder; callers
 * pipeline it alongside `snapshot` / `fetch` so the round-trip is
 * shared with the surrounding call (DESIGN.md §4.10).
 *
 * `text()` / `json()` are whole-value conveniences mirroring the daemon
 * `EndoBlob` / lite `SnapshotBlob` surface, so a `BlobRef` and a daemon blob
 * are mutually interchangeable for the common read shapes: `getInfo` + `fetch`
 * (range I/O) and `text` + `json` (whole value). `streamBase64` stays
 * daemon-only — the extended layer streams via `fetch` / `PassableBytesReader`
 * rather than the CapTP base64 pump. See
 * designs/fs-interface-consolidation.md § C4.
 */
export const BlobRefInterface = M.interface('BlobRef', {
  getInfo: M.call().returns(BlobInfoShape),
  fetch: M.call(M.bigint(), M.bigint()).returns(
    M.eref(M.remotable('PassableBytesReader')),
  ),
  text: M.call().returns(M.promise()),
  json: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
harden(BlobRefInterface);
