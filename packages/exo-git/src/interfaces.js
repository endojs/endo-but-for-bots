// @ts-check

import { M } from '@endo/patterns';

import {
  DEFAULT_REMOTE_REF_STRING_LIMIT,
  DEFAULT_REMOTE_TEXT_LIMIT,
  DEFAULT_REMOTE_UPDATED_REFS_LIMIT,
} from './result-bounds.js';

// #region Shape primitives

const GitDirectionShape = M.or(M.eq('fetch'), M.eq('push'));

const GitIndexStatusShape = M.or(
  'added',
  'clean',
  'conflicted',
  'copied',
  'deleted',
  'modified',
  'renamed',
);

const GitWorktreeStatusShape = M.or(
  'clean',
  'conflicted',
  'deleted',
  'ignored',
  'modified',
  'untracked',
);

const GitStatusEntryShape = M.splitRecord(
  {
    index: GitIndexStatusShape,
    path: M.string(),
    worktree: GitWorktreeStatusShape,
  },
  {
    renamedFrom: M.string(),
  },
);

const GitStatusOptionsShape = M.splitRecord(
  {},
  {
    maxCount: M.number(),
    untracked: M.or('all', 'normal', 'no'),
  },
  harden({}),
);

const GitStatusResultShape = M.splitRecord(
  {
    entries: M.arrayOf(GitStatusEntryShape),
    truncated: M.boolean(),
  },
  {},
  harden({}),
);

const GitTrackingStatusShape = M.splitRecord(
  {
    ahead: M.number(),
    behind: M.number(),
    detached: M.boolean(),
  },
  {
    branch: M.string(),
    upstream: M.string(),
  },
  harden({}),
);

const GitRefKindShape = M.or('branch', 'commit', 'detached', 'tag');

const GitRefShape = M.splitRecord(
  {
    kind: GitRefKindShape,
    name: M.string(
      harden({ stringLengthLimit: DEFAULT_REMOTE_REF_STRING_LIMIT }),
    ),
  },
  {
    oid: M.string(
      harden({ stringLengthLimit: DEFAULT_REMOTE_REF_STRING_LIMIT }),
    ),
  },
);
const RefArgShape = M.or(M.string(), GitRefShape);

const GitCommitShape = M.splitRecord(
  {
    oid: M.string(),
    summary: M.string(),
  },
  {
    author: M.string(),
    committedAt: M.number(),
  },
);

const GitWorktreeEntryShape = M.splitRecord(
  {
    path: M.string(),
    bare: M.boolean(),
    detached: M.boolean(),
    locked: M.boolean(),
    prunable: M.boolean(),
  },
  {
    head: M.string(),
    branch: M.string(),
  },
  harden({}),
);

const GitWorktreeAddOptionsShape = M.splitRecord(
  {},
  {
    ref: RefArgShape,
    newBranch: M.string(),
  },
  harden({}),
);

const GitCommitOptionsShape = M.splitRecord(
  {},
  {
    amend: M.boolean(),
  },
  harden({}),
);

const GitConflictSideShape = M.or(M.eq('ours'), M.eq('theirs'));

const GitCherryPickOptionsShape = M.splitRecord(
  {},
  { noCommit: M.boolean() },
  harden({}),
);

export const GitRebaseStartInputShape = M.splitRecord(
  { mode: 'start', upstream: M.string() },
  { autosquash: M.boolean() },
  harden({}),
);
harden(GitRebaseStartInputShape);

const GitRebaseControlInputShape = M.splitRecord(
  { mode: M.or('continue', 'abort', 'skip') },
  {},
  harden({}),
);

const GitRebaseInputShape = M.or(
  GitRebaseStartInputShape,
  GitRebaseControlInputShape,
);

const GitRefUpdateResultShape = M.or(
  'created',
  'updated',
  'up-to-date',
  'fast-forward',
  'forced',
  'pruned',
  'rejected',
);

const RemoteRefUpdateShape = M.splitRecord(
  {
    remote: M.string(
      harden({ stringLengthLimit: DEFAULT_REMOTE_REF_STRING_LIMIT }),
    ),
    result: GitRefUpdateResultShape,
  },
  { local: GitRefShape },
  harden({}),
);

