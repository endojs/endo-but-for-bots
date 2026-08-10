// @ts-check
/// <reference types="ses"/>

/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate with: yarn workspace @endo/agent-tools gen:code-mode-types
 *
 * Source of truth:
 *   - workspace: packages/platform/src/fs/extended/types.ts (the
 *     `Filesystem` type alias and the capability types it reaches), printed
 *     by the TypeScript compiler API, with `PassableReader`,
 *     `PassableBytesReader`, `PassableBytesWriter`, and the stream nodes
 *     they reach followed into packages/exo-stream/types.d.ts.
 *
 * The generic extraction and rendering live in
 * scripts/code-mode-type-extract.js; this exo's source configuration lives in
 * its scripts/code-mode-*-extract.js extractor. The divergence gate in
 * test/code-mode-types.test.js keeps this artifact fresh.
 *
 * Each entry is consumed by formatGlobalDeclarations in code-mode/declarations.js via
 * the per-exo descriptor in code-mode-globals/fs.js:
 * `aux` is the supporting `type` aliases, `body` is the object type spliced
 * after the dynamic `declare const <name>:`.
 */

export const fsDeclarations = harden({
  workspace: {
    aux: `type Filesystem = {
  brands: () => Promise<ReadonlySet<bigint> | readonly bigint[]>;
  help: (method?: string) => string;
  named: (name: string) => ERef<Directory>;
  root: () => ERef<Directory>;
  statfs: () => Promise<FilesystemStats>;
};
type BlobInfo = {
    algorithm: string;
    hash: string;
    size: bigint;
};
type BlobRef = {
    getInfo: () => BlobInfo;
    fetch: (offset: bigint, length: bigint) => ERef<PassableBytesReader>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    help: (method?: string) => string;
};
type Cursor = {
    read: (limit?: bigint) => Promise<DirectoryPage>;
    stream: () => ERef<PassableReader<DirectoryEntry>>;
    toArray: () => Promise<DirectoryEntry[]>;
    skip: (n: bigint) => Promise<void>;
    rewind: () => Promise<void>;
    close: () => Promise<void>;
    help: (method?: string) => string;
};
type Directory = {
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
    move: (fromPath: string | readonly string[], toPath: string | readonly string[]) => Promise<void>;
    copy: (fromPath: string | readonly string[], toPath: string | readonly string[]) => Promise<void>;
    rename: (oldName: string, newParent: ERef<Directory>, newName: string) => Promise<void>;
    fsync: () => Promise<void>;
    materialise: (path: readonly string[]) => ERef<Directory>;
    watchFrom: () => ERef<WatchFromResult>;
    help: (method?: string) => string;
};
type DirectoryEntry = {
    name: string;
    kind: 'file';
    qid: Qid<'file'>;
} | {
    name: string;
    kind: 'directory';
    qid: Qid<'directory'>;
};
type DirectoryPage = {
    entries: DirectoryEntry[];
    atEnd: boolean;
};
type ERef<T> = T | Promise<T>;
type File = {
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
type FileReadOptions = {
    offset?: bigint;
    length?: bigint;
};
type FileWriteOptions = {
    offset?: bigint;
};
type FilesystemStats = {
    blockSize?: bigint;
    totalBlocks?: bigint;
    freeBlocks?: bigint;
    totalBytes?: bigint;
    freeBytes?: bigint;
    files?: bigint;
    directories?: bigint;
    type?: string;
};
type Lock = {
    release: () => Promise<void>;
    help: (method?: string) => string;
};
type LockOpts = {
    type: LockType;
    start?: bigint;
    length?: bigint;
};
type LockQuery = {
    start?: bigint;
    length?: bigint;
};
type LockState = {
    type: LockType;
    start: bigint;
    length: bigint;
};
type LockType = 'shared' | 'exclusive';
type NodeAttrs = NodeStat & {
    ctime?: bigint;
    btime?: bigint | null;
};
type NodeKind = 'file' | 'directory';
type NodeStat = {
    size?: bigint;
    mtime?: bigint;
    atime?: bigint;
};
type NodeWatcher = {
    events: () => ERef<PassableReader<WatchEvent>>;
    cancel: () => Promise<void>;
};
type OpenFile = {
    read: (offset?: bigint, length?: bigint) => ERef<PassableBytesReader>;
    write: (offset?: bigint) => ERef<PassableBytesWriter>;
    truncate: (size: bigint) => Promise<void>;
    fsync: () => Promise<void>;
    lock: (opts: LockOpts) => ERef<Lock>;
    getLock: (opts: LockQuery) => Promise<LockState | null>;
    close: () => Promise<void>;
    help: (method?: string) => string;
};
type OpenFileOptions = {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
};
type PassableBytesReader<TReadReturn = undefined> = {
    streamBase64: (synPromise: ERef<StreamNode<unknown, TReadReturn>>) => Promise<StreamNode<string, TReadReturn>>;
    readReturnPattern: () => unknown | undefined;
};
type PassableBytesWriter<TWriteReturn = undefined> = {
    streamBase64: (synPromise: ERef<StreamNode<string, TWriteReturn>>) => Promise<StreamNode<undefined, TWriteReturn>>;
    writeReturnPattern: () => unknown | undefined;
};
type PassableReader<TRead = unknown, TReadReturn = unknown> = {
    stream: (synPromise: ERef<StreamNode<undefined, TReadReturn>>) => Promise<StreamNode<TRead, TReadReturn>>;
    readPattern: () => unknown | undefined;
    readReturnPattern: () => unknown | undefined;
};
type Qid<K = NodeKind> = {
    type: K;
    pathId: bigint;
    version: bigint;
};
type StreamNode<Y = undefined, R = undefined> = StreamYieldNode<Y, R> | StreamReturnNode<R>;
type StreamReturnNode<R = undefined> = {
    value: R;
    promise: null;
};
type StreamYieldNode<Y = unknown, R = undefined> = {
    value: Y;
    promise: Promise<StreamNode<Y, R>>;
};
type WatchEvent = {
    kind: 'changed' | 'created' | 'removed' | 'child-added' | 'child-removed';
    name?: string;
};
type WatchFromResult = {
    cursor: Cursor;
    watcher: NodeWatcher;
};
type XattrSetOptions = {
    existence?: 'create' | 'replace';
};
type Xattrs = {
    get: (name: string) => ERef<PassableBytesReader>;
    set: (name: string, opts?: XattrSetOptions) => ERef<PassableBytesWriter>;
    list: () => ERef<PassableReader<string>>;
    remove: (name: string) => Promise<void>;
    help: (method?: string) => string;
};`,
    body: `Filesystem`,
  },
});
harden(fsDeclarations);
