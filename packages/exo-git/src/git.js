// @ts-check
/// <reference types="ses"/>

import { q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { defineExoClassKit } from '@endo/exo';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { makeChangeTopic } from '@endo/pubsub/change-topic.js';
import { makeLatestTopic } from '@endo/pubsub/latest-topic.js';
// Deep specifiers rather than the `@endo/platform/fs/extended` index: the
// index also re-exports `makeNodeFilesystem` / `makeNodeFsBackend`, which
// statically import `node:fs/promises` and `node:path`.  `@endo/exo-git` is
// on the XS daemon bundle's compartment graph, where those do not resolve,
// and it needs neither (`designs/platform-neutral-hash.md`).
import { readOnly as readOnlyFs } from '@endo/platform/fs/extended/readonly.js';
import { wrapBackend } from '@endo/platform/fs/extended/wrap-backend.js';

import { makeGitFsBackend } from './git-filesystem.js';
import { gitHelp, makeHelp } from './help-text.js';
import {
  GitReaderInterface,
  GitWriterInterface,
  GitRewriterInterface,
} from './interfaces.js';

/** @import { Reader } from '@endo/stream' */

/**
 * @import {
 *   EndoGit,
 *   GitCherryPickOptions,
 *   GitCommit,
 *   GitCommitOptions,
 *   GitConflictSide,
 *   GitCreateBranchOptions,
 *   GitDeleteBranchOptions,
 *   GitDiffOptions,
 *   FollowRootOptions,
 *   GitCommitPosition,
 *   GitRootChange,
 *   GitRootSnapshot,
 *   GitIndexStatus,
 *   GitLogOptions,
 *   GitMakeHistoryRewriteOptions,
 *   GitMakeOptions,
 *   GitMakeReadOnlyOptions,
 *   GitMakeReadWriteOptions,
 *   GitMakeReadWriteOrHistoryRewriteOptions,
 *   GitMergeOptions,
 *   GitRebaseInput,
 *   GitRef,
 *   GitRemoteCredential,
 *   RemoteOperationResult,
 *   PathEntry,
 *   GitPathDesignator,
 *   ReadableTree,
 *   GitRestoreOptions,
 *   GitStashPushOptions,
 *   GitStatusOptions,
 *   GitStatusResult,
 *   GitTrackingStatus,
 *   GitWorktreeStatus,
 *   GitWorktreeAddOptions,
 *   GitWorktreeEntry,
 *   GitTree,
 *   HistoryRewriteEndoGit,
 *   ReadOnlyEndoGit,
 *   ReadOnlyGitWorktree,
 *   ReadWriteEndoGit,
 *   WritableGitWorktree,
 * } from './types.js'
 */

/**
 * Backend-facing row produced by `GitBackend.status`.  The public Git exo
 * projects each `BackendStatusEntry` into copy data; the public type lives in
 * `types.d.ts`.
 *
 * @typedef {object} BackendStatusEntry
 * @property {string} path
 * @property {GitIndexStatus} index
 * @property {GitWorktreeStatus} worktree
 * @property {string} [renamedFrom]
 */

/**
 * Backend-facing linked-worktree record.  The native backend converts Git's
 * path spelling to a mount-relative path before returning it.
 *
 * @typedef {GitWorktreeEntry} BackendWorktreeEntry
 */

/**
 * Backend-facing diff options.  The public Git exo collapses `GitRef`
 * values to strings and `entries` (PathEntry[]) to repo-relative
 * `paths` before calling the backend.
 *
 * @typedef {object} GitBackendDiffOptions
 * @property {boolean} [cached]
 * @property {string} [base]
 * @property {string} [head]
 * @property {string[]} [paths]
 */

/**
 * Backend-facing log options.  Mirrors the public `GitLogOptions` after the
 * public Git exo collapses `GitRef | string` to a plain string.
 *
 * @typedef {object} GitBackendLogOptions
 * @property {number} [maxCount]
 * @property {string} [ref]
 * @property {string} [since]
 * @property {string} [until]
 */

/**
 * Backend-facing stash-push options.  The public Git exo resolves
 * `entries` to repo-relative `paths` before calling the backend.
 *
 * @typedef {object} GitBackendStashPushOptions
 * @property {string} [message]
 * @property {string[]} [paths]
 * @property {boolean} [includeUntracked]
 */

/**
 * Backend-facing contract.  Concrete backends (native git, future JS git
 * libraries, daemon-native commit storage) translate the structured
 * operations into their implementation-specific calls.  Path-bearing inputs
 * are either pre-resolved to host-absolute strings or, for `worktreeAdd`,
 * validated mount-relative segments; a backend never sees an unresolved
 * `PathEntry`.
 *
 * Phase 1 declares the contract; later phases implement the methods.
 *
 * @typedef {object} GitBackend
 * @property {() => Promise<void>} assertRepositoryRoot  Verifies the mount
 *   root is exactly a git worktree root (e.g. `git rev-parse --show-toplevel`
 *   equals the root).  Called by `provideGit` at formula instantiation.
 * @property {() => Promise<void>} assertNoExecutableRepoConfig  Refuses
 *   repository-local config that can execute code via filter or merge
 *   driver hooks before any worktree-mutation method runs.
 * @property {(options?: GitStatusOptions) => Promise<BackendStatusEntry[]>} status
 * @property {() => Promise<BackendWorktreeEntry[]>} worktreeList  Returns
 *   mount-relative paths; entries outside the mount are omitted.
 * @property {(destinationSegments: string[], options?: { ref?: string, newBranch?: string }) => Promise<GitBackend>} worktreeAdd
 * @property {(destinationSegments: string[]) => Promise<void>} worktreeRemove
 * @property {(opts?: GitBackendDiffOptions) => Promise<string>} diff
 * @property {(opts?: GitBackendLogOptions) => Promise<GitCommit[]>} log
 * @property {(ref: string) => Promise<string>} show
 * @property {(ref: string) => Promise<GitRef>} revParse
 * @property {(paths: string[]) => Promise<void>} add
 * @property {(paths: string[], opts?: GitRestoreOptions) => Promise<void>} restore
 * @property {(paths: string[], side: GitConflictSide) => Promise<void>} checkoutConflict
 * @property {(message: string, opts?: GitCommitOptions) => Promise<GitCommit>} commit
 * @property {(ref: string, message: string) => Promise<GitCommit>} reword
 * @property {(ref: string, opts?: GitCherryPickOptions) => Promise<string>} cherryPick
 * @property {() => Promise<GitRef | undefined>} currentBranch
 * @property {() => Promise<GitTrackingStatus>} trackingStatus
 * @property {() => Promise<GitRef[]>} branches
 * @property {(name: string, opts?: GitCreateBranchOptions) => Promise<GitRef>} createBranch
 * @property {(name: string, opts?: GitDeleteBranchOptions) => Promise<void>} deleteBranch
 * @property {(from: string, to: string) => Promise<void>} renameBranch
 * @property {(name: string) => Promise<void>} switchBranch
 * @property {(ref: string) => Promise<void>} detach
 * @property {(ref: string) => Promise<void>} switch
 * @property {(ref: string, opts?: GitMergeOptions) => Promise<string>} merge
 * @property {(input: GitRebaseInput) => Promise<string>} rebase
 * @property {(opts?: GitBackendStashPushOptions) => Promise<string>} stashPush
 * @property {() => Promise<string[]>} stashList
 * @property {(index?: number) => Promise<string>} stashShow
 * @property {(index?: number) => Promise<void>} stashApply
 * @property {(index?: number) => Promise<void>} stashPop
 * @property {(index?: number) => Promise<void>} stashDrop
 * @property {(ref: string) => Promise<GitTree>} tree  Returns a
 *   `GitTree` exo for the given tree-ish; blobs implement
 *   `ReadableBlob`.
 * @property {(input: { url?: unknown, refspecs?: unknown, prune?: boolean, tags?: boolean, credential?: GitRemoteCredential, signal?: AbortSignal }) => Promise<RemoteOperationResult>} remoteFetch
 *   Fetch from a policy-bound remote URL.  The caller has already
 *   validated the URL and the refspecs against `GitRemote`'s policy;
 *   this method runs the underlying `git fetch` invocation through the
 *   sanitized environment.
 * @property {(input: { url?: unknown, refspecs?: unknown, forceWithLease?: { ref: string, expectedOid: string }, setUpstream?: boolean, credential?: GitRemoteCredential, signal?: AbortSignal }) => Promise<RemoteOperationResult>} remotePush
 *   Push to a policy-bound remote URL with the same policy
 *   pre-validation contract as `remoteFetch`.
 * @property {(ref: string) => Promise<{ treeOid: string, commitOid?: string }>} resolveTree
 *   Resolve a ref to a canonical tree OID and (when applicable) the
 *   commit OID that points at it.  Used by `filesystemAt(ref)` at
 *   construction time so the resulting Filesystem is pinned to a
 *   specific tree OID and later ref movement does not affect it.
 * @property {() => Promise<{ treeOid: string, commitOid: string, treeAlgorithm: string } | null>} resolveRoot
 *   Resolve the repository's currently published root. An unborn repository
 *   returns null.
 * @property {(options: { cancelled: Promise<never>, after: { treeOid: string, commitOid: string, treeAlgorithm: string } | null }) => AsyncIterable<{ treeOid: string, commitOid: string, treeAlgorithm: string } | null>} watchRoot
 *   Watch the published root through a backend-owned mechanism. The native
 *   backend initially implements this seam by polling; a future fs watcher can
 *   replace that mechanism without changing the public follower.
 * @property {(treeOid: string) => Promise<readonly GitTreeEntryRecord[]>} lsTree
 *   Enumerate entries at a tree OID.  The records are content-addressed
 *   and safe to cache per-OID.
 * @property {(blobOid: string) => Promise<Uint8Array>} readBlobBytes
 *   Read full bytes of a blob.
 * @property {(blobOid: string) => AsyncIterable<Uint8Array>} streamBlobBytes
 *   Stream blob bytes for range-read paths that should not buffer the
 *   full blob in memory.
 */

/**
 * Structural record describing one entry in a git tree object.  Mirrors
 * `git ls-tree -z --long` output: mode is the 6-digit octal string, type
 * is `'blob'` / `'tree'` / `'commit'`, oid is the 40-hex (sha1) object
 * identifier — the native backend's `parseLsTreeEntries` regex only
 * accepts sha1 today; sha256-formatted repos are a Phase 5 follow-up
 * tracked in `designs/endo-fs-from-git.md` — size is present for blobs
 * only, and name is the single-segment entry name (no slashes).
 *
 * @typedef {object} GitTreeEntryRecord
 * @property {string} mode
 * @property {'blob' | 'tree' | 'commit'} type
 * @property {string} oid
 * @property {number} [size]
 * @property {string} name
 */

/**
 * @typedef {object} GitPowers
 * @property {WritableGitWorktree} mount The writable worktree authority.
 * @property {GitBackend} backend
 * @property {(value: unknown) => object | undefined} lineageOf
 *   Returns the mount-lineage sentinel for daemon-minted `EndoMount` /
 *   `EndoMountEntry` values; `undefined` for foreign caps.
 *   The daemon
 *   binds its `mount.js#lineageOf`; in-process unit tests can pass a
 *   stub.
 *   Two entries with the same returned sentinel are guaranteed
 *   to belong to the same mount root.
 */

/**
 * Host-private capability handed only to composing host code (never to a
 * guest, and not reachable from `reader`, `writer`, or `rewriter` by any
 * method those facets expose): the backend authority `GitRemote` needs to
 * run its native fetch/push data plane.  Minted alongside the guest-facing
 * `Git` kit from the same `powers` and threaded explicitly into
 * `makeGitRemote({ operations })` by the caller that built both.
 * `pairingToken` is an ephemeral, unforgeable brand generated fresh for
 * each `makeGitKit` call (i.e. each Git formula evaluation) — never
 * persisted, and never derived from `backend` object identity — so
 * `makeGitRemote` can verify (via `gitPairingTokenFor`) that this
 * `GitOperations` was minted alongside the specific `git` it claims to
 * pair with, rather than merely alongside *some* daemon-minted Git
 * instance that happens to share a backend reference. A restart
 * reincarnates the Git formula and mints a new token; the old token does
 * not need to survive the upgrade.
 *
 * @typedef {object} GitOperations
 * @property {GitBackend} backend
 * @property {unknown} pairingToken
 */

/**
 * Mint the host-private operations capability for one Git instance's
 * backend. Independent of the guest-facing kit: it carries no reference to
 * any `reader` / `writer` / `rewriter` facet and cannot be recovered from
 * one. Pass the `git` facet minted alongside `backend` (by the same
 * `makeGit` / `makeGitKit` call) so the resulting `GitOperations` carries
 * that instance's pairing token; omitting `git` (or passing a value not
 * minted by this module) yields an operations capability that can never
 * pass `makeGitRemote`'s pairing check.
 *
 * @param {{ backend: GitBackend, git?: unknown }} powers
 * @returns {GitOperations}
 */
export const makeGitOperations = ({ backend, git }) => {
  if (backend === null || typeof backend !== 'object') {
    throw new Error('makeGitOperations requires a backend');
  }
  return harden({ backend, pairingToken: gitPairingTokenFor(git) });
};
harden(makeGitOperations);

/**
 * Shared per-instance state: the `filesystemAt` memo and the mount lineage
 * sentinel are per Git *instance*, not per facet, so `reader`, `writer`, and
 * `rewriter` facets of the same `makeGitKit` call resolve the same cached
 * Filesystem for the same tree OID and reject the same foreign `PathEntry`
 * values.
 *
 * @typedef {object} GitState
 * @property {WritableGitWorktree} mount
 * @property {GitBackend} backend
 * @property {(value: unknown) => object | undefined} lineageOf
 * @property {object | undefined} mountLineage
 * @property {Map<string, object>} filesystemByTreeOid
 * @property {Promise<ReadOnlyGitWorktree> | undefined} readOnlyWorktreeP
 * @property {RootTracker} rootTracker
 */

/**
 * @typedef {object} RootTracker
 * @property {Promise<void>} tail
 * @property {boolean} initialized
 * @property {bigint} revision
 * @property {GitCommitPosition | null} position
 * @property {ReturnType<typeof makeChangeTopic<GitRootChange, undefined>>} changes
 * @property {ReturnType<typeof makeLatestTopic<GitRootSnapshot, undefined>>} latest
 * @property {number} subscriberCount
 * @property {((reason?: Error) => void) | undefined} stopWatching
 * @property {Promise<void> | undefined} watching
 * @property {Error | undefined} failure
 */

/**
 * The `this` context every shared method body below runs with: whichever
 * facet dispatched the call, but every one of them only reads `this.state`
 * (identical for all three facets of one instance) or `this.facets` (to
 * reach a named sibling), so a single hoisted function reference is safe to
 * assign into more than one facet's method table.
 *
 * @typedef {object} GitMethodThis
 * @property {GitState} state
 * @property {{ reader: ReadOnlyEndoGit, writer: ReadWriteEndoGit, rewriter: HistoryRewriteEndoGit }} facets
 */

/**
 * @param {GitPowers} powers
 * @returns {GitState}
 */
const initGitState = ({ mount, backend, lineageOf }) =>
  // Be careful not to freeze the state record (defineExoClassKit seals it,
  // but individual fields such as `readOnlyWorktreeP` and the
  // `filesystemByTreeOid` Map remain mutable).
  ({
    mount,
    backend,
    lineageOf,
    mountLineage: lineageOf(mount),
    filesystemByTreeOid: new Map(),
    readOnlyWorktreeP: undefined,
    rootTracker: {
      tail: Promise.resolve(),
      initialized: false,
      revision: 0n,
      position: null,
      changes: makeChangeTopic(),
      latest: makeLatestTopic(),
      subscriberCount: 0,
      stopWatching: undefined,
      watching: undefined,
      failure: undefined,
    },
  });

/**
 * The worktree authority a read-only Git exposes.  A writable Git hands
 * out the writable `mount`; a read-only Git must not expose write methods
 * through `worktree()` despite the facet's read-only intent.  `mount.readOnly()`
 * yields a structural read-only view that shares the same mount lineage.
 * Resolved lazily and memoized on `state` because `readOnly()` is a
 * synchronous attenuation but the read-only view is only needed once a read
 * flows through the reader facet.
 *
 * @overload
 * @param {GitState} state
 * @param {true} readOnly
 * @returns {Promise<ReadOnlyGitWorktree>}
 */
/**
 * @overload
 * @param {GitState} state
 * @param {false} readOnly
 * @returns {WritableGitWorktree}
 */
/**
 * @param {GitState} state
 * @param {boolean} readOnly
 * @returns {WritableGitWorktree | Promise<ReadOnlyGitWorktree>}
 */
const worktreeAuthorityFor = (state, readOnly) => {
  if (!readOnly) {
    return state.mount;
  }
  if (state.readOnlyWorktreeP === undefined) {
    state.readOnlyWorktreeP = Promise.resolve(E(state.mount).readOnly());
  }
  return state.readOnlyWorktreeP;
};

/**
 * Resolve one PathEntry to mount-relative segments after checking its
 * lineage.  The native backend receives these segments, never a host path.
 *
 * @param {GitState} state
 * @param {object} entry
 * @returns {Promise<string[]>}
 */
const entryToRepoSegments = async (state, entry) => {
  const otherLineage = state.lineageOf(entry);
  if (otherLineage === undefined) {
    throw new Error('entry is not a PathEntry minted for this Git worktree');
  }
  if (otherLineage !== state.mountLineage) {
    throw new Error(
      'entry was minted by a different mount lineage and cannot be used here',
    );
  }
  const segments = await E(entry).segments();
  return segments;
};
harden(entryToRepoSegments);

/**
 * Validate the destination of a linked worktree before handing it to the
 * backend and the narrowed mount.  Ordinary Git path designators may resolve
 * to the worktree root so that `designatorsToRepoPaths` can report its
 * user-facing root diagnostic; linked-worktree destinations must not.
 *
 * @param {string[]} segments
 * @returns {string[]}
 */
const assertWorktreeDestination = segments => {
  if (
    !Array.isArray(segments) ||
    segments.length === 0 ||
    segments.some(
      segment =>
        typeof segment !== 'string' ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('/') ||
        segment.includes('\\') ||
        /^\.git$/iu.test(segment) ||
        /^git~\d+$/iu.test(segment),
    )
  ) {
    throw new Error(
      'entry is not a non-empty confined mount-relative PathEntry',
    );
  }
  return [...segments];
};
harden(assertWorktreeDestination);

/**
 * Translate an array of PathEntry caps into the repo-relative path strings
 * that the backend (and the underlying git binary) accept.  Entries from a
 * different mount lineage are rejected before any path is exposed to git.
 *
 * @param {GitState} state
 * @param {readonly object[]} entries
 * @returns {Promise<string[]>}
 */
const entriesToRepoPaths = async (state, entries) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('entries must be a non-empty array of PathEntry values');
  }
  const paths = [];
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    const segments = await entryToRepoSegments(
      state,
      /** @type {object} */ (entry),
    );
    paths.push(segments.join('/'));
  }
  return paths;
};

