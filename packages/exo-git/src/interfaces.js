// @ts-check

import { M } from '@endo/patterns';

// #region Shape primitives

const GitDirectionShape = M.or(M.eq('fetch'), M.eq('push'));

const GitIndexStatusShape = M.or(
  'clean',
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'conflicted',
);

const GitWorktreeStatusShape = M.or(
  'clean',
  'modified',
  'deleted',
  'untracked',
  'ignored',
  'conflicted',
);

const GitStatusEntryShape = M.splitRecord(
  {
    entry: M.remotable(),
    path: M.string(),
    index: GitIndexStatusShape,
    worktree: GitWorktreeStatusShape,
  },
  {
    node: M.remotable(),
    renamedFrom: M.string(),
  },
);

const GitRefKindShape = M.or('branch', 'tag', 'commit', 'detached');

const GitRefShape = M.splitRecord(
  {
    name: M.string(),
    kind: GitRefKindShape,
  },
  {
    oid: M.string(),
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

const GitCommitOptionsShape = M.splitRecord(
  {},
  {
    amend: M.boolean(),
  },
  harden({}),
);

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
    remote: M.string(),
    result: GitRefUpdateResultShape,
  },
  { local: GitRefShape },
  harden({}),
);

const RemoteOperationResultShape = M.splitRecord(
  {
    updatedRefs: M.arrayOf(RemoteRefUpdateShape),
    text: M.string(),
  },
  {},
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

// #endregion

export const GitInterface = M.interface('Git', {
  // `callWhen` so a read-only Git may resolve its worktree authority
  // through `mount.readOnly()` (which yields a promise of the
  // structural read-only view) before the return shape is matched; a
  // writable Git returns its mount synchronously and is unaffected.
  worktree: M.callWhen().returns(M.remotable()),
  status: M.callWhen().returns(M.arrayOf(GitStatusEntryShape)),
  diff: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.string()),
  log: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.arrayOf(GitCommitShape)),
  show: M.callWhen(RefArgShape).returns(M.string()),
  revParse: M.callWhen(RefArgShape).returns(GitRefShape),
  add: M.callWhen(M.arrayOf(M.remotable())).returns(M.undefined()),
  restore: M.callWhen(M.arrayOf(M.remotable()))
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.undefined()),
  commit: M.callWhen(M.string())
    .optional(GitCommitOptionsShape)
    .returns(GitCommitShape),
  reword: M.callWhen(RefArgShape, M.string()).returns(GitCommitShape),
  cherryPick: M.callWhen(RefArgShape)
    .optional(GitCherryPickOptionsShape)
    .returns(M.string()),
  currentBranch: M.callWhen().returns(M.or(GitRefShape, M.undefined())),
  branches: M.callWhen().returns(M.arrayOf(GitRefShape)),
  createBranch: M.callWhen(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(GitRefShape),
  deleteBranch: M.callWhen(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.undefined()),
  renameBranch: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  switchBranch: M.callWhen(M.string()).returns(M.undefined()),
  detach: M.callWhen(RefArgShape).returns(M.undefined()),
  switch: M.callWhen(RefArgShape).returns(M.undefined()),
  merge: M.callWhen(RefArgShape)
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.string()),
  rebase: M.callWhen(GitRebaseInputShape).returns(M.string()),
  stashPush: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.string()),
  stashList: M.callWhen().returns(M.arrayOf(M.string())),
  stashShow: M.callWhen().optional(M.number()).returns(M.string()),
  stashApply: M.callWhen().optional(M.number()).returns(M.undefined()),
  stashPop: M.callWhen().optional(M.number()).returns(M.undefined()),
  stashDrop: M.callWhen().optional(M.number()).returns(M.undefined()),
  tree: M.callWhen(RefArgShape).returns(M.remotable()),
  filesystemAt: M.callWhen(RefArgShape).returns(M.remotable('Filesystem')),
  readOnly: M.call().returns(M.remotable('Git')),
});

export const GitTreeInterface = M.interface('EndoGitTree', {
  archiveTar: M.call().returns(M.remotable()),
  // `callWhen` so the settled value (not the promise) is guarded against
  // the return shape, matching the GitInterface convention above.
  archiveLossless: M.callWhen().returns(M.boolean()),
  has: M.callWhen().rest(M.arrayOf(M.string())).returns(M.boolean()),
  list: M.callWhen().rest(M.arrayOf(M.string())).returns(M.arrayOf(M.string())),
  lookup: M.callWhen(M.or(M.string(), M.arrayOf(M.string()))).returns(
    M.remotable(),
  ),
});

export const GitRemoteInterface = M.interface('GitRemote', {
  inspect: M.callWhen().returns(RemoteSnapshotShape),
  fetch: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(RemoteOperationResultShape),
  pull: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(RemotePullResultShape),
  push: M.callWhen()
    .optional(M.recordOf(M.string(), M.any()))
    .returns(RemoteOperationResultShape),
});

export const GitRemoteControllerInterface = M.interface('GitRemoteController', {
  inspect: M.callWhen().returns(RemoteControllerSnapshotShape),
  audit: M.call().returns(M.promise()),
  setAllowedDirections: M.call(M.arrayOf(GitDirectionShape)).returns(
    M.promise(),
  ),
  setFetchRefspecs: M.call(M.arrayOf(M.string())).returns(M.promise()),
  setPushRefspecs: M.call(M.arrayOf(M.string())).returns(M.promise()),
  setAllowedBranches: M.call(M.arrayOf(M.string())).returns(M.promise()),
  setAllowForcePush: M.call(M.boolean()).returns(M.promise()),
  setAllowTags: M.call(M.boolean()).returns(M.promise()),
  setAllowDelete: M.call(M.boolean()).returns(M.promise()),
  revoke: M.call().returns(M.promise()),
});

export const GitCredentialControllerInterface = M.interface(
  'GitCredentialController',
  {
    inspect: M.callWhen().returns(GitCredentialSnapshotShape),
    rotate: M.call(M.recordOf(M.string(), M.any())).returns(M.promise()),
    revoke: M.call().returns(M.promise()),
  },
);

export const BearerCredentialInterface = M.interface('BearerCredential', {
  audience: M.call().returns(M.string()),
});

export const BasicCredentialInterface = M.interface('BasicCredential', {
  audience: M.call().returns(M.string()),
});
