// @ts-check
/// <reference types="ses"/>

/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate with: yarn workspace @endo/agent-tools gen:code-mode-types
 *
 * Source of truth:
 *   - git / gitHistory / gitReadOnly: packages/exo-git/src/types.ts (the
 *     `ReadWriteEndoGit`, `HistoryRewriteEndoGit`, and `ReadOnlyEndoGit`
 *     type alias), printed by the typescript compiler API
 *     (TypeScript-canonical).
 *
 * The generic extraction and rendering live in
 * scripts/code-mode-type-extract.js; this exo's source configuration lives in
 * its scripts/code-mode-*-extract.js extractor. The divergence gate in
 * test/code-mode-types.test.js keeps this artifact fresh.
 *
 * Each entry is consumed by formatGlobalDeclarations in code-mode/declarations.js via
 * the per-exo descriptor in code-mode-globals/git.js:
 * `aux` is the supporting `type` aliases, `body` is the object type spliced
 * after the dynamic `declare const <name>:`.
 */

export const gitDeclarations = harden({
  git: {
    aux: `type WritableEndoGit = {
  add: (designators: GitPathDesignator[]) => Promise<void>;
  branches: () => Promise<GitRef[]>;
  checkoutConflict: (designators: GitPathDesignator[], side: GitConflictSide) => Promise<void>;
  commit: (message: string) => Promise<GitCommit>;
  createBranch: (name: string, options?: GitCreateBranchOptions) => Promise<GitRef>;
  currentBranch: () => Promise<GitRef | undefined>;
  deleteBranch: (name: string, options?: GitDeleteBranchOptions) => Promise<void>;
  detach: (ref: GitRef | string) => Promise<void>;
  diff: (options?: GitDiffOptions) => Promise<string>;
  filesystemAt: (ref: GitRef | string) => Promise<GitFilesystem>;
  log: (options?: GitLogOptions) => Promise<GitCommit[]>;
  merge: (ref: GitRef | string, options?: GitMergeOptions) => Promise<string>;
  readOnly: () => GitReadOnlyEndoGit;
  renameBranch: (from: string, to: string) => Promise<void>;
  restore: (designators: GitPathDesignator[], options?: GitRestoreOptions) => Promise<void>;
  revParse: (ref: GitRef | string) => Promise<GitRef>;
  scope: (name: 'reader' | 'writer') => GitReadOnlyEndoGit | WritableEndoGit;
  show: (ref: GitRef | string) => Promise<string>;
  stashApply: (index?: number) => Promise<void>;
  stashDrop: (index?: number) => Promise<void>;
  stashList: () => Promise<string[]>;
  stashPop: (index?: number) => Promise<void>;
  stashPush: (options?: GitStashPushOptions) => Promise<string>;
  stashShow: (index?: number) => Promise<string>;
  status: (options?: GitStatusOptions) => Promise<GitStatusResult>;
  switch: (ref: GitRef | string) => Promise<void>;
  switchBranch: (name: string) => Promise<void>;
  trackingStatus: () => Promise<GitTrackingStatus>;
  tree: (ref: GitRef | string) => Promise<GitReadableTree>;
  worktree: () => Promise<GitWritableGitWorktree>;
};
type GitBlobInfo = {
    algorithm: string;
    hash: string;
    size: bigint;
};
type GitBlobRef = {
    getInfo: () => GitExtendedBlobInfo;
    fetch: (offset: bigint, length: bigint) => GitERef<GitPassableBytesReader>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    help: (method?: string) => string;
};
type GitCursor = {
    read: (limit?: bigint) => Promise<GitDirectoryPage>;
    stream: () => GitERef<GitPassableReader<GitDirectoryEntry>>;
    toArray: () => Promise<GitDirectoryEntry[]>;
    skip: (n: bigint) => Promise<void>;
    rewind: () => Promise<void>;
    close: () => Promise<void>;
    help: (method?: string) => string;
};
type GitDirectory = GitLiteDirectory;
type GitDirectoryEntry = {
    name: string;
    kind: 'file';
    qid: GitQid<'file'>;
} | {
    name: string;
    kind: 'directory';
    qid: GitQid<'directory'>;
};
type GitDirectoryPage = {
    entries: GitDirectoryEntry[];
    atEnd: boolean;
};
type GitDirectoryWriteSource = GitReadableBlobSource | GitLiteReadableTree;
type GitERef<T> = T | Promise<T>;
type GitExtendedBlobInfo = {
    algorithm: string;
    hash: string;
    size: bigint;
};
type GitExtendedDirectory = {
    getQid: () => GitQid<'directory'>;
    getStat: () => Promise<GitNodeStat>;
    setStat: (patch: GitNodeStat) => Promise<void>;
    getAttrs: () => Promise<GitNodeAttrs>;
    setAttrs: (patch: GitNodeStat) => Promise<void>;
    watch: () => GitERef<GitNodeWatcher>;
    xattrs: () => GitERef<GitXattrs>;
    lookup: (nameOrPath: string | readonly string[]) => GitERef<GitExtendedDirectory | GitExtendedFile>;
    lookupStep: (name: string) => GitERef<GitExtendedDirectory | GitExtendedFile>;
    subView: (nameOrPath: string | readonly string[]) => GitERef<GitExtendedDirectory>;
    list: () => GitERef<GitCursor>;
    write: (name: string, value: string) => Promise<void>;
    create: (name: string, opts?: GitOpenFileOptions) => GitERef<GitOpenFile>;
    makeDirectory: (name: string) => GitERef<GitExtendedDirectory>;
    mkdir: (name: string) => GitERef<GitExtendedDirectory>;
    remove: (name: string) => Promise<void>;
    unlink: (name: string) => Promise<void>;
    move: (fromPath: string | readonly string[], toPath: string | readonly string[]) => Promise<void>;
    copy: (fromPath: string | readonly string[], toPath: string | readonly string[]) => Promise<void>;
    rename: (oldName: string, newParent: GitERef<GitExtendedDirectory>, newName: string) => Promise<void>;
    fsync: () => Promise<void>;
    materialise: (path: readonly string[]) => GitERef<GitExtendedDirectory>;
    watchFrom: () => GitERef<GitWatchFromResult>;
    help: (method?: string) => string;
};
type GitExtendedFile = {
    getQid: () => GitQid<'file'>;
    getStat: () => Promise<GitNodeStat>;
    setStat: (patch: GitNodeStat) => Promise<void>;
    getAttrs: () => Promise<GitNodeAttrs>;
    setAttrs: (patch: GitNodeStat) => Promise<void>;
    watch: () => GitERef<GitNodeWatcher>;
    xattrs: () => GitERef<GitXattrs>;
    open: (opts?: GitOpenFileOptions) => GitERef<GitOpenFile>;
    read: (opts?: GitFileReadOptions) => GitERef<GitPassableBytesReader>;
    write: (opts?: GitFileWriteOptions) => GitERef<GitPassableBytesWriter>;
    snapshot: () => Promise<GitBlobRef>;
    help: (method?: string) => string;
};
type GitExtendedFilesystem = {
    root: () => GitERef<GitExtendedDirectory>;
    named: (name: string) => GitERef<GitExtendedDirectory>;
    statfs: () => Promise<GitFilesystemStats>;
    brands: () => Promise<ReadonlySet<bigint> | readonly bigint[]>;
    help: (method?: string) => string;
};
type GitFileReadOptions = {
    offset?: bigint;
    length?: bigint;
};
type GitFileWriteOptions = {
    offset?: bigint;
};
type GitFilesystem = GitExtendedFilesystem;
type GitFilesystemStats = {
    blockSize?: bigint;
    totalBlocks?: bigint;
    freeBlocks?: bigint;
    totalBytes?: bigint;
    freeBytes?: bigint;
    files?: bigint;
    directories?: bigint;
    type?: string;
};
type GitCommit = {
    oid: string;
    summary: string;
    author?: string;
    committedAt?: number;
};
type GitConflictSide = 'ours' | 'theirs';
type GitCreateBranchOptions = {
    startPoint?: string;
    switchAfterCreate?: boolean;
};
type GitDeleteBranchOptions = {
    force?: boolean;
};
type GitDiffOptions = {
    cached?: boolean;
    base?: GitRef | string;
    head?: GitRef | string;
    entries?: GitPathEntry[];
    paths?: string[];
};
type GitIndexStatus = 'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted';
type GitLogOptions = {
    maxCount?: number;
    ref?: GitRef | string;
    since?: string;
    until?: string;
};
type GitMergeOptions = {
    fastForwardOnly?: boolean;
    noFastForward?: boolean;
};
type GitPathDesignator = GitPathEntry | string;
type GitRef = {
    name: string;
    kind: 'branch' | 'tag' | 'commit' | 'detached';
    oid?: string;
};
type GitRestoreOptions = {
    staged?: boolean;
};
type GitStashPushOptions = {
    message?: string;
    entries?: GitPathEntry[];
    paths?: string[];
    includeUntracked?: boolean;
};
type GitStatusEntry = {
    path: string;
    index: GitIndexStatus;
    worktree: GitWorktreeStatus;
    renamedFrom?: string;
};
type GitStatusOptions = {
    untracked?: 'all' | 'normal' | 'no';
    maxCount?: number;
};
type GitStatusResult = {
    entries: GitStatusEntry[];
    truncated: boolean;
};
type GitTrackingStatus = {
    branch?: string;
    upstream?: string;
    ahead: number;
    behind: number;
    detached: boolean;
};
type GitWorktreeStatus = 'clean' | 'modified' | 'deleted' | 'untracked' | 'ignored' | 'conflicted';
type GitLiteDirectory = {
    has: (...path: string[]) => Promise<boolean>;
    list: (...path: string[]) => Promise<string[]>;
    lookup: (path: string | string[]) => Promise<unknown>;
    write: (path: string[], value: GitDirectoryWriteSource) => Promise<void>;
    remove: (path: string[]) => Promise<void>;
    move: (from: string[], to: string[]) => Promise<void>;
    copy: (from: string[], to: string[]) => Promise<void>;
    makeDirectory: (path: string[]) => Promise<GitLiteDirectory>;
    readOnly: () => GitLiteReadableTree;
    snapshot: () => Promise<GitSnapshotTree>;
};
type GitLitePathEntry = {
    segments: () => string[];
    displayPath: () => string;
    child: (name: string) => GitLitePathEntry;
    help: (method?: string) => string;
};
type GitLitePathEntryIssuer = {
    entry: (path: string | string[]) => GitLitePathEntry;
};
type GitLiteReadableTree = {
    has: (...petNamePath: string[]) => Promise<boolean>;
    list: (...petNamePath: string[]) => Promise<readonly string[]>;
    lookup: (petNamePath: string | readonly string[]) => Promise<unknown>;
    listTree?: (petNamePath: string | readonly string[], options?: {
        ignore?: readonly string[];
    }) => Promise<GitTreeEntry[]>;
};
type GitLock = {
    release: () => Promise<void>;
    help: (method?: string) => string;
};
type GitLockOpts = {
    type: GitLockType;
    start?: bigint;
    length?: bigint;
};
type GitLockQuery = {
    start?: bigint;
    length?: bigint;
};
type GitLockState = {
    type: GitLockType;
    start: bigint;
    length: bigint;
};
type GitLockType = 'shared' | 'exclusive';
type GitNodeAttrs = GitNodeStat & {
    ctime?: bigint;
    btime?: bigint | null;
};
type GitNodeKind = 'file' | 'directory';
type GitNodeStat = {
    size?: bigint;
    mtime?: bigint;
    atime?: bigint;
};
type GitNodeWatcher = {
    events: () => GitERef<GitPassableReader<GitWatchEvent>>;
    cancel: () => Promise<void>;
};
type GitOpenFile = {
    read: (offset?: bigint, length?: bigint) => GitERef<GitPassableBytesReader>;
    write: (offset?: bigint) => GitERef<GitPassableBytesWriter>;
    truncate: (size: bigint) => Promise<void>;
    fsync: () => Promise<void>;
    lock: (opts: GitLockOpts) => GitERef<GitLock>;
    getLock: (opts: GitLockQuery) => Promise<GitLockState | null>;
    close: () => Promise<void>;
    help: (method?: string) => string;
};
type GitOpenFileOptions = {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
};
type GitPassableBytesReader<TReadReturn = undefined> = {
    streamBase64: (synPromise: GitERef<GitStreamNode<unknown, TReadReturn>>) => Promise<GitStreamNode<string, TReadReturn>>;
    readReturnPattern: () => unknown | undefined;
};
type GitPassableBytesWriter<TWriteReturn = undefined> = {
    streamBase64: (synPromise: GitERef<GitStreamNode<string, TWriteReturn>>) => Promise<GitStreamNode<undefined, TWriteReturn>>;
    writeReturnPattern: () => unknown | undefined;
};
type GitPassableReader<TRead = unknown, TReadReturn = unknown> = {
    stream: (synPromise: GitERef<GitStreamNode<undefined, TReadReturn>>) => Promise<GitStreamNode<TRead, TReadReturn>>;
    readPattern: () => unknown | undefined;
    readReturnPattern: () => unknown | undefined;
};
type GitPathEntry = GitLitePathEntry;
type GitPathEntryIssuer = GitLitePathEntryIssuer;
type GitQid<K = GitNodeKind> = {
    type: K;
    pathId: bigint;
    version: bigint;
};
type GitReadOnlyEndoGit = {
    worktree: () => Promise<GitReadOnlyGitWorktree>;
    status: (options?: GitStatusOptions) => Promise<GitStatusResult>;
    trackingStatus: () => Promise<GitTrackingStatus>;
    diff: (options?: GitDiffOptions) => Promise<string>;
    log: (options?: GitLogOptions) => Promise<GitCommit[]>;
    show: (ref: GitRef | string) => Promise<string>;
    revParse: (ref: GitRef | string) => Promise<GitRef>;
    currentBranch: () => Promise<GitRef | undefined>;
    branches: () => Promise<GitRef[]>;
    stashList: () => Promise<string[]>;
    stashShow: (index?: number) => Promise<string>;
    tree: (ref: GitRef | string) => Promise<GitReadableTree>;
    filesystemAt: (ref: GitRef | string) => Promise<GitFilesystem>;
    readOnly: () => GitReadOnlyEndoGit;
    scope: (name: 'reader') => GitReadOnlyEndoGit;
};
type GitReadOnlyGitWorktree = GitReadableTree;
type GitReadableBlobSource = {
    streamBase64: (...args: any[]) => PromiseLike<unknown>;
};
type GitReadableTree = GitLiteReadableTree;
type GitSnapshotTree = GitLiteReadableTree & {
    sha256: () => string;
    getInfo: () => Promise<GitBlobInfo>;
};
type GitStreamNode<Y = undefined, R = undefined> = GitStreamYieldNode<Y, R> | GitStreamReturnNode<R>;
type GitStreamReturnNode<R = undefined> = {
    value: R;
    promise: null;
};
type GitStreamYieldNode<Y = unknown, R = undefined> = {
    value: Y;
    promise: Promise<GitStreamNode<Y, R>>;
};
type GitTreeEntry = {
    path: string[];
    type: 'file' | 'directory';
};
type GitWatchEvent = {
    kind: 'changed' | 'created' | 'removed' | 'child-added' | 'child-removed';
    name?: string;
};
type GitWatchFromResult = {
    cursor: GitCursor;
    watcher: GitNodeWatcher;
};
type GitWritableGitWorktree = GitDirectory & GitPathEntryIssuer;
type GitXattrSetOptions = {
    existence?: 'create' | 'replace';
};
type GitXattrs = {
    get: (name: string) => GitERef<GitPassableBytesReader>;
    set: (name: string, opts?: GitXattrSetOptions) => GitERef<GitPassableBytesWriter>;
    list: () => GitERef<GitPassableReader<string>>;
    remove: (name: string) => Promise<void>;
    help: (method?: string) => string;
};`,
    body: `WritableEndoGit`,
  },
  gitHistory: {
    aux: `type EndoGitHistory = {
  cherryPick: (ref: GitRef | string, options?: GitCherryPickOptions) => Promise<string>;
  commit: (message: string, options?: GitCommitOptions) => Promise<GitCommit>;
  rebase: (input: GitRebaseInput) => Promise<string>;
  reword: (ref: GitRef | string, message: string) => Promise<GitCommit>;
};
type GitCherryPickOptions = {
    noCommit?: boolean;
};
type GitCommit = {
    oid: string;
    summary: string;
    author?: string;
    committedAt?: number;
};
type GitCommitOptions = {
    amend?: boolean;
};
type GitRebaseInput = {
    mode: 'start';
    upstream: string;
    autosquash?: boolean;
} | {
    mode: 'continue' | 'abort' | 'skip';
    upstream?: never;
    autosquash?: never;
};
type GitRef = {
    name: string;
    kind: 'branch' | 'tag' | 'commit' | 'detached';
    oid?: string;
};`,
    body: `EndoGitHistory`,
  },
  gitReadOnly: {
    aux: `type ReadOnlyEndoGit = {
  branches: () => Promise<GitRef[]>;
  currentBranch: () => Promise<GitRef | undefined>;
  diff: (options?: GitDiffOptions) => Promise<string>;
  filesystemAt: (ref: GitRef | string) => Promise<GitFilesystem>;
  log: (options?: GitLogOptions) => Promise<GitCommit[]>;
  readOnly: () => ReadOnlyEndoGit;
  revParse: (ref: GitRef | string) => Promise<GitRef>;
  scope: (name: 'reader') => ReadOnlyEndoGit;
  show: (ref: GitRef | string) => Promise<string>;
  stashList: () => Promise<string[]>;
  stashShow: (index?: number) => Promise<string>;
  status: (options?: GitStatusOptions) => Promise<GitStatusResult>;
  trackingStatus: () => Promise<GitTrackingStatus>;
  tree: (ref: GitRef | string) => Promise<GitReadableTree>;
  worktree: () => Promise<GitReadOnlyGitWorktree>;
};
type GitBlobInfo = {
    algorithm: string;
    hash: string;
    size: bigint;
};
type GitBlobRef = {
    getInfo: () => GitBlobInfo;
    fetch: (offset: bigint, length: bigint) => GitERef<GitPassableBytesReader>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    help: (method?: string) => string;
};
type GitCursor = {
    read: (limit?: bigint) => Promise<GitDirectoryPage>;
    stream: () => GitERef<GitPassableReader<GitDirectoryEntry>>;
    toArray: () => Promise<GitDirectoryEntry[]>;
    skip: (n: bigint) => Promise<void>;
    rewind: () => Promise<void>;
    close: () => Promise<void>;
    help: (method?: string) => string;
};
type GitDirectoryEntry = {
    name: string;
    kind: 'file';
    qid: GitQid<'file'>;
} | {
    name: string;
    kind: 'directory';
    qid: GitQid<'directory'>;
};
type GitDirectoryPage = {
    entries: GitDirectoryEntry[];
    atEnd: boolean;
};
type GitERef<T> = T | Promise<T>;
type GitExtendedDirectory = {
    getQid: () => GitQid<'directory'>;
    getStat: () => Promise<GitNodeStat>;
    setStat: (patch: GitNodeStat) => Promise<void>;
    getAttrs: () => Promise<GitNodeAttrs>;
    setAttrs: (patch: GitNodeStat) => Promise<void>;
    watch: () => GitERef<GitNodeWatcher>;
    xattrs: () => GitERef<GitXattrs>;
    lookup: (nameOrPath: string | readonly string[]) => GitERef<GitExtendedDirectory | GitExtendedFile>;
    lookupStep: (name: string) => GitERef<GitExtendedDirectory | GitExtendedFile>;
    subView: (nameOrPath: string | readonly string[]) => GitERef<GitExtendedDirectory>;
    list: () => GitERef<GitCursor>;
    write: (name: string, value: string) => Promise<void>;
    create: (name: string, opts?: GitOpenFileOptions) => GitERef<GitOpenFile>;
    makeDirectory: (name: string) => GitERef<GitExtendedDirectory>;
    mkdir: (name: string) => GitERef<GitExtendedDirectory>;
    remove: (name: string) => Promise<void>;
    unlink: (name: string) => Promise<void>;
    move: (fromPath: string | readonly string[], toPath: string | readonly string[]) => Promise<void>;
    copy: (fromPath: string | readonly string[], toPath: string | readonly string[]) => Promise<void>;
    rename: (oldName: string, newParent: GitERef<GitExtendedDirectory>, newName: string) => Promise<void>;
    fsync: () => Promise<void>;
    materialise: (path: readonly string[]) => GitERef<GitExtendedDirectory>;
    watchFrom: () => GitERef<GitWatchFromResult>;
    help: (method?: string) => string;
};
type GitExtendedFile = {
    getQid: () => GitQid<'file'>;
    getStat: () => Promise<GitNodeStat>;
    setStat: (patch: GitNodeStat) => Promise<void>;
    getAttrs: () => Promise<GitNodeAttrs>;
    setAttrs: (patch: GitNodeStat) => Promise<void>;
    watch: () => GitERef<GitNodeWatcher>;
    xattrs: () => GitERef<GitXattrs>;
    open: (opts?: GitOpenFileOptions) => GitERef<GitOpenFile>;
    read: (opts?: GitFileReadOptions) => GitERef<GitPassableBytesReader>;
    write: (opts?: GitFileWriteOptions) => GitERef<GitPassableBytesWriter>;
    snapshot: () => Promise<GitBlobRef>;
    help: (method?: string) => string;
};
type GitExtendedFilesystem = {
    root: () => GitERef<GitExtendedDirectory>;
    named: (name: string) => GitERef<GitExtendedDirectory>;
    statfs: () => Promise<GitFilesystemStats>;
    brands: () => Promise<ReadonlySet<bigint> | readonly bigint[]>;
    help: (method?: string) => string;
};
type GitFileReadOptions = {
    offset?: bigint;
    length?: bigint;
};
type GitFileWriteOptions = {
    offset?: bigint;
};
type GitFilesystem = GitExtendedFilesystem;
type GitFilesystemStats = {
    blockSize?: bigint;
    totalBlocks?: bigint;
    freeBlocks?: bigint;
    totalBytes?: bigint;
    freeBytes?: bigint;
    files?: bigint;
    directories?: bigint;
    type?: string;
};
type GitCommit = {
    oid: string;
    summary: string;
    author?: string;
    committedAt?: number;
};
type GitDiffOptions = {
    cached?: boolean;
    base?: GitRef | string;
    head?: GitRef | string;
    entries?: GitPathEntry[];
    paths?: string[];
};
type GitIndexStatus = 'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted';
type GitLogOptions = {
    maxCount?: number;
    ref?: GitRef | string;
    since?: string;
    until?: string;
};
type GitRef = {
    name: string;
    kind: 'branch' | 'tag' | 'commit' | 'detached';
    oid?: string;
};
type GitStatusEntry = {
    path: string;
    index: GitIndexStatus;
    worktree: GitWorktreeStatus;
    renamedFrom?: string;
};
type GitStatusOptions = {
    untracked?: 'all' | 'normal' | 'no';
    maxCount?: number;
};
type GitStatusResult = {
    entries: GitStatusEntry[];
    truncated: boolean;
};
type GitTrackingStatus = {
    branch?: string;
    upstream?: string;
    ahead: number;
    behind: number;
    detached: boolean;
};
type GitWorktreeStatus = 'clean' | 'modified' | 'deleted' | 'untracked' | 'ignored' | 'conflicted';
type GitLitePathEntry = {
    segments: () => string[];
    displayPath: () => string;
    child: (name: string) => GitLitePathEntry;
    help: (method?: string) => string;
};
type GitLiteReadableTree = {
    has: (...petNamePath: string[]) => Promise<boolean>;
    list: (...petNamePath: string[]) => Promise<readonly string[]>;
    lookup: (petNamePath: string | readonly string[]) => Promise<unknown>;
    listTree?: (petNamePath: string | readonly string[], options?: {
        ignore?: readonly string[];
    }) => Promise<GitTreeEntry[]>;
};
type GitLock = {
    release: () => Promise<void>;
    help: (method?: string) => string;
};
type GitLockOpts = {
    type: GitLockType;
    start?: bigint;
    length?: bigint;
};
type GitLockQuery = {
    start?: bigint;
    length?: bigint;
};
type GitLockState = {
    type: GitLockType;
    start: bigint;
    length: bigint;
};
type GitLockType = 'shared' | 'exclusive';
type GitNodeAttrs = GitNodeStat & {
    ctime?: bigint;
    btime?: bigint | null;
};
type GitNodeKind = 'file' | 'directory';
type GitNodeStat = {
    size?: bigint;
    mtime?: bigint;
    atime?: bigint;
};
type GitNodeWatcher = {
    events: () => GitERef<GitPassableReader<GitWatchEvent>>;
    cancel: () => Promise<void>;
};
type GitOpenFile = {
    read: (offset?: bigint, length?: bigint) => GitERef<GitPassableBytesReader>;
    write: (offset?: bigint) => GitERef<GitPassableBytesWriter>;
    truncate: (size: bigint) => Promise<void>;
    fsync: () => Promise<void>;
    lock: (opts: GitLockOpts) => GitERef<GitLock>;
    getLock: (opts: GitLockQuery) => Promise<GitLockState | null>;
    close: () => Promise<void>;
    help: (method?: string) => string;
};
type GitOpenFileOptions = {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
};
type GitPassableBytesReader<TReadReturn = undefined> = {
    streamBase64: (synPromise: GitERef<GitStreamNode<unknown, TReadReturn>>) => Promise<GitStreamNode<string, TReadReturn>>;
    readReturnPattern: () => unknown | undefined;
};
type GitPassableBytesWriter<TWriteReturn = undefined> = {
    streamBase64: (synPromise: GitERef<GitStreamNode<string, TWriteReturn>>) => Promise<GitStreamNode<undefined, TWriteReturn>>;
    writeReturnPattern: () => unknown | undefined;
};
type GitPassableReader<TRead = unknown, TReadReturn = unknown> = {
    stream: (synPromise: GitERef<GitStreamNode<undefined, TReadReturn>>) => Promise<GitStreamNode<TRead, TReadReturn>>;
    readPattern: () => unknown | undefined;
    readReturnPattern: () => unknown | undefined;
};
type GitPathEntry = GitLitePathEntry;
type GitQid<K = GitNodeKind> = {
    type: K;
    pathId: bigint;
    version: bigint;
};
type GitReadOnlyGitWorktree = GitReadableTree;
type GitReadableTree = GitLiteReadableTree;
type GitStreamNode<Y = undefined, R = undefined> = GitStreamYieldNode<Y, R> | GitStreamReturnNode<R>;
type GitStreamReturnNode<R = undefined> = {
    value: R;
    promise: null;
};
type GitStreamYieldNode<Y = unknown, R = undefined> = {
    value: Y;
    promise: Promise<GitStreamNode<Y, R>>;
};
type GitTreeEntry = {
    path: string[];
    type: 'file' | 'directory';
};
type GitWatchEvent = {
    kind: 'changed' | 'created' | 'removed' | 'child-added' | 'child-removed';
    name?: string;
};
type GitWatchFromResult = {
    cursor: GitCursor;
    watcher: GitNodeWatcher;
};
type GitXattrSetOptions = {
    existence?: 'create' | 'replace';
};
type GitXattrs = {
    get: (name: string) => GitERef<GitPassableBytesReader>;
    set: (name: string, opts?: GitXattrSetOptions) => GitERef<GitPassableBytesWriter>;
    list: () => GitERef<GitPassableReader<string>>;
    remove: (name: string) => Promise<void>;
    help: (method?: string) => string;
};`,
    body: `ReadOnlyEndoGit`,
  },
});
harden(gitDeclarations);
