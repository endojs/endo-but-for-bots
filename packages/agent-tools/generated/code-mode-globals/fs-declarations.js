// @ts-check
/// <reference types="ses"/>

/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate with: yarn workspace @endo/agent-tools gen:code-mode-types
 *
 * Source of truth:
 *   - workspace: the platform/fs/extended interface guards
 *     (`FilesystemInterface` and the remotables it reaches), the richest
 *     available source since the FS `.d.ts` is a stub.
 *   - daemonMount / daemonMountReadOnly: the focused code-mode contract
 *     derived from `packages/daemon/src/types.d.ts`, with runtime method
 *     names pinned to the daemon mount interfaces.
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
  brands: () => Promise<unknown>;
  help: (arg0?: string) => string;
  named: (arg0: string) => ERef<Directory>;
  root: () => ERef<Directory>;
  statfs: () => Promise<unknown>;
};
type ERef<T> = T | Promise<T>;
type Cursor = {
  close: () => Promise<unknown>;
  help: (arg0?: string) => string;
  read: (arg0?: bigint) => Promise<unknown>;
  rewind: () => Promise<unknown>;
  skip: (arg0: bigint) => Promise<unknown>;
  stream: () => ERef<PassableReader>;
  toArray: () => Promise<unknown>;
};
type Directory = {
  copy: (arg0: string | Array<string>, arg1: string | Array<string>) => Promise<unknown>;
  create: (arg0: string, arg1: unknown) => ERef<OpenFile>;
  fsync: () => Promise<unknown>;
  getAttrs: () => Promise<unknown>;
  getQid: () => unknown;
  getStat: () => Promise<unknown>;
  help: (arg0?: string) => string;
  list: () => ERef<Cursor>;
  lookup: (arg0: string | Array<string>) => ERef<Directory | File>;
  lookupStep: (arg0: string) => ERef<Directory | File>;
  makeDirectory: (arg0: string, arg1: unknown) => ERef<Directory>;
  materialise: (arg0: Array<string>, arg1: unknown) => ERef<Directory>;
  mkdir: (arg0: string, arg1: unknown) => ERef<Directory>;
  move: (arg0: string | Array<string>, arg1: string | Array<string>) => Promise<unknown>;
  remove: (arg0: string) => Promise<unknown>;
  rename: (arg0: string, arg1: Directory, arg2: string) => undefined;
  setAttrs: (arg0: unknown) => Promise<unknown>;
  setStat: (arg0: unknown) => Promise<unknown>;
  subView: (arg0: string | Array<string>) => ERef<Directory>;
  unlink: (arg0: string) => Promise<unknown>;
  watch: () => ERef<NodeWatcher>;
  watchFrom: () => ERef<unknown>;
  write: (arg0: string, arg1: string) => Promise<unknown>;
  xattrs: () => ERef<Xattrs>;
};
type File = {
  getAttrs: () => Promise<unknown>;
  getQid: () => unknown;
  getStat: () => Promise<unknown>;
  help: (arg0?: string) => string;
  open: (arg0: unknown) => ERef<OpenFile>;
  setAttrs: (arg0: unknown) => Promise<unknown>;
  setStat: (arg0: unknown) => Promise<unknown>;
  snapshot: () => Promise<unknown>;
  watch: () => ERef<NodeWatcher>;
  xattrs: () => ERef<Xattrs>;
};
type Lock = {
  help: (arg0?: string) => string;
  release: () => Promise<unknown>;
};
type NodeWatcher = {
  cancel: () => Promise<unknown>;
  events: () => ERef<PassableReader>;
};
type OpenFile = {
  close: () => Promise<unknown>;
  fsync: (arg0: unknown) => Promise<unknown>;
  getLock: (arg0: unknown) => Promise<unknown>;
  help: (arg0?: string) => string;
  lock: (arg0: unknown) => ERef<Lock>;
  read: (arg0?: bigint, arg1?: bigint) => unknown;
  truncate: (arg0: bigint) => Promise<unknown>;
  write: (arg0?: bigint) => unknown;
};
type PassableBytesReader = {
  readReturnPattern: () => undefined | unknown;
  streamBase64: (arg0: unknown) => Promise<unknown>;
};
type PassableBytesWriter = {
  streamBase64: (arg0: unknown) => Promise<unknown>;
  writeReturnPattern: () => undefined | unknown;
};
type PassableReader = {
  readPattern: () => undefined | unknown;
  readReturnPattern: () => undefined | unknown;
  stream: (arg0: unknown) => Promise<unknown>;
};
type Xattrs = {
  get: (arg0: string) => ERef<PassableBytesReader>;
  help: (arg0?: string) => string;
  list: () => ERef<PassableReader>;
  remove: (arg0: string) => Promise<unknown>;
  set: (arg0: string, arg1: unknown) => ERef<PassableBytesWriter>;
};`,
    body: `Filesystem`,
  },
  daemonMount: {
    aux: `type DaemonMount = {
  entry: (path: string | string[]) => MountDaemonMountEntry;
  has: {
    (...pathSegments: string[]): Promise<boolean>;
    (entry: MountDaemonMountEntry): Promise<boolean>;
};
  list: (...pathSegments: string[]) => Promise<string[]>;
  glob: (pattern: string) => Promise<string[]>;
  grep: (pattern: string, paths?: string[] | Promise<string[]>, options?: {
    maxResults?: number;
}) => Promise<MountDaemonGrepMatch[]>;
  glorp: (globPattern: string, grepPattern: string, options?: {
    maxResults?: number;
}) => Promise<MountDaemonGrepMatch[]>;
  lookup: (path: MountDaemonPath) => Promise<DaemonMount | MountDaemonMountFile>;
  maybeLookup: (path: MountDaemonPath) => Promise<DaemonMount | MountDaemonMountFile | undefined>;
  followNameChanges: (...pathSegments: string[]) => MountDaemonPassableReader;
  subView: (path: MountDaemonPath) => Promise<DaemonMount>;
  write: (path: MountDaemonPath, value: MountDaemonDirectoryWriteSource) => Promise<void>;
  copy: (from: MountDaemonPath, to: MountDaemonPath) => Promise<void>;
  stat: (path: MountDaemonPath) => Promise<MountDaemonMountStat | undefined>;
  readText: (path: MountDaemonPath) => Promise<string>;
  maybeReadText: (path: MountDaemonPath) => Promise<string | undefined>;
  writeText: (path: MountDaemonPath, content: string) => Promise<void>;
  makeDirectory: (path: MountDaemonPath) => Promise<DaemonMount>;
  makeFile: (path: MountDaemonPath, content?: string) => Promise<void>;
  remove: (path: MountDaemonPath) => Promise<void>;
  move: (from: MountDaemonPath, to: MountDaemonPath) => Promise<void>;
  readOnly: () => MountDaemonReadableTree;
  snapshot: () => Promise<MountDaemonSnapshotTree>;
  help: (method?: string) => string;
};
type MountDaemonBlobInfo = {
    algorithm: string;
    hash: string;
    size: bigint;
};
type MountDaemonDirectoryWriteSource = MountDaemonReadableBlob | MountDaemonReadableTree;
type MountDaemonGrepMatch = {
    file: string;
    line: number;
    text: string;
};
type MountDaemonMountEntry = {
    segments: () => string[];
    displayPath: () => string;
    child: (name: string) => MountDaemonMountEntry;
    help: (method?: string) => string;
};
type MountDaemonMountFile = {
    streamBase64: (synPromise: unknown) => Promise<unknown>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    getInfo: () => Promise<MountDaemonBlobInfo>;
    fetch: (offset: bigint, length: bigint) => Promise<MountDaemonPassableBytesReader>;
    writeText: (content: string) => Promise<void>;
    append: (content: string) => Promise<void>;
    writeBytes: (readableRef: MountDaemonPassableBytesReader) => Promise<void>;
    stat: () => Promise<MountDaemonMountStat>;
    snapshot: () => Promise<MountDaemonSnapshotTree>;
    readOnly: () => MountDaemonReadableBlob;
    help: (method?: string) => string;
};
type MountDaemonMountStat = {
    kind: 'file' | 'directory' | 'symlink';
    size: bigint;
    mtime: bigint;
    atime: bigint;
};
type MountDaemonPassableBytesReader = {
    streamBase64: (synPromise: unknown) => Promise<unknown>;
    readReturnPattern: () => unknown | undefined;
};
type MountDaemonPassableReader = {
    stream: (synPromise: unknown) => Promise<unknown>;
    readPattern: () => unknown | undefined;
    readReturnPattern: () => unknown | undefined;
};
type MountDaemonPath = string | readonly string[] | MountDaemonMountEntry;
type MountDaemonReadableBlob = {
    streamBase64: (synPromise: unknown) => Promise<unknown>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    getInfo: () => Promise<MountDaemonBlobInfo>;
    fetch: (offset: bigint, length: bigint) => Promise<MountDaemonPassableBytesReader>;
    help: (method?: string) => string;
};
type MountDaemonReadableTree = {
    has: (...pathSegments: string[]) => Promise<boolean>;
    list: (...pathSegments: string[]) => Promise<readonly string[]>;
    listTree: (petNamePath: string | readonly string[], options?: {
        ignore?: readonly string[];
    }) => Promise<MountDaemonTreeEntry[]>;
    lookup: (path: string | readonly string[]) => Promise<MountDaemonReadableTree | MountDaemonReadableBlob>;
    help: (method?: string) => string;
};
type MountDaemonSnapshotTree = MountDaemonReadableTree & {
    sha256: () => string;
    getInfo: () => Promise<MountDaemonBlobInfo>;
};
type MountDaemonTreeEntry = {
    path: string[];
    type: 'file' | 'directory';
};`,
    body: `DaemonMount`,
  },
  daemonMountReadOnly: {
    aux: `type DaemonMountReadOnly = {
  has: (...pathSegments: string[]) => Promise<boolean>;
  list: (...pathSegments: string[]) => Promise<readonly string[]>;
  listTree: (petNamePath: string | readonly string[], options?: {
    ignore?: readonly string[];
}) => Promise<ReadOnlyMountDaemonTreeEntry[]>;
  lookup: (path: string | readonly string[]) => Promise<ReadOnlyMountDaemonReadableTree | ReadOnlyMountDaemonReadableBlob>;
  help: (method?: string) => string;
};
type ReadOnlyMountDaemonBlobInfo = {
    algorithm: string;
    hash: string;
    size: bigint;
};
type ReadOnlyMountDaemonPassableBytesReader = {
    streamBase64: (synPromise: unknown) => Promise<unknown>;
    readReturnPattern: () => unknown | undefined;
};
type ReadOnlyMountDaemonReadableBlob = {
    streamBase64: (synPromise: unknown) => Promise<unknown>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    getInfo: () => Promise<ReadOnlyMountDaemonBlobInfo>;
    fetch: (offset: bigint, length: bigint) => Promise<ReadOnlyMountDaemonPassableBytesReader>;
    help: (method?: string) => string;
};
type ReadOnlyMountDaemonReadableTree = {
    has: (...pathSegments: string[]) => Promise<boolean>;
    list: (...pathSegments: string[]) => Promise<readonly string[]>;
    listTree: (petNamePath: string | readonly string[], options?: {
        ignore?: readonly string[];
    }) => Promise<ReadOnlyMountDaemonTreeEntry[]>;
    lookup: (path: string | readonly string[]) => Promise<ReadOnlyMountDaemonReadableTree | ReadOnlyMountDaemonReadableBlob>;
    help: (method?: string) => string;
};
type ReadOnlyMountDaemonTreeEntry = {
    path: string[];
    type: 'file' | 'directory';
};`,
    body: `DaemonMountReadOnly`,
  },
});
harden(fsDeclarations);
