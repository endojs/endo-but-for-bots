// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { getInterfaceGuardPayload } from '@endo/patterns';
import { GitInterface, GitRemoteInterface } from '@endo/exo-git';
import {
  HttpClientInterface,
  HttpResponseInterface,
} from '@endo/exo-http-client';
import { ShellInterface } from '@endo/exo-shell';
import {
  MountEntryInterface,
  MountFileInterface,
  MountInterface,
} from '@endo/daemon/src/interfaces.js';
import {
  RichReadableBlobInterface,
  ReadableTreeInterface,
} from '@endo/platform/fs/lite';

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
 * Every mounted capability type reachable from the injected `workspace`
 * declaration, keyed by the generated alias that carries its surface. The
 * root, the file, and the read-only views are daemon-owned; the path selector
 * is the shared platform `PathEntry` the daemon's `EndoMountEntry` aliases,
 * which is why the generated name is the platform one.
 *
 * @type {Record<string, InterfaceGuard>}
 */
const WORKSPACE_GUARDS = harden({
  DaemonMount: /** @type {InterfaceGuard} */ (MountInterface),
  MountEndoMountFile: /** @type {InterfaceGuard} */ (MountFileInterface),
  MountPathEntry: /** @type {InterfaceGuard} */ (MountEntryInterface),
  MountReadableBlobView: /** @type {InterfaceGuard} */ (
    RichReadableBlobInterface
  ),
  MountReadableTreeView: /** @type {InterfaceGuard} */ (ReadableTreeInterface),
});

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
      workspace: 'DaemonMount',
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