/**
 * Split a worktree-relative path string into the segment list `mount.entry()`
 * accepts.  Empty components — from a leading, doubled, or trailing separator
 * — and explicit `.` steps collapse to no-ops, so `a/b`, `a//b`, `./a/b`, and
 * `a/b/` all designate the same path.  This is spelling normalization only,
 * and deliberately not a second authority model: a `..` segment is left intact
 * for the mount to contain (clamped at the worktree root), and a denied
 * segment is left for the mount to refuse.  A designator built solely from
 * dropped components (`''`, `.`, `./`, `/`, `//`) yields the empty segment
 * list, which denotes the worktree root; `designatorsToRepoPaths` rejects that
 * below rather than handing git an empty pathspec.
 *
 * @param {string} designator
 * @returns {string[]}
 */
const designatorToSegments = designator =>
  designator.split('/').filter(segment => segment !== '' && segment !== '.');

/**
 * Resolve strings through this Git's own worktree mount, then translate every
 * resulting entry through the same lineage-checking path used for caller-
 * supplied `PathEntry` values.  The mount owns confinement, denied segments,
 * and `..` resolution: this layer only normalizes the spelling of a path
 * string into the mount's segment form.
 *
 * @param {GitState} state
 * @param {readonly GitPathDesignator[]} designators
 * @returns {Promise<string[]>}
 */
