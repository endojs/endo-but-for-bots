// @ts-check

import { M } from '@endo/patterns';

// `help: help(method?) → string` is conventional on every capability
// (see root AGENTS.md): with no argument it returns a one-line description
// of the cap; with a method name it documents that method.
const HelpMethod = M.call().optional(M.string()).returns(M.string());

// Shared path-argument shapes. The reconciled vocabulary standardizes on
// `string | string[]` (a single name or a path of segments). Surfaces that
// accept more (e.g. the daemon `EndoMount`, which also takes a `MountEntry`
// cap) widen these in their own guards rather than here — see
// designs/fs-interface-consolidation.md § "The load-bearing constraint".
const NamePathShape = M.arrayOf(M.string());
const NameOrPathShape = M.or(M.string(), M.arrayOf(M.string()));

// PathEntry is the portable descriptor for an authority-bearing path selector.
// It is intentionally inert: holders can inspect the confined segments and
// derive child selectors, but actual filesystem authority stays on the mount,
// directory, or Git capability that accepts the entry.
export const pathEntryMethodGuards = harden({
  help: HelpMethod,
  segments: M.call().returns(NamePathShape),
  displayPath: M.call().returns(M.string()),
  child: M.call(M.string()).returns(M.remotable('PathEntry')),
});

// `readableBlobMethodGuards` is the shared read-surface for immutable bytes.
// `SnapshotBlob` adds `sha256`; `File` adds the write surface. Exported so the
// extended cap-FS engine and the daemon blob caps can spread one definition
// rather than hand-copying the shapes (designs/fs-interface-consolidation.md
// § C2 / C4).
export const readableBlobMethodGuards = harden({
  help: HelpMethod,
  streamBase64: M.call(M.any()).returns(M.promise()),
  text: M.call().returns(M.promise()),
  json: M.call().returns(M.promise()),
});

// `readableTreeMethodGuards` is the shared read-surface for content-addressed
// directories. `SnapshotTree` adds `sha256`; `Directory` adds the write
// surface. Exported for the same reason as `readableBlobMethodGuards`
// (designs/fs-interface-consolidation.md § C2 / C3).
export const readableTreeMethodGuards = harden({
  help: HelpMethod,
  has: M.call().rest(NamePathShape).returns(M.promise()),
  list: M.call().rest(NamePathShape).returns(M.promise()),
  lookup: M.call(NameOrPathShape).returns(M.promise()),
});

// `readableNameHubMethodGuards` is the read surface of a *mutable* name hub /
// directory: the readable-tree read methods plus `maybeLookup`
// (lookup-or-undefined). It is the portable contract that the daemon's
// `EndoDirectory` / `EndoGuest` / `EndoHost` / `EndoMount` and an agent host's
// `LocalMount` all satisfy by method name (the daemon's full registry hub adds
// locator/identifier methods on top, which stay daemon-side). Lives here, not
// in `@endo/daemon`, so non-daemon hosts (a browser/Go/Rust client) can
// consume it without depending on the daemon. See
// designs/fs-interface-consolidation.md § C1.
export const readableNameHubMethodGuards = harden({
  ...readableTreeMethodGuards,
  maybeLookup: M.call(NameOrPathShape).returns(M.any()),
});

// `directoryFileMethodGuards` is the live read/write surface a directory or
// mount adds on top of the read contract: directory creation plus text I/O.
// Shared by `EndoDirectory` / `EndoGuest` / `EndoHost` and an agent host's `LocalMount`
// (all on `NameOrPathShape`); `EndoMount` widens these to its entry-accepting
// shape in its own guard.
export const directoryFileMethodGuards = harden({
  makeDirectory: M.call(NameOrPathShape).returns(M.promise()),
  readText: M.call(NameOrPathShape).returns(M.promise()),
  maybeReadText: M.call(NameOrPathShape).returns(M.promise()),
  writeText: M.call(NameOrPathShape, M.string()).returns(M.promise()),
});

// `getInfo()` is the uniform content-address identity accessor: it returns the
// `{ algorithm, hash, size }` triple in one round-trip. It is the shared half
// of the range-I/O surface (rich blobs add `range` / `textRange` for windowed
// reads) and is *also* carried by the content-addressed snapshot caps
// (`SnapshotBlob`, `SnapshotTree`, daemon `EndoReadableTree`), so a caller can
// read a content hash off *any* blob or tree uniformly via `getInfo().hash`
// without feature-detecting `sha256()` vs `getInfo()`. See
// designs/fs-interface-consolidation.md § C4.
export const getInfoMethodGuard = harden({
  getInfo: M.call().returns(M.any()),
});

