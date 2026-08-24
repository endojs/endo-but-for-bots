// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify as nodePromisify } from 'node:util';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/compat';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';
import { makeGit } from '@endo/exo-git';
import { makeNativeGitBackend } from '@endo/git';
import { makeMount, lineageOf } from '@endo/daemon/src/mount.js';
import { makeFilePowers } from '@endo/daemon/src/manager-node-powers.js';
import {
  isFilesystemReadOnly,
  isFilesystemReadWrite,
  makeInMemoryFilesystem,
  makeNodeFilesystem,
  readOnly,
} from '@endo/platform/fs/extended';

import { makeEvaluateTool } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import { makeCompartmentEvaluate } from '@endo/agent-tools/code-mode/compartment.js';
import { makeWorkspaceGlobal } from '@endo/agent-tools/code-mode-globals/fs.js';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { gitDeclarations } from '@endo/agent-tools/generated/code-mode-globals/git-declarations.js';
import { fsDeclarations } from '@endo/agent-tools/generated/code-mode-globals/fs-declarations.js';
import {
  makeCodeModeSystemPrompt,
  makeCodeModeAgent,
  makeCodeModeAgentFromLookup,
  makeCodeModeGitLoopAgent,
  resolveCodeModePowers,
} from '../src/code-mode.js';
import { defineAgent, makeEnvCredentials } from '../src/define-agent.js';

/** @import { CodeModeGlobal, CodeModePower, Evaluate } from '@endo/agent-tools/code-mode/types.js' */
/** @import { Model } from '@earendil-works/pi-ai' */
/** @import { PassableBytesReader, PassableBytesWriter } from '@endo/exo-stream' */

const execFileAsync = nodePromisify(execFile);

/**
 * Register a per-test faux pi-ai provider whose responses are seeded by the
 * test. Returns the faux `Model` to drive an agent with, plus the registration
 * handle (so the test can teardown the registration).
 *
 * @param {import('ava').ExecutionContext} t
 * @param {import('@earendil-works/pi-ai').AssistantMessage[]} responses
 * @returns {Model<string>}
 */
const fauxModel = (t, responses) => {
  const registration = registerFauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-model' }],
  });
  registration.setResponses(responses);
  t.teardown(() => registration.unregister());
  return registration.getModel();
};

/**
 * @param {Record<string, unknown>} endowments
 * @returns {Evaluate}
 */
const compartmentEvaluateOver = endowments =>
  makeCompartmentEvaluate({ endowments: harden({ E, ...endowments }) });

/**
 * @param {string[]} calls
 */
const makeStubGit = calls =>
  Far('StubGit', {
    async branches() {
      calls.push('branches');
      return harden([{ name: 'main', kind: 'branch' }]);
    },
    async currentBranch() {
      calls.push('currentBranch');
      return harden({ name: 'main', kind: 'branch' });
    },
  });

/**
 * @param {import('ava').ExecutionContext} t
 */