const designatorsToRepoPaths = async (state, designators) => {
  await null;
  if (!Array.isArray(designators) || designators.length === 0) {
    throw new Error('path designators must be a non-empty array');
  }
  const entries = await Promise.all(
    designators.map(async designator => {
      if (typeof designator !== 'string') {
        return designator;
      }
      return E(state.mount).entry(harden(designatorToSegments(designator)));
    }),
  );
  const paths = await entriesToRepoPaths(state, entries);
  // A designator that normalizes to no segments — a root alias such as `.`,
  // `/`, or `//`, a `..` chain clamped at the root, or a caller-supplied root
  // `PathEntry` — would reach the backend as an empty pathspec, which git
  // reads as "everything".  Reject it here, before any backend mutation.
  const rootIndex = paths.indexOf('');
  if (rootIndex >= 0) {
    const designator = designators[rootIndex];
    const spelling = typeof designator === 'string' ? `: ${q(designator)}` : '';
    throw new Error(
      `path designator must not resolve to the Git worktree root${spelling}`,
    );
  }
  return paths;
};

/**
 * @param {unknown} ref
 * @returns {string}
 */
const refName = ref =>
  typeof ref === 'string' ? ref : /** @type {{ name: string }} */ (ref).name;

// #region Shared method bodies
//
// Every function below is referenced from two or three of the reader /
// writer / rewriter method tables further down (see `writerMethods` and
// `rewriterMethods`'s object spreads). None of them close over per-instance
// data directly: every one takes `this.state` (bound at call time by
// whichever facet dispatched the call) so the identical function reference
// is safe to share across facets of the same kit. This is what makes the
// facets cumulative without duplicating a single method body.

