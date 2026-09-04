// @ts-check
/// <reference types="ses"/>

/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate with: yarn workspace @endo/agent-tools gen:code-mode-types
 *
 * Source of truth:
 *   - workspace: packages/daemon/src/types.d.ts (the `EndoMount` interface),
 *     reached through the re-export in
 *     packages/agent-tools/src/code-mode-globals/daemon-mount-types.ts and
 *     printed by the TypeScript compiler API.
 *   - filesystem: packages/platform/src/fs/extended/types.ts (the local
 *     `Filesystem` type alias and the capability types it reaches), printed
 *     by the TypeScript compiler API.
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
  filesystem: {
    aux: `type ERef<T> = T | Promise<T>;
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
type PassableBytesReader<TReadReturn = undefined> = {
    stream: (synPromise: ERef<StreamNode<unknown, TReadReturn>>) => Promise<StreamNode<Uint8Array, TReadReturn>>;
    readReturnPattern: () => unknown | undefined;
};
type DirectoryPage = {
    entries: DirectoryEntry[];
    atEnd: boolean;
};
type PassableReader<TRead = unknown, TReadReturn = unknown> = {
    stream: (synPromise: ERef<StreamNode<undefined, TReadReturn>>) => Promise<StreamNode<TRead, TReadReturn>>;
    readPattern: () => unknown | undefined;
    readReturnPattern: () => unknown | undefined;
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
type Qid<K = NodeKind> = {
    type: K;
    pathId: bigint;
    version: bigint;
};
type NodeStat = {
    size?: bigint;
    mtime?: bigint;
    atime?: bigint;
};
type NodeAttrs = NodeStat & {
    ctime?: bigint;
    btime?: bigint | null;
};
type NodeWatcher = {
    events: () => ERef<PassableReader<{
        kind: 'changed' | 'created' | 'removed' | 'child-added' | 'child-removed';
        name?: string;
    }>>;
    cancel: () => Promise<void>;
};
type Xattrs = {
    get: (name: string) => ERef<PassableBytesReader>;
    set: (name: string, opts?: {
        existence?: 'create' | 'replace';
    }) => ERef<PassableBytesWriter>;
    list: () => ERef<PassableReader<string>>;
    remove: (name: string) => Promise<void>;
    help: (method?: string) => string;
};
type File = {
    getQid: () => Qid<'file'>;
    getStat: () => Promise<NodeStat>;
    setStat: (patch: NodeStat) => Promise<void>;
    getAttrs: () => Promise<NodeAttrs>;
    setAttrs: (patch: NodeStat) => Promise<void>;
    watch: () => ERef<NodeWatcher>;
    xattrs: () => ERef<Xattrs>;
    open: (opts?: OpenFileOptions) => ERef<OpenFile>;
    read: (opts?: {
        offset?: bigint;
        length?: bigint;
    }) => ERef<PassableBytesReader>;
    write: (opts?: {
        offset?: bigint;
    }) => ERef<PassableBytesWriter>;
    snapshot: () => Promise<BlobRef>;
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
type OpenFileOptions = {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
};
type OpenFile = {
    read: (offset?: bigint, length?: bigint) => ERef<PassableBytesReader>;
    write: (offset?: bigint) => ERef<PassableBytesWriter>;
    truncate: (size: bigint) => Promise<void>;
    fsync: () => Promise<void>;
    lock: (opts: LockOpts) => ERef<Lock>;
    getLock: (opts: {
        start?: bigint;
        length?: bigint;
    }) => Promise<LockState | null>;
    close: () => Promise<void>;
    help: (method?: string) => string;
};
type WatchFromResult = {
    cursor: Cursor;
    watcher: NodeWatcher;
};
type PassableBytesWriter<TWriteReturn = undefined> = {
    stream: (synPromise: ERef<StreamNode<Uint8Array, TWriteReturn>>) => Promise<StreamNode<undefined, TWriteReturn>>;
    writeReturnPattern: () => unknown | undefined;
};
type BlobRef = {
    getInfo: () => {
        algorithm: string;
        hash: string;
        size: bigint;
    };
    fetch: (offset: bigint, length: bigint) => ERef<PassableBytesReader>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    help: (method?: string) => string;
};
type LockType = 'shared' | 'exclusive';
type LockOpts = {
    type: LockType;
    start?: bigint;
    length?: bigint;
};
type Lock = {
    release: () => Promise<void>;
    help: (method?: string) => string;
};
type LockState = {
    type: LockType;
    start: bigint;
    length: bigint;
};
type StreamNode<Y = undefined, R = undefined> = StreamYieldNode<Y, R> | {
    value: R;
    promise: null;
};
type NodeKind = 'file' | 'directory';
type StreamYieldNode<Y = unknown, R = undefined> = {
    value: Y;
    promise: Promise<StreamNode<Y, R>>;
};`,
    body: `{
    brands: () => Promise<ReadonlySet<bigint> | readonly bigint[]>;
    help: (method?: string) => string;
    named: (name: string) => ERef<Directory>;
    root: () => ERef<Directory>;
    statfs: () => Promise<FilesystemStats>;
}`,
  },
  workspace: {
    aux: `type MountEndoMountEntry = MountPathEntry;
type MountPassableReader<TRead = unknown, TReadReturn = unknown> = {
    stream: (synPromise: MountERef<MountStreamNode<undefined, TReadReturn>>) => Promise<MountStreamNode<TRead, TReadReturn>>;
    readPattern: () => unknown | undefined;
    readReturnPattern: () => unknown | undefined;
};
type MountNameChange = {
    add: string;
    type: 'file' | 'directory';
} | {
    remove: string;
};
type MountGrepMatch = {
    file: string;
    line: number;
    text: string;
};
type MountEndoMountFile = {
    kind: () => 'file';
    list: () => Promise<never>;
    text: () => Promise<string>;
    stream: (synPromise: MountERef<MountStreamNode<unknown, unknown>>) => Promise<MountStreamNode<Uint8Array, undefined>>;
    json: () => Promise<unknown>;
    getInfo: () => Promise<MountBlobInfo>;
    fetch: (offset: bigint, length: bigint) => Promise<MountPassableBytesReader>;
    writeText: (content: string) => Promise<void>;
    append: (content: string) => Promise<void>;
    writeBytes: (readableRef: MountERef<MountPassableBytesReader>) => Promise<void>;
    stat: () => Promise<MountEndoMountStat>;
    snapshot: () => Promise<unknown>;
    readOnly: () => MountReadableBlobView;
    help: (method?: string) => string;
};
type MountReadableTreeView = {
    has: (...pathSegments: string[]) => Promise<boolean>;
    list: (...pathSegments: string[]) => Promise<readonly string[]>;
    listTree: (petNamePath: string | readonly string[], options?: {
        ignore?: readonly string[];
    }) => Promise<MountTreeEntry[]>;
    lookup: (path: string | readonly string[]) => Promise<MountReadableTreeView | MountReadableBlobView>;
    help: (method?: string) => string;
};
type MountSnapshotTree = MountReadableTree & {
    sha256: () => string;
    getInfo: () => Promise<{
        algorithm: string;
        hash: string;
        size: bigint;
    }>;
};
type MountEndoMountStat = {
    kind: 'file' | 'directory' | 'symlink';
    size: bigint;
    mtime: bigint;
    atime: bigint;
};
type MountDirectoryWriteSource = MountReadableBlobSource | MountReadableTree;
type MountReadableBlobSource = {
    stream: (...args: any[]) => PromiseLike<unknown>;
};
type MountReadableTree = {
    has: (...petNamePath: string[]) => Promise<boolean>;
    list: (...petNamePath: string[]) => Promise<readonly string[]>;
    lookup: (petNamePath: string | readonly string[]) => Promise<unknown>;
    listTree?: (petNamePath: string | readonly string[], options?: {
        ignore?: readonly string[];
    }) => Promise<MountTreeEntry[]>;
};
type MountPathEntry = {
    segments: () => string[];
    displayPath: () => string;
    child: (name: string) => MountPathEntry;
    help: (method?: string) => string;
};
type MountERef<T> = T | Promise<T>;
type MountStreamNode<Y = undefined, R = undefined> = MountStreamYieldNode<Y, R> | {
    value: R;
    promise: null;
};
type MountBlobInfo = {
    algorithm: string;
    hash: string;
    size: bigint;
};
type MountPassableBytesReader<TReadReturn = undefined> = {
    stream: (synPromise: MountERef<MountStreamNode<unknown, TReadReturn>>) => Promise<MountStreamNode<Uint8Array, TReadReturn>>;
    readReturnPattern: () => unknown | undefined;
};
type MountReadableBlobView = {
    stream: (synPromise: MountERef<MountStreamNode<unknown, unknown>>) => Promise<MountStreamNode<Uint8Array, undefined>>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    getInfo: () => Promise<MountBlobInfo>;
    fetch: (offset: bigint, length: bigint) => Promise<MountPassableBytesReader>;
    help: (method?: string) => string;
};
type MountTreeEntry = {
    path: string[];
    type: 'file' | 'directory';
};
type MountStreamYieldNode<Y = unknown, R = undefined> = {
    value: Y;
    promise: Promise<MountStreamNode<Y, R>>;
};`,
    body: `{
    copy: (from: string | string[] | MountEndoMountEntry, to: string | string[] | MountEndoMountEntry) => Promise<void>;
    entry: (path: string | string[]) => MountEndoMountEntry;
    followNameChanges: (...pathSegments: string[]) => MountPassableReader<MountNameChange, undefined>;
    glob: (pattern: string) => Promise<string[]>;
    glorp: (globPattern: string, grepPattern: string, options?: {
        maxResults?: number;
    }) => Promise<Array<MountGrepMatch>>;
    grep: (pattern: string, paths?: string[] | Promise<string[]>, options?: {
        maxResults?: number;
    }) => Promise<Array<MountGrepMatch>>;
    has: {
        (...pathSegments: string[]): Promise<boolean>;
        (entry: MountEndoMountEntry): Promise<boolean>;
    };
    help: (method?: string) => string;
    kind: () => 'directory';
    list: (...pathSegments: string[]) => Promise<string[]>;
    lookup: (path: string | readonly string[] | MountEndoMountEntry) => Promise<typeof workspace | MountEndoMountFile>;
    makeDirectory: (path: string | string[] | MountEndoMountEntry) => Promise<typeof workspace>;
    makeFile: (path: string | string[] | MountEndoMountEntry, content?: string) => Promise<void>;
    maybeLookup: (path: string | string[] | MountEndoMountEntry) => Promise<typeof workspace | MountEndoMountFile | undefined>;
    maybeReadText: (path: string | string[] | MountEndoMountEntry) => Promise<string | undefined>;
    move: (from: string | string[] | MountEndoMountEntry, to: string | string[] | MountEndoMountEntry) => Promise<void>;
    readOnly: () => MountReadableTreeView;
    readText: (path: string | string[] | MountEndoMountEntry) => Promise<string>;
    remove: (path: string | string[] | MountEndoMountEntry) => Promise<void>;
    snapshot: () => Promise<MountSnapshotTree>;
    stat: (path: string | string[] | MountEndoMountEntry) => Promise<MountEndoMountStat | undefined>;
    subView: (path: string | string[] | MountEndoMountEntry) => Promise<typeof workspace>;
    write: (path: string | string[] | MountEndoMountEntry, value: MountDirectoryWriteSource) => Promise<void>;
    writeText: (path: string | string[] | MountEndoMountEntry, content: string) => Promise<void>;
}`,
  },
});
harden(fsDeclarations);
