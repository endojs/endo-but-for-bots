/**
 * Public types for `@endo/git-object-store`.
 */

/** Git object hash algorithm for a single repository. */
export type GitHashAlgorithm = 'sha1' | 'sha256';

/** Loose object type names. */
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

/** Lowercase hex object id (40 chars for sha1, 64 for sha256). */
export type GitObjectId = string;

/**
 * Digester power: hash bytes with a named algorithm and return the raw
 * digest bytes.
 */
export type GitDigest = (
  algorithm: GitHashAlgorithm,
  bytes: Uint8Array,
) => Uint8Array;

/**
 * A typed git object as returned from the store.
 */
export type GitObject = {
  type: GitObjectType;
  content: Uint8Array;
  oid: GitObjectId;
};

/**
 * Oid index entry: object type plus CAS sha256 of the content bytes.
 */
export type OidIndexEntry = {
  type: GitObjectType;
  casHash: string;
};

/**
 * Derived cache mapping `(algorithm, oid)` to `(type, casHash)`.
 */
export type OidIndex = {
  get: (
    algorithm: GitHashAlgorithm,
    oid: GitObjectId,
  ) => Promise<OidIndexEntry | undefined>;
  getMany: (
    algorithm: GitHashAlgorithm,
    oids: GitObjectId[],
  ) => Promise<(OidIndexEntry | undefined)[]>;
  put: (
    algorithm: GitHashAlgorithm,
    oid: GitObjectId,
    type: GitObjectType,
    casHash: string,
  ) => Promise<void>;
  has: (algorithm: GitHashAlgorithm, oid: GitObjectId) => Promise<boolean>;
};

/**
 * Minimal ContentStore surface this package needs.
 * Matches `@endo/platform` `ContentStore` for the methods we call.
 */
export type ContentStoreLike = {
  store: (
    readable: AsyncIterator<Uint8Array> | AsyncIterable<Uint8Array>,
  ) => Promise<string>;
  fetch: (sha256: string) => {
    makeFileReader: () => AsyncIterable<Uint8Array> | AsyncIterator<Uint8Array>;
    text?: () => Promise<string>;
    size?: () => Promise<bigint>;
    readRange?: (offset: number, length: number) => Promise<Uint8Array>;
  };
  has: (sha256: string) => Promise<boolean>;
};

/**
 * CAS-backed git object store.
 */
export type GitObjectStore = {
  hasObject: (oid: GitObjectId) => Promise<boolean>;
  readObject: (oid: GitObjectId) => Promise<GitObject>;
  readObjects: (oids: GitObjectId[]) => Promise<(GitObject | undefined)[]>;
  writeObject: (
    type: GitObjectType,
    content: Uint8Array,
  ) => Promise<GitObjectId>;
  /** The repository hash algorithm this store was constructed for. */
  getHashAlgorithm: () => GitHashAlgorithm;
};

/**
 * Parsed tree entry.
 */
export type GitTreeEntry = {
  mode: string;
  name: string;
  oid: GitObjectId;
  /** True when mode denotes a tree (directory). */
  isTree: boolean;
};

/**
 * Parsed signature identity on commits and tags.
 */
export type GitIdentity = {
  name: string;
  email: string;
  /** Unix epoch seconds as a decimal string (domain may exceed safe int). */
  when: string;
  /** Timezone offset like `+0000` or `-0700`. */
  tz: string;
};

/**
 * Parsed commit.
 */
export type GitCommitObject = {
  tree: GitObjectId;
  parents: GitObjectId[];
  author: GitIdentity;
  committer: GitIdentity;
  encoding?: string;
  gpgsig?: string;
  message: string;
};

/**
 * Parsed tag.
 */
export type GitTagObject = {
  object: GitObjectId;
  type: GitObjectType;
  tag: string;
  tagger: GitIdentity;
  message: string;
};

/**
 * One path change between two trees.
 */
export type GitTreeDiffEntry = {
  path: string;
  change: 'added' | 'deleted' | 'modified';
  beforeOid?: GitObjectId;
  afterOid?: GitObjectId;
  beforeMode?: string;
  afterMode?: string;
};
