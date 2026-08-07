import { expectTypeOf } from 'expect-type';

import { makeGit, normalizeGitRemotePolicy } from '@endo/exo-git';
import type {
  Directory,
  EndoGit,
  File,
  Filesystem,
  GitCherryPickOptions,
  GitCommit,
  GitCommitOptions,
  GitCreateBranchOptions,
  GitDeleteBranchOptions,
  GitDiffOptions,
  GitDirection,
  GitIndexStatus,
  GitLogOptions,
  GitMakeHistoryRewriteOptions,
  GitMakeOptions,
  GitMakeReadOnlyOptions,
  GitMakeReadWriteOptions,
  GitMakeReadWriteOrHistoryRewriteOptions,
  GitMergeOptions,
  GitOperations,
  GitReadWriteCommitOptions,
  GitRebaseInput,
  GitRef,
  GitRefUpdateResult,
  GitRemote,
  GitRemoteAuditEvent,
  GitRemoteAuditEventBase,
  GitRemoteController,
  GitRemoteCredential,
  GitRemoteEndpoint,
  GitRemoteKit,
  GitRemoteOperationFailureAuditEvent,
  GitRemoteOperationSuccessAuditEvent,
  GitRemotePolicyAuditEvent,
  GitRestoreOptions,
  GitStashPushOptions,
  GitStatusEntry,
  GitStatusOptions,
  GitStatusResult,
  GitWorktree,
  GitWorktreeStatus,
  HistoryRewriteEndoGit,
  NormalizedRemotePolicy,
  PathEntry,
  PathEntryIssuer,
  ReadableBlob,
  ReadableTree,
  ReadOnlyEndoGit,
  ReadOnlyGitWorktree,
  ReadWriteEndoGit,
  RemoteOperationResult,
  RemotePolicy,
  RemotePullResult,
  RemoteRefUpdate,
  RemoteSnapshot,
  WritableGitWorktree,
} from '@endo/exo-git';
import type { GitBackend } from '../src/git.js';

expectTypeOf<GitStatusEntry>().toEqualTypeOf<{
  path: string;
  index: GitIndexStatus;
  worktree: GitWorktreeStatus;
  renamedFrom?: string;
}>();
expectTypeOf<GitStatusOptions>().toEqualTypeOf<{
  maxCount?: number;
  untracked?: 'all' | 'normal' | 'no';
}>();
expectTypeOf<GitStatusResult>().toEqualTypeOf<{
  entries: GitStatusEntry[];
  truncated: boolean;
}>();
declare const remotePolicy: RemotePolicy;
const normalizedRemotePolicy = normalizeGitRemotePolicy({
  name: 'origin',
  policy: remotePolicy,
});

// The canonical normalizer is reachable through the package entry point and
// returns the normalized policy contract rather than an untyped object.
expectTypeOf(normalizedRemotePolicy).toEqualTypeOf<NormalizedRemotePolicy>();
expectTypeOf(normalizedRemotePolicy.defaultPullRef).toEqualTypeOf<
  string | undefined
>();

// The shared backend contract must carry the canonical credential type on
// both remote operations; widening to `unknown` would silently drop the
// compile-time guarantee that backends receive only supported bearer or
// basic credentials.
expectTypeOf<
  Parameters<GitBackend['remoteFetch']>[0]['credential']
>().toEqualTypeOf<GitRemoteCredential | undefined>();
expectTypeOf<
  Parameters<GitBackend['remotePush']>[0]['credential']
>().toEqualTypeOf<GitRemoteCredential | undefined>();

