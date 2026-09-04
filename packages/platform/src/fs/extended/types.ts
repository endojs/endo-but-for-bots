// Authored TypeScript source for the extended filesystem capability surface.
// This is the contract the `wrapBackend` exos implement and the source the
// code-mode `workspace` declaration is printed from; the `M.interface` guards
// in `./type-guards.js` are its runtime enforcement layer, and the divergence
// gate in `@endo/agent-tools` keeps the two method sets aligned.
//
// Capability surfaces are `type` aliases of arrow-function properties rather
// than `interface` method declarations, matching `@endo/exo-git`'s authored
// surface: that is the shape the code-mode extractor prints from.

import type { ERef } from '@endo/eventual-send';
import type {
  PassableBytesReader,
  PassableBytesWriter,
  PassableReader,
} from '@endo/exo-stream';
import type { RichReadableBlob } from '@endo/platform/fs/lite/types';

export type { ERef };
export type { PassableBytesReader, PassableBytesWriter, PassableReader };

/**
 * Portable identity for a complete immutable filesystem tree. The algorithm
 * names both the digest and the tree encoding it covers.
 */
export type TreeRef = {
  algorithm: string;
  hash: string;
};

/** The kind of a filesystem node. */
export type NodeKind = 'file' | 'directory';

export type FilesystemStats = {
  blockSize?: bigint;
  totalBlocks?: bigint;
  freeBlocks?: bigint;
  totalBytes?: bigint;
  freeBytes?: bigint;
  files?: bigint;
  directories?: bigint;
  type?: string;
};

export type Filesystem = {
  root: () => ERef<Directory>;
  named: (name: string) => ERef<Directory>;
  statfs: () => Promise<FilesystemStats>;
  brands: () => Promise<ReadonlySet<bigint> | readonly bigint[]>;
  help: (method?: string) => string;
};

/**
 * The narrow portable stat shape. Times are nanoseconds since the Unix epoch.
 */
export type NodeStat = {
  size?: bigint;
  mtime?: bigint;
  atime?: bigint;
};

/**
 * The wide legacy attrs shape reported by `getAttrs`, which adds the two times
 * a caller cannot set.
 */
export type NodeAttrs = NodeStat & {
  ctime?: bigint;
  btime?: bigint | null;
};

/**
 * A node's identity triple, parameterized by the node's kind so a
 * `Directory`'s qid is `Qid<'directory'>` and a `File`'s is `Qid<'file'>`.
 * `pathId` is a stable per-path hash by default; a content-address backend may
 * source it from a stronger identity such as a git object id.
 */
export type Qid<K extends NodeKind = NodeKind> = {
  type: K;
  pathId: bigint;
  version: bigint;
};

/** An event yielded by `NodeWatcher.events()`. */
export type WatchEvent = {
  kind: 'changed' | 'created' | 'removed' | 'child-added' | 'child-removed';
  /** The direct child's name for child events. */
  name?: string;
};

export type NodeWatcher = {
  events: () => ERef<PassableReader<WatchEvent>>;
  cancel: () => Promise<void>;
};

/**
 * Options accepted by `Xattrs.set`: the POSIX `XATTR_CREATE` /
 * `XATTR_REPLACE` existence precondition. Advisory at this layer — the
 * vat-local sidecar does not enforce it yet.
 */
export type XattrSetOptions = {
  existence?: 'create' | 'replace';
};

/**
 * Vat-local `user.*` extended attributes. `get` and `set` are stream-shaped
 * because raw bytes are not passable across CapTP; `set` returns a writer whose
 * coalesced chunks become the attribute value when the writer closes.
 */
export type Xattrs = {
  get: (name: string) => ERef<PassableBytesReader>;
  set: (name: string, opts?: XattrSetOptions) => ERef<PassableBytesWriter>;
  list: () => ERef<PassableReader<string>>;
  remove: (name: string) => Promise<void>;
  help: (method?: string) => string;
};

/**
 * A directory listing entry, as yielded by `Cursor.read` and `Cursor.stream`.
 * `kind` and `qid.type` are correlated discriminants: narrowing either
 * narrows the whole entry, and the union makes a mismatched pair
 * (`kind: 'file'` with a directory qid) unrepresentable.
 */
export type DirectoryEntry =
  | { name: string; kind: 'file'; qid: Qid<'file'> }
  | { name: string; kind: 'directory'; qid: Qid<'directory'> };

/** One bounded page of a directory listing. */
export type DirectoryPage = {
  entries: DirectoryEntry[];
  atEnd: boolean;
};

export type Cursor = {
  read: (limit?: bigint) => Promise<DirectoryPage>;
  stream: () => ERef<PassableReader<DirectoryEntry>>;
  toArray: () => Promise<DirectoryEntry[]>;
  skip: (n: bigint) => Promise<void>;
  rewind: () => Promise<void>;
  close: () => Promise<void>;
  help: (method?: string) => string;
};

/**
 * The atomic snapshot-plus-subscribe pair returned by `Directory.watchFrom`: a
 * cursor over the entries at the moment of subscription and a watcher that
 * receives every event from that point onward.
 */
export type WatchFromResult = {
  cursor: Cursor;
  watcher: NodeWatcher;
};