test('read-only generated Git declaration exposes tracking status', t => {
  t.true(
    listDeclaredTypeMembers(
      gitDeclarations.gitReadOnly.aux,
      'ReadOnlyEndoGit',
    ).includes('trackingStatus'),
  );
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
    'range: (start: bigint, end?: bigint) => Promise<GitRichReadableBlob>;',
    'textRange: (startLine: number, endLine: number) => Promise<GitRichReadableBlob>;',
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

test('git blob declarations expose Exo methods without CAS backing helpers', t => {
  const { aux } = gitDeclarations.git;
  t.deepEqual(listDeclaredTypeMembers(aux, 'GitLiteReadableBlob'), [
    'streamBase64',
    'text',
    'json',
    'help',
  ]);
  t.deepEqual(listDeclaredTypeMembers(aux, 'GitRichReadableBlob'), [
    'getInfo',
    'range',
    'textRange',
  ]);
  const leakedMethodNames = [
    'makeFileReader',
    'readRange',
    'rangeRead',
    'rangeReadText',
  ];
  const leaked = leakedMethodNames.filter(
    name => aux.includes(`${name}:`) || aux.includes(`${name}?:`),
  );
  t.deepEqual(
    leaked,
    [],
    `leaked non-Git blob method(s): ${leaked.join(', ')}`,
  );
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

// Divergence gate (workspace): the injected declaration is printed from the
// daemon's own `EndoMount` contract, and the `M.interface` guards stay the
// runtime enforcement layer. Neither side may grow, lose, or rename a method
// without the other, so every reachable declaration must match its live guard.
test('workspace declarations match the provisioned mount runtime guards', t => {
  const { workspace } = fsDeclarations;
  t.deepEqual(
    Object.keys(WORKSPACE_GUARDS).sort(),
    [
      'DaemonMount',
      'MountEndoMountFile',
      'MountPathEntry',
      'MountReadableBlobView',
      'MountReadableTreeView',
    ],
    'a new reachable mount guard must be represented in the workspace declaration',
  );
  for (const [typeName, guard] of Object.entries(WORKSPACE_GUARDS)) {
    t.deepEqual(
      listDeclaredTypeMembers(workspace.aux, typeName).sort(),
      guardMethodNames(guard),
      `${typeName} declaration must match its runtime guard method names`,
    );
  }
});

test('workspace root declaration is exactly the capability provision binds', t => {
  const { workspace } = fsDeclarations;
  t.deepEqual(
    listDeclaredTypeMembers(workspace.aux, 'DaemonMount').sort(),
    guardMethodNames(MountInterface),
    'every declared workspace method must exist on the provisioned EndoMount',
  );
  t.false(workspace.aux.includes('root:'));
  t.false(workspace.aux.includes('named:'));
  t.true(workspace.aux.includes("kind: () => 'directory';"));
  t.true(workspace.aux.includes("kind: () => 'file';"));
  t.true(
    workspace.aux.includes(
      'lookup: (path: string | readonly string[] | MountEndoMountEntry) => Promise<DaemonMount | MountEndoMountFile>;',
    ),
  );
  t.true(
    workspace.aux.includes(
      'entry: (path: string | string[]) => MountEndoMountEntry;',
    ),
  );
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

test('filesystem declaration remains available to local seam helpers', t => {
  const { filesystem } = fsDeclarations;
  t.is(filesystem.body, 'Filesystem');
  t.true(filesystem.aux.includes('type ERef<T> = T | Promise<T>;'));
  t.true(filesystem.aux.includes('type Directory = {'));
  t.true(filesystem.aux.includes('lookup:'));
  t.true(filesystem.aux.includes('write:'));
});

test('workspace declaration reaches the mount surface transitively', t => {
  const { workspace } = fsDeclarations;
  t.is(workspace.body, 'DaemonMount');
  t.true(workspace.aux.includes('type MountEndoMountFile ='));
  t.true(workspace.aux.includes('type MountEndoMountEntry = MountPathEntry;'));
  t.true(workspace.aux.includes('lookup:'));
  t.true(workspace.aux.includes('write:'));
  // Nothing the daemon reaches may arrive as a dangling module reference: a
  // type the walk cannot follow collapses to `unknown` instead.
  t.false(workspace.aux.includes("import('@endo/"));
});

test('workspace declaration names mount result records and path conventions', t => {
  const { aux } = fsDeclarations.workspace;
  for (const shape of [
    "kind: () => 'directory';",
    "kind: () => 'file';",
    'list: () => Promise<never>;',
    'entry: (path: string | string[])',
    'lookup: (path: string | readonly string[] | MountEndoMountEntry)',
    'type MountEndoMountStat = {',
    // `GrepMatch` lives behind `@endo/platform/fs/search.types`, whose
    // published type entry point only re-exports it.
    'type MountGrepMatch = {',
    // `followNameChanges` returns an `@endo/exo-stream` reader parameterized
    // by the daemon's own change union.
    'followNameChanges: (...pathSegments: string[]) => MountPassableReader<MountNameChange, undefined>;',
  ]) {
    t.true(aux.includes(shape), `missing named result shape: ${shape}`);
  }
  // `BlobRef.range()` / `.textRange()` derive a generic `RichReadableBlob`
  // (per the range-attenuation surface, PR #910); the authored source imports
  // that type from `@endo/platform/fs/lite/types`, so the extractor follows the
  // import and the results name the concrete shape instead of `unknown`. In the
  // workspace declaration the alias carries the `Mount` prefix.
  t.true(
    aux.includes(
      'range: (start: bigint, end?: bigint) => Promise<MountRichReadableBlob>;',
    ),
    'BlobRef.range names the derived MountRichReadableBlob',
  );
  t.true(
    aux.includes(
      'textRange: (startLine: number, endLine: number) => Promise<MountRichReadableBlob>;',
    ),
    'BlobRef.textRange names the derived MountRichReadableBlob',
  );
  // The `unknown` results left are the caller-supplied stream promise of
  // `streamBase64()`, `BlobRef.json()` (which parses arbitrary JSON), the
  // whole-tree `snapshot()`, and the mount `lookup()` — none of them the
  // range-attenuation methods, which name their concrete `MountRichReadableBlob`.
  const unknownResults = aux
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes('=> Promise<unknown>'));
  t.deepEqual(unknownResults, [
    'json: () => Promise<unknown>;',
    'snapshot: () => Promise<unknown>;',
    'streamBase64: (synPromise: unknown) => Promise<unknown>;',
    'json: () => Promise<unknown>;',
    'lookup: (petNamePath: string | readonly string[]) => Promise<unknown>;',
  ]);
  // The sole `: any` is the structural `ReadableBlobSource` variadic; no
  // concrete result type leaks `any`.
  const anyLeaks = aux
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes(': any'));
  t.deepEqual(anyLeaks, [
    'streamBase64: (...args: any[]) => PromiseLike<unknown>;',
  ]);
  t.true(aux.includes('mtime: bigint;'));
  t.false(aux.includes('wait?: boolean;'));
});

// `EndoMount` declares `has` twice, once for path segments and once for a
// minted entry. An overload set is one member of the guarded interface, so it
// prints as one member whose type carries both call signatures.
test('workspace declaration folds the mount overload set into one member', t => {
  const { aux } = fsDeclarations.workspace;
  t.true(
    aux.includes(
      `  has: {
    (...pathSegments: string[]): Promise<boolean>;
    (entry: MountEndoMountEntry): Promise<boolean>;
};`,
    ),
  );
  t.is(
    listDeclaredTypeMembers(aux, 'DaemonMount').filter(name => name === 'has')
      .length,
    1,
  );
});