/** @this {GitMethodThis} */
async function worktree() {
  return worktreeAuthorityFor(this.state, false);
}

/** @this {GitMethodThis} */
async function worktreeReadOnly() {
  return worktreeAuthorityFor(this.state, true);
}

/** @this {GitMethodThis} */
async function worktreeList() {
  return harden(await this.state.backend.worktreeList());
}

/**
 * Add a linked worktree and derive a Git whose mount and backend both point at
 * the new checkout.  `subView()` is the confinement shift that makes entries
 * minted by the returned Git relative to the new checkout rather than to its
 * parent mount.
 *
 * @param {GitState} state
 * @param {object} entry
 * @param {GitWorktreeAddOptions} options
 * @param {boolean} allowHistoryRewrite
 * @returns {Promise<ReadWriteEndoGit | HistoryRewriteEndoGit>}
 */
const doWorktreeAdd = async (state, entry, options, allowHistoryRewrite) => {
  const segments = assertWorktreeDestination(
    await entryToRepoSegments(state, entry),
  );
  const opts = /** @type {GitWorktreeAddOptions} */ (options);
  const backendOptions = /** @type {{ ref?: string, newBranch?: string }} */ ({
    ...(opts.ref === undefined ? {} : { ref: refName(opts.ref) }),
    ...(opts.newBranch === undefined ? {} : { newBranch: opts.newBranch }),
  });
  const backend = await state.backend.worktreeAdd(segments, backendOptions);
  const mountWithSubView =
    /** @type {{ subView: (path: string[]) => Promise<WritableGitWorktree> }} */ (
      /** @type {unknown} */ (E(state.mount))
    );
  let destinationMount;
  try {
    destinationMount = await mountWithSubView.subView(segments);
  } catch (error) {
    try {
      await state.backend.worktreeRemove(segments);
    } catch (cleanupError) {
      throw new Error(
        'worktreeAdd failed to narrow the mount and cleanup also failed',
        { cause: cleanupError },
      );
    }
    throw error;
  }
  return makeGit(
    {
      mount: destinationMount,
      backend,
      lineageOf: state.lineageOf,
    },
    { allowHistoryRewrite },
  );
};
harden(doWorktreeAdd);

/**
 * @param {object} entry
 * @param {GitWorktreeAddOptions} options
 * @this {GitMethodThis}
 */
async function worktreeAdd(entry, options = {}) {
  return doWorktreeAdd(this.state, entry, options, false);
}

/**
 * @param {object} entry
 * @param {GitWorktreeAddOptions} options
 * @this {GitMethodThis}
 */
async function worktreeAddHistory(entry, options = {}) {
  return doWorktreeAdd(this.state, entry, options, true);
}

/**
 * @param {GitState} state
 * @param {GitStatusOptions} options
 * @returns {Promise<GitStatusResult>}
 */
const doStatus = async (state, options) => {
  const { maxCount, ...backendOptions } = options;
  if (
    maxCount !== undefined &&
    (!Number.isInteger(maxCount) || maxCount <= 0)
  ) {
    throw new Error('status.maxCount must be a positive integer');
  }
  const raw = await state.backend.status(backendOptions);
  const selected = maxCount === undefined ? raw : raw.slice(0, maxCount);
  const entries = selected.map(r =>
    harden({
      path: r.path,
      index: r.index,
      worktree: r.worktree,
      ...(r.renamedFrom !== undefined ? { renamedFrom: r.renamedFrom } : {}),
    }),
  );
  return harden({
    entries: harden(entries),
    truncated: maxCount !== undefined && raw.length > maxCount,
  });
};

/**
 * @param {GitStatusOptions} [options]
 * @this {GitMethodThis}
 */
async function status(options = {}) {
  return doStatus(this.state, options);
}

/**
 * @param {GitStatusOptions} [options]
 * @this {GitMethodThis}
 */
async function statusReadOnly(options = {}) {
  return doStatus(this.state, options);
}

/** @this {GitMethodThis} */
async function trackingStatus() {
  return this.state.backend.trackingStatus();
}

/**
 * @param {{ cached?: boolean, base?: unknown, head?: unknown, entries?: readonly object[], paths?: string[] }} options
 * @this {GitMethodThis}
 */