// `updatedRefs` and `text` are network-sourced: a fetch/push result
// originates from the remote (see `native-git-backend.js`'s `remoteFetch` /
// `remotePush`), and `git-remote.js` retains the result in `GitRemote`'s
// durable audit log.  The bounds below are the hard structural ceiling; a
// malformed or oversized result is rejected here regardless of which backend
// produced it.  `makeGitRemote`'s `resultLimits` option transparently
// truncates a legitimately large result to fit under this ceiling before it
// ever reaches this guard (see `result-bounds.js`).
const RemoteOperationResultShape = M.splitRecord(
  {
    updatedRefs: M.arrayOf(
      RemoteRefUpdateShape,
      harden({ arrayLengthLimit: DEFAULT_REMOTE_UPDATED_REFS_LIMIT }),
    ),
    text: M.string(harden({ stringLengthLimit: DEFAULT_REMOTE_TEXT_LIMIT })),
  },
  { droppedUpdatedRefsCount: M.number() },
  harden({}),
);

const RemotePullResultShape = M.splitRecord(
  {
    fetch: RemoteOperationResultShape,
    integration: M.or('up-to-date', 'fast-forward', 'merge', 'rebase'),
    head: GitRefShape,
  },
  {},
  harden({}),
);

const RemotePolicyRequiredShape = {
  url: M.string(),
  allowedDirections: M.arrayOf(GitDirectionShape),
  fetchRefspecs: M.arrayOf(M.string()),
  pushRefspecs: M.arrayOf(M.string()),
};

const RemotePolicyOptionalShape = {
  defaultPullRef: M.string(),
  allowedBranches: M.arrayOf(M.string()),
  allowForcePush: M.boolean(),
  allowTags: M.boolean(),
  allowDelete: M.boolean(),
  allowLocalFileTransport: M.boolean(),
};

const RemoteSnapshotShape = M.splitRecord(
  { ...RemotePolicyRequiredShape, name: M.string() },
  RemotePolicyOptionalShape,
  harden({}),
);

const RemoteControllerSnapshotShape = M.splitRecord(
  { ...RemotePolicyRequiredShape, name: M.string(), revoked: M.boolean() },
  RemotePolicyOptionalShape,
  harden({}),
);

const GitCredentialKindShape = M.or('bearer', 'basic');

const GitCredentialSnapshotShape = M.splitRecord(
  {
    kind: GitCredentialKindShape,
    audience: M.string(),
    available: M.boolean(),
    revoked: M.boolean(),
  },
  {},
  harden({}),
);

// `GitReadWriteCommitOptionsShape` is the argument-sensitive authority split:
// the writer facet's `commit` accepts `amend` only as an explicit `false` (or
// omitted), so a caller holding ordinary write authority can never smuggle a
// history rewrite past the guard by supplying `amend: true`. The rewriter
// facet uses the unrestricted `GitCommitOptionsShape` below instead.
const GitReadWriteCommitOptionsShape = M.splitRecord(
  {},
  { amend: M.eq(false) },
  harden({}),
);

// `scope`'s closed vocabulary is a strict, per-facet subset: a facet may
// only select itself or a lower-authority sibling, never a higher one — the
// guard itself is the escalation barrier, not a runtime check in the method
// body. An unrecognized name and an escalation attempt reject with the same
// guard-rejection shape.
const GitReaderScopeNameShape = M.eq('reader');
const GitWriterScopeNameShape = M.or('reader', 'writer');
const GitRewriterScopeNameShape = M.or('reader', 'writer', 'rewriter');

// #endregion

/**
 * The single per-method guard table every facet interface is generated
 * from. A facet's `M.interface(...)` is a projection of this table (see
 * `pickGuards` below), not an independently hand-written duplicate: adding or
 * reshaping a method here is the one edit that reaches every facet guard,
 * the `GitInterface` compatibility export, and (via the conformance test in
 * `test/kit-conformance.test.js`) the checked-in `types.ts` and generated
 * code-mode prompt surfaces that must stay aligned with it.
 *
 * `commit` is entered twice because its guard is one of the two
 * argument-sensitive authority splits in the whole table (`commit`'s
 * `amend` split, `scope`'s per-facet closed vocabulary); every other method
 * has exactly one guard shared by every facet that carries it.
 */
