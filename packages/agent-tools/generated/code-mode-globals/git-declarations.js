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
    aux: `type GitPathDesignator = GitPathEntry | string;
type GitRef = {
    name: string;
    kind: 'branch' | 'tag' | 'commit' | 'detached';
    oid?: string;
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
type GitFilesystem = GitExtendedFilesystem;
type GitLogOptions = {
    maxCount?: number;
    ref?: GitRef | string;
    since?: string;
    until?: string;
};
type GitReadOnlyEndoGit = {
    help: (method?: string) => string;
    worktree: () => Promise<GitReadOnlyGitWorktree>;
    status: (options?: GitStatusOptions) => Promise<GitStatusResult>;
    trackingStatus: () => Promise<GitTrackingStatus>;
    worktreeList: () => Promise<GitWorktreeEntry[]>;
    diff: (options?: GitDiffOptions) => Promise<string>;
    log: (options?: GitLogOptions) => Promise<GitCommit[]>;
    show: (ref: GitRef | string) => Promise<string>;
    revParse: (ref: GitRef | string) => Promise<GitRef>;
    currentBranch: () => Promise<GitRef | undefined>;
    branches: () => Promise<GitRef[]>;
    stashList: () => Promise<string[]>;
    stashShow: (index?: number) => Promise<string>;
    tree: (ref: GitRef | string) => Promise<GitTree>;
    filesystemAt: (ref: GitRef | string) => Promise<GitFilesystem>;
    readOnly: () => GitReadOnlyEndoGit;
    scope: (name: 'reader') => GitReadOnlyEndoGit;
};
type GitStashPushOptions = {
    message?: string;
    entries?: GitPathEntry[];
    paths?: string[];
    includeUntracked?: boolean;
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
type GitTree = GitReadableTree & {
    help: (method?: string) => string;
};
type GitWritableGitWorktree = GitDirectory & GitPathEntryIssuer;
type GitPathEntry = GitLitePathEntry;
type GitWorktreeAddOptions = {
    ref?: GitRef | string;
    newBranch?: string;
};
type GitWorktreeEntry = {
    path: string;
    head?: string;
    branch?: string;
    bare: boolean;
    detached: boolean;
    locked: boolean;
    prunable: boolean;
};
type GitERef<T> = T | Promise<T>;
type GitPassableBytesReader<TReadReturn = undefined> = {
    stream: (synPromise: GitERef<GitStreamNode<unknown, TReadReturn>>) => Promise<GitStreamNode<Uint8Array, TReadReturn>>;
    readReturnPattern: () => unknown | undefined;
};
type GitDirectoryPage = {
    entries: GitDirectoryEntry[];
    atEnd: boolean;
};
type GitPassableReader<TRead = unknown, TReadReturn = unknown> = {
    stream: (synPromise: GitERef<GitStreamNode<undefined, TReadReturn>>) => Promise<GitStreamNode<TRead, TReadReturn>>;
    readPattern: () => unknown | undefined;
    readReturnPattern: () => unknown | undefined;
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
type GitQid<K = GitNodeKind> = {
    type: K;
    pathId: bigint;
    version: bigint;
};
type GitReadableBlobSource = {
    text: (...args: any[]) => PromiseLike<unknown>;
} | {
    stream: (...args: any[]) => PromiseLike<unknown>;
    getInfo: (...args: any[]) => PromiseLike<unknown>;
} | {
    stream: (...args: any[]) => PromiseLike<unknown>;
    readReturnPattern: (...args: any[]) => unknown;
};
type GitLiteReadableTree = {
    has: (...petNamePath: string[]) => Promise<boolean>;
    list: (...petNamePath: string[]) => Promise<readonly string[]>;
    lookup: (petNamePath: string | readonly string[]) => Promise<unknown>;
    listTree?: (petNamePath: string | readonly string[], options?: {
        ignore?: readonly string[];
    }) => Promise<{
        path: string[];
        type: 'file' | 'directory';
    }[]>;
};
type GitNodeStat = {
    size?: bigint;
    mtime?: bigint;
    atime?: bigint;
};
type GitNodeAttrs = GitNodeStat & {
    ctime?: bigint;
    btime?: bigint | null;
};
type GitNodeWatcher = {
    events: () => GitERef<GitPassableReader<{
        kind: 'changed' | 'created' | 'removed' | 'child-added' | 'child-removed';
        name?: string;
    }>>;
    cancel: () => Promise<void>;
};
type GitXattrs = {
    get: (name: string) => GitERef<GitPassableBytesReader>;
    set: (name: string, opts?: {
        existence?: 'create' | 'replace';
    }) => GitERef<GitPassableBytesWriter>;
    list: () => GitERef<GitPassableReader<string>>;
    remove: (name: string) => Promise<void>;
    help: (method?: string) => string;
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
    read: (opts?: {
        offset?: bigint;
        length?: bigint;
    }) => GitERef<GitPassableBytesReader>;
    write: (opts?: {
        offset?: bigint;
    }) => GitERef<GitPassableBytesWriter>;
    snapshot: () => Promise<GitBlobRef>;
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
type GitOpenFileOptions = {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
};
type GitOpenFile = {
    read: (offset?: bigint, length?: bigint) => GitERef<GitPassableBytesReader>;
    write: (offset?: bigint) => GitERef<GitPassableBytesWriter>;
    truncate: (size: bigint) => Promise<void>;
    fsync: () => Promise<void>;
    lock: (opts: GitLockOpts) => GitERef<GitLock>;
    getLock: (opts: {
        start?: bigint;
        length?: bigint;
    }) => Promise<GitLockState | null>;
    close: () => Promise<void>;
    help: (method?: string) => string;
};
type GitWatchFromResult = {
    cursor: GitCursor;
    watcher: GitNodeWatcher;
};
type GitPassableBytesWriter<TWriteReturn = undefined> = {
    stream: (synPromise: GitERef<GitStreamNode<Uint8Array, TWriteReturn>>) => Promise<GitStreamNode<undefined, TWriteReturn>>;
    writeReturnPattern: () => unknown | undefined;
};
type GitBlobRef = {
    getInfo: () => {
        algorithm: string;
        hash: string;
        size: bigint;
    };
    fetch: (offset: bigint, length: bigint) => GitERef<GitPassableBytesReader>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    help: (method?: string) => string;
};
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
type GitExtendedFilesystem = {
    root: () => GitERef<GitExtendedDirectory>;
    named: (name: string) => GitERef<GitExtendedDirectory>;
    statfs: () => Promise<GitFilesystemStats>;
    brands: () => Promise<ReadonlySet<bigint> | readonly bigint[]>;
    help: (method?: string) => string;
};
type GitStatusEntry = {
    path: string;
    index: 'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted';
    worktree: 'clean' | 'modified' | 'deleted' | 'untracked' | 'ignored' | 'conflicted';
    renamedFrom?: string;
};
type GitReadableTree = GitLiteReadableTree;
type GitDirectoryWriteSource = GitReadableBlobSource | GitLiteReadableTree;
type GitSnapshotTree = GitLiteReadableTree & {
    sha256: () => string;
    getInfo: () => Promise<{
        algorithm: string;
        hash: string;
        size: bigint;
    }>;
};
type GitLitePathEntry = {
    segments: () => string[];
    displayPath: () => string;
    child: (name: string) => GitLitePathEntry;
    help: (method?: string) => string;
};
type GitLockType = 'shared' | 'exclusive';
type GitLockOpts = {
    type: GitLockType;
    start?: bigint;
    length?: bigint;
};
type GitLock = {
    release: () => Promise<void>;
    help: (method?: string) => string;
};
type GitLockState = {
    type: GitLockType;
    start: bigint;
    length: bigint;
};
type GitStreamNode<Y = undefined, R = undefined> = GitStreamYieldNode<Y, R> | {
    value: R;
    promise: null;
};
type GitLitePathEntryIssuer = {
    entry: (path: string | string[]) => GitLitePathEntry;
};
type GitNodeKind = 'file' | 'directory';
type GitReadOnlyGitWorktree = GitReadableTree;
type GitStreamYieldNode<Y = unknown, R = undefined> = {
    value: Y;
    promise: Promise<GitStreamNode<Y, R>>;
};
type GitDirectory = GitLiteDirectory;
type GitPathEntryIssuer = GitLitePathEntryIssuer;`,
    body: `{
    add: (designators: GitPathDesignator[]) => Promise<void>;
    branches: () => Promise<GitRef[]>;
    checkoutConflict: (designators: GitPathDesignator[], side: 'ours' | 'theirs') => Promise<void>;
    commit: (message: string) => Promise<GitCommit>;
    createBranch: (name: string, options?: {
        startPoint?: string;
        switchAfterCreate?: boolean;
    }) => Promise<GitRef>;
    currentBranch: () => Promise<GitRef | undefined>;
    deleteBranch: (name: string, options?: {
        force?: boolean;
    }) => Promise<void>;
    detach: (ref: GitRef | string) => Promise<void>;
    diff: (options?: GitDiffOptions) => Promise<string>;
    filesystemAt: (ref: GitRef | string) => Promise<GitFilesystem>;
    help: (method?: string) => string;
    log: (options?: GitLogOptions) => Promise<GitCommit[]>;
    merge: (ref: GitRef | string, options?: {
        fastForwardOnly?: boolean;
        noFastForward?: boolean;
    }) => Promise<string>;
    readOnly: () => GitReadOnlyEndoGit;
    renameBranch: (from: string, to: string) => Promise<void>;
    restore: (designators: GitPathDesignator[], options?: {
        staged?: boolean;
    }) => Promise<void>;
    revParse: (ref: GitRef | string) => Promise<GitRef>;
    scope: (name: 'reader' | 'writer') => GitReadOnlyEndoGit | typeof git;
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
    tree: (ref: GitRef | string) => Promise<GitTree>;
    worktree: () => Promise<GitWritableGitWorktree>;
    worktreeAdd: (entry: GitPathEntry, options?: GitWorktreeAddOptions) => Promise<typeof git>;
    worktreeList: () => Promise<GitWorktreeEntry[]>;
}`,
  },
  gitHistory: {
    aux: `type GitRef = {
    name: string;
    kind: 'branch' | 'tag' | 'commit' | 'detached';
    oid?: string;
};
type GitCommit = {
    oid: string;
    summary: string;
    author?: string;
    committedAt?: number;
};
type GitRebaseInput = {
    mode: 'start';
    upstream: string;
    autosquash?: boolean;
} | {
    mode: 'continue' | 'abort' | 'skip';
    upstream?: never;
    autosquash?: never;
};`,
    body: `{
    cherryPick: (ref: GitRef | string, options?: {
        noCommit?: boolean;
    }) => Promise<string>;
    commit: (message: string, options?: {
        amend?: boolean;
    }) => Promise<GitCommit>;
    rebase: (input: GitRebaseInput) => Promise<string>;
    reword: (ref: GitRef | string, message: string) => Promise<GitCommit>;
}`,
  },
  gitReadOnly: {
    aux: `type GitRef = {
    name: string;
    kind: 'branch' | 'tag' | 'commit' | 'detached';
    oid?: string;
};
type GitDiffOptions = {
    cached?: boolean;
    base?: GitRef | string;
    head?: GitRef | string;
    entries?: GitPathEntry[];
    paths?: string[];
};
type GitFilesystem = GitExtendedFilesystem;
type GitLogOptions = {
    maxCount?: number;
    ref?: GitRef | string;
    since?: string;
    until?: string;
};
type GitCommit = {
    oid: string;
    summary: string;
    author?: string;
    committedAt?: number;
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
type GitTree = GitReadableTree & {
    help: (method?: string) => string;
};
type GitReadOnlyGitWorktree = GitReadableTree;
type GitWorktreeEntry = {
    path: string;
    head?: string;
    branch?: string;
    bare: boolean;
    detached: boolean;
    locked: boolean;
    prunable: boolean;
};
type GitERef<T> = T | Promise<T>;
type GitPassableBytesReader<TReadReturn = undefined> = {
    stream: (synPromise: GitERef<GitStreamNode<unknown, TReadReturn>>) => Promise<GitStreamNode<Uint8Array, TReadReturn>>;
    readReturnPattern: () => unknown | undefined;
};
type GitDirectoryPage = {
    entries: GitDirectoryEntry[];
    atEnd: boolean;
};
type GitPassableReader<TRead = unknown, TReadReturn = unknown> = {
    stream: (synPromise: GitERef<GitStreamNode<undefined, TReadReturn>>) => Promise<GitStreamNode<TRead, TReadReturn>>;
    readPattern: () => unknown | undefined;
    readReturnPattern: () => unknown | undefined;
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
type GitQid<K = GitNodeKind> = {
    type: K;
    pathId: bigint;
    version: bigint;
};
type GitNodeStat = {
    size?: bigint;
    mtime?: bigint;
    atime?: bigint;
};
type GitNodeAttrs = GitNodeStat & {
    ctime?: bigint;
    btime?: bigint | null;
};
type GitNodeWatcher = {
    events: () => GitERef<GitPassableReader<{
        kind: 'changed' | 'created' | 'removed' | 'child-added' | 'child-removed';
        name?: string;
    }>>;
    cancel: () => Promise<void>;
};
type GitXattrs = {
    get: (name: string) => GitERef<GitPassableBytesReader>;
    set: (name: string, opts?: {
        existence?: 'create' | 'replace';
    }) => GitERef<GitPassableBytesWriter>;
    list: () => GitERef<GitPassableReader<string>>;
    remove: (name: string) => Promise<void>;
    help: (method?: string) => string;
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
    read: (opts?: {
        offset?: bigint;
        length?: bigint;
    }) => GitERef<GitPassableBytesReader>;
    write: (opts?: {
        offset?: bigint;
    }) => GitERef<GitPassableBytesWriter>;
    snapshot: () => Promise<GitBlobRef>;
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
type GitOpenFileOptions = {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    truncate?: boolean;
    append?: boolean;
};
type GitOpenFile = {
    read: (offset?: bigint, length?: bigint) => GitERef<GitPassableBytesReader>;
    write: (offset?: bigint) => GitERef<GitPassableBytesWriter>;
    truncate: (size: bigint) => Promise<void>;
    fsync: () => Promise<void>;
    lock: (opts: GitLockOpts) => GitERef<GitLock>;
    getLock: (opts: {
        start?: bigint;
        length?: bigint;
    }) => Promise<GitLockState | null>;
    close: () => Promise<void>;
    help: (method?: string) => string;
};
type GitWatchFromResult = {
    cursor: GitCursor;
    watcher: GitNodeWatcher;
};
type GitPassableBytesWriter<TWriteReturn = undefined> = {
    stream: (synPromise: GitERef<GitStreamNode<Uint8Array, TWriteReturn>>) => Promise<GitStreamNode<undefined, TWriteReturn>>;
    writeReturnPattern: () => unknown | undefined;
};
type GitBlobRef = {
    getInfo: () => {
        algorithm: string;
        hash: string;
        size: bigint;
    };
    fetch: (offset: bigint, length: bigint) => GitERef<GitPassableBytesReader>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    help: (method?: string) => string;
};
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
type GitExtendedFilesystem = {
    root: () => GitERef<GitExtendedDirectory>;
    named: (name: string) => GitERef<GitExtendedDirectory>;
    statfs: () => Promise<GitFilesystemStats>;
    brands: () => Promise<ReadonlySet<bigint> | readonly bigint[]>;
    help: (method?: string) => string;
};
type GitPathEntry = GitLitePathEntry;
type GitStatusEntry = {
    path: string;
    index: 'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted';
    worktree: 'clean' | 'modified' | 'deleted' | 'untracked' | 'ignored' | 'conflicted';
    renamedFrom?: string;
};
type GitReadableTree = GitLiteReadableTree;
type GitLitePathEntry = {
    segments: () => string[];
    displayPath: () => string;
    child: (name: string) => GitLitePathEntry;
    help: (method?: string) => string;
};
type GitLockType = 'shared' | 'exclusive';
type GitLockOpts = {
    type: GitLockType;
    start?: bigint;
    length?: bigint;
};
type GitLock = {
    release: () => Promise<void>;
    help: (method?: string) => string;
};
type GitLockState = {
    type: GitLockType;
    start: bigint;
    length: bigint;
};
type GitStreamNode<Y = undefined, R = undefined> = GitStreamYieldNode<Y, R> | {
    value: R;
    promise: null;
};
type GitNodeKind = 'file' | 'directory';
type GitLiteReadableTree = {
    has: (...petNamePath: string[]) => Promise<boolean>;
    list: (...petNamePath: string[]) => Promise<readonly string[]>;
    lookup: (petNamePath: string | readonly string[]) => Promise<unknown>;
    listTree?: (petNamePath: string | readonly string[], options?: {
        ignore?: readonly string[];
    }) => Promise<{
        path: string[];
        type: 'file' | 'directory';
    }[]>;
};
type GitStreamYieldNode<Y = unknown, R = undefined> = {
    value: Y;
    promise: Promise<GitStreamNode<Y, R>>;
};`,
    body: `{
    branches: () => Promise<GitRef[]>;
    currentBranch: () => Promise<GitRef | undefined>;
    diff: (options?: GitDiffOptions) => Promise<string>;
    filesystemAt: (ref: GitRef | string) => Promise<GitFilesystem>;
    log: (options?: GitLogOptions) => Promise<GitCommit[]>;
    readOnly: () => typeof gitReadOnly;
    revParse: (ref: GitRef | string) => Promise<GitRef>;
    scope: (name: 'reader') => typeof gitReadOnly;
    show: (ref: GitRef | string) => Promise<string>;
    stashList: () => Promise<string[]>;
    stashShow: (index?: number) => Promise<string>;
    status: (options?: {
        untracked?: 'all' | 'normal' | 'no';
        maxCount?: number;
    }) => Promise<GitStatusResult>;
    trackingStatus: () => Promise<GitTrackingStatus>;
    tree: (ref: GitRef | string) => Promise<GitTree>;
    worktree: () => Promise<GitReadOnlyGitWorktree>;
    worktreeList: () => Promise<GitWorktreeEntry[]>;
}`,
  },
});
harden(gitDeclarations);