async function diff(options = {}) {
  const { state } = this;
  // Translate caller-supplied options to the backend shape:
  // - `base` and `head` accept GitRef-or-string; collapse to a string
  //   name the backend forwards to git unchanged.
  // - `entries` (PathEntry[]) get resolved to repo-relative paths with
  //   the same lineage check `add` uses. `paths` (string[]) passes
  //   through (callers can use either).
  const opts =
    /** @type {{ cached?: boolean, base?: unknown, head?: unknown, entries?: readonly object[], paths?: string[] }} */ (
      options
    );
  const resolved =
    /** @type {{ cached?: boolean, base?: string, head?: string, paths?: string[] }} */ ({});
  if (opts.cached !== undefined) resolved.cached = opts.cached;
  if (opts.base !== undefined) {
    resolved.base =
      typeof opts.base === 'string'
        ? opts.base
        : /** @type {{ name: string }} */ (opts.base).name;
  }
  if (opts.head !== undefined) {
    resolved.head =
      typeof opts.head === 'string'
        ? opts.head
        : /** @type {{ name: string }} */ (opts.head).name;
  }
  if (Array.isArray(opts.entries) && opts.entries.length > 0) {
    resolved.paths = await entriesToRepoPaths(state, opts.entries);
  } else if (Array.isArray(opts.paths) && opts.paths.length > 0) {
    resolved.paths = [...opts.paths];
  }
  return state.backend.diff(resolved);
}

/**
 * @param {GitLogOptions} options
 * @this {GitMethodThis}
 */
async function log(options = {}) {
  const { ref, ...rest } = /** @type {GitLogOptions} */ (options);
  const resolved = /** @type {GitBackendLogOptions} */ ({ ...rest });
  if (ref !== undefined) resolved.ref = refName(ref);
  return this.state.backend.log(resolved);
}

/**
 * @param {unknown} ref
 * @this {GitMethodThis}
 */
async function show(ref) {
  return this.state.backend.show(refName(ref));
}

/**
 * @param {unknown} ref
 * @this {GitMethodThis}
 */
async function revParse(ref) {
  return this.state.backend.revParse(refName(ref));
}

/**
 * @param {readonly GitPathDesignator[]} designators
 * @this {GitMethodThis}
 */
async function add(designators) {
  const { state } = this;
  const paths = await designatorsToRepoPaths(state, designators);
  return state.backend.add(paths);
}

/**
 * @param {readonly GitPathDesignator[]} designators
 * @param {GitRestoreOptions} options
 * @this {GitMethodThis}
 */
async function restore(designators, options = {}) {
  const { state } = this;
  const paths = await designatorsToRepoPaths(state, designators);
  return state.backend.restore(paths, options);
}

/**
 * @param {readonly GitPathDesignator[]} designators
 * @param {GitConflictSide} side
 * @this {GitMethodThis}
 */
async function checkoutConflict(designators, side) {
  const { state } = this;
  const paths = await designatorsToRepoPaths(state, designators);
  return state.backend.checkoutConflict(paths, side);
}

/**
 * Refresh follower state after a successful operation that may move HEAD.
 * The Git operation has already committed by this point, so a failure to
 * observe the new root terminates followers but does not misreport the
 * mutation itself as rejected.
 *
 * @param {GitState} state
 */
const notifyRootAfterMutation = async state => {
  try {
    await refreshRoot(state);
  } catch (caughtError) {
    await failRootTracker(state, /** @type {Error} */ (caughtError));
  }
};

/**
 * @param {string} message
 * @param {GitCommitOptions} options
 * @this {GitMethodThis}
 */
async function commit(message, options = {}) {
  const result = await this.state.backend.commit(message, options);
  await notifyRootAfterMutation(this.state);
  return result;
}

/**
 * @param {unknown} ref
 * @param {string} message
 * @this {GitMethodThis}
 */
async function reword(ref, message) {
  const result = await this.state.backend.reword(refName(ref), message);
  await notifyRootAfterMutation(this.state);
  return result;
}

/**
 * @param {unknown} ref
 * @param {GitCherryPickOptions} options
 * @this {GitMethodThis}
 */
async function cherryPick(ref, options = {}) {
  const result = await this.state.backend.cherryPick(refName(ref), options);
  await notifyRootAfterMutation(this.state);
  return result;
}

/** @this {GitMethodThis} */
async function currentBranch() {
  return this.state.backend.currentBranch();
}

/** @this {GitMethodThis} */
async function branches() {
  return this.state.backend.branches();
}

/**
 * @param {string} name
 * @param {GitCreateBranchOptions} options
 * @this {GitMethodThis}
 */
async function createBranch(name, options = {}) {
  const result = await this.state.backend.createBranch(name, options);
  await notifyRootAfterMutation(this.state);
  return result;
}

/**
 * @param {string} name
 * @param {GitDeleteBranchOptions} options
 * @this {GitMethodThis}
 */
async function deleteBranch(name, options = {}) {
  return this.state.backend.deleteBranch(name, options);
}

/**
 * @param {string} from
 * @param {string} to
 * @this {GitMethodThis}
 */
async function renameBranch(from, to) {
  return this.state.backend.renameBranch(from, to);
}

/**
 * @param {string} name
 * @this {GitMethodThis}
 */
async function switchBranch(name) {
  await this.state.backend.switchBranch(name);
  await notifyRootAfterMutation(this.state);
}

/**
 * @param {unknown} ref
 * @this {GitMethodThis}
 */
async function detach(ref) {
  await this.state.backend.detach(refName(ref));
  await notifyRootAfterMutation(this.state);
}

/**
 * @param {unknown} ref
 * @this {GitMethodThis}
 */
async function doSwitch(ref) {
  await this.state.backend.switch(refName(ref));
  await notifyRootAfterMutation(this.state);
}

/**
 * @param {unknown} ref
 * @param {GitMergeOptions} options
 * @this {GitMethodThis}
 */
async function merge(ref, options = {}) {
  const result = await this.state.backend.merge(refName(ref), options);
  await notifyRootAfterMutation(this.state);
  return result;
}

/**
 * @param {GitRebaseInput} input
 * @this {GitMethodThis}
 */
async function rebase(input) {
  const result = await this.state.backend.rebase(input);
  await notifyRootAfterMutation(this.state);
  return result;
}

/**
 * @param {GitStashPushOptions} options
 * @this {GitMethodThis}
 */
async function stashPush(options = {}) {
  const { state } = this;
  const opts = /** @type {GitStashPushOptions} */ (options);
  const resolved =
    /** @type {{ message?: string, paths?: string[], includeUntracked?: boolean }} */ ({});
  if (opts.message !== undefined) resolved.message = opts.message;
  if (opts.includeUntracked !== undefined) {
    resolved.includeUntracked = opts.includeUntracked;
  }
  if (Array.isArray(opts.entries) && opts.entries.length > 0) {
    resolved.paths = await entriesToRepoPaths(state, opts.entries);
  } else if (Array.isArray(opts.paths) && opts.paths.length > 0) {
    resolved.paths = [...opts.paths];
  }
  return state.backend.stashPush(resolved);
}

/** @this {GitMethodThis} */
async function stashList() {
  return this.state.backend.stashList();
}

/**
 * @param {number | undefined} index
 * @this {GitMethodThis}
 */
async function stashShow(index) {
  return this.state.backend.stashShow(index);
}

/**
 * @param {number | undefined} index
 * @this {GitMethodThis}
 */
async function stashApply(index) {
  return this.state.backend.stashApply(index);
}

