// Authored TypeScript source for the platform filesystem contracts.
// TypeScript resolves existing `./types.js` type imports to this module and
// composite declaration emit produces the corresponding `types.d.ts` artifact.

/** An async iterator of Uint8Array chunks. */
export type ReadableStream = AsyncIterator<Uint8Array>;

/**
 * A ReadableBlob presents an interface over a stream of bytes.
 * Exposed by platform as an Exo; directly usable locally.
 */
export interface ReadableBlob {
  streamBase64: (synPromise: unknown) => Promise<unknown>;
  text: () => Promise<string>;
  json: () => Promise<any>;
  help: (method?: string) => string;
}

/**
 * The one rich `ReadableBlob` surface: a whole-value `ReadableBlob` plus the
 * content-address `getInfo` and the `range` / `textRange` attenuation
 * (designs/readableblob-range-attenuation.md), implemented by the daemon,
 * mount, Git, extended `BlobRef`, and platform `LocalBlob` Exos. `range` and
 * `textRange` return a new `RichReadableBlob` with exactly the authority to
 * read the selected byte / line window of the receiver, so ranges compose.
 * Replaces the retired `ReadableBlobRange` (getInfo + `fetch`) and
 * `ReadableBlobRangeRead` (+ `rangeRead` / `rangeReadText`) types.
 */
export type RichReadableBlob = ReadableBlob & {
  getInfo: () => Promise<BlobInfo>;
  /**
   * Attenuate to the half-open byte interval `[start, end)` relative to the
   * receiver, clamped at end-of-content. `start`/`end` are non-negative
   * `bigint`s; `start > end`, a negative, or a non-safe value rejects with
   * `EINVAL`; `start === end` is an empty attenuation. `end` is optional:
   * omitting it selects from `start` to end-of-content.
   */
  range: (start: bigint, end?: bigint) => Promise<RichReadableBlob>;
  /**
   * Attenuate to lines `[startLine, endLine)` (zero-based, end-exclusive,
   * LF-delimited with a terminal empty line for a final LF) relative to the
   * receiver's current bytes. Indices are non-negative safe-integer `number`s;
   * an `endLine` past the last line clamps to the end.
   *
   * The line boundaries are resolved to **byte** offsets once, at call time,
   * against the receiver's then-current content. On an *immutable* source
   * (`BlobRef`, snapshot `EndoBlob`, a Git blob) that is exact and stable. On a
   * *live* source (a mount-file view) a later read on the returned blob reads
   * the source's then-current bytes at those frozen byte offsets, which may no
   * longer be the same lines if the content changed — so a `textRange` grant on
   * a live face can decay into a byte grant. Prefer `textRange` on immutable
   * snapshots when the line semantics must be stable.
   */
  textRange: (startLine: number, endLine: number) => Promise<RichReadableBlob>;
};

/**
 * The source a producer supplies to `makeBlobRangeMethods` (src/fs/blob-range.js)
 * to build the shared range attenuator: a single `readWindow` primitive over the
 * source's current bytes, a `hashBytes` digest (so the maker needs no host
 * `crypto` import), and an optional exo label for the derived ranges. Named here
 * rather than inline in the implementation because it is the parameter type of
 * an exported maker reused by every producer (`LocalBlob`, `BlobRef`, the daemon
 * `EndoBlob` / `EndoMountFile`, and the Git blob), any of which may `@import` it
 * to type the record it passes.
 */
export interface RangeSource {
  /**
   * Read the source's current bytes in the absolute half-open interval
   * `[start, end)`, clamped at end-of-content. `end === undefined` reads to
   * end-of-content. A read that returns fewer bytes than requested signals
   * end-of-content — the maker relies on this to stream `streamBase64` in
   * bounded windows. The returned bytes must occupy a fresh backing buffer:
   * callers with authority to the selected interval must not retain a view of
   * an unattenuated source allocation and thereby reach bytes outside it.
   */
  readWindow: (start: bigint, end: bigint | undefined) => Promise<Uint8Array>;
  /**
   * Optional fresh whole-source byte stream. Immutable producers whose native
   * read primitive is a stream (Git), and hosts whose range primitive must
   * first materialize the whole source (XS), provide this so a derived
   * `streamBase64` uses one source read rather than one per 48 KiB window. The
   * shared maker applies the attenuation and copies every yielded window.
   */
  streamBytes?: () => AsyncIterable<Uint8Array>;
  /** Raw digest (e.g. SHA-256) of the given bytes, base64-encoded by the maker. */
  hashBytes: (bytes: Uint8Array) => Uint8Array;
  /** Exo label for derived ranges; defaults to `'ReadableBlob range'`. */
  label?: string;
}

/**
 * One entry in a recursive `listTree` walk: the path relative to the queried
 * node and whether it names a file or a directory. Size and host stat fields
 * are intentionally omitted (they leak implementation details germane to
 * security); `type` is structural.
 */