// The range-*attenuation* surface for content-addressed bytes
// (designs/readableblob-range-attenuation.md). `range` and `textRange` return
// a new, ephemeral `ReadableBlob` with exactly the authority to read the
// selected portion of the receiver — an attenuation, not a one-shot bytes
// reader — so ranges compose and can be handed to any code that already
// accepts a readable blob. This replaces the retired `fetch(offset, length)`
// windowed read and the `rangeRead` / `rangeReadText` conveniences: a caller
// reads the returned attenuated blob by its normal `text` / `json` /
// `streamBase64` / `getInfo` methods rather than consuming a special value.
//
// - `range(start, end?)` selects the half-open **byte** interval `[start, end)`
//   relative to the receiver. `start` and `end` are non-negative `bigint`s in
//   the safe-offset domain; `start > end`, a negative, or a non-safe value
//   rejects with `EINVAL`; `start === end` is an empty attenuation; the
//   selection clamps at end-of-content. `end` is *optional* — omitting it
//   selects from `start` to end-of-content, the same domain the implementation
//   already models (`end === undefined`); a caller need not synthesize a
//   sentinel upper bound (`range(start, MAX)`) to express "to EOF".
// - `textRange(startLine, endLine)` selects lines `[startLine, endLine)`
//   (zero-based, end-exclusive, LF-delimited with a terminal empty line for a
//   final LF) relative to the receiver's current bytes and returns the
//   corresponding byte slice as a `ReadableBlob`. Line indices are plain
//   non-negative safe-integer `number`s; an `endLine` past the last line
//   clamps to the end.
//
// The runtime guards require each method return a promise; they do **not**
// constrain the fulfillment value's interface (`M.promise()` is opaque to the
// resolution), so promiseness — not "the resolved value is a `ReadableBlob`" —
// is what the boundary enforces. Callers that compose ranges detect the rich
// surface by its method names, not by any guard-level interface guarantee.
export const rangeAttenuationMethodGuards = harden({
  range: M.call(M.bigint()).optional(M.bigint()).returns(M.promise()),
  textRange: M.call(M.number(), M.number()).returns(M.promise()),
});

// `listTree(petNamePath, options?)` is the recursive counterpart to `list`:
// where `list` yields only the immediate child names of the sub-path,
// `listTree` walks the whole subtree in one round-trip and returns every
// descendant as a `{ path: string[], type: 'file' | 'directory' }` record,
// lexically sorted, parents before children. It consolidates the
// recursive-list feature of the lal / fae toolkits. The record omits
// size and any host stat fields for the same security reason `stat` is
// omitted from the blob surface — `type` is structural, not an
// implementation-detail leak. See designs/platform-range-and-tree-reads.md.
//
// The query takes a `PetNamePath` (a single `string` name or a `string[]`
// path — the same shape `lookup` accepts; `[]` names the whole tree) rather
// than a rest argument, leaving the second parameter free for an options bag.
// `options.ignore` **augments** (does not replace) the tree's own ignore set
// for this one call, so a caller can hide additional names at the read site
// without the surface baking in an arbitrary default list.
const listTreeOptionsShape = M.splitRecord(
  {},
  { ignore: M.arrayOf(M.string()) },
);
export const recursiveListMethodGuards = harden({
  listTree: M.call(NameOrPathShape)
    .optional(listTreeOptionsShape)
    .returns(M.promise()),
});

export const ReadableBlobInterface = M.interface('ReadableBlob', {
  ...readableBlobMethodGuards,
});
harden(ReadableBlobInterface);