/**
 * @param {number | undefined} index
 * @this {GitMethodThis}
 */
async function stashPop(index) {
  return this.state.backend.stashPop(index);
}

/**
 * @param {number | undefined} index
 * @this {GitMethodThis}
 */
async function stashDrop(index) {
  return this.state.backend.stashDrop(index);
}

/**
 * @param {unknown} ref
 * @this {GitMethodThis}
 */
async function tree(ref) {
  return this.state.backend.tree(refName(ref));
}

/**
 * Return the memoized immutable Filesystem for one canonical tree OID.
 *
 * @param {GitState} state
 * @param {string} treeOid
 * @returns {object}
 */
const filesystemForTree = (state, treeOid) => {
  const cached = state.filesystemByTreeOid.get(treeOid);
  if (cached !== undefined) {
    return cached;
  }
  const fsBackend = makeGitFsBackend({ backend: state.backend, treeOid });
  const description = `git-tree (${treeOid})`;
  const filesystem = readOnlyFs(wrapBackend(fsBackend, { description }));
  state.filesystemByTreeOid.set(treeOid, filesystem);
  return filesystem;
};

/**
 * @param {GitState} state
 * @param {{ treeOid: string, commitOid: string, treeAlgorithm: string } | null} resolved
 * @returns {GitCommitPosition | null}
 */
const positionForResolvedRoot = (state, resolved) => {
  if (resolved === null) {
    return null;
  }
  return harden({
    commitOid: resolved.commitOid,
    tree: harden({ algorithm: resolved.treeAlgorithm, hash: resolved.treeOid }),
    root: filesystemForTree(state, resolved.treeOid),
  });
};

/**
 * Update a root tracker while its serialization tail is held.
 *
 * @param {GitState} state
 * @param {{ treeOid: string, commitOid: string, treeAlgorithm: string } | null} resolved
 */
const updateRootTracker = async (state, resolved) => {
  const { rootTracker } = state;
  const nextPosition = positionForResolvedRoot(state, resolved);
  if (!rootTracker.initialized) {
    rootTracker.initialized = true;
    rootTracker.position = nextPosition;
    return;
  }
  const previousCommitOid = rootTracker.position?.commitOid;
  const nextCommitOid = nextPosition?.commitOid;
  if (previousCommitOid === nextCommitOid) {
    return;
  }
  if (nextPosition === null) {
    throw new Error('published Git root cannot return to an unborn state');
  }
  const fromRevision = rootTracker.revision;
  const toRevision = fromRevision + 1n;
  rootTracker.revision = toRevision;
  rootTracker.position = nextPosition;
  const transition = harden({
    type: /** @type {'transition'} */ ('transition'),
    fromRevision,
    toRevision,
    position: nextPosition,
  });
  const snapshot = harden({
    type: /** @type {'snapshot'} */ ('snapshot'),
    revision: toRevision,
    position: nextPosition,
  });
  await Promise.all([
    rootTracker.changes.publisher.next(transition),
    rootTracker.latest.publisher.next(snapshot),
  ]);
};

/**
 * Serialize one root observation with subscriptions and peer observations.
 *
 * @param {GitState} state
 * @param {{ treeOid: string, commitOid: string, treeAlgorithm: string } | null | undefined} observed
 */
const refreshRoot = (state, observed = undefined) => {
  const { rootTracker } = state;
  const operation = rootTracker.tail.then(async () => {
    if (rootTracker.failure !== undefined) {
      throw rootTracker.failure;
    }
    const resolved =
      observed === undefined ? await state.backend.resolveRoot() : observed;
    await updateRootTracker(state, resolved);
  });
  rootTracker.tail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
};

/**
 * Terminate both follower topics with one sticky source failure.
 *
 * @param {GitState} state
 * @param {Error} error
 */
const failRootTracker = async (state, error) => {
  const { rootTracker } = state;
  if (rootTracker.failure !== undefined) return;
  rootTracker.failure = error;
  await Promise.all([
    rootTracker.changes.publisher.throw(error),
    rootTracker.latest.publisher.throw(error),
  ]);
};

/**
 * Start the backend-owned watcher when the first root subscriber arrives.
 *
 * @param {GitState} state
 */
const startRootWatcher = state => {
  const { rootTracker } = state;
  if (rootTracker.watching !== undefined) return;
  let stopWatching;
  const stopped = new Promise((_resolve, reject) => {
    stopWatching = reject;
  });
  stopped.catch(() => {});
  rootTracker.stopWatching = stopWatching;
  const { position } = rootTracker;
  const after =
    position === null
      ? null
      : harden({
          commitOid: position.commitOid,
          treeOid: position.tree.hash,
          treeAlgorithm: position.tree.algorithm,
        });
  rootTracker.watching = (async () => {
    try {
      for await (const resolved of state.backend.watchRoot({
        cancelled: /** @type {Promise<never>} */ (stopped),
        after,
      })) {
        await refreshRoot(state, resolved);
      }
      if (rootTracker.stopWatching !== undefined) {
        throw new Error('Git root watcher ended before cancellation');
      }
    } catch (caughtError) {
      const error = /** @type {Error} */ (caughtError);
      if (rootTracker.stopWatching !== undefined) {
        await failRootTracker(state, error);
      }
    }
  })().finally(() => {
    rootTracker.watching = undefined;
    rootTracker.stopWatching = undefined;
  });
};

/**
 * @param {GitState} state
 */
const releaseRootWatcher = state => {
  const { rootTracker } = state;
  rootTracker.subscriberCount -= 1;
  if (rootTracker.subscriberCount === 0) {
    const stop = rootTracker.stopWatching;
    rootTracker.stopWatching = undefined;
    stop?.(new Error('Git root watcher has no subscribers'));
  }
};

/**
 * Atomically subscribe and capture the initial root snapshot.
 *
 * @param {GitState} state
 * @param {'changes' | 'latest'} mode
 */
const openRootSubscription = (state, mode) => {
  const { rootTracker } = state;
  let opened;
  const operation = rootTracker.tail.then(async () => {
    if (rootTracker.failure !== undefined) {
      if (rootTracker.subscriberCount !== 0) {
        throw rootTracker.failure;
      }
      rootTracker.failure = undefined;
      rootTracker.initialized = false;
      rootTracker.revision = 0n;
      rootTracker.position = null;
      rootTracker.changes = makeChangeTopic();
      rootTracker.latest = makeLatestTopic();
    }
    // Subscribe before resolving the root. If this observation publishes a
    // concurrent advancement, the revision filter in the iterator suppresses
    // the duplicate after yielding the newer initial snapshot.
    const subscription =
      mode === 'changes'
        ? rootTracker.changes.subscribe()
        : rootTracker.latest.subscribe();
    await updateRootTracker(state, await state.backend.resolveRoot());
    const snapshot = harden({
      type: /** @type {'snapshot'} */ ('snapshot'),
      revision: rootTracker.revision,
      position: rootTracker.position,
    });
    rootTracker.subscriberCount += 1;
    opened = { subscription, snapshot };
  });
  rootTracker.tail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation.then(() => {
    startRootWatcher(state);
    return opened;
  });
};

