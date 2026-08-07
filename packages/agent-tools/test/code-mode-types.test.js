// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { getInterfaceGuardPayload } from '@endo/patterns';
import { GitInterface, GitRemoteInterface } from '@endo/exo-git';
import {
  HttpClientInterface,
  HttpResponseInterface,
} from '@endo/exo-http-client';
import { ShellInterface } from '@endo/exo-shell';
import * as extendedFsTypeGuards from '@endo/platform/fs/extended/type-guards.js';

/** @import { InterfaceGuard } from '@endo/patterns' */

import { gitDeclarations } from '../generated/code-mode-globals/git-declarations.js';
import { fsDeclarations } from '../generated/code-mode-globals/fs-declarations.js';
import { shellDeclarations } from '../generated/code-mode-globals/shell-declarations.js';
import { httpDeclarations } from '../generated/code-mode-globals/http-declarations.js';
import { gitRemoteDeclarations } from '../generated/code-mode-globals/git-remote-declarations.js';
import {
  buildGitTypeDeclarations,
  buildGitIRs,
  GIT_HISTORY_MEMBERS,
  GIT_READONLY_MEMBERS,
} from '../scripts/code-mode-git-extract.js';
import {
  buildFsTypeDeclarations,
  buildWorkspaceIR,
} from '../scripts/code-mode-fs-extract.js';
import {
  buildShellIR,
  buildShellTypeDeclarations,
} from '../scripts/code-mode-shell-extract.js';
import {
  buildHttpIR,
  buildHttpTypeDeclarations,
} from '../scripts/code-mode-http-extract.js';
import {
  buildGitRemoteIR,
  buildGitRemoteTypeDeclarations,
} from '../scripts/code-mode-git-remote-extract.js';
import {
  listDeclaredTypeMembers,
  listDeclaredTypeNames,
} from './_util/declaration-inspect.js';

/**
 * @param {import('@endo/patterns').InterfaceGuard} guard
 * @returns {string[]}
 */
const guardMethodNames = guard =>
  Object.keys(getInterfaceGuardPayload(guard).methodGuards).sort();

/**
 * Every `<TypeName>Interface` the extended filesystem publishes, keyed by the
 * type name the `workspace` declaration is expected to print for it. Derived
 * from the guard module's own exports rather than a hand-kept list, so a new
 * guard joins the divergence gate the moment it is exported — including the
 * three stream guards `@endo/platform/fs/extended` re-exports from
 * `@endo/exo-stream`, whose declarations the extractor follows across the
 * package boundary.
 *
 * @type {Record<string, InterfaceGuard>}
 */
const WORKSPACE_GUARDS = harden(
  Object.fromEntries(
    Object.entries(extendedFsTypeGuards)
      .filter(([name]) => name.endsWith('Interface'))
      .map(([name, guard]) => [
        name.slice(0, -'Interface'.length),
        /** @type {InterfaceGuard} */ (guard),
      ]),
  ),
);

/**
 * @param {import('ava').ExecutionContext} t
 * @param {import('../scripts/code-mode-type-extract.js').GlobalTypeIR} ir
 * @param {import('@endo/patterns').InterfaceGuard} guard
 * @param {string} label
 */
const assertIRMatchesGuard = (t, ir, guard, label) => {
  t.deepEqual(
    ir.members.map(member => member.name).sort(),
    guardMethodNames(guard),
    `${label} declaration must match its runtime guard method names`,
  );
};

// Freshness gate (git): the checked-in git artifact must equal a fresh
// extraction, so a change to the exo-git or platform TypeScript sources cannot
// land without regenerating and committing the declarations.
test('generated git declarations are up to date with their source', t => {
  const fresh = buildGitTypeDeclarations();
  t.deepEqual(Object.keys(gitDeclarations).sort(), Object.keys(fresh).sort());
  for (const key of Object.keys(fresh)) {
    t.deepEqual(
      gitDeclarations[key],
      fresh[key],
      `${key} declaration is stale; run: yarn workspace @endo/agent-tools gen:code-mode-types`,
    );
  }
});

// Freshness gate (fs): the checked-in workspace artifact must equal a fresh
// extraction from the FS guards.
test('generated fs declarations are up to date with their source', t => {
  const fresh = buildFsTypeDeclarations();
  t.deepEqual(Object.keys(fsDeclarations).sort(), Object.keys(fresh).sort());
  for (const key of Object.keys(fresh)) {
    t.deepEqual(
      fsDeclarations[key],
      fresh[key],
      `${key} declaration is stale; run: yarn workspace @endo/agent-tools gen:code-mode-types`,
    );
  }
});

