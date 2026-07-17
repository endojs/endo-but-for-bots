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
import {
  makeNodeFilesystem,
  readOnly as readOnlyFilesystem,
} from '@endo/platform/fs/extended';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';
import { isGitReadOnly, makeGit } from '@endo/exo-git';
import { makeNativeGitBackend } from '@endo/git';
import { makeMount, lineageOf } from '@endo/daemon/src/mount.js';
import { makeFilePowers } from '@endo/daemon/src/daemon-node-powers.js';

import { makeEvaluateTool } from '@endo/agent-tools/code-mode/evaluate-tool.js';
import { makeCompartmentEvaluate } from '@endo/agent-tools/code-mode/compartment.js';
import { gitDeclarations } from '@endo/agent-tools/generated/code-mode-globals/git-declarations.js';
import { fsDeclarations } from '@endo/agent-tools/generated/code-mode-globals/fs-declarations.js';
import {
  makeCodeModeSystemPrompt,
  makeCodeModeAgent,
  prepareCodeMode,
} from '../src/code-mode.js';
import { defineAgent, makeEnvCredentials } from '../src/define-agent.js';

/** @import { CodeModeGlobal, Evaluate } from '@endo/agent-tools/code-mode/evaluate-tool.js' */
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
  const workspace = makeNodeFilesystem({ rootPath: repoRoot });
  const filePowers = makeFilePowers({ fs, path });
  const mount = makeMount({ rootPath: repoRoot, readOnly: false, filePowers });
  const backend = makeNativeGitBackend({ repoRoot });
  const git = makeGit({ mount, backend, lineageOf }, { allowHistoryRewrite });
  return harden({ repoRoot, workspace, git });
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

  // git: TS-canonical, referenced by its named root type plus the supporting
  // aliases the printer emitted.
  t.true(systemPrompt.includes('declare const git: WritableEndoGit;'));
  t.true(systemPrompt.includes('type WritableEndoGit = {'));
  t.true(
    systemPrompt.includes('commit: (message: string) => Promise<GitCommit>;'),
  );
  // workspace: guard-derived, reaching the Directory surface transitively.
  t.true(systemPrompt.includes('declare const workspace: Filesystem;'));
  t.true(systemPrompt.includes('type Directory = {'));
  // The runtime introspection fallback is still advertised.
  t.true(systemPrompt.includes('__getMethodNames__'));
});

test('makeCodeModeAgent infers the history-rewrite Git surface from its power', async t => {
  const { workspace, git } = await makeRealGit(t, true);
  const setup = await prepareCodeMode({
    host: { kind: 'inProcess' },
    powers: { workspace, git },
    access: 'rewriteHistory',
  });
  const { globals, systemPrompt } = makeCodeModeAgent({
    model: fauxModel(t, []),
    ...setup,
  });
  t.deepEqual(
    globals.map(global => global.name),
    ['workspace', 'git'],
  );
  t.true(systemPrompt.includes('declare const git: EndoGitHistory;'));
  t.true(
    systemPrompt.includes(
      'commit: (message: string, options?: GitCommitOptions) => Promise<GitCommit>;',
    ),
  );
  t.true(systemPrompt.includes('reword:'));
});

test('makeCodeModeAgent uses the ordinary Git surface without history-rewrite authority', async t => {
  const { workspace, git } = await makeRealGit(t);
  const setup = await prepareCodeMode({
    host: { kind: 'inProcess' },
    powers: { workspace, git },
    access: 'edit',
  });
  const { systemPrompt } = makeCodeModeAgent({
    model: fauxModel(t, []),
    ...setup,
  });
  t.true(systemPrompt.includes('declare const git: WritableEndoGit;'));
  t.false(systemPrompt.includes('declare const git: EndoGitHistory;'));
});