// Representative ref-update rows across every `GitRefUpdateResult` member,
// both for a fetch (updating `refs/remotes/*`) and a push (updating
// `refs/heads/*`), including the no-`local` deletion case. Each is a
// construction-site check: an incompatible edit to `RemoteRefUpdate` or
// `GitRefUpdateResult` fails to compile right here instead of at a call site
// deep in the audit pipeline.
const fetchCreated: RemoteRefUpdate = {
  local: { name: 'refs/remotes/origin/main', kind: 'branch', oid: 'oid' },
  remote: 'refs/heads/main',
  result: 'created',
};
const fetchUpdated: RemoteRefUpdate = {
  local: { name: 'refs/remotes/origin/main', kind: 'branch', oid: 'oid' },
  remote: 'refs/heads/main',
  result: 'updated',
};
const fetchPruned: RemoteRefUpdate = {
  local: { name: 'refs/remotes/origin/old', kind: 'branch' },
  remote: 'refs/heads/old',
  result: 'pruned',
};
const pushCreated: RemoteRefUpdate = {
  local: { name: 'refs/heads/topic', kind: 'branch', oid: 'oid' },
  remote: 'refs/heads/topic',
  result: 'created',
};
const pushForced: RemoteRefUpdate = {
  local: { name: 'refs/heads/topic', kind: 'branch', oid: 'oid' },
  remote: 'refs/heads/topic',
  result: 'forced',
};
const pushRejected: RemoteRefUpdate = {
  local: { name: 'refs/heads/topic', kind: 'branch', oid: 'oid' },
  remote: 'refs/heads/topic',
  result: 'rejected',
};
const deletionPush: RemoteRefUpdate = {
  remote: 'refs/heads/topic',
  result: 'pruned',
};
expectTypeOf(fetchCreated).toEqualTypeOf<RemoteRefUpdate>();
expectTypeOf(fetchUpdated).toEqualTypeOf<RemoteRefUpdate>();
expectTypeOf(fetchPruned).toEqualTypeOf<RemoteRefUpdate>();
expectTypeOf(pushCreated).toEqualTypeOf<RemoteRefUpdate>();
expectTypeOf(pushForced).toEqualTypeOf<RemoteRefUpdate>();
expectTypeOf(pushRejected).toEqualTypeOf<RemoteRefUpdate>();
expectTypeOf(deletionPush).toEqualTypeOf<RemoteRefUpdate>();

// A success audit event's `updatedRefs` is a plain array of
// `RemoteRefUpdate` (never `readonly`, never widened to `any[]`), its
// `head` is a full `GitRef`, and — the security-relevant pin — it has no
// `credential` field at all: an audit log must never carry secret material,
// so `credential` regressing from `never` to present-but-optional would be a
// silent capability leak into logs.
expectTypeOf<
  NonNullable<GitRemoteOperationSuccessAuditEvent['updatedRefs']>
>().toEqualTypeOf<RemoteRefUpdate[]>();
expectTypeOf<
  NonNullable<GitRemoteOperationSuccessAuditEvent['head']>
>().toEqualTypeOf<GitRef>();
expectTypeOf<
  Extract<keyof GitRemoteOperationSuccessAuditEvent, 'credential'>
>().toEqualTypeOf<never>();

// `pull`'s `branch` selector accepts either a resolved `GitRef` or a bare
// string (branch name, tag, etc); narrowing it to `GitRef` only would break
// every caller that currently passes a plain branch-name string.
type PullOptions = NonNullable<Parameters<GitRemote['pull']>[0]>;
expectTypeOf<NonNullable<PullOptions['branch']>>().toEqualTypeOf<
  GitRef | string
>();

// `fetch`/`pull`/`push` resolve to explicit result records, not
// `Promise<any>`/`Promise<object>`; a regression back to a loose return
// type would silently drop the runtime guard's compile-time counterpart.
expectTypeOf<
  Awaited<ReturnType<GitRemote['fetch']>>
>().toEqualTypeOf<RemoteOperationResult>();
expectTypeOf<
  Awaited<ReturnType<GitRemote['pull']>>
>().toEqualTypeOf<RemotePullResult>();
expectTypeOf<
  Awaited<ReturnType<GitRemote['push']>>
>().toEqualTypeOf<RemoteOperationResult>();

declare const powers: Parameters<typeof makeGit>[0];
declare const selectedAtRuntime: boolean;
declare const optionsSelectedAtRuntime: {
  readOnly?: boolean;
  allowHistoryRewrite?: boolean;
};

const readWrite = makeGit(powers);
const explicitReadWrite = makeGit(powers, { allowHistoryRewrite: false });
const historyRewrite = makeGit(powers, { allowHistoryRewrite: true });
const readOnly = makeGit(powers, { readOnly: true });
const readOnlyWithIgnoredRewrite = makeGit(powers, {
  readOnly: true,
  allowHistoryRewrite: true,
});
const dynamicWritable = makeGit(powers, {
  allowHistoryRewrite: selectedAtRuntime,
});
const dynamicAuthority = makeGit(powers, optionsSelectedAtRuntime);