export type Directory = {
  getQid: () => Qid<'directory'>;
  getStat: () => Promise<NodeStat>;
  setStat: (patch: NodeStat) => Promise<void>;
  getAttrs: () => Promise<NodeAttrs>;
  setAttrs: (patch: NodeStat) => Promise<void>;
  watch: () => ERef<NodeWatcher>;
  xattrs: () => ERef<Xattrs>;
  lookup: (nameOrPath: string | readonly string[]) => ERef<Directory | File>;
  lookupStep: (name: string) => ERef<Directory | File>;
  subView: (nameOrPath: string | readonly string[]) => ERef<Directory>;
  list: () => ERef<Cursor>;
  write: (name: string, value: string) => Promise<void>;
  create: (name: string, opts?: OpenFileOptions) => ERef<OpenFile>;
  makeDirectory: (name: string) => ERef<Directory>;
  mkdir: (name: string) => ERef<Directory>;
  remove: (name: string) => Promise<void>;
  unlink: (name: string) => Promise<void>;
  move: (
    fromPath: string | readonly string[],
    toPath: string | readonly string[],
  ) => Promise<void>;
  copy: (
    fromPath: string | readonly string[],
    toPath: string | readonly string[],
  ) => Promise<void>;
  rename: (
    oldName: string,
    newParent: ERef<Directory>,
    newName: string,
  ) => Promise<void>;
  fsync: () => Promise<void>;
  materialise: (path: readonly string[]) => ERef<Directory>;
  watchFrom: () => ERef<WatchFromResult>;
  help: (method?: string) => string;
};

/**
 * A child node paired with its kind, as resolved by pipelining `lookup` with
 * `getQid`. The tagged-record shape restores the discriminated narrowing that
 * two independently awaited values (a node and its qid) cannot give the type
 * system on their own: narrowing `kind` narrows `node` to the matching cap.
 */
export type ResolvedNode =
  { kind: 'file'; node: File } | { kind: 'directory'; node: Directory };

/** Options for the one-shot `File.read` porcelain. */
export type FileReadOptions = {
  offset?: bigint;
  length?: bigint;
};

/**
 * Options for the one-shot `File.write` porcelain. Omitting `offset` selects
 * whole-file overwrite; supplying one selects pwrite semantics.
 */
export type FileWriteOptions = {
  offset?: bigint;
};

export type File = {
  getQid: () => Qid<'file'>;
  getStat: () => Promise<NodeStat>;
  setStat: (patch: NodeStat) => Promise<void>;
  getAttrs: () => Promise<NodeAttrs>;
  setAttrs: (patch: NodeStat) => Promise<void>;
  watch: () => ERef<NodeWatcher>;
  xattrs: () => ERef<Xattrs>;
  open: (opts?: OpenFileOptions) => ERef<OpenFile>;
  read: (opts?: FileReadOptions) => ERef<PassableBytesReader>;
  write: (opts?: FileWriteOptions) => ERef<PassableBytesWriter>;
  snapshot: () => Promise<BlobRef>;
  help: (method?: string) => string;
};

/** The algorithm, hash, and size triple a `BlobRef` reports. */
export type BlobInfo = {
  algorithm: string;
  hash: string;
  size: bigint;
};

/**
 * The content-addressed handle returned by `File.snapshot()`. The bytes it
 * carries are captured at snapshot time and are independent of later writes.
 */
export type BlobRef = {
  getInfo: () => BlobInfo;
  streamBase64: (synPromise: unknown) => Promise<unknown>;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  help: (method?: string) => string;
  // A derived range is a generic attenuated `RichReadableBlob`, *not* a
  // `BlobRef` (its `getInfo` is async, and it carries no snapshot identity), so
  // it is typed as such rather than as `Promise<BlobRef>` — the shared
  // attenuator is the single source of that contract. `end` is optional:
  // omitting it selects from `start` to end-of-content.
  range: (start: bigint, end?: bigint) => Promise<RichReadableBlob>;
  textRange: (startLine: number, endLine: number) => Promise<RichReadableBlob>;
};

export type LockType = 'shared' | 'exclusive';

/**
 * Range-lock request accepted by `OpenFile.lock`.
 *
 * Conflicting requests fail immediately with `EAGAIN`; callers that need
 * retries must implement that policy themselves, so there is no `wait` option.
 */
export type LockOpts = {
  type: LockType;
  start?: bigint;
  /** `length === 0n` means to the end of the file. */
  length?: bigint;
};

/** Range query accepted by `OpenFile.getLock`. */
export type LockQuery = {
  start?: bigint;
  length?: bigint;
};

/** The state of a lock overlapping a queried range. */
export type LockState = {
  type: LockType;
  start: bigint;
  length: bigint;
};

export type Lock = {
  release: () => Promise<void>;
  help: (method?: string) => string;
};

export type OpenFile = {
  read: (offset?: bigint, length?: bigint) => ERef<PassableBytesReader>;
  write: (offset?: bigint) => ERef<PassableBytesWriter>;
  truncate: (size: bigint) => Promise<void>;
  fsync: () => Promise<void>;
  lock: (opts: LockOpts) => ERef<Lock>;
  getLock: (opts: LockQuery) => Promise<LockState | null>;
  close: () => Promise<void>;
  help: (method?: string) => string;
};

export type OpenFileOptions = {
  read?: boolean;
  write?: boolean;
  create?: boolean;
  truncate?: boolean;
  append?: boolean;
};