test('makeCodeModeAgent injects typed git + workspace declarations from powers', async t => {
  const { workspace, git } = await makeRealGit(t);
  const setup = await prepareCodeMode({
    host: { kind: 'inProcess' },
    powers: { workspace, git },
    access: 'edit',
  });
  const { systemPrompt } = makeCodeModeAgent({
    model: fauxModel(t, []),
    ...setup,
  });
  t.true(systemPrompt.includes('declare const git: WritableEndoGit;'));
  t.true(systemPrompt.includes('declare const workspace: Filesystem;'));
  t.true(systemPrompt.includes('type WritableEndoGit = {'));
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

test('prepareCodeMode inspect attenuates Git and workspace powers at runtime and in the prompt', async t => {
  const { workspace, git } = await makeRealGit(t);
  const model = fauxModel(t, [fauxAssistantMessage('done')]);
  const setup = await prepareCodeMode({
    host: { kind: 'inProcess' },
    powers: { workspace, git },
    access: 'inspect',
  });
  await t.throwsAsync(
    setup.evaluate({
      source:
        "(async () => E(await E(workspace).root()).write('new.txt', 'content'))()",
      globals: setup.globals,
    }),
    {
      message: /read-only Filesystem/,
    },
  );
  await t.throwsAsync(
    setup.evaluate({
      source: "E(git).commit('not allowed')",
      globals: setup.globals,
    }),
    {
      message: /not permitted on a read-only Git capability/,
    },
  );
  const attenuatedGit = await setup.evaluate({
    source: 'git',
    globals: setup.globals,
  });
  t.true(isGitReadOnly(attenuatedGit));
  const root = await E(workspace).root();
  await E(root).write('still-writable.txt', 'content');
  const { agent, globals, systemPrompt } = makeCodeModeAgent({
    model,
    ...setup,
  });
  t.deepEqual(
    agent.state.tools.map(tool => tool.name),
    ['evaluate'],
  );
  t.deepEqual(
    globals.map(global => global.name),
    ['workspace', 'git'],
  );
  t.true(systemPrompt.includes('declare const git: ReadOnlyEndoGit;'));
  t.true(
    systemPrompt.includes(
      'Read-only @endo/platform/fs/extended Filesystem for repository inspection.',
    ),
  );
  t.false(systemPrompt.includes('write: (arg0: string, arg1: string)'));
});

test('prepareCodeMode refuses to widen read-only workspace or Git powers', async t => {
  const { workspace, git } = await makeRealGit(t);
  const readOnlyWorkspace = readOnlyFilesystem(workspace);
  const readOnlyGit = git.readOnly();
  await t.throwsAsync(
    prepareCodeMode({
      host: { kind: 'inProcess' },
      powers: { workspace: readOnlyWorkspace, git },
      access: 'edit',
    }),
    { message: /requires a proven writable Filesystem.*read-only posture/ },
  );
  await t.throwsAsync(
    prepareCodeMode({
      host: { kind: 'inProcess' },
      powers: { workspace, git: readOnlyGit },
      access: 'rewriteHistory',
    }),
    { message: /requires a proven writable Git.*read-only posture/ },
  );
});

test('prepareCodeMode never treats unknown Git posture as writable', async t => {
  const readOnlyFake = Far('ReadOnlyFakeGit', {
    async branches() {
      return harden([]);
    },
  });
  const fake = Far('RemoteShapedFakeGit', {
    readOnly() {
      return readOnlyFake;
    },
  });
  const cases = [
    {
      label: 'direct fake',
      host: /** @type {const} */ ({ kind: 'inProcess' }),
      powers: { git: fake },
    },
    {
      label: 'promise',
      host: /** @type {const} */ ({ kind: 'inProcess' }),
      powers: { git: Promise.resolve(fake) },
    },
    {
      label: 'lookup-resolved fake',
      host: /** @type {const} */ ({
        kind: 'inProcess',
        powers: Far('LookupPowers', {
          async lookup() {
            return fake;
          },
        }),
      }),
      powers: { gitPetName: 'git-cap' },
    },
  ];
  for (const candidate of cases) {
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(
      prepareCodeMode({
        host: candidate.host,
        powers: candidate.powers,
        access: 'edit',
      }),
      { message: /unknown posture/ },
    );
    t.truthy(error, candidate.label);
  }

  const inspect = await prepareCodeMode({
    host: { kind: 'inProcess' },
    powers: { git: fake },
    access: 'inspect',
  });
  t.true(inspect.globals[0].description?.startsWith('Read-only @endo/exo-git'));
  t.is(
    await inspect.evaluate({ source: 'git', globals: inspect.globals }),
    readOnlyFake,
  );
});

test('prepareCodeMode inspect leaves unsupported named powers unchanged', async t => {
  let count = 0;
  const counter = Far('Counter', {
    increment() {
      count += 1;
      return count;
    },
  });
  const description = 'Mutable counter capability; unchanged by setup.';
  const setup = await prepareCodeMode({
    host: { kind: 'inProcess' },
    powers: {
      namedPowers: [{ name: 'counter', description, power: counter }],
    },
    access: 'inspect',
  });
  t.is(setup.globals[0].description, description);
  t.is(
    await setup.evaluate({
      source: 'E(counter).increment()',
      globals: setup.globals,
    }),
    1,
  );
});

test('prepareCodeMode daemon preparation trusts only matching host attestations', async t => {
  const preparationCalls = [];
  const evaluationCalls = [];
  const credential = Far('Credential', {});
  const controller = Far('HostController', {});
  const daemonPowers = Far('DaemonPowers', {
    async prepareCodeMode(request) {
      preparationCalls.push(request);
      return harden({
        access: request.access,
        workspace: {
          petName: ['prepared', 'workspace'],
          readOnly: false,
        },
        git: {
          petName: ['prepared', 'git'],
          readOnly: false,
          historyRewrite: false,
        },
        namedPowers: harden([]),
        controller,
      });
    },
    async evaluate(...args) {
      evaluationCalls.push(args);
      return 'daemon-result';
    },
  });
  const setup = await prepareCodeMode({
    host: { kind: 'daemon', powers: daemonPowers },
    repository: {
      remoteUrl: 'https://example.invalid/org/repository.git',
      credential,
    },
    access: 'edit',
  });
  t.is(preparationCalls.length, 1);
  t.is(
    preparationCalls[0].repository.remoteUrl,
    'https://example.invalid/org/repository.git',
  );
  t.is(preparationCalls[0].repository.credential, credential);
  t.deepEqual(
    setup.globals.map(({ name, petName }) => ({ name, petName })),
    [
      { name: 'workspace', petName: ['prepared', 'workspace'] },
      { name: 'git', petName: ['prepared', 'git'] },
    ],
  );
  t.false(JSON.stringify(setup.globals).includes('HostController'));
  t.false(JSON.stringify(setup.globals).includes('Credential'));
  const result = await setup.evaluate({
    source: 'E(git).status()',
    resultName: ['results', 'status'],
    globals: setup.globals,
  });
  t.is(result, 'daemon-result');
  t.deepEqual(evaluationCalls, [
    [
      undefined,
      'E(git).status()',
      ['workspace', 'git'],
      [
        ['prepared', 'workspace'],
        ['prepared', 'git'],
      ],
      ['results', 'status'],
    ],
  ]);
});

test('prepareCodeMode daemon preparation rejects contradictory attestations', async t => {
  const daemonPowers = Far('ContradictoryDaemonPowers', {
    async prepareCodeMode() {
      return harden(
        /** @type {const} */ ({
          access: 'inspect',
          git: {
            petName: 'git',
            readOnly: false,
            historyRewrite: false,
          },
          namedPowers: [],
        }),
      );
    },
    async evaluate() {
      return undefined;
    },
  });
  await t.throwsAsync(
    prepareCodeMode({
      host: { kind: 'daemon', powers: daemonPowers },
      powers: { gitPetName: 'git' },
      access: 'inspect',
    }),
    { message: /Git attestation contradicts requested access/ },
  );
});

test('prepareCodeMode edit grants ordinary runtime mutation', async t => {
  const { workspace, git } = await makeRealGit(t);
  const setup = await prepareCodeMode({
    host: { kind: 'inProcess' },
    powers: { workspace, git },
    access: 'edit',
  });
  const result = await setup.evaluate({
    source: `\
(async () => {
  const root = await E(workspace).root();
  await E(root).write('new.txt', 'content');
  return (await E(git).status()).some(row => row.path === 'new.txt');
})()`,
    globals: setup.globals,
  });
  t.true(result);
  t.true(
    setup.globals.some(global =>
      global.description?.startsWith('Writable @endo/platform'),
    ),
  );
});

test('prepareCodeMode rewriteHistory advertises and retains elevated Git authority', async t => {
  const { workspace, git } = await makeRealGit(t, true);
  const setup = await prepareCodeMode({
    host: { kind: 'inProcess' },
    powers: { workspace, git },
    access: 'rewriteHistory',
  });
  const prompt = makeCodeModeSystemPrompt(setup.globals);
  t.true(prompt.includes('declare const git: EndoGitHistory;'));
  const result = await setup.evaluate({
    source: "E(git).commit('amended', { amend: true })",
    globals: setup.globals,
  });
  t.is(/** @type {{ summary: string }} */ (result).summary, 'amended');
});

test('read-only Filesystem attenuation still rejects direct writes', async t => {
  const { workspace } = await makeRealGit(t);
  const root = await E(readOnlyFilesystem(workspace)).root();
  await t.throwsAsync(E(root).write('new.txt', 'content'), {
    message: /read-only Filesystem/,
  });
});

test('faux provider drives a scripted evaluate-only code-mode agent', async t => {
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
    evaluate: async input => {
      const result = await compartmentEvaluateOver({ git })(input);
      executions.push(result);
      return result;
    },
    globals: harden([{ name: 'git', description: 'Repository Git.' }]),
  });

  await agent.prompt('List branch names.');
  await agent.waitForIdle();

  t.deepEqual(gitCalls, ['branches']);
  t.deepEqual(executions, [['main']]);
});