export interface TreeEntry {
  path: string[];
  type: 'file' | 'directory';
}

/**
 * The `{ algorithm, hash, size }` content-address triple returned by
 * `getInfo()`. `hash` is base64; `algorithm` is `'sha256'`; `size` is the byte
 * length (of the blob, or of a tree's own manifest).
 */
export interface BlobInfo {
  algorithm: string;
  hash: string;
  size: bigint;
}

/**
 * A SnapshotBlob is a ReadableBlob with a content-addressed identity.
 * `sha256()` returns the digest as base64 (the canonical public hash encoding);
 * the hex form is the internal content-store address. `getInfo()` is the
 * uniform identity accessor (the same shape live blobs and trees expose).
 */
export type SnapshotBlob = ReadableBlob & {
  sha256: () => string;
  getInfo: () => Promise<BlobInfo>;
};

/**
 * A ReadableTree presents an immutable directory-like interface.
 */
export interface ReadableTree {
  has: (...petNamePath: string[]) => Promise<boolean>;
  list: (...petNamePath: string[]) => Promise<readonly string[]>;
  lookup: (petNamePath: string | readonly string[]) => Promise<unknown>;
  /**
   * Recursive counterpart to `list`: every descendant under the sub-path
   * `petNamePath` (a single name, a path of segments, or `[]` for the whole
   * tree) as `{ path, type }` records, lexically sorted, parents before
   * children. `options.ignore` augments the tree's own ignore set for the
   * call. Optional: only the richer tree surfaces expose it.
   */
  listTree?: (
    petNamePath: string | readonly string[],
    options?: { ignore?: readonly string[] },
  ) => Promise<TreeEntry[]>;
}

/**
 * A remotable byte source accepted by `Directory.write()`.
 *
 * The streaming protocol only needs `streamBase64`; optional reader metadata
 * such as `readReturnPattern` is not part of the materialization contract.
 */
export type ReadableBlobSource = {
  streamBase64: (...args: any[]) => PromiseLike<unknown>;
};

/** Portable semantic payload accepted by `Directory.write()`. */
export type DirectoryWriteSource = ReadableBlobSource | ReadableTree;

/**
 * A SnapshotTree is a ReadableTree with a content-addressed identity.
 * `sha256()` returns the digest as base64 (the canonical public hash encoding);
 * the hex form is the internal content-store address. `getInfo()` is the
 * uniform identity accessor (its `size` is the manifest byte length).
 */
export type SnapshotTree = ReadableTree & {
  sha256: () => string;
  getInfo: () => Promise<BlobInfo>;
};

/**
 * The host-side blob backing returned by `ContentStore.fetch()`.
 *
 * This is a local CAS implementation seam, not a public ReadableBlob Exo.
 * `readRange` uses safe-number offsets because it backs the public bigint
 * `RichReadableBlob.range()` attenuation at the daemon boundary.
 */
export interface ContentStoreBlob {
  makeFileReader: () => import('@endo/stream').Reader<Uint8Array>;
  text: () => Promise<string>;
  json: () => Promise<any>;
  size?: () => Promise<bigint>;
  readRange?: (offset: number, length: number) => Promise<Uint8Array>;
}

/**
 * A ContentStore stores and fetches host-side CAS blob backings by sha256.
 */
export interface ContentStore {
  /** Store the contents of a readable stream and return the sha256. */
  store: (
    readable: AsyncIterator<Uint8Array> | AsyncIterable<Uint8Array>,
  ) => Promise<string>;
  /** Fetch a local backing blob by its sha256. */
  fetch: (sha256: string) => ContentStoreBlob;
  /** Check whether a blob with the given sha256 exists. */
  has: (sha256: string) => Promise<boolean>;
  /**
   * Remove a blob by its sha256. Idempotent: removing a missing
   * blob is not an error. Callers are responsible for any
   * reference-counting; the store does not track references.
   */
  remove: (sha256: string) => Promise<void>;
}

/**
 * The writer half handed to a filesystem-backed `ContentStore`'s
 * `store` loop: an `@endo/stream` `Writer<Uint8Array>`-shaped sink the
 * store streams chunks into before the atomic rename. Reproduced as a
 * narrow type here (rather than imported wholesale from `@endo/stream`)
 * so the filesystem-dependency contract stays self describing.
 */
export interface ContentStoreFileWriter {
  next: (chunk: Uint8Array) => Promise<IteratorResult<undefined, undefined>>;
  return: (value?: undefined) => Promise<IteratorResult<undefined, undefined>>;
}

/**
 * The filesystem dependency a filesystem-backed `ContentStore` stands
 * on. This is the platform-owned contract a content store such as
 * `@endo/daemon-cas` injects to materialise blobs on disk: stream a
 * temp file, hash as the bytes land, atomically rename to the sha256
 * name, then read back by whole-value, range, or stat. Path-keyed and
 * `node:fs`-shaped, it is the small filesystem seam the CAS layer
 * couples to so that the store implementation stays host-agnostic.
 */