test('TypeScript-extracted declaration members stay alphabetized', t => {
  const { members } = buildWorkspaceIR();
  t.deepEqual(
    members.map(member => member.name),
    [...members].map(member => member.name).sort(),
  );
});

test('generated Shell declarations are up to date with their source', t => {
  t.deepEqual(shellDeclarations, buildShellTypeDeclarations());
});

test('generated HTTP declarations are up to date with their source', t => {
  t.deepEqual(httpDeclarations, buildHttpTypeDeclarations());
});

test('generated GitRemote declarations are up to date with their source', t => {
  t.deepEqual(gitRemoteDeclarations, buildGitRemoteTypeDeclarations());
});

// These roots are the public declarations injected into agentry code-mode
// prompts. Keep their names pinned independently of the generator freshness
// checks so a regenerated artifact cannot silently rename a model-visible
// capability without a focused failure.
test('generated code-mode declaration roots stay stable', t => {
  t.deepEqual(
    {
      git: gitDeclarations.git.body,
      gitHistory: gitDeclarations.gitHistory.body,
      gitReadOnly: gitDeclarations.gitReadOnly.body,
      workspace: fsDeclarations.workspace.body,
      shell: shellDeclarations.shell.body,
      http: httpDeclarations.http.body,
      gitRemote: gitRemoteDeclarations.gitRemote.body,
    },
    {
      git: 'WritableEndoGit',
      gitHistory: 'EndoGitHistory',
      gitReadOnly: 'ReadOnlyEndoGit',
      workspace: 'Filesystem',
      shell: 'EndoShell',
      http: 'HttpClient',
      gitRemote: 'GitRemote',
    },
  );
});

// The base declaration stays guard-canonical except for the deliberately
// attenuated history-rewrite methods. `gitHistory` carries those separately.
test('git declarations split the GitInterface history-rewrite method', t => {
  const { git } = buildGitIRs();
  const tsMembers = git.members.map(member => member.name).sort();
  const guardMethods = Object.keys(
    getInterfaceGuardPayload(/** @type {InterfaceGuard} */ (GitInterface))
      .methodGuards,
  )
    .filter(name => !GIT_HISTORY_MEMBERS.includes(name) || name === 'commit')
    .sort();
  t.deepEqual(tsMembers, guardMethods);
});

test('read-only git is a subset of read-write git and omits mutators', t => {
  const { git, gitReadOnly } = buildGitIRs();
  const readWrite = new Set(git.members.map(member => member.name));
  const readOnly = gitReadOnly.members.map(member => member.name);
  for (const name of readOnly) {
    t.true(
      readWrite.has(name),
      `read-only member ${name} missing from read-write`,
    );
  }
  t.deepEqual([...readOnly].sort(), [...GIT_READONLY_MEMBERS].sort());
  // A self-referential return (`readOnly(): ReadOnlyEndoGit`) must not leak the
  // mutating surface back into the read-only declaration.
  t.false(gitReadOnly.members.some(member => member.name === 'commit'));
  t.false(gitReadOnly.members.some(member => member.name === 'merge'));
  t.false(gitDeclarations.gitReadOnly.aux.includes('commit:'));
  t.true(readOnly.includes('log'));
  t.true(readOnly.includes('diff'));
});

test('git declarations retain reachable filesystem contracts without status caps', t => {
  const { aux } = gitDeclarations.git;
  t.false(aux.includes("import('@endo/platform"));
  for (const shape of [
    'type GitPathEntry =',
    'child: (name: string) => GitLitePathEntry;',
    'type GitPathEntryIssuer =',
    'entry: (path: string | string[]) => GitLitePathEntry;',
    'lookup: (path: string | string[]) => Promise<unknown>;',
    'type GitDirectoryWriteSource = GitReadableBlobSource | GitLiteReadableTree;',
    'write: (path: string[], value: GitDirectoryWriteSource) => Promise<void>;',
    'type GitFilesystem =',
    'root: () => GitERef<GitExtendedDirectory>;',
    'type GitReadableTree =',
  ]) {
    t.true(aux.includes(shape), `missing reachable type shape: ${shape}`);
  }
});

test('git status declarations expose copy data without live capabilities', t => {
  const { aux } = gitDeclarations.git;
  t.true(aux.includes('type GitStatusEntry ='));
  t.true(aux.includes('type GitStatusResult ='));
  t.true(aux.includes('entries: GitStatusEntry[];'));
  t.true(aux.includes('truncated: boolean;'));
  t.false(aux.includes('entry: GitPathEntry;'));
  t.false(aux.includes('node?:'));
  t.false(aux.includes('type GitStatusNode ='));
});

