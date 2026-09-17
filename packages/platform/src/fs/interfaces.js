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
  stream: M.call(M.any()).returns(M.promise()),
  text: M.call().returns(M.promise()),
  json: M.call().returns(M.promise()),
});

// Method-name duck-type for "this remote value is a readable blob whose bytes
// should be materialized" — the accept side of the daemon's `write()` /
// `copyInto` / `stageTree` and the extended-FS mount-child probes. Every
// admitted value is drained through `iterateBytesReader(source)`, i.e.
// `E(source).stream(synHead)`, so **`stream` is required on every branch** — a
// value that carries a blob marker but no `stream` (an extended-layer
// `BlobRef`, `{getInfo, fetch, text, json, help}`, whose bytes flow via `fetch`
// and which deliberately has no daemon-side `stream`) would otherwise pass the
// duck-type, get a scratch file opened, then die on an opaque method-missing
// error — the exact failure the crisp shape error exists to replace. Admits the
// canonical `ReadableBlob` whole-value read surface (`text` paired with
// `stream`, the shape every `readableBlobMethodGuards` implementor carries —
// `blobFromBytes`, an `@endo/exo-unzip` leaf, `makeBrowserBlob`), plus the two
// byte-stream-only shapes that lack `text` yet are still readable blobs: a
// `BlobRef`-style content-addressed blob (`stream` + `getInfo`) and a raw
// `PassableBytesReader` (`stream` + `readReturnPattern`). A generic value
// `PassableReader` also advertises `readReturnPattern`, so it is excluded by
// additionally requiring the *absence* of `readPattern` — the value-pattern
// accessor a bytes reader never carries (its yields are always `Uint8Array`).
// An `HttpResponse` (`@endo/exo-http-client`) exposes its readable body under
// `body()` — a zero-arg factory returning a `PassableBytesReader` — *not*
// `stream`, precisely so its whole-value read surface (`text`/`json`) cannot
// collide with this discriminator: lacking `stream`, an `HttpResponse` fails
// the top-level `stream` check and is never mistaken for a drainable blob, with
// no `@endo/exo-http-client`-specific clause reaching across the package
// boundary into this predicate. A writer
// (`writePattern`/`writeReturnPattern`, neither `text` nor a read marker) is
// rejected by falling through both branches. `stream` alone no longer
// discriminates: it is the generic byte-stream method shared with
// readers/writers, so it is always paired with a marker.
//
// This is the single source of truth for the discriminator (five consumers
// spread across four packages import it); never re-inline it per consumer — a
// divergent copy is exactly the wire-shape classification bug this consolidates
// away.
/**
 * The single exported discriminator for "this remote value is a readable blob
 * whose bytes should be materialized": true when `methodNames` carries `stream`
 * paired with a `text` whole-value read surface or a
 * `getInfo`/`readReturnPattern` byte-read marker (and not `readPattern`). See
 * the block comment above for the full duck-type rationale and the values each
 * branch admits or excludes.
 *
 * @param {string[]} methodNames
 * @returns {boolean}
 */
export const looksLikeReadableBlob = methodNames =>
  methodNames.includes('stream') &&
  (methodNames.includes('text') ||
    (!methodNames.includes('readPattern') &&
      (methodNames.includes('getInfo') ||
        methodNames.includes('readReturnPattern'))));
harden(looksLikeReadableBlob);

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

// The named read surface for content-addressed bytes: the richer
// `BlobRef` shape (see `@endo/platform/fs/extended` `BlobRefInterface`),
// lifted to a portable record so the daemon's remote blob cap can expose it
// too. Hash and size have separate accessors, `bytes()` streams the selected
// content, and `byteRange()` attenuates authority. See
// designs/fs-interface-consolidation.md § C4.
export const rangeReadMethodGuards = harden({
  sha256: M.call().returns(M.promise()),
  size: M.call().returns(M.promise()),
  bytes: M.call().returns(M.promise()),
});

// Range *attenuation* (designs/readableblob-range-attenuation.md): instead of
// reading a byte window, `byteRange` / `textRange` return a new, ephemeral
// `ReadableBlob` with exactly the authority to read the selected portion, so
// ranges compose and can be handed to anything that already accepts a readable
// blob.
//
// - `byteRange(start, end) → ReadableBlob` selects the half-open byte interval
//   `[start, end)` relative to the receiver. Construction reads no bytes, so
//   it resolves synchronously to the derived cap; the guard requires a
//   `ReadableBlob` remotable (not `M.any()`) so the same-interface guarantee is
//   enforced at the CapTP boundary.
// - `textRange(startLine, endLine) → Promise<ReadableBlob>` selects lines
//   `[startLine, endLine)` (0-based, end-exclusive, LF boundaries) of the
//   receiver's current bytes and returns the byte slice as a `ReadableBlob`.
//   It must read bytes to find LF boundaries, so it resolves asynchronously.
export const rangeAttenuationMethodGuards = harden({
  byteRange: M.call(M.bigint(), M.bigint()).returns(
    M.remotable('ReadableBlob'),
  ),
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

// A `ReadableBlob` that also exposes the `BlobRef` range-I/O surface
// (`sha256` / `size` / `bytes`) plus the attenuation surface (`byteRange` /
// `textRange`, designs/readableblob-range-attenuation.md) — the rich shape for
// content-addressed blobs read remotely, where a range returns a new
// `ReadableBlob` with exactly the authority to read the selected portion.
// Pre-assembled so implementers (mount `EndoMountReadableBlob`, GitBlob) can
// adopt the full surface without re-spreading the records or depending on
// `@endo/patterns` themselves. The interface tag is distinct from
// `ReadableBlobInterface`'s so the two shapes don't collide in diagnostics /
// marshaled interface names (feature detection keys on method names, not the
// tag). See designs/fs-interface-consolidation.md § C4.
export const ReadableBlobRangeInterface = M.interface('ReadableBlobRange', {
  ...readableBlobMethodGuards,
  ...rangeReadMethodGuards,
  ...rangeAttenuationMethodGuards,
});
harden(ReadableBlobRangeInterface);

export const SnapshotBlobInterface = M.interface('SnapshotBlob', {
  ...readableBlobMethodGuards,
  sha256: M.call().returns(M.string()),
  size: M.call().returns(M.promise()),
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
  sha256: M.call().returns(M.string()),
  size: M.call().returns(M.promise()),
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
