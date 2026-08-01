// Focused code-mode contract for the daemon's EndoMount capability.
//
// This is authored from packages/daemon/src/types.d.ts.  The daemon source
// uses interface inheritance, overloads, and imports from several platform
// type modules; those forms are intentionally flattened here so the prompt
// extractor can print a self-contained declaration.  The extractor's
// divergence test pins the method names to the daemon's runtime guards.

export type DaemonMountEntry = {
  segments: () => string[];
  displayPath: () => string;
  child: (name: string) => DaemonMountEntry;
  help: (method?: string) => string;
};

export type DaemonBlobInfo = {
  algorithm: string;
  hash: string;
  size: bigint;
};

export type DaemonMountStat = {
  kind: 'file' | 'directory' | 'symlink';
  size: bigint;
  mtime: bigint;
  atime: bigint;
};

export type DaemonTreeEntry = {
  path: string[];
  type: 'file' | 'directory';
};

export type DaemonPassableReader = {
  stream: (synPromise: unknown) => Promise<unknown>;
  readPattern: () => unknown | undefined;
  readReturnPattern: () => unknown | undefined;
};

export type DaemonPassableBytesReader = {
  streamBase64: (synPromise: unknown) => Promise<unknown>;
  readReturnPattern: () => unknown | undefined;
};

export type DaemonReadableBlob = {
  streamBase64: (synPromise: unknown) => Promise<unknown>;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  getInfo: () => Promise<DaemonBlobInfo>;
  fetch: (offset: bigint, length: bigint) => Promise<DaemonPassableBytesReader>;
  help: (method?: string) => string;
};

export type DaemonReadableTree = {
  has: (...pathSegments: string[]) => Promise<boolean>;
  list: (...pathSegments: string[]) => Promise<readonly string[]>;
  listTree: (
    petNamePath: string | readonly string[],
    options?: { ignore?: readonly string[] },
  ) => Promise<DaemonTreeEntry[]>;
  lookup: (
    path: string | readonly string[],
  ) => Promise<DaemonReadableTree | DaemonReadableBlob>;
  help: (method?: string) => string;
};

export type DaemonSnapshotTree = DaemonReadableTree & {
  sha256: () => string;
  getInfo: () => Promise<DaemonBlobInfo>;
};

export type DaemonMountFile = {
  streamBase64: (synPromise: unknown) => Promise<unknown>;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  getInfo: () => Promise<DaemonBlobInfo>;
  fetch: (offset: bigint, length: bigint) => Promise<DaemonPassableBytesReader>;
  writeText: (content: string) => Promise<void>;
  append: (content: string) => Promise<void>;
  writeBytes: (readableRef: DaemonPassableBytesReader) => Promise<void>;
  stat: () => Promise<DaemonMountStat>;
  snapshot: () => Promise<DaemonSnapshotTree>;
  readOnly: () => DaemonReadableBlob;
  help: (method?: string) => string;
};

export type DaemonGrepMatch = {
  file: string;
  line: number;
  text: string;
};

export type DaemonDirectoryWriteSource =
  | DaemonReadableBlob
  | DaemonReadableTree;

export type DaemonPath = string | readonly string[] | DaemonMountEntry;

export type DaemonMount = {
  entry: (path: string | string[]) => DaemonMountEntry;
  has: {
    (...pathSegments: string[]): Promise<boolean>;
    (entry: DaemonMountEntry): Promise<boolean>;
  };
  list: (...pathSegments: string[]) => Promise<string[]>;
  glob: (pattern: string) => Promise<string[]>;
  grep: (
    pattern: string,
    paths?: string[] | Promise<string[]>,
    options?: { maxResults?: number },
  ) => Promise<DaemonGrepMatch[]>;
  glorp: (
    globPattern: string,
    grepPattern: string,
    options?: { maxResults?: number },
  ) => Promise<DaemonGrepMatch[]>;
  lookup: (path: DaemonPath) => Promise<DaemonMount | DaemonMountFile>;
  maybeLookup: (
    path: DaemonPath,
  ) => Promise<DaemonMount | DaemonMountFile | undefined>;
  followNameChanges: (...pathSegments: string[]) => DaemonPassableReader;
  subView: (path: DaemonPath) => Promise<DaemonMount>;
  write: (path: DaemonPath, value: DaemonDirectoryWriteSource) => Promise<void>;
  copy: (from: DaemonPath, to: DaemonPath) => Promise<void>;
  stat: (path: DaemonPath) => Promise<DaemonMountStat | undefined>;
  readText: (path: DaemonPath) => Promise<string>;
  maybeReadText: (path: DaemonPath) => Promise<string | undefined>;
  writeText: (path: DaemonPath, content: string) => Promise<void>;
  makeDirectory: (path: DaemonPath) => Promise<DaemonMount>;
  makeFile: (path: DaemonPath, content?: string) => Promise<void>;
  remove: (path: DaemonPath) => Promise<void>;
  move: (from: DaemonPath, to: DaemonPath) => Promise<void>;
  readOnly: () => DaemonReadableTree;
  snapshot: () => Promise<DaemonSnapshotTree>;
  help: (method?: string) => string;
};

export type DaemonMountReadOnly = DaemonReadableTree;