// `makeGit`'s overloads must select the posture from its options literal at
// the call site: the default and `allowHistoryRewrite: false` construct
// `ReadWriteEndoGit`; `allowHistoryRewrite: true` alone constructs
// `HistoryRewriteEndoGit`; `readOnly: true` wins over any `allowHistoryRewrite`
// value (history-rewrite authority is meaningless without write authority in
// the first place); and a plain `boolean` or a whole options value decided at
// runtime cannot resolve to one overload, so the honest static result is the
// governing union. A regression that let a runtime-selected boolean resolve
// eagerly to `HistoryRewriteEndoGit` would grant `reword` / `cherryPick` /
// `rebase` to a caller whose runtime value turns out `false`.
expectTypeOf(readWrite).toEqualTypeOf<ReadWriteEndoGit>();
expectTypeOf(explicitReadWrite).toEqualTypeOf<ReadWriteEndoGit>();
expectTypeOf(historyRewrite).toEqualTypeOf<HistoryRewriteEndoGit>();
expectTypeOf(readOnly).toEqualTypeOf<ReadOnlyEndoGit>();
expectTypeOf(readOnlyWithIgnoredRewrite).toEqualTypeOf<ReadOnlyEndoGit>();
expectTypeOf(dynamicWritable).toEqualTypeOf<
  ReadWriteEndoGit | HistoryRewriteEndoGit
>();
expectTypeOf(dynamicAuthority).toEqualTypeOf<
  ReadOnlyEndoGit | ReadWriteEndoGit | HistoryRewriteEndoGit
>();

// Every posture's `readOnly()` attenuates down to the same `ReadOnlyEndoGit`,
// regardless of which elevated posture it started from; a `readOnly()` that
// returned `this`'s own type would leak the caller's write or
// history-rewrite authority into a supposedly read-only handle.
expectTypeOf<
  ReturnType<ReadWriteEndoGit['readOnly']>
>().toEqualTypeOf<ReadOnlyEndoGit>();
expectTypeOf<
  ReturnType<HistoryRewriteEndoGit['readOnly']>
>().toEqualTypeOf<ReadOnlyEndoGit>();

// `worktree()` returns a mutable `WritableGitWorktree` for read-write
// postures and an immutable `ReadOnlyGitWorktree` for the read-only posture;
// and the writable worktree issues lineage-bearing `PathEntry` values (the
// property downstream mount-bridged tools, e.g. `GitMountToolCapability`,
// depend on to stage files by entry rather than by trusting a bare path
// string).
expectTypeOf<
  Awaited<ReturnType<ReadWriteEndoGit['worktree']>>
>().toEqualTypeOf<WritableGitWorktree>();
expectTypeOf<
  Awaited<ReturnType<ReadOnlyEndoGit['worktree']>>
>().toEqualTypeOf<ReadOnlyGitWorktree>();
expectTypeOf<WritableGitWorktree>().toExtend<PathEntryIssuer>();

// `ReadOnlyEndoGit` must expose none of the mutating methods under any name;
// a mutator method leaking onto the read-only posture (e.g. through a bad
// intersection) would let a guest holding only a read-only Git mutate the
// repository despite the type system's promise otherwise.
type Mutator =
  | 'add'
  | 'restore'
  | 'checkoutConflict'
  | 'commit'
  | 'reword'
  | 'createBranch'
  | 'deleteBranch'
  | 'renameBranch'
  | 'switchBranch'
  | 'detach'
  | 'switch'
  | 'merge'
  | 'rebase'
  | 'stashPush'
  | 'stashApply'
  | 'stashPop'
  | 'stashDrop';
expectTypeOf<Extract<keyof ReadOnlyEndoGit, Mutator>>().toEqualTypeOf<never>();