export const GIT_METHOD_GUARDS = harden({
  add: M.callWhen(M.arrayOf(M.or(M.remotable(), M.string()))).returns(
    M.undefined(),
  ),
  branches: M.callWhen().returns(M.arrayOf(GitRefShape)),
  checkoutConflict: M.callWhen(
    M.arrayOf(M.or(M.remotable(), M.string())),
    GitConflictSideShape,
  ).returns(M.undefined()),
  cherryPick: M.callWhen(RefArgShape)
    .optional(GitCherryPickOptionsShape)
    .returns(M.string()),
  commit: M.callWhen(M.string())
    .optional(GitCommitOptionsShape)
    .returns(GitCommitShape),
  commitReadWrite: M.callWhen(M.string())
    .optional(GitReadWriteCommitOptionsShape)
    .returns(GitCommitShape),
  createBranch: M.callWhen(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(GitRefShape),
  currentBranch: M.callWhen().returns(M.or(GitRefShape, M.undefined())),
  deleteBranch: M.callWhen(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.undefined()),
  detach: M.callWhen(RefArgShape).returns(M.undefined()),
  diff: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.string()),
  filesystemAt: M.callWhen(RefArgShape).returns(M.remotable('Filesystem')),
  log: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.arrayOf(GitCommitShape)),
  merge: M.callWhen(RefArgShape)
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.string()),
  rebase: M.callWhen(GitRebaseInputShape).returns(M.string()),
  readOnly: M.call().returns(M.remotable('Git')),
  renameBranch: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  restore: M.callWhen(M.arrayOf(M.or(M.remotable(), M.string())))
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.undefined()),
  reword: M.callWhen(RefArgShape, M.string()).returns(GitCommitShape),
  revParse: M.callWhen(RefArgShape).returns(GitRefShape),
  scopeReader: M.call(GitReaderScopeNameShape).returns(M.remotable('Git')),
  scopeRewriter: M.call(GitRewriterScopeNameShape).returns(M.remotable('Git')),
  scopeWriter: M.call(GitWriterScopeNameShape).returns(M.remotable('Git')),
  show: M.callWhen(RefArgShape).returns(M.string()),
  stashApply: M.callWhen().optional(M.number()).returns(M.undefined()),
  stashDrop: M.callWhen().optional(M.number()).returns(M.undefined()),
  stashList: M.callWhen().returns(M.arrayOf(M.string())),
  stashPop: M.callWhen().optional(M.number()).returns(M.undefined()),
  stashPush: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.string()),
  stashShow: M.callWhen().optional(M.number()).returns(M.string()),
  status: M.callWhen()
    .optional(GitStatusOptionsShape)
    .returns(GitStatusResultShape),
  switch: M.callWhen(RefArgShape).returns(M.undefined()),
  switchBranch: M.callWhen(M.string()).returns(M.undefined()),
  tree: M.callWhen(RefArgShape).returns(M.remotable()),
  trackingStatus: M.callWhen().returns(GitTrackingStatusShape),
  // `callWhen` so a read-only Git may resolve its worktree authority
  // through `mount.readOnly()` (which yields a promise of the
  // structural read-only view) before the return shape is matched; a
  // writable Git returns its mount synchronously and is unaffected.
  worktree: M.callWhen().returns(M.remotable()),
  worktreeAdd: M.callWhen(M.remotable())
    .optional(GitWorktreeAddOptionsShape)
    .returns(M.remotable('Git')),
  worktreeList: M.callWhen().returns(M.arrayOf(GitWorktreeEntryShape)),
});

/**
 * Facet membership: every reader method name also appears in
 * `GIT_WRITER_METHODS`, and every writer method name also appears in
 * `GIT_REWRITER_METHODS` — the cumulative-facet requirement expressed as
 * data instead of three independently maintained method lists.
 */
export const GIT_READER_METHODS = harden([
  'branches',
  'currentBranch',
  'diff',
  'filesystemAt',
  'log',
  'readOnly',
  'revParse',
  'scope',
  'show',
  'stashList',
  'stashShow',
  'status',
  'trackingStatus',
  'tree',
  'worktree',
  'worktreeList',
]);

export const GIT_WRITER_ONLY_METHODS = harden([
  'add',
  'checkoutConflict',
  'createBranch',
  'deleteBranch',
  'detach',
  'merge',
  'renameBranch',
  'restore',
  'stashApply',
  'stashDrop',
  'stashPop',
  'stashPush',
  'switch',
  'switchBranch',
  'worktreeAdd',
]);
export const GIT_WRITER_METHODS = harden([
  ...GIT_READER_METHODS,
  ...GIT_WRITER_ONLY_METHODS,
  'commit',
]);

export const GIT_REWRITER_ONLY_METHODS = harden([
  'cherryPick',
  'rebase',
  'reword',
]);
export const GIT_REWRITER_METHODS = harden([
  ...GIT_WRITER_METHODS,
  ...GIT_REWRITER_ONLY_METHODS,
]);