test('code-mode agent edits the workspace, commits, and reads HEAD~1 over a real mount', async t => {
  const { repoRoot, workspace, git } = await makeRealGit(t);

  const executions = [];
  const source = `\
(async () => {
  const root = await E(workspace).root();
  const cursor = await E(root).list();
  const listed = await E(cursor).toArray();
  const note = await E(root).lookup('note.txt');
  const beforeStat = await E(note).getStat();

  await writeFileText(note, 'after\\n');

  const rows = await E(git).status();
  const row = rows.find(candidate => candidate.path === 'note.txt');
  if (row === undefined) {
    throw new Error('note.txt did not appear in git status');
  }
  await E(git).add([row.entry]);
  const stagedDiff = await E(git).diff({ cached: true, entries: [row.entry] });
  const commit = await E(git).commit('agent edit');

  const previousFs = await E(git).filesystemAt('HEAD~1');
  const previousRoot = await E(previousFs).root();
  const previousNote = await E(previousRoot).lookup('note.txt');
  const previousText = await readFileText(previousNote);
  const currentText = await readFileText(note);

  return {
    listed: listed.map(entry => entry.name).sort(),
    beforeSize: String(beforeStat.size),
    status: { path: row.path, index: row.index, worktree: row.worktree },
    stagedDiffHasEdit: stagedDiff.includes('+after'),
    commitSummary: commit.summary,
    previousText,
    currentText,
  };
})()`;
  const setup = await prepareCodeMode({
    host: { kind: 'inProcess' },
    powers: {
      workspace,
      git,
      namedPowers: [
        {
          name: 'readFileText',
          description: 'Read a UTF-8 file through a File capability.',
          power: readFileText,
        },
        {
          name: 'writeFileText',
          description: 'Write UTF-8 text through a File capability.',
          power: writeFileText,
        },
      ],
    },
    access: 'edit',
  });
  const evaluate = async input => {
    const result = await setup.evaluate(input);
    executions.push(result);
    return result;
  };
  const model = fauxModel(t, [
    fauxAssistantMessage(fauxToolCall('evaluate', { source }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('done'),
  ]);
  const { agent } = makeCodeModeAgent({
    model,
    evaluate,
    globals: setup.globals,
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