/**
 * @param {GitState} state
 * @param {'changes' | 'latest'} mode
 * @param {FollowRootOptions} options
 */
const rootIterator = async function* rootChangesIterator(state, mode, options) {
  const { subscription, snapshot } =
    /** @type {{ subscription: Reader<GitRootChange, undefined>, snapshot: GitRootSnapshot }} */ (
      await openRootSubscription(state, mode)
    );
  let deliveredRevision = snapshot.revision;
  try {
    yield snapshot;
    for (;;) {
      const next = subscription.next();
      let result;
      if (options.cancelled === undefined) {
        // eslint-disable-next-line no-await-in-loop
        result = await next;
      } else {
        // eslint-disable-next-line no-await-in-loop
        result = await Promise.race([next, options.cancelled]);
      }
      if (result.done) return;
      const revision = /** @type {bigint} */ (
        result.value.type === 'transition'
          ? result.value.toRevision
          : result.value.revision
      );
      if (revision > deliveredRevision) {
        deliveredRevision = revision;
        yield result.value;
      }
    }
  } finally {
    subscription.return(undefined).catch(() => {});
    releaseRootWatcher(state);
  }
};

/**
 * @param {FollowRootOptions} options
 * @this {GitMethodThis}
 */
function followRootChanges(options = {}) {
  return readerFromIterator(rootIterator(this.state, 'changes', options));
}

/**
 * @param {FollowRootOptions} options
 * @this {GitMethodThis}
 */
function followLatestRoot(options = {}) {
  return readerFromIterator(rootIterator(this.state, 'latest', options));
}

/**
 * @param {unknown} ref
 * @this {GitMethodThis}
 */
async function filesystemAt(ref) {
  const { state } = this;
  const { treeOid } = await state.backend.resolveTree(refName(ref));
  return filesystemForTree(state, treeOid);
}

/** Every facet's `readOnly()` attenuates to the same pre-existing reader. */
/** @this {GitMethodThis} */
function attenuateToReadOnly() {
  return this.facets.reader;
}

/**
 * Downscope to a pre-existing sibling facet of the same instance. The scope
 * vocabulary is closed and strictly non-escalating per facet — reader
 * accepts only `'reader'`, writer accepts `'reader' | 'writer'`, rewriter
 * accepts all three (`scopeReader` / `scopeWriter` / `scopeRewriter` in
 * `interfaces.js`) — so an unknown name *or* an escalation attempt is
 * rejected by the guard before this body runs, with the same rejection
 * shape either way. Repeated calls with the same name return the identical
 * facet reference (`this.facets` is fixed per instance), and no internal
 * state record is ever returned — only the other guarded exo facets of
 * this kit.
 *
 * @param {'reader' | 'writer' | 'rewriter'} name
 * @this {GitMethodThis}
 */
function scope(name) {
  return this.facets[name];
}

// #endregion

const readerMethods = harden({
  help: makeHelp(gitHelp),
  worktree: worktreeReadOnly,
  status: statusReadOnly,
  trackingStatus,
  diff,
  log,
  show,
  revParse,
  currentBranch,
  branches,
  stashList,
  stashShow,
  tree,
  filesystemAt,
  followLatestRoot,
  followRootChanges,
  worktreeList,
  scope,
  readOnly: attenuateToReadOnly,
});

const writerMethods = harden({
  ...readerMethods,
  worktree,
  worktreeAdd,
  status,
  add,
  restore,
  checkoutConflict,
  commit,
  createBranch,
  deleteBranch,
  renameBranch,
  switchBranch,
  detach,
  switch: doSwitch,
  merge,
  stashPush,
  stashApply,
  stashPop,
  stashDrop,
});

const rewriterMethods = harden({
  ...writerMethods,
  worktreeAdd: worktreeAddHistory,
  reword,
  cherryPick,
  rebase,
});

/** @type {((exo: unknown, facetName?: string) => boolean) | undefined} */
let isGitKitInstance;

/**
 * Per-instance pairing identity: every facet minted for one `makeGitKit`
 * call maps to that call's own ephemeral pairing token — a fresh, private,
 * unforgeable brand minted for that call alone — so a `GitOperations`
 * capability can be verified against the specific `git` it claims to pair
 * with, not merely against the kit type, and not against `backend` object
 * identity (which is real authority, not a pairing marker). Populated in
 * `makeGitKit`, read by `gitPairingTokenFor`. Never persisted: a
 * reincarnated Git formula calls `makeGitKit` again and gets a new token.
 *
 * @type {WeakMap<object, object>}
 */
const gitInstancePairingTokens = new WeakMap();

/**
 * The exo class kit: one instance, three cumulative facets sharing
 * `GitState`. `reader`'s methods are a subset of `writer`'s, which are a
 * subset of `rewriter`'s (see `readerMethods` / `writerMethods` /
 * `rewriterMethods` above) — every method that exists on a facet is a
 * shared function reference, not a copy, so there is exactly one
 * implementation per Git operation regardless of how many facets expose
 * it. Posture is facet membership: which object a caller holds *is* its
 * authority, checked with `isGitKitInstance(cap, facetName)` below rather
 * than a side-table stamp.
 */
const makeGitKitInstance = defineExoClassKit(
  'Git',
  {
    reader: GitReaderInterface,
    writer: GitWriterInterface,
    rewriter: GitRewriterInterface,
  },
  initGitState,
  {
    reader: readerMethods,
    writer: writerMethods,
    rewriter: rewriterMethods,
  },
  {
    receiveInstanceTester(isInstance) {
      isGitKitInstance = isInstance;
    },
  },
);

/**
 * Mint one Git instance and return all three cumulative facets plus the
 * host-private posture-testing hook. Composing host code (the daemon's
 * `provideGit` formula handler, in-process tests) calls this directly when
 * it needs more than one posture from the same instance, or needs the
 * `reader`/`writer`/`rewriter` identity for later `scope`/`readOnly`
 * comparisons. `makeGit` below is the narrower, overload-typed entry point
 * most callers want.
 *
 * @param {GitPowers} powers
 * @returns {{ reader: ReadOnlyEndoGit, writer: ReadWriteEndoGit, rewriter: HistoryRewriteEndoGit }}
 */