// The history-rewrite operations are visible only on `HistoryRewriteEndoGit`:
// `ReadWriteEndoGit` must omit them entirely (not merely reject their
// arguments), and `HistoryRewriteEndoGit` must expose every one of them, and
// it must remain a structural extension of `ReadWriteEndoGit` (every ordinary
// operation still present) so an elevated Git can stand in anywhere an
// ordinary one is expected.
type HistoryRewriteOperation = 'reword' | 'cherryPick' | 'rebase';
expectTypeOf<
  Extract<keyof ReadWriteEndoGit, HistoryRewriteOperation>
>().toEqualTypeOf<never>();
expectTypeOf<
  Extract<keyof HistoryRewriteEndoGit, HistoryRewriteOperation>
>().toEqualTypeOf<HistoryRewriteOperation>();
expectTypeOf<HistoryRewriteEndoGit>().toExtend<ReadWriteEndoGit>();

// `commit`'s `amend` option is the one argument-sensitive authority split
// between the two writable postures: an ordinary `ReadWriteEndoGit` can only
// ever pass `amend: false` (or omit it), while `HistoryRewriteEndoGit` may
// pass either `true` or `false`. If `ReadWriteEndoGit`'s `commit` widened to
// accept `amend: true`, a caller holding only ordinary write authority could
// silently rewrite the tip commit's identity, the exact authority split this
// fixture exists to hold at the type level (see also the `@ts-expect-error`
// rejections below, which prove the same contract from the call-site
// direction).
expectTypeOf<
  NonNullable<Parameters<ReadWriteEndoGit['commit']>[1]>['amend']
>().toEqualTypeOf<false | undefined>();
expectTypeOf<
  NonNullable<Parameters<HistoryRewriteEndoGit['commit']>[1]>['amend']
>().toEqualTypeOf<boolean | undefined>();

declare const ordinaryGit: ReadWriteEndoGit;
declare const historyRewriteGit: HistoryRewriteEndoGit;

// Call-site proof of the same commit/amend and history-rewrite-operation
// contract pinned above by shape: an ordinary read-write Git must reject
// `amend: true` and every history-rewrite verb at the call site, not merely
// in the abstract type shape, while an elevated Git accepts them all. A
// regression that let any of these five calls through on `ordinaryGit` is
// exactly the authority leak the three-posture split exists to prevent.
ordinaryGit.commit('new commit');
ordinaryGit.commit('new commit', { amend: false });
// @ts-expect-error Ordinary read-write authority cannot amend history.
ordinaryGit.commit('amended commit', { amend: true });
// @ts-expect-error Ordinary read-write authority cannot reword history.
ordinaryGit.reword('HEAD', 'reworded commit');
// @ts-expect-error Ordinary read-write authority cannot cherry-pick history.
ordinaryGit.cherryPick('HEAD');
// @ts-expect-error Ordinary read-write authority cannot rebase history.
ordinaryGit.rebase({ mode: 'start', upstream: 'main' });

historyRewriteGit.commit('amended commit', { amend: true });
historyRewriteGit.reword('HEAD', 'reworded commit');
historyRewriteGit.cherryPick('HEAD');
historyRewriteGit.rebase({ mode: 'start', upstream: 'main' });

// `checkoutConflict` selects one side of an unmerged index entry and stages
// it — an additive, non-history-rewriting write, unlike `reword` /
// `cherryPick` / `rebase` above. It must therefore be ordinary write
// authority: present on `ReadWriteEndoGit` (not gated behind
// `allowHistoryRewrite`), with the identical signature carried through to
// `HistoryRewriteEndoGit` by structural extension. A regression that moved
// `checkoutConflict` onto `HistoryRewriteEndoGit` only would force every
// merge-conflict resolution through the elevated posture for no authority
// reason — the same over-gating this fixture's `Mutator` list (which already
// pins it absent from `ReadOnlyEndoGit`) exists to catch in the other
// direction.
expectTypeOf<ReadWriteEndoGit['checkoutConflict']>().toEqualTypeOf<
  HistoryRewriteEndoGit['checkoutConflict']
>();

declare const conflictEntries: Parameters<
  ReadWriteEndoGit['checkoutConflict']
>[0];
ordinaryGit.checkoutConflict(conflictEntries, 'ours');
ordinaryGit.checkoutConflict(conflictEntries, 'theirs');
historyRewriteGit.checkoutConflict(conflictEntries, 'ours');