const provisionGitWorktree = async t => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'agentry-git-loop-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', '--local', 'commit.gpgsign', 'false'], {
    cwd: root,
  });
  await execFileAsync('git', ['config', '--local', 'tag.gpgsign', 'false'], {
    cwd: root,
  });
  await execFileAsync('git', ['config', '--local', 'user.email', 't@t'], {
    cwd: root,
  });
  await execFileAsync('git', ['config', '--local', 'user.name', 'T'], {
    cwd: root,
  });
  await fs.promises.writeFile(path.join(root, 'note.txt'), 'before\n');
  await execFileAsync('git', ['add', 'note.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
  return root;
};

/**
 * Build a live exo `Git` capability over a fresh real repository using the real
 * daemon mount (the same recipe `@endo/agent-tools`'s git-flow test uses): a
 * writable `EndoMount` over the worktree, a `NativeGitBackend`, and `makeGit`.
 * This exercises the real, inert `EndoMountEntry` exo and its private
 * `mountEntryRecords` WeakMap.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {boolean} [allowHistoryRewrite]
 */
const makeRealGit = async (t, allowHistoryRewrite = false) => {
  const repoRoot = await provisionGitWorktree(t);
  const filePowers = makeFilePowers({ fs, path });
  const mount = makeMount({ rootPath: repoRoot, readOnly: false, filePowers });
  const backend = makeNativeGitBackend({ repoRoot });
  const git = makeGit({ mount, backend, lineageOf }, { allowHistoryRewrite });
  return harden({ repoRoot, workspace: mount, git });
};

/**
 * @param {PassableBytesReader} readerRef
 * @returns {Promise<Uint8Array>}
 */
const collectBytes = async readerRef => {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of iterateBytesReader(readerRef)) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

/**
 * @param {unknown} file
 */
const readFileText = async file => {
  const fileRef = /** @type {any} */ (file);
  const stat = await E(fileRef).getStat();
  const openFile = await E(fileRef).open({ read: true });
  try {
    const reader = await E(openFile).read(0n, stat.size ?? 0n);
    return new TextDecoder().decode(await collectBytes(reader));
  } finally {
    await E(openFile).close();
  }
};

/**
 * @param {unknown} file
 * @param {string} text
 */
const writeFileText = async (file, text) => {
  const bytes = new TextEncoder().encode(text);
  const fileRef = /** @type {any} */ (file);
  const openFile = await E(fileRef).open({ write: true });
  try {
    const writer = iterateBytesWriter(await E(openFile).write(0n));
    await writer.next(bytes);
    await writer.return();
    await E(openFile).truncate(BigInt(bytes.length));
  } finally {
    await E(openFile).close();
  }
};

test('an untyped global carries name + one-line description only', t => {
  /** @type {CodeModeGlobal[]} */
  const globals = harden([
    {
      name: 'git',
      petName: 'git',
      description: 'Read/write @endo/exo-git Git capability for the repo.',
    },
    {
      name: 'repoName',
      description: 'Human-readable repository name.',
    },
  ]);
  const systemPrompt = makeCodeModeSystemPrompt(globals);

  // Globals without a declaration stay name-only; the model introspects live
  // caps via __getMethodNames__ at runtime.
  t.true(systemPrompt.includes('declare const git;'));
  t.true(systemPrompt.includes('declare const repoName;'));
  t.true(
    systemPrompt.includes(
      '// Read/write @endo/exo-git Git capability for the repo.',
    ),
  );
  t.false(systemPrompt.includes('declare const git:'));
  t.true(systemPrompt.includes('__getMethodNames__'));
  t.false(systemPrompt.includes('resultName'));

  const storedPrompt = makeCodeModeSystemPrompt(globals, { storeValue: true });
  t.true(storedPrompt.includes('resultName'));
});

test('a typed global injects its generated declaration into the prompt', t => {
  /** @type {CodeModeGlobal[]} */
  const globals = harden([
    {
      name: 'git',
      petName: 'git',
      description: 'Read/write git.',
      declaration: gitDeclarations.git,
    },
    {
      name: 'workspace',
      petName: 'workspace',
      description: 'Writable Filesystem.',
      declaration: fsDeclarations.workspace,
    },
  ]);
  const systemPrompt = makeCodeModeSystemPrompt(globals);

  // git: TS-canonical, inlined at the global declaration plus the supporting
  // aliases the printer emitted.
  t.true(systemPrompt.includes('declare const git: {'));
  t.true(
    systemPrompt.includes('commit: (message: string) => Promise<GitCommit>'),
  );
  t.true(systemPrompt.includes('type GitCommit ='));
  // workspace: the raw daemon mount bound by code-mode provisioning.
  t.true(systemPrompt.includes('declare const workspace: {'));
  t.true(systemPrompt.includes('type MountPathEntry = {'));
  t.true(systemPrompt.includes("kind: () => 'directory';"));
  t.true(systemPrompt.includes("kind: () => 'file';"));
  t.true(
    systemPrompt.includes('workspace` binding is the workspace root itself'),
  );
  t.true(systemPrompt.includes('workspace.entry()'));
  // The runtime introspection fallback is still advertised.
  t.true(systemPrompt.includes('__getMethodNames__'));
});

test('makeCodeModeAgent configures one history-rewrite git capability', async t => {
  const { workspace, git } = await makeRealGit(t, true);
  const { globals, systemPrompt } = makeCodeModeAgent({
    model: fauxModel(t, []),
    powers: { workspace, git, gitMode: 'historyRewrite' },
  });
  t.deepEqual(
    globals.map(global => global.name),
    ['workspace', 'git'],
  );
  t.true(systemPrompt.includes('declare const git: {'));
  t.true(systemPrompt.includes('commit: (message: string, options?: {'));
  t.true(systemPrompt.includes('reword:'));
  t.true(systemPrompt.includes('cherryPick:'));
  t.true(systemPrompt.includes('rebase:'));
});

test('makeCodeModeAgent rejects ordinary Git for history-rewrite mode', async t => {
  const { workspace, git } = await makeRealGit(t);
  t.throws(
    () =>
      makeCodeModeAgent({
        model: fauxModel(t, []),
        powers: { workspace, git, gitMode: 'historyRewrite' },
      }),
    { message: /requires a Git capability with history-rewrite authority/ },
  );
});

test('makeCodeModeAgent injects typed git + workspace declarations from powers', async t => {
  const { workspace, git } = await makeRealGit(t);
  const { systemPrompt } = makeCodeModeAgent({
    model: fauxModel(t, []),
    powers: { workspace, git },
  });
  t.true(systemPrompt.includes('declare const git: {'));
  t.true(systemPrompt.includes('declare const workspace: {'));
});

test('makeCodeModeAgent selects the matching standalone Filesystem declaration', t => {
  const workspace = makeNodeFilesystem({ rootPath: process.cwd() });
  const { globals, systemPrompt } = makeCodeModeAgent({
    model: fauxModel(t, []),
    powers: { workspace, workspaceSurface: 'filesystem' },
  });
  t.deepEqual(
    globals.map(global => global.declaration?.body.startsWith('{')),
    [true],
  );
  t.true(systemPrompt.includes('declare const workspace: {'));
});

test('makeEnvCredentials is the single env reader and reads through .get', t => {
  const credentials = makeEnvCredentials({ TOKEN: 'secret', EMPTY: '' });
  t.is(credentials.get('TOKEN'), 'secret');
  // Empty values read as undefined.
  t.is(credentials.get('EMPTY'), undefined);
  t.is(credentials.get('ABSENT'), undefined);
});

test('defineAgent returns a maker that builds a powered agent', t => {
  /** @type {Model<string>} */
  const model = harden({
    id: 'm',
    name: 'faux/m',
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: 'http://invalid.example',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  });
  const tool = makeEvaluateTool(async () => 'ok', []);
  const makeCodeModeAgentMaker = defineAgent({
    model,
    instructions: 'You are codeMode.',
    tools: [
      {
        name: 'evaluate',
        label: 'evaluate',
        description: tool.description,
        parameters: /** @type {any} */ (tool.parameters),
        execute: async () => ({ content: [], details: undefined }),
      },
    ],
  });
  t.is(typeof makeCodeModeAgentMaker, 'function');
  const agent = makeCodeModeAgentMaker();
  t.deepEqual(
    agent.state.tools.map(agentTool => agentTool.name),
    ['evaluate'],
  );
  t.is(agent.state.systemPrompt, 'You are codeMode.');
});

test('makeCodeModeAgent exposes only evaluate and rejects non-readOnly git in readOnly mode', async t => {
  const { workspace, git } = await makeRealGit(t);
  const model = fauxModel(t, [fauxAssistantMessage('done')]);

  t.throws(
    () =>
      makeCodeModeAgent({
        model,
        powers: { workspace, git, gitMode: 'readOnly' },
      }),
    { message: /requires an already read-only Git capability/ },
  );

  const readOnlyGit = /** @type {{ readOnly: () => CodeModePower }} */ (
    /** @type {unknown} */ (git)
  ).readOnly();
  const { agent, globals } = makeCodeModeAgent({
    model,
    powers: { workspace, git: readOnlyGit, gitMode: 'readOnly' },
  });
  t.deepEqual(
    agent.state.tools.map(tool => tool.name),
    ['evaluate'],
  );
  t.deepEqual(
    globals.map(global => global.name),
    ['workspace', 'git'],
  );
});

test('faux provider drives a scripted named-capability code-mode agent', async t => {
  const gitCalls = [];
  const git = makeStubGit(gitCalls);
  const executions = [];
  const source =
    '(async () => (await E(git).branches()).map(branch => branch.name))()';
  const model = fauxModel(t, [
    fauxAssistantMessage(fauxToolCall('evaluate', { source }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('done'),
  ]);
  const { agent } = makeCodeModeAgent({
    model,
    endowments: { git },
    evaluate: async input => {
      const result = await compartmentEvaluateOver({ git })(input);
      executions.push(result);
      return result;
    },
  });

  await agent.prompt('List branch names.');
  await agent.waitForIdle();

  t.deepEqual(gitCalls, ['branches']);
  t.deepEqual(executions, [['main']]);
});

test('makeCodeModeAgent rejects declarations for unrecognized endowments', t => {
  const capability = Far('Capability', {});
  t.throws(
    () =>
      makeCodeModeAgent({
        model: fauxModel(t, []),
        endowments: { capability },
        globals: harden([
          { name: 'capability', declaration: { body: 'WritableEndoGit' } },
        ]),
      }),
    {
      message:
        /cannot claim a declaration without a recognized capability posture/,
    },
  );
});

test('hostile foreign Git and Filesystem objects cannot self-attest posture', t => {
  let postureCalls = 0;
  const hostileGit = Far('HostileGit', {
    readOnly() {
      postureCalls += 1;
      return false;
    },
    historyRewrite() {
      postureCalls += 1;
      return true;
    },
  });
  const hostileFilesystem = Far('HostileFilesystem', {
    readOnly() {
      postureCalls += 1;
      return this;
    },
    root() {
      postureCalls += 1;
      return this;
    },
  });
  t.throws(
    () =>
      makeCodeModeAgent({
        model: fauxModel(t, []),
        powers: { git: hostileGit },
      }),
    { message: /recognized same-vat Git capability/ },
  );
  t.throws(
    () =>
      makeCodeModeAgent({
        model: fauxModel(t, []),
        powers: { workspace: hostileFilesystem },
      }),
    { message: /locally recognized exact reader or writer posture/ },
  );
  t.is(postureCalls, 0);
});

test('filesystem posture forgery subpaths are unreachable and unrecognized objects fail closed', async t => {
  const postureSubpath = ['@endo/platform/fs/extended', 'posture.js'].join('/');
  await t.throwsAsync(() => import(postureSubpath), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });

  const hostileFilesystem = Far('HostileFilesystem', {
    root() {
      return this;
    },
    named() {
      return this;
    },
    statfs() {
      return harden({});
    },
    brands() {
      return harden([]);
    },
    help() {
      return 'hostile';
    },
  });
  t.throws(
    () =>
      makeCodeModeAgent({
        model: fauxModel(t, []),
        powers: {
          workspace: hostileFilesystem,
          workspaceSurface: 'filesystem',
        },
      }),
    { message: /locally recognized exact reader or writer posture/ },
  );
  t.false(isFilesystemReadOnly(hostileFilesystem));
  t.false(isFilesystemReadWrite(hostileFilesystem));
});

test('recognized filesystem reader and writer globals retain exact declarations', t => {
  const writer = makeInMemoryFilesystem();
  const reader = readOnly(writer);

  t.false(isFilesystemReadOnly(writer));
  t.true(isFilesystemReadWrite(writer));
  t.true(isFilesystemReadOnly(reader));
  t.false(isFilesystemReadWrite(reader));

  const writerGlobal = makeCodeModeAgent({
    model: fauxModel(t, []),
    powers: { workspace: writer, workspaceSurface: 'filesystem' },
  }).globals[0];
  const readerGlobal = makeCodeModeAgent({
    model: fauxModel(t, []),
    powers: { workspace: reader, workspaceSurface: 'filesystem' },
  }).globals[0];
  t.deepEqual(writerGlobal.declaration, fsDeclarations.filesystem);
  t.deepEqual(readerGlobal.declaration, fsDeclarations.filesystem);
  t.is(
    writerGlobal.description,
    'Writable @endo/platform/fs/extended Filesystem.',
  );
  t.is(
    readerGlobal.description,
    'Read-only @endo/platform/fs/extended Filesystem; mutating methods reject with EACCES at the capability.',
  );
});

test('a reader filesystem grant describes read-only authority in the prompt', t => {
  const reader = readOnly(makeInMemoryFilesystem());
  const { globals, systemPrompt } = makeCodeModeAgent({
    model: fauxModel(t, []),
    powers: { workspace: reader, workspaceSurface: 'filesystem' },
  });

  // The global shape: one grant, the exact generated Filesystem declaration,
  // and a description that states mutation rejects.
  t.deepEqual(
    globals.map(global => global.name),
    ['workspace'],
  );
  t.deepEqual(globals[0].declaration, fsDeclarations.filesystem);
  t.is(
    globals[0].description,
    'Read-only @endo/platform/fs/extended Filesystem; mutating methods reject with EACCES at the capability.',
  );

  // The generated prompt must not advertise a writable filesystem.
  t.true(systemPrompt.includes('declare const workspace: {'));
  t.true(
    systemPrompt.includes(
      'Read-only @endo/platform/fs/extended Filesystem; mutating methods reject with EACCES at the capability.',
    ),
  );
  t.false(
    systemPrompt.includes('Writable @endo/platform/fs/extended Filesystem.'),
  );
});

test('lookup-backed workspace and git powers resolve before posture validation', async t => {
  const { workspace, git } = await makeRealGit(t);
  const looked = [];
  const lookupPowers = Far('Powers', {
    async lookup(petName) {
      looked.push(petName);
      if (petName === 'workspace') return workspace;
      if (petName === 'git') return git;
      throw new Error(`no such power ${petName}`);
    },
  });

  // The synchronous entry point cannot inspect a promise's posture, so it
  // refuses rather than minting an unvalidated grant.
  t.throws(
    () =>
      makeCodeModeAgent({
        model: fauxModel(t, []),
        lookupPowers,
        powers: { workspacePetName: 'workspace', gitPetName: 'git' },
      }),
    {
      message:
        /code-mode workspace capability must be resolved before posture validation/,
    },
  );

  const { globals, systemPrompt } = await makeCodeModeAgentFromLookup({
    model: fauxModel(t, []),
    lookupPowers,
    powers: { workspacePetName: 'workspace', gitPetName: 'git' },
  });
  t.deepEqual(looked.sort(), ['git', 'workspace']);
  t.deepEqual(
    globals.map(global => global.name),
    ['workspace', 'git'],
  );
  t.true(systemPrompt.includes('declare const workspace: {'));
  t.true(systemPrompt.includes('declare const git: {'));
});

test('resolveCodeModePowers leaves inline capabilities and named powers alone', async t => {
  const { workspace, git } = await makeRealGit(t);
  const looked = [];
  const lookupPowers = Far('Powers', {
    async lookup(petName) {
      looked.push(petName);
      return Far('Cap', {});
    },
  });
  const powers = harden({
    workspace,
    git,
    namedPowers: [{ name: 'helper', petName: 'helper-cap' }],
  });
  t.is(await resolveCodeModePowers(powers, lookupPowers), powers);
  t.deepEqual(looked, []);
});

test('lookup-backed named powers stay opaque and resolve exactly once', async t => {
  let lookups = 0;
  const lookupPowers = Far('Powers', {
    async lookup() {
      lookups += 1;
      return Far('Capability', {});
    },
  });
  const options = {
    model: fauxModel(t, []),
    lookupPowers,
    powers: { namedPowers: [{ name: 'helper', petName: 'helper-cap' }] },
  };
  const { globals } = makeCodeModeAgent(options);
  await Promise.resolve();
  t.is(lookups, 1);
  t.deepEqual(globals, [
    { name: 'helper', petName: 'helper-cap', description: undefined },
  ]);

  t.throws(
    () =>
      makeCodeModeAgent({
        ...options,
        globals: [
          {
            name: 'helper',
            petName: 'helper-cap',
            declaration: { body: 'WritableEndoGit' },
          },
        ],
      }),
    { message: /globals must be derived from live capability posture/ },
  );
});

test('a lookup-backed capability still requires a lookup powers handle', async t => {
  await t.throwsAsync(
    () =>
      makeCodeModeAgentFromLookup({
        model: fauxModel(t, []),
        powers: { gitPetName: 'git' },
      }),
    { message: /code-mode git capability requires powers/ },
  );
});

test('the git-loop preset preserves a caller-supplied system prompt', async t => {
  const { workspace, git } = await makeRealGit(t);
  const systemPrompt = 'You are a bespoke repository agent.';
  const agent = makeCodeModeGitLoopAgent({
    model: fauxModel(t, []),
    workspace,
    git,
    systemPrompt,
  });
  t.true(agent.state.systemPrompt.startsWith(systemPrompt));
  t.false(
    agent.state.systemPrompt.includes(
      'You are an Endo-hosted Pi coding agent.',
    ),
  );
});

test('git-loop preset edits the workspace, commits, and reads HEAD~1 over a real mount', async t => {
  const { repoRoot, workspace, git } = await makeRealGit(t);

  const executions = [];
  const source = `\
(async () => {
  const listed = await E(workspace).list();
  const note = await E(workspace).lookup('note.txt');
  const beforeStat = await E(note).stat();

  await E(note).writeText('after\\n');

  const status = await E(git).status();
  const row = status.entries.find(candidate => candidate.path === 'note.txt');
  if (row === undefined) {
    throw new Error('note.txt did not appear in git status');
  }
  await E(git).add([row.path]);
  const worktree = await E(git).worktree();
  const entry = await E(worktree).entry(row.path);
  const stagedDiff = await E(git).diff({ cached: true, entries: [entry] });
  const commit = await E(git).commit('agent edit');

  const previousFs = await E(git).filesystemAt('HEAD~1');
  const previousRoot = await E(previousFs).root();
  const previousNote = await E(previousRoot).lookup('note.txt');
  const previousText = await readFileText(previousNote);
  const currentText = await E(note).text();

  return {
    listed: [...listed].sort(),
    beforeSize: String(beforeStat.size),
    status: { path: row.path, index: row.index, worktree: row.worktree },
    stagedDiffHasEdit: stagedDiff.includes('+after'),
    commitSummary: commit.summary,
    previousText,
    currentText,
  };
})()`;
  const evaluate = async input => {
    const result = await compartmentEvaluateOver({
      git,
      workspace,
      readFileText,
      writeFileText,
    })(input);
    executions.push(result);
    return result;
  };
  const model = fauxModel(t, [
    fauxAssistantMessage(fauxToolCall('evaluate', { source }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('done'),
  ]);
  const agent = makeCodeModeGitLoopAgent({
    model,
    workspace,
    git,
    evaluate,
    globals: harden([
      makeWorkspaceGlobal({ name: 'workspace' }),
      makeGitGlobal({ name: 'git' }),
      {
        name: 'readFileText',
        description: 'Read a UTF-8 file through an endo-fs File capability.',
      },
      {
        name: 'writeFileText',
        description: 'Write UTF-8 text through an endo-fs File capability.',
      },
    ]),
    endowments: { readFileText, writeFileText },
  });

  await agent.prompt('Edit note.txt, commit the change, and inspect HEAD~1.');
  await agent.waitForIdle();

  t.is(executions.length, 1);
  t.deepEqual(executions[0], {
    listed: ['.git', 'note.txt'],
    beforeSize: '7',
    status: { path: 'note.txt', index: 'clean', worktree: 'modified' },
    stagedDiffHasEdit: true,
    commitSummary: 'agent edit',
    previousText: 'before\n',
    currentText: 'after\n',
  });
  t.is(
    await fs.promises.readFile(path.join(repoRoot, 'note.txt'), 'utf8'),
    'after\n',
  );
  const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%s'], {
    cwd: repoRoot,
  });
  t.is(stdout.trim(), 'agent edit');
});