/** @type {Record<'reader' | 'writer' | 'rewriter', string>} */
const SCOPE_GUARD_NAME_BY_LEVEL = harden({
  reader: 'scopeReader',
  rewriter: 'scopeRewriter',
  writer: 'scopeWriter',
});

/**
 * Project `GIT_METHOD_GUARDS` onto a named method list, substituting the two
 * argument-sensitive guards (`commit`'s amend split, `scope`'s per-facet
 * closed vocabulary) for the requested authority level.
 *
 * @param {readonly string[]} methodNames
 * @param {'reader' | 'writer' | 'rewriter'} level
 * @returns {Record<string, import('@endo/patterns').MethodGuard>}
 */
const pickGuards = (methodNames, level) =>
  Object.fromEntries(
    methodNames.map(name => {
      if (name === 'commit' && level === 'writer') {
        return [name, GIT_METHOD_GUARDS.commitReadWrite];
      }
      if (name === 'scope') {
        return [name, GIT_METHOD_GUARDS[SCOPE_GUARD_NAME_BY_LEVEL[level]]];
      }
      return [name, GIT_METHOD_GUARDS[name]];
    }),
  );

export const GitReaderInterface = M.interface(
  'GitReader',
  pickGuards(GIT_READER_METHODS, 'reader'),
);

export const GitWriterInterface = M.interface(
  'GitWriter',
  pickGuards(GIT_WRITER_METHODS, 'writer'),
);

export const GitRewriterInterface = M.interface(
  'GitRewriter',
  pickGuards(GIT_REWRITER_METHODS, 'rewriter'),
);

/**
 * Compatibility export: the full method set (equivalent to
 * `GitRewriterInterface`, retagged) for consumers that still walk a single
 * flat Git guard rather than the three-facet kit (`@endo/agent-tools`'s
 * JSON-tool and code-mode prompt generation).
 */
export const GitInterface = M.interface(
  'Git',
  pickGuards(GIT_REWRITER_METHODS, 'rewriter'),
);

export const GitTreeInterface = M.interface('EndoGitTree', {
  // `callWhen` so the settled value (not the promise) is guarded against
  // the return shape, matching the GitInterface convention above.
  archiveLossless: M.callWhen().returns(M.boolean()),
  archiveTar: M.call().returns(M.remotable()),
  has: M.callWhen().rest(M.arrayOf(M.string())).returns(M.boolean()),
  list: M.callWhen().rest(M.arrayOf(M.string())).returns(M.arrayOf(M.string())),
  lookup: M.callWhen(M.or(M.string(), M.arrayOf(M.string()))).returns(
    M.remotable(),
  ),
});

export const GitRemoteInterface = M.interface('GitRemote', {
  fetch: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(RemoteOperationResultShape),
  inspect: M.callWhen().returns(RemoteSnapshotShape),
  pull: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(RemotePullResultShape),
  push: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(RemoteOperationResultShape),
});

export const GitRemoteControllerInterface = M.interface('GitRemoteController', {
  audit: M.call().returns(M.promise()),
  inspect: M.callWhen().returns(RemoteControllerSnapshotShape),
  revoke: M.call().returns(M.promise()),
  setAllowedBranches: M.call(M.arrayOf(M.string())).returns(M.promise()),
  setAllowedDirections: M.call(M.arrayOf(GitDirectionShape)).returns(
    M.promise(),
  ),
  setAllowDelete: M.call(M.boolean()).returns(M.promise()),
  setAllowForcePush: M.call(M.boolean()).returns(M.promise()),
  setAllowTags: M.call(M.boolean()).returns(M.promise()),
  setFetchRefspecs: M.call(M.arrayOf(M.string())).returns(M.promise()),
  setPushRefspecs: M.call(M.arrayOf(M.string())).returns(M.promise()),
});

export const GitCredentialControllerInterface = M.interface(
  'GitCredentialController',
  {
    inspect: M.callWhen().returns(GitCredentialSnapshotShape),
    revoke: M.call().returns(M.promise()),
    rotate: M.call(M.recordOf(M.string(), M.any())).returns(M.promise()),
  },
);

export const BearerCredentialInterface = M.interface('BearerCredential', {
  audience: M.call().returns(M.string()),
});

export const BasicCredentialInterface = M.interface('BasicCredential', {
  audience: M.call().returns(M.string()),
});