export interface ContentStoreFilePowers {
  /**
   * Whole-blob byte stream — the `@endo/stream` `Reader<Uint8Array>`
   * the `ContentStoreBlob.makeFileReader` surface hands back.
   */
  makeFileReader: (path: string) => import('@endo/stream').Reader<Uint8Array>;
  makeFileWriter: (path: string) => ContentStoreFileWriter;
  readFileText: (path: string) => Promise<string>;
  /**
   * Copy `[offset, offset + length)` into a fresh backing buffer, clamped at
   * EOF. Returning a view into a whole-file allocation would expose bytes
   * outside an attenuated window.
   */
  readFileRange: (
    path: string,
    offset: number,
    length: number,
  ) => Promise<Uint8Array>;
  makePath: (path: string) => Promise<void>;
  joinPath: (...components: string[]) => string;
  renamePath: (source: string, target: string) => Promise<void>;
  /**
   * Idempotent removal (missing path is not an error), matching the
   * `ContentStore.remove` contract.
   */
  removePath: (path: string) => Promise<void>;
  statPath: (path: string) => Promise<{
    kind: 'file' | 'directory' | 'symlink';
    size: bigint;
    mtime: bigint;
    atime: bigint;
  }>;
}

/**
 * The content-addressing dependency a `ContentStore` injects: a
 * sha256 digester over the inbound stream plus a random hex source for
 * the temp-file name. Platform-owned so the CAS layer stands on a
 * single shared contract rather than reproducing the daemon's crypto
 * powers.
 */
export interface ContentStoreCryptoPowers {
  makeSha256: () => {
    update(chunk: Uint8Array): void;
    digestHex(): string;
  };
  randomHex256: () => Promise<string>;
}

/**
 * A SnapshotStore is a ContentStore that also knows how to load
 * SnapshotBlob and SnapshotTree remotable Exos.
 */
export type SnapshotStore = ContentStore & {
  loadBlob: (sha256: string) => SnapshotBlob;
  loadTree: (sha256: string) => SnapshotTree;
};

/**
 * A TreeWriter materializes tree entries into a concrete location.
 */
export interface TreeWriter {
  writeBlob: (
    pathSegments: string[],
    readable: AsyncIterator<Uint8Array> | AsyncIterable<Uint8Array>,
  ) => Promise<void>;
  makeDirectory: (pathSegments: string[]) => Promise<void>;
}

/**
 * A File presents a mutable byte-content interface that also satisfies
 * the ReadableBlob read surface.  Concrete implementations supply
 * confinement and provenance (e.g. EndoMountFile constrains writes to
 * a mount root).
 */
export interface File {
  streamBase64: (synPromise: unknown) => Promise<unknown>;
  text: () => Promise<string>;
  json: () => Promise<any>;
  writeText: (content: string) => Promise<void>;
  writeBytes: (readable: unknown) => Promise<void>;
  append: (content: string) => Promise<void>;
  readOnly: () => ReadableBlob;
  snapshot: () => Promise<SnapshotBlob>;
}

/**
 * A Directory presents a mutable handle-first filesystem interface
 * that also satisfies the ReadableTree read surface on the query side.
 * `write` accepts a `ReadableBlob` (materialised as bytes at `path`) or
 * a `ReadableTree` (materialised recursively).  Concrete
 * implementations supply confinement and provenance.
 */
export interface Directory {
  has: (...path: string[]) => Promise<boolean>;
  list: (...path: string[]) => Promise<string[]>;
  lookup: (path: string | string[]) => Promise<unknown>;
  write: (path: string[], value: DirectoryWriteSource) => Promise<void>;
  remove: (path: string[]) => Promise<void>;
  move: (from: string[], to: string[]) => Promise<void>;
  copy: (from: string[], to: string[]) => Promise<void>;
  makeDirectory: (path: string[]) => Promise<Directory>;
  readOnly: () => ReadableTree;
  snapshot: () => Promise<SnapshotTree>;
}

/**
 * A PathEntry is an inert, authority-bearing path selector minted by a
 * filesystem authority such as a mount.
 * The entry carries no read/write
 * authority on its own; callers pass it back to the authority that minted it.
 */
export interface PathEntry {
  segments: () => string[];
  displayPath: () => string;
  child: (name: string) => PathEntry;
  help: (method?: string) => string;
}

/**
 * Authority that mints inert, lineage-bearing path selectors.
 *
 * The issuer is deliberately separate from `Directory`: a capability may
 * need to mint selectors for another operation without exposing a general
 * directory surface.
 */
export interface PathEntryIssuer {
  entry: (path: string | string[]) => PathEntry;
}