// The one rich `ReadableBlob` surface: the whole-value read methods, the
// content-address `getInfo`, and the `range` / `textRange` attenuation
// (designs/readableblob-range-attenuation.md). Every public rich blob — the
// extended `BlobRef`, platform `LocalBlob`, the daemon's stored and transient
// blobs, live mount-file views, and the Git blob — implements exactly this
// surface, and every derived range is again this same surface, so a range of a
// range composes. This single interface replaces the former
// `ReadableBlobRange` (getInfo + `fetch`) / `ReadableBlobRangeRead`
// (+ `rangeRead` / `rangeReadText`) split; those names are retired. The tag is
// `'RichReadableBlob'` — distinct from the whole-value `ReadableBlobInterface`'s
// `'ReadableBlob'` so the two different method sets do not marshal under one
// interface name and a diagnostic can tell a whole-value blob from a rich one
// (feature detection still keys on method names, not the tag).
export const RichReadableBlobInterface = M.interface('RichReadableBlob', {
  ...readableBlobMethodGuards,
  ...getInfoMethodGuard,
  ...rangeAttenuationMethodGuards,
});
harden(RichReadableBlobInterface);

// `SnapshotBlob` is the immutable content-addressed *identity* surface (its
// `sha256` is a fixed, whole-value address). It deliberately does **not** carry
// the `range` / `textRange` attenuation that `RichReadableBlobInterface` adds:
// a derived range is a generic `RichReadableBlob` over a byte/line window with
// no snapshot identity of its own, so mixing the two on one cap would imply a
// `sha256`-bearing value that a range silently strips. A holder that needs a
// windowed read of a snapshot's bytes loads the bytes (e.g. through the CAS or a
// rich blob) and ranges there; the snapshot family stays the identity surface.
export const SnapshotBlobInterface = M.interface('SnapshotBlob', {
  ...readableBlobMethodGuards,
  ...getInfoMethodGuard,
  sha256: M.call().returns(M.string()),
});
harden(SnapshotBlobInterface);

// A tree implies recursion, so the recursive `listTree` lives on the plain
// `ReadableTreeInterface` rather than a separate "recursive tree" variant.
// This is the read surface the platform's own `LocalTree` implements. Because
// `listTree` is spread here — not into the shared `readableTreeMethodGuards`
// — the daemon / git / mount tree exos (which carry their own separately
// tagged tree interfaces) are unaffected; adopting `listTree` there is a
// documented follow-up in designs/platform-range-and-tree-reads.md.
export const ReadableTreeInterface = M.interface('ReadableTree', {
  ...readableTreeMethodGuards,
  ...recursiveListMethodGuards,
});
harden(ReadableTreeInterface);

export const SnapshotTreeInterface = M.interface('SnapshotTree', {
  ...readableTreeMethodGuards,
  ...getInfoMethodGuard,
  sha256: M.call().returns(M.string()),
});
harden(SnapshotTreeInterface);

export const PathEntryInterface = M.interface('PathEntry', {
  ...pathEntryMethodGuards,
});
harden(PathEntryInterface);

export const pathEntryIssuerMethodGuards = harden({
  entry: M.call(M.or(M.string(), M.arrayOf(M.string()))).returns(
    M.remotable('PathEntry'),
  ),
});

export const PathEntryIssuerInterface = M.interface('PathEntryIssuer', {
  ...pathEntryIssuerMethodGuards,
});
harden(PathEntryIssuerInterface);

export const TreeWriterInterface = M.interface('TreeWriter', {
  help: HelpMethod,
  writeBlob: M.call(M.arrayOf(M.string()), M.remotable()).returns(M.promise()),
  makeDirectory: M.call(M.arrayOf(M.string())).returns(M.promise()),
});
harden(TreeWriterInterface);

export const FileInterface = M.interface('File', {
  ...readableBlobMethodGuards,
  writeText: M.call(M.string()).returns(M.promise()),
  writeBytes: M.call(M.remotable()).returns(M.promise()),
  append: M.call(M.string()).returns(M.promise()),
  readOnly: M.call().returns(M.remotable('ReadableBlob')),
  snapshot: M.call().returns(M.promise()),
});
harden(FileInterface);

export const DirectoryInterface = M.interface('Directory', {
  ...readableTreeMethodGuards,
  write: M.call(M.arrayOf(M.string()), M.remotable()).returns(M.promise()),
  remove: M.call(M.arrayOf(M.string())).returns(M.promise()),
  move: M.call(M.arrayOf(M.string()), M.arrayOf(M.string())).returns(
    M.promise(),
  ),
  copy: M.call(M.arrayOf(M.string()), M.arrayOf(M.string())).returns(
    M.promise(),
  ),
  makeDirectory: M.call(M.arrayOf(M.string())).returns(M.promise()),
  readOnly: M.call().returns(M.remotable('ReadableTree')),
  snapshot: M.call().returns(M.promise()),
});
harden(DirectoryInterface);