export const makeGitKit = powers => {
  const kit =
    /** @type {{ reader: ReadOnlyEndoGit, writer: ReadWriteEndoGit, rewriter: HistoryRewriteEndoGit }} */ (
      makeGitKitInstance(powers)
    );
  // A fresh, private brand for this call alone: ephemeral (never written to
  // a formula), and independent of `powers.backend` identity, so pairing
  // verification does not ride on the same object as the backend's real
  // authority. Every reincarnation of the owning Git formula calls
  // `makeGitKit` again and mints a new one.
  const pairingToken = harden({});
  gitInstancePairingTokens.set(kit.reader, pairingToken);
  gitInstancePairingTokens.set(kit.writer, pairingToken);
  gitInstancePairingTokens.set(kit.rewriter, pairingToken);
  return kit;
};
harden(makeGitKit);

/**
 * Host-private accessor: the ephemeral pairing token a daemon-minted `git`
 * facet was minted with, or `undefined` for a fake, foreign, or
 * non-daemon-minted value. Lets a caller of `makeGitRemote` (or
 * `makeGitRemote` itself) verify that a `GitOperations` capability was
 * actually minted alongside the specific `git` it is paired with, rather
 * than merely being *some* daemon-minted operations value.
 *
 * @param {unknown} git
 * @returns {object | undefined}
 */
export const gitPairingTokenFor = git =>
  typeof git === 'object' && git !== null
    ? gitInstancePairingTokens.get(git)
    : undefined;
harden(gitPairingTokenFor);

/**
 * Host-private accessor: returns whether a daemon-minted Git exo is
 * read-only, or undefined for fakes / remotes not minted in this vat.
 *
 * @param {unknown} git
 * @returns {boolean | undefined}
 */
export const isGitReadOnly = git => {
  if (isGitKitInstance === undefined) {
    return undefined;
  }
  if (isGitKitInstance(git, 'reader')) {
    return true;
  }
  if (isGitKitInstance(git, 'writer') || isGitKitInstance(git, 'rewriter')) {
    return false;
  }
  return undefined;
};
harden(isGitReadOnly);

/**
 * Host-private accessor: returns whether a daemon-minted Git exo has
 * history-rewrite authority, or undefined for fakes / remotes not minted
 * here.
 *
 * @param {unknown} git
 * @returns {boolean | undefined}
 */
export const isGitHistoryRewrite = git => {
  if (isGitKitInstance === undefined) {
    return undefined;
  }
  if (isGitKitInstance(git, 'rewriter')) {
    return true;
  }
  if (isGitKitInstance(git, 'reader') || isGitKitInstance(git, 'writer')) {
    return false;
  }
  return undefined;
};
harden(isGitHistoryRewrite);

/**
 * Construct the public Git capability exo. Internally mints a three-facet
 * exo class kit (`reader` / `writer` / `rewriter`, see `makeGitKit`) and
 * returns the single facet `opts` selects — the call-site contract is
 * unchanged from the single-class implementation this replaces.
 *
 * @overload
 * @param {GitPowers} powers
 * @param {GitMakeReadOnlyOptions} opts
 * @returns {ReadOnlyEndoGit}
 */
/**
 * @overload
 * @param {GitPowers} powers
 * @param {GitMakeHistoryRewriteOptions} opts
 * @returns {HistoryRewriteEndoGit}
 */
/**
 * @overload
 * @param {GitPowers} powers
 * @param {GitMakeReadWriteOptions} [opts]
 * @returns {ReadWriteEndoGit}
 */
/**
 * @overload
 * @param {GitPowers} powers
 * @param {GitMakeReadWriteOrHistoryRewriteOptions} opts
 * @returns {ReadWriteEndoGit | HistoryRewriteEndoGit}
 */
/**
 * @overload
 * @param {GitPowers} powers
 * @param {GitMakeOptions} [opts]
 * @returns {EndoGit}
 */
/**
 * @param {GitPowers} powers
 * @param {GitMakeOptions} [opts]
 * @returns {EndoGit}
 */
export const makeGit = (
  powers,
  { readOnly = false, allowHistoryRewrite = false } = {},
) => {
  const { reader, writer, rewriter } = makeGitKit(powers);
  if (readOnly) {
    return reader;
  }
  if (allowHistoryRewrite) {
    return rewriter;
  }
  return writer;
};
harden(makeGit);

/**
 * Phase 1 stub backend.  Every method throws "not yet implemented".
 * Phase 2 replaces this with `makeNativeGitBackend` which runs the
 * sanitized git binary in a confined environment derived from the
 * fae-git-tool-reference work.
 *
 * @returns {GitBackend}
 */
export const makeNotYetImplementedBackend = () => {
  const fail = name => {
    throw new Error(`Git backend method ${q(name)} is not yet implemented`);
  };
  return harden({
    assertRepositoryRoot: async () => undefined,
    assertNoExecutableRepoConfig: async () =>
      fail('assertNoExecutableRepoConfig'),
    status: async () => fail('status'),
    worktreeList: async () => fail('worktreeList'),
    worktreeAdd: async () => fail('worktreeAdd'),
    worktreeRemove: async () => fail('worktreeRemove'),
    diff: async () => fail('diff'),
    log: async () => fail('log'),
    show: async () => fail('show'),
    revParse: async () => fail('revParse'),
    add: async () => fail('add'),
    restore: async () => fail('restore'),
    checkoutConflict: async () => fail('checkoutConflict'),
    commit: async () => fail('commit'),
    reword: async () => fail('reword'),
    cherryPick: async () => fail('cherryPick'),
    currentBranch: async () => fail('currentBranch'),
    trackingStatus: async () => fail('trackingStatus'),
    branches: async () => fail('branches'),
    createBranch: async () => fail('createBranch'),
    deleteBranch: async () => fail('deleteBranch'),
    renameBranch: async () => fail('renameBranch'),
    switchBranch: async () => fail('switchBranch'),
    detach: async () => fail('detach'),
    switch: async () => fail('switch'),
    merge: async () => fail('merge'),
    rebase: async () => fail('rebase'),
    stashPush: async () => fail('stashPush'),
    stashList: async () => fail('stashList'),
    stashShow: async () => fail('stashShow'),
    stashApply: async () => fail('stashApply'),
    stashPop: async () => fail('stashPop'),
    stashDrop: async () => fail('stashDrop'),
    tree: async () => fail('tree'),
    remoteFetch: async () => fail('remoteFetch'),
    remotePush: async () => fail('remotePush'),
    resolveTree: async () => fail('resolveTree'),
    resolveRoot: async () => fail('resolveRoot'),
    watchRoot: () => {
      fail('watchRoot');
      return /** @type {AsyncIterable<null>} */ ({
        async *[Symbol.asyncIterator]() {
          yield* [];
        },
      });
    },
    lsTree: async () => fail('lsTree'),
    readBlobBytes: async () => fail('readBlobBytes'),
    streamBlobBytes: () => {
      fail('streamBlobBytes');
      // Unreachable; satisfies the typedef's async-iterable return.
      return /** @type {AsyncIterable<Uint8Array>} */ ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true, value: undefined };
            },
          };
        },
      });
    },
  });
};
harden(makeNotYetImplementedBackend);