test('combined Git and workspace declarations have unique alias names', t => {
  const combined = [fsDeclarations.workspace.aux, gitDeclarations.git.aux].join(
    '\n',
  );
  const names = listDeclaredTypeNames(combined);
  t.deepEqual(
    names,
    [...new Set(names)],
    'workspace and Git aliases must not declare the same TypeScript name',
  );
});

test('Git declarations define every reachable custom filesystem alias', t => {
  const declared = new Set(listDeclaredTypeNames(gitDeclarations.git.aux));
  for (const name of [
    'GitERef',
    'GitFilesystemStats',
    'GitSnapshotTree',
    'GitBlobInfo',
  ]) {
    t.true(declared.has(name), `missing generated alias: ${name}`);
  }
  t.false(gitDeclarations.git.aux.includes("import('@endo/platform"));
});

test('base and history git declarations split history rewrite authority', t => {
  const { git, gitHistory } = buildGitIRs();
  const baseCommit = git.members.find(member => member.name === 'commit');
  if (baseCommit === undefined) {
    t.fail('base git declaration must include commit');
    return;
  }
  t.is(baseCommit.signature, '(message: string) => Promise<GitCommit>');
  for (const name of GIT_HISTORY_MEMBERS) {
    if (name !== 'commit') {
      t.false(git.members.some(member => member.name === name));
    }
  }
  t.deepEqual(
    gitHistory.members.map(member => member.name).sort(),
    [...GIT_HISTORY_MEMBERS].sort(),
  );
  t.true(
    gitHistory.members.some(member =>
      member.signature.includes('GitCommitOptions'),
    ),
  );
  for (const historyOnlyType of [
    'GitCommitOptions',
    'GitCherryPickOptions',
    'GitRebaseInput',
  ]) {
    t.false(
      git.auxTypes.some(type => type.name === historyOnlyType),
      `base git declaration should omit ${historyOnlyType}`,
    );
  }
});

// Divergence gate (fs): `workspace` is printed from the checked TypeScript
// source, and the `M.interface` guards stay the runtime enforcement layer.
// Neither side may grow, lose, or rename a method without the other, so the
// declaration's method names must exactly equal the guard's for every guarded
// type.
test('workspace declarations match the filesystem runtime guards', t => {
  const { workspace } = fsDeclarations;
  t.deepEqual(
    Object.keys(WORKSPACE_GUARDS).sort(),
    [
      'BlobRef',
      'Cursor',
      'Directory',
      'File',
      'Filesystem',
      'Lock',
      'NodeWatcher',
      'OpenFile',
      'PassableBytesReader',
      'PassableBytesWriter',
      'PassableReader',
      'Xattrs',
    ],
    'a new extended-filesystem guard must be reachable from the workspace declaration',
  );
  for (const [typeName, guard] of Object.entries(WORKSPACE_GUARDS)) {
    t.deepEqual(
      listDeclaredTypeMembers(workspace.aux, typeName).sort(),
      guardMethodNames(guard),
      `${typeName} declaration must match its runtime guard method names`,
    );
  }
});

test('Shell, HTTP, and GitRemote declarations match runtime method names', t => {
  assertIRMatchesGuard(t, buildShellIR(), ShellInterface, 'Shell');
  assertIRMatchesGuard(t, buildHttpIR(), HttpClientInterface, 'HttpClient');
  assertIRMatchesGuard(t, buildGitRemoteIR(), GitRemoteInterface, 'GitRemote');
  t.deepEqual(
    listDeclaredTypeMembers(httpDeclarations.http.aux, 'HttpResponse').sort(),
    guardMethodNames(HttpResponseInterface),
    'HttpResponse declaration must match its runtime guard',
  );
});

// `HttpResponse.stream()` returns `import('@endo/exo-stream').PassableBytesReader`.
// The extractor follows that import into `@endo/exo-stream`'s own type source,
// so the declaration carries the real streaming surface and the stream-node
// types it reaches, rather than a hand-written stand-in or `unknown`.
test('HTTP stream declaration inlines the followed exo-stream reader shape', t => {
  const { aux } = httpDeclarations.http;
  t.false(aux.includes('stream: () => unknown;'));
  t.true(aux.includes('stream: () => HttpPassableBytesReader;'));
  t.deepEqual(listDeclaredTypeMembers(aux, 'HttpPassableBytesReader'), [
    'streamBase64',
    'readReturnPattern',
  ]);
  for (const shape of [
    'type HttpStreamNode<',
    'type HttpStreamYieldNode<',
    'type HttpStreamReturnNode<',
  ]) {
    t.true(aux.includes(shape), `missing followed exo-stream type: ${shape}`);
  }
  // The walk stops at the `@endo` namespace boundary and at packages that
  // publish no type source: `Pattern` (`@endo/patterns`) and `Passable`
  // (`@endo/pass-style`) collapse to `unknown` rather than leaking a dangling
  // reference into the prompt.
  t.false(aux.includes("import('@endo/"));
  t.false(/\bPattern\b/u.test(aux));
  t.false(/\bPassable\b(?!BytesReader)/u.test(aux));
});

