// Authored TypeScript source for the extended filesystem backend protocol.
// Existing `.js` type imports resolve to this module during typechecking, and
// composite declaration emit produces the corresponding `.d.ts` artifact.

import type { NodeKind, NodeStat, Qid, WatchEvent } from './types.js';

// The node kind, the portable stat shape, and the watch event are the same
// vocabulary the capability surface uses (`./types.js`); a backend speaks it
// rather than redeclaring it. Re-exported so `backend-types.js` stays the one
// import site for the backend protocol.
export type { NodeKind, NodeStat, WatchEvent };

/**
 * `FsBackend` is the minimal protocol that any storage backing (in-memory map,
 * `node:fs`, a remote Mount adapter, a KV blob store, SQLite, S3, IPFS, ...)
 * implements to participate in `@endo/platform/fs/extended`.
 *
 * `wrapBackend(backend)` from `./wrap-backend.js` builds the full `Filesystem`
 * exo surface on top of an `FsBackend`.
 */

/** An entry in a directory listing. */
export interface DirEntry {
  /** The unqualified child name, without path separators. */
  name: string;
  /** The child's node type. */
  kind: NodeKind;
}

/**
 * The backend protocol.
 *
 * Paths are `string[]` segments; the empty array denotes the root. Optional
 * methods are advertised by method existence. Missing methods are synthesized
 * or surfaced as ENOSYS by `wrapBackend`.
 */
export interface FsBackend {
  /** Return the tree-only kind, or `undefined` for a missing/non-tree node. */
  kind: (path: string[]) => Promise<NodeKind | undefined>;
  list: (dirPath: string[]) => AsyncIterable<DirEntry>;
  read: (
    path: string[],
    offset?: bigint,
    length?: bigint,
  ) => Promise<Uint8Array>;
  write: (path: string[], bytes: Uint8Array, offset?: bigint) => Promise<void>;
  makeDirectory: (path: string[]) => Promise<void>;
  remove: (path: string[]) => Promise<void>;
  getStat?: (path: string[]) => Promise<NodeStat>;
  setStat?: (path: string[], patch: NodeStat) => Promise<void>;
  fsync?: (path: string[]) => Promise<void>;
  rename?: (src: string[], dst: string[]) => Promise<void>;
  watch?: (path: string[]) => AsyncIterable<WatchEvent>;
  statfs?: () => Promise<{
    blockSize?: bigint;
    totalBlocks?: bigint;
    freeBlocks?: bigint;
    totalBytes?: bigint;
    freeBytes?: bigint;
    files?: bigint;
    directories?: bigint;
  }>;
  /**
   * Sync content-address hook: a `Qid` whose `pathId` is a stronger
   * identity than the path-hash `synthQid` default (e.g. a git object
   * OID). `wrapBackend` falls back to `synthQid` when absent or when it
   * returns `undefined` for a given path.
   */
  qidFor?: <K extends NodeKind>(path: string[], kind: K) => Qid<K> | undefined;
  /**
   * Content-address hook for `BlobRef`: reports `{ algorithm, hash }`
   * (e.g. `git-sha1` + the blob OID) in place of the default SHA-256
   * over captured bytes. Falls back the same way as `qidFor`.
   */
  blobInfoFor?: (
    path: string[],
  ) => { algorithm: string; hash: string } | undefined;
}
