// @ts-check
/// <reference types="ses"/>

/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate with: yarn workspace @endo/agent-tools gen:code-mode-types
 *
 * Source of truth:
 *   - gitRemote: packages/exo-git/src/types.ts (the `GitRemote` type alias),
 *     printed by the TypeScript compiler API.
 *
 * The generic extraction and rendering live in
 * scripts/code-mode-type-extract.js; this exo's source configuration lives in
 * its scripts/code-mode-*-extract.js extractor. The divergence gate in
 * test/code-mode-types.test.js keeps this artifact fresh.
 *
 * Each entry is consumed by formatGlobalDeclarations in code-mode/declarations.js via
 * the per-exo descriptor in code-mode-globals/git-remote.js:
 * `aux` is the supporting `type` aliases, `body` is the object type spliced
 * after the dynamic `declare const <name>:`.
 */

export const gitRemoteDeclarations = harden({
  gitRemote: {
    aux: `type GitRemote = {
  inspect: () => Promise<RemoteGitRemoteSnapshot>;
  fetch: (options?: {
    prune?: boolean;
    tags?: boolean;
}) => Promise<RemoteGitRemoteOperationResult>;
  pull: (options?: {
    branch?: RemoteGitRef | string;
    strategy?: 'merge' | 'rebase' | 'ff-only';
    prune?: boolean;
    tags?: boolean;
}) => Promise<RemoteGitRemotePullResult>;
  push: (options?: {
    refspecs?: string[];
    source?: string;
    destination?: string;
    force?: boolean;
    forceWithLease?: string;
    setUpstream?: boolean;
}) => Promise<RemoteGitRemoteOperationResult>;
};
type RemoteGitDirection = 'fetch' | 'push';
type RemoteGitRef = {
    name: string;
    kind: 'branch' | 'tag' | 'commit' | 'detached';
    oid?: string;
};
type RemoteGitRefUpdateResult = 'created' | 'updated' | 'up-to-date' | 'fast-forward' | 'forced' | 'pruned' | 'rejected';
type RemoteGitRemoteOperationResult = {
    updatedRefs: RemoteGitRemoteRefUpdate[];
    text: string;
};
type RemoteGitRemotePolicy = {
    url: string;
    allowedDirections: RemoteGitDirection[];
    fetchRefspecs: string[];
    pushRefspecs: string[];
    allowedBranches?: string[];
    allowForcePush?: boolean;
    allowTags?: boolean;
    allowDelete?: boolean;
    allowLocalFileTransport?: boolean;
};
type RemoteGitRemotePullResult = {
    fetch: RemoteGitRemoteOperationResult;
    integration: 'up-to-date' | 'fast-forward' | 'merge' | 'rebase';
    head: RemoteGitRef;
};
type RemoteGitRemoteRefUpdate = {
    local?: RemoteGitRef;
    remote: string;
    result: RemoteGitRefUpdateResult;
};
type RemoteGitRemoteSnapshot = RemoteGitRemotePolicy & {
    name: string;
};`,
    body: `GitRemote`,
  },
});
harden(gitRemoteDeclarations);