// A followed type that references itself through another followed type
// (`StreamNode` -> `StreamYieldNode` -> `StreamNode`) must terminate with one
// alias apiece rather than expanding forever.
test('following imported types is cycle-safe', t => {
  const { aux } = httpDeclarations.http;
  t.true(aux.includes('promise: Promise<HttpStreamNode<Y, R>>;'));
  const names = listDeclaredTypeNames(aux);
  t.deepEqual(names, [...new Set(names)]);
});

test('Shell and HTTP declarations include named arguments and result shapes', t => {
  t.true(
    shellDeclarations.shell.aux.includes(
      'exec: (command: string, args: readonly string[], options?:',
    ),
  );
  t.true(shellDeclarations.shell.aux.includes('type ShellResult ='));
  t.true(
    httpDeclarations.http.aux.includes(
      'fetch: (url: string, options?: HttpFetchOptions)',
    ),
  );
  t.true(httpDeclarations.http.aux.includes('type HttpResponse ='));
});

test('GitRemote declarations include concrete result records', t => {
  const { aux } = gitRemoteDeclarations.gitRemote;
  t.true(aux.includes('Promise<RemoteOperationResult>'));
  t.true(aux.includes('type RemoteOperationResult ='));
  t.true(aux.includes('type RemotePullResult ='));
  t.false(aux.includes('Promise<any>'));
});

test('workspace declaration reaches the Directory surface transitively', t => {
  const { workspace } = fsDeclarations;
  t.is(workspace.body, 'Filesystem');
  t.true(workspace.aux.includes('type ERef<T> = T | Promise<T>;'));
  t.true(workspace.aux.includes('type Directory = {'));
  // Directory verbs only reachable transitively from `root()`.
  t.true(workspace.aux.includes('lookup:'));
  t.true(workspace.aux.includes('write:'));
});

// The guard walker printed `Promise<unknown>` wherever a guard said
// `M.promise()` — 32 returns across the workspace section. Printing from the
// authored TypeScript instead names the concrete result records, so the only
// `unknown` results left are the ones the authored type really says.
test('workspace declaration names its result records', t => {
  const { aux } = fsDeclarations.workspace;
  for (const shape of [
    'statfs: () => Promise<FilesystemStats>;',
    'getStat: () => Promise<NodeStat>;',
    'getAttrs: () => Promise<NodeAttrs>;',
    "getQid: () => Qid<'directory'>;",
    'read: (limit?: bigint) => Promise<DirectoryPage>;',
    'toArray: () => Promise<DirectoryEntry[]>;',
    'watchFrom: () => ERef<WatchFromResult>;',
    'snapshot: () => Promise<BlobRef>;',
    'getLock: (opts: LockQuery) => Promise<LockState | null>;',
  ]) {
    t.true(aux.includes(shape), `missing named result shape: ${shape}`);
  }
  // `BlobRef.json()` is the one member whose authored return really is
  // unknown: it parses arbitrary JSON.
  const unknownResults = aux
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes('=> Promise<unknown>'));
  t.deepEqual(unknownResults, ['json: () => Promise<unknown>;']);
  t.false(aux.includes(': any'));
  t.true(aux.includes('btime?: bigint | null;'));
  t.false(aux.includes('wait?: boolean;'));
});

// The reader and writer types are `@endo/exo-stream`'s, referenced from the
// filesystem's authored source rather than re-authored beside it. The
// extractor follows the import and inlines the real definitions.
test('workspace declaration inlines the followed exo-stream stream shapes', t => {
  const { aux } = fsDeclarations.workspace;
  t.true(aux.includes('stream: () => ERef<PassableReader<DirectoryEntry>>;'));
  t.true(aux.includes('events: () => ERef<PassableReader<WatchEvent>>;'));
  t.true(
    aux.includes(
      'read: (opts?: FileReadOptions) => ERef<PassableBytesReader>;',
    ),
  );
  for (const shape of [
    'type StreamNode<',
    'type StreamYieldNode<',
    'type StreamReturnNode<',
  ]) {
    t.true(aux.includes(shape), `missing followed exo-stream type: ${shape}`);
  }
  t.false(aux.includes("import('@endo/"));
});
