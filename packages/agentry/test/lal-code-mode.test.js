// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify as nodePromisify } from 'node:util';
import { E, Far } from '@endo/far';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { makeNodeFilesystem } from '@endo/endo-fs';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';
import { makeGit } from '@endo/exo-git';
import { makeNativeGitBackend } from '@endo/git';

import {
  makeLalCodeModeAgent,
  makeLalCodeModeSystemPrompt,
} from '../src/lal-code-mode.js';
import {
  makeLalCodeModeGitLoopAgent,
  makeLalCodeModeGitLoopGlobals,
} from '../src/lal-code-mode-git-loop.js';
import {
  gitReadOnlyCodeModeCapabilityType,
  gitWritableCodeModeCapabilityType,
  makeCodeModeApiKeyResolver,
  makeCodeModeRuntime,
} from '../src/code-mode-runtime.js';
import { registerEndoCodeModeExtension } from '../src/pi-extension.js';
import { make as makeCodeModeNode } from '../src/code-mode-agent-node.js';
import { makeCodeModeDelegateTool } from '../src/code-mode-delegation.js';

/** @import { LalCodeModeGlobal, LalCodeModeExecute } from '../src/lal-code-mode.js' */
/** @import { AssistantMessage, Model, StopReason } from '@earendil-works/pi-ai' */
/** @import { StreamFn } from '@earendil-works/pi-agent-core' */
/** @import { PassableBytesReader, PassableBytesWriter } from '@endo/exo-stream' */

/**
 * @typedef {{
 *   content: AssistantMessage['content'],
 *   stopReason: StopReason,
 * }} ScriptedAssistantTurn
 *
 * @typedef {{
 *   read(offset?: bigint, length?: bigint): Promise<PassableBytesReader>,
 *   write(offset?: bigint): Promise<PassableBytesWriter>,
 *   truncate(size: bigint): Promise<void>,
 *   close(): Promise<void>,
 * }} TestOpenFile
 *
 * @typedef {{
 *   getStat(): Promise<{ size?: bigint }>,
 *   open(opts?: { read?: boolean, write?: boolean }): Promise<TestOpenFile>,
 * }} TestFile
 *
 * @typedef {{
 *   lookup(name: string): Promise<TestDirectory>,
 * }} TestDirectory
 *
 * @typedef {{
 *   root(): Promise<TestDirectory>,
 * }} TestWorkspace
 */

/** @type {Model<string>} */
const stubModel = harden({
  id: 'stub-model',
  name: 'stub/stub-model',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'http://invalid.example',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
});

const execFileAsync = nodePromisify(execFile);

/**
 * @param {ScriptedAssistantTurn[]} script
 * @returns {StreamFn}
 */
const makeScriptedStreamFn = script => {
  let turn = 0;
  return (_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    const next = script[turn] || {
      content: [{ type: 'text', text: 'done' }],
      stopReason:  /** @type {const} */ ('stop'),
    };
    turn += 1;
    /** @type {AssistantMessage} */
    const partial = harden({
      role: /** @type {const} */('assistant'),
      content: [],
      api: stubModel.api,
      provider: stubModel.provider,
      model: stubModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason:  /** @type {const} */ ('stop'),
      timestamp: Date.now(),
    });
    /** @type {AssistantMessage} */
    const finalMessage = harden({
      ...partial,
      content: next.content,
      stopReason: next.stopReason,
    });
    stream.push({ type: 'start', partial });
    stream.push({
      type: 'done',
      reason: next.stopReason === 'toolUse' ? 'toolUse' : 'stop',
      message: finalMessage,
    });
    stream.end(finalMessage);
    return stream;
  };
};

/**
 * @param {string[]} calls
 */
const makeStubGit = calls =>
  Far('StubGit', {
    async log(options = {}) {
      calls.push(`log:${JSON.stringify(options)}`);
      return harden([{ oid: 'abc123', summary: 'initial commit' }]);
    },
    async diff(options = {}) {
      calls.push(`diff:${JSON.stringify(options)}`);
      return 'diff --git a/file.txt b/file.txt';
    },
    async show(ref) {
      calls.push(`show:${String(ref)}`);
      return 'commit abc123';
    },
    async commit(message) {
      calls.push(`commit:${message}`);
      return harden({ oid: 'def456', summary: message });
    },
    async branches() {
      calls.push('branches');
      return harden([{ name: 'main', kind: 'branch' }]);
    },
    async createBranch(name) {
      calls.push(`createBranch:${name}`);
      return harden({ name, kind: 'branch' });
    },
    async switchBranch(name) {
      calls.push(`switchBranch:${name}`);
    },
    async currentBranch() {
      calls.push('currentBranch');
      return harden({ name: 'main', kind: 'branch' });
    },
  });

/**
 * @param {Record<string, unknown>} endowments
 * @returns {LalCodeModeExecute}
 */
const makeCompartmentExecute = endowments => async ({ source }) => {
  const compartment = new Compartment(harden({ E, ...endowments }));
  return compartment.evaluate(source);
};

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
  const fileRef = /** @type {TestFile} */ (file);
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
  const fileRef = /** @type {TestFile} */ (file);
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

/**
 * @param {unknown} workspace
 */
const makeMountOverFilesystem = workspace => {
  const rootId = harden({});
  const entryRecords = new WeakMap();

  /**
   * @param {string | string[]} pathArg
   * @returns {string[]}
   */
  const normalize = pathArg => {
    if (Array.isArray(pathArg)) {
      return pathArg;
    }
    if (pathArg === '') {
      return [];
    }
    return pathArg.split('/').filter(segment => segment !== '');
  };

  /**
   * @param {string[]} segments
   */
  const makeEntry = segments => {
    const entry = Far('EndoMountEntry', {
      segments: () => harden([...segments]),
      child: name => makeEntry([...segments, name]),
    });
    entryRecords.set(entry, rootId);
    return entry;
  };

  /**
   * @param {string[]} segments
   */
  const lookup = async segments => {
    let node = await E(/** @type {TestWorkspace} */ (workspace)).root();
    for (const segment of segments) {
      // eslint-disable-next-line no-await-in-loop
      node = await E(node).lookup(segment);
    }
    return node;
  };

  const mount = Far('EndoMount', {
    entry: (pathArg = []) => makeEntry(normalize(pathArg)),
    lookup: (pathArg = []) => lookup(normalize(pathArg)),
    readOnly: () => mount,
  });

  return harden({
    mount,
    lineageOf: value =>
      value === mount ? rootId : entryRecords.get(/** @type {object} */ (value)),
  });
};

/** @type {LalCodeModeGlobal[]} */
const gitGlobals = harden([
  {
    name: 'git',
    petName: 'git',
    type: gitWritableCodeModeCapabilityType,
    description: 'Repository git capability.',
  },
]);

test('code-mode subpath exports resolve through package exports', async t => {
  const [
    runtimeModule,
    piExtensionModule,
    nodeModule,
    delegationModule,
  ] = await Promise.all([
    // eslint-disable-next-line import/no-unresolved
    import('@endo/agentry/code-mode-runtime'),
    // eslint-disable-next-line import/no-unresolved
    import('@endo/agentry/pi-extension'),
    // eslint-disable-next-line import/no-unresolved
    import('@endo/agentry/code-mode-agent-node'),
    // eslint-disable-next-line import/no-unresolved
    import('@endo/agentry/code-mode-delegation'),
  ]);

  t.is(typeof runtimeModule.makeCodeModeRuntime, 'function');
  t.is(typeof piExtensionModule.registerEndoCodeModeExtension, 'function');
  t.is(typeof nodeModule.make, 'function');
  t.is(typeof delegationModule.makeCodeModeDelegateTool, 'function');
});

test('lalCodeMode exposes only execute and injects all global type info', t => {
  const systemPrompt = makeLalCodeModeSystemPrompt([
    ...gitGlobals,
    {
      name: 'repoName',
      type: 'string',
      description: 'Human-readable repository name.',
    },
  ]);
  const agent = makeLalCodeModeAgent({
    model: stubModel,
    globals: gitGlobals,
    execute: async () => 'ok',
    systemPrompt,
  });

  t.deepEqual(
    agent.state.tools.map(tool => tool.name),
    ['execute'],
  );
  t.false(systemPrompt.includes('listMessages'));
  t.true(systemPrompt.includes('declare const git:'));
  t.true(systemPrompt.includes('currentBranch(): Promise'));
  t.true(systemPrompt.includes('declare const repoName: string;'));
});

test('code-mode runtime selects read-only versus writable Git declarations', t => {
  const readOnlyRuntime = makeCodeModeRuntime({
    config: {
      model: {},
      powers: { workspace: harden({}), git: harden({}), gitMode: 'readOnly' },
    },
    model: stubModel,
    execute: async () => 'ok',
  });
  const writableRuntime = makeCodeModeRuntime({
    config: {
      model: {},
      powers: { workspace: harden({}), git: harden({}), gitMode: 'readWrite' },
    },
    model: stubModel,
    execute: async () => 'ok',
  });

  t.true(
    readOnlyRuntime.systemPrompt.includes(gitReadOnlyCodeModeCapabilityType),
  );
  t.false(readOnlyRuntime.systemPrompt.includes('commit(message: string)'));
  t.true(writableRuntime.systemPrompt.includes('commit(message: string)'));
  t.deepEqual(
    readOnlyRuntime.agent.state.tools.map(tool => tool.name),
    ['execute'],
  );
});

test('code-mode token resolver uses documented precedence', async t => {
  const powers = Far('TokenPowers', {
    lookup: async petName => {
      t.deepEqual(petName, ['secrets', 'api']);
      return 'pet-token';
    },
  });

  await null;
  t.is(
    await makeCodeModeApiKeyResolver({
      modelConfig: {
        apiTokenPetName: ['secrets', 'api'],
        apiTokenEnvVar: 'TOKEN',
      },
      getApiKey: async () => 'callback-token',
      powers,
      env: { TOKEN: 'env-token' },
    })('openai'),
    'callback-token',
  );
  t.is(
    await makeCodeModeApiKeyResolver({
      modelConfig: {
        apiTokenPetName: ['secrets', 'api'],
        apiTokenEnvVar: 'TOKEN',
      },
      powers,
      env: { TOKEN: 'env-token' },
    })('openai'),
    'pet-token',
  );
  t.is(
    await makeCodeModeApiKeyResolver({
      modelConfig: {
        apiTokenPetName: ['secrets', 'api'],
        apiTokenEnvVar: 'TOKEN',
      },
      powers,
      env: { TOKEN: 'env-token' },
    })('openai'),
    'pet-token',
  );
  t.is(
    await makeCodeModeApiKeyResolver({
      modelConfig: { apiTokenEnvVar: 'TOKEN' },
      env: { TOKEN: 'env-token' },
    })('openai'),
    'env-token',
  );
  t.is(
    await makeCodeModeApiKeyResolver({
      modelConfig: {},
      env: {},
    })('openai'),
    undefined,
  );
  t.is(
    await makeCodeModeApiKeyResolver({
      modelConfig: {},
      env: {},
      localOllama: true,
    })('openai'),
    'ollama',
  );
});

test('code-mode runtime does not place API tokens in prompts or tool schemas', t => {
  const runtime = makeCodeModeRuntime({
    config: {
      model: { apiTokenEnvVar: 'TOKEN' },
      powers: { workspace: harden({}), git: harden({}) },
    },
    env: { TOKEN: 'super-secret-token' },
    model: stubModel,
    execute: async () => 'ok',
  });
  const toolSchemaText = JSON.stringify(runtime.tool.parameters);
  const initialMessagesText = JSON.stringify(runtime.agent.state.messages);

  t.false(runtime.systemPrompt.includes('super-secret-token'));
  t.false(toolSchemaText.includes('super-secret-token'));
  t.false(initialMessagesText.includes('super-secret-token'));
});

test('code-mode runtime rejects missing configured powers', t => {
  t.throws(
    () =>
      makeCodeModeRuntime({
        config: { model: {}, powers: {} },
        model: stubModel,
        execute: async () => 'ok',
      }),
    { message: /workspace capability requires powers/ },
  );
});

test('code-mode runtime exposes named powers only when configured', t => {
  const baseRuntime = makeCodeModeRuntime({
    config: {
      model: {},
      powers: { workspace: harden({}), git: harden({}) },
    },
    model: stubModel,
    execute: async () => 'ok',
  });
  const helper = () => 'helped';
  const namedPowerRuntime = makeCodeModeRuntime({
    config: {
      model: {},
      powers: {
        workspace: harden({}),
        git: harden({}),
        namedPowers: [
          {
            name: 'helper',
            type: '() => string',
            description: 'Test helper.',
          },
        ],
      },
    },
    endowments: { helper },
    model: stubModel,
    execute: async () => 'ok',
  });

  t.deepEqual(
    baseRuntime.globals.map(global => global.name),
    ['workspace', 'git'],
  );
  t.deepEqual(
    namedPowerRuntime.globals.map(global => global.name),
    ['workspace', 'git', 'helper'],
  );
  t.true(namedPowerRuntime.systemPrompt.includes('declare const helper'));
});

test('lalCodeMode executes code against an injected git global', async t => {
  const gitCalls = [];
  const git = makeStubGit(gitCalls);
  const executions = [];
  const execute = async input => {
    const result = await makeCompartmentExecute({ git })(input);
    executions.push({ source: input.source, result });
    return result;
  };
  const source =
    '(async () => (await E(git).currentBranch())?.name || "detached")()';
  const agent = makeLalCodeModeAgent({
    model: stubModel,
    globals: gitGlobals,
    execute,
    streamFn: makeScriptedStreamFn([
      {
        content: [
          {
            type:  /** @type {const} */ ('toolCall'),
            id: 'call-1-execute',
            name: 'execute',
            arguments: { source },
          },
        ],
        stopReason: /** @type {const} */ ('toolUse'),
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
      },
    ]),
  });

  await agent.prompt('Which branch is checked out?');
  await agent.waitForIdle();

  t.deepEqual(gitCalls, ['currentBranch']);
  t.is(executions.length, 1);
  t.is(executions[0].result, 'main');
  t.true(executions[0].source.includes('E(git).currentBranch()'));
});

test('programmatic code-mode runtime drives scripted execute-only agent', async t => {
  const gitCalls = [];
  const git = makeStubGit(gitCalls);
  const executions = [];
  const source =
    '(async () => (await E(git).branches()).map(branch => branch.name))()';
  const runtime = makeCodeModeRuntime({
    config: {
      model: {},
      powers: { workspace: harden({}), git, gitMode: 'readOnly' },
    },
    model: stubModel,
    execute: async input => {
      const result = await makeCompartmentExecute({ git })(input);
      executions.push(result);
      return result;
    },
    streamFn: makeScriptedStreamFn([
      {
        content: [
          {
            type: 'toolCall',
            id: 'call-1-execute',
            name: 'execute',
            arguments: { source },
          },
        ],
        stopReason: 'toolUse',
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
      },
    ]),
  });

  await runtime.agent.prompt('List branch names.');
  await runtime.agent.waitForIdle();

  t.deepEqual(gitCalls, ['branches']);
  t.deepEqual(executions, [['main']]);
  t.is(
    /** @type {{ gitMode: string }} */ (runtime.describe()).gitMode,
    'readOnly',
  );
});

test('Pi extension registers only Endo execute tool and delegates calls', async t => {
  const calls = [];
  const runtime = makeCodeModeRuntime({
    config: {
      model: {},
      powers: { workspace: harden({}), git: harden({}) },
    },
    model: stubModel,
    execute: async input => {
      calls.push(input.source);
      return harden({ ok: true, source: input.source });
    },
  });
  /**
   * @type {{
   *   tools: Array<{ name: string, execute: (args: Record<string, unknown>) => Promise<unknown> }>,
   *   commands: Map<string, object>,
   *   handlers: Map<string, (...args: unknown[]) => unknown>,
   *   registerTool(tool: object): void,
   *   registerCommand(name: string, command: object): void,
   *   on(name: string, handler: (...args: unknown[]) => unknown): void,
   * }}
   */
  const pi = {
    tools: [],
    commands: new Map(),
    handlers: new Map(),
    registerTool(tool) {
      this.tools.push(
        /** @type {{ name: string, execute: (args: Record<string, unknown>) => Promise<unknown> }} */ (
          tool
        ),
      );
    },
    registerCommand(name, command) {
      this.commands.set(name, command);
    },
    on(name, handler) {
      this.handlers.set(name, handler);
    },
  };

  registerEndoCodeModeExtension(pi, { runtime });

  t.deepEqual(
    pi.tools.map(tool => tool.name),
    ['execute'],
  );
  t.true(pi.commands.has('endo:status'));
  t.true(pi.commands.has('endo:globals'));
  t.true(pi.handlers.has('tool_call'));
  const result = await pi.tools[0].execute({ source: '1 + 1' });
  t.deepEqual(result, {
    ok: true,
    source: '1 + 1',
  });
  t.deepEqual(calls, ['1 + 1']);
});

test('Endo-hosted service prompt routes through shared runtime', async t => {
  const lookups = [];
  const powers = Far('CodeModePowers', {
    lookup: async petName => {
      lookups.push(petName);
      if (petName === 'workspace') {
        return harden({});
      }
      if (petName === 'git') {
        return makeStubGit([]);
      }
      throw new Error(`missing ${String(petName)}`);
    },
  });
  const executions = [];
  const service = await makeCodeModeNode(powers, harden({ requestId: 1 }), {
    config: {
      model: {},
      powers: {
        workspacePetName: 'workspace',
        gitPetName: 'git',
        gitMode: 'readOnly',
      },
    },
    model: stubModel,
    execute: async input => {
      executions.push(input.source);
      return 42;
    },
    streamFn: makeScriptedStreamFn([
      {
        content: [
          {
            type: 'toolCall',
            id: 'call-1-execute',
            name: 'execute',
            arguments: { source: '42' },
          },
        ],
        stopReason: 'toolUse',
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
      },
    ]),
  });

  await service.prompt('Compute the answer.');

  t.deepEqual(lookups, ['workspace', 'git']);
  t.deepEqual(executions, ['42']);
  t.true(
    /** @type {{ contextPresent: boolean }} */ (service.status())
      .contextPresent,
  );
});

test('delegation tool calls sub-agent with read-only Git', async t => {
  const git = makeStubGit([]);
  const tool = makeCodeModeDelegateTool({
    callerConfig: {
      model: {},
      powers: {
        workspace: harden({}),
        git,
        gitMode: 'readWrite',
      },
    },
    model: stubModel,
    runAgent: async (runtime, prompt) =>
      harden({
        prompt,
        gitMode: runtime.config.powers.gitMode,
        hasCommit: runtime.systemPrompt.includes('commit(message: string)'),
        tools: runtime.agent.state.tools.map(agentTool => agentTool.name),
      }),
  });

  await null;
  const delegationResult = await tool.invoke({
    prompt: 'Inspect history.',
    powers: { gitMode: 'readOnly' },
  });
  t.deepEqual(
    delegationResult,
    {
      prompt: 'Inspect history.',
      gitMode: 'readOnly',
      hasCommit: false,
      tools: ['execute'],
    },
  );
});

test('delegation tool can call a sub-agent with writable Git', async t => {
  const { workspace, git } = await makeTestGit(t);
  const tool = makeCodeModeDelegateTool({
    callerConfig: {
      model: {},
      powers: {
        workspace,
        workspacePetName: 'repoWorkspace',
        git,
        gitPetName: 'repoGit',
        gitMode: 'readWrite',
      },
    },
    model: stubModel,
    runAgent: async runtime =>
      harden({
        gitMode: runtime.config.powers.gitMode,
        globals: runtime.globals.map(global => global.name),
        hasCommit: runtime.systemPrompt.includes('commit(message: string)'),
      }),
  });

  await null;
  const delegationResult = await tool.invoke({
    prompt: 'Prepare a commit.',
    powers: { gitMode: 'readWrite' },
  });
  t.deepEqual(delegationResult, {
    gitMode: 'readWrite',
    globals: ['repoWorkspace', 'repoGit'],
    hasCommit: true,
  });
});

test('delegation tool resolves model profiles by pet name', async t => {
  const lookups = [];
  const powers = Far('DelegateModelProfilePowers', {
    lookup: async petName => {
      lookups.push(petName);
      if (petName === 'fastModel') {
        return harden({
          provider: 'ollama',
          model: 'qwen3-fast',
          baseUrl: 'http://localhost:11434',
        });
      }
      throw new Error(`missing ${String(petName)}`);
    },
  });
  const tool = makeCodeModeDelegateTool({
    callerConfig: {
      model: { provider: 'ollama', model: 'qwen3' },
      powers: {
        workspace: harden({}),
        git: makeStubGit([]),
        gitMode: 'readWrite',
      },
    },
    callerPowers: powers,
    model: stubModel,
    runAgent: async runtime =>
      harden({
        model: runtime.config.model,
        provider: runtime.model.provider,
        id: runtime.model.id,
      }),
  });

  await null;
  const delegationResult = await tool.invoke({
    prompt: 'Use the fast profile.',
    modelProfile: 'fastModel',
    powers: { gitMode: 'readWrite' },
  });
  t.deepEqual(lookups, ['fastModel']);
  t.deepEqual(delegationResult, {
    model: {
      provider: 'ollama',
      model: 'qwen3-fast',
      baseUrl: 'http://localhost:11434',
    },
    provider: stubModel.provider,
    id: stubModel.id,
  });
});

test('delegation tool does not inherit caller-configured named powers', async t => {
  const calls = [];
  const lookups = [];
  const git = makeStubGit([]);
  const originRemote = makeStubRemote(calls);
  const powers = Far('DelegateRemotePowers', {
    lookup: async petName => {
      lookups.push(petName);
      if (petName === 'origin') {
        return originRemote;
      }
      throw new Error(`missing ${String(petName)}`);
    },
  });
  const tool = makeCodeModeDelegateTool({
    callerConfig: {
      model: {},
      powers: {
        workspace: harden({}),
        git,
        gitMode: 'readWrite',
        namedPowers: [
          {
            name: 'originRemote',
            petName: 'origin',
            type: gitRemoteCodeModeCapabilityType,
            description: 'Policy-gated origin GitRemote capability.',
          },
        ],
      },
    },
    callerPowers: powers,
    model: stubModel,
    runAgent: async runtime =>
      harden({
        globals: runtime.globals.map(global => global.name),
        hasOriginRemote: runtime.systemPrompt.includes('originRemote'),
      }),
  });

  await null;
  const delegationResult = await tool.invoke({
    prompt: 'Inspect origin.',
    powers: { gitMode: 'readOnly' },
  });
  t.deepEqual(lookups, []);
  t.deepEqual(calls, []);
  t.deepEqual(delegationResult, {
    globals: ['workspace', 'git'],
    hasOriginRemote: false,
  });
});

test('delegation tool resolves requested named powers', async t => {
  const calls = [];
  const lookups = [];
  const git = makeStubGit([]);
  const originRemote = makeStubRemote(calls);
  const originPetName = harden(['remotes', 'origin']);
  const powers = Far('DelegateRequestedPowers', {
    lookup: async petName => {
      lookups.push(petName);
      if (
        Array.isArray(petName) &&
        petName.length === originPetName.length &&
        petName.every((part, index) => part === originPetName[index])
      ) {
        return originRemote;
      }
      throw new Error(`missing ${String(petName)}`);
    },
  });
  const tool = makeCodeModeDelegateTool({
    callerConfig: {
      model: {},
      powers: {
        workspace: harden({}),
        git,
        gitMode: 'readWrite',
        namedPowers: [
          {
            name: 'originRemote',
            petName: originPetName,
            type: gitRemoteCodeModeCapabilityType,
            description: 'Policy-gated origin GitRemote capability.',
          },
        ],
      },
    },
    callerPowers: powers,
    model: stubModel,
    runAgent: async runtime => {
      const result = await runtime.execute({
        source: '(async () => E(originRemote).inspect())()',
        globals: runtime.globals,
      });
      return harden({
        globals: runtime.globals.map(global => global.name),
        result,
      });
    },
  });

  await null;
  const delegationResult = await tool.invoke({
    prompt: 'Inspect origin.',
    powers: { gitMode: 'readOnly', originRemote: originPetName },
  });
  t.deepEqual(lookups, [originPetName]);
  t.deepEqual(calls, ['inspect']);
  t.deepEqual(delegationResult, {
    globals: ['workspace', 'git', 'originRemote'],
    result: { name: 'origin', allowedDirections: ['fetch'] },
  });
});

test('delegation tool rejects unresolved powers and Git authority upgrades', async t => {
  const missingPowers = Far('MissingPowers', {
    lookup: async petName => {
      throw new Error(`no ${String(petName)}`);
    },
  });
  const unresolvedTool = makeCodeModeDelegateTool({
    callerConfig: {
      model: {},
      powers: { gitMode: 'readWrite' },
    },
    callerPowers: missingPowers,
    model: stubModel,
  });
  await t.throwsAsync(
    () =>
      unresolvedTool.invoke({
        prompt: 'Try unknown cap.',
        powers: { workspace: 'unknown-workspace' },
      }),
    { message: /workspace power "unknown-workspace" is not resolvable/ },
  );

  const upgradeTool = makeCodeModeDelegateTool({
    callerConfig: {
      model: {},
      powers: {
        workspace: harden({}),
        git: harden({}),
        gitMode: 'readOnly',
      },
    },
    model: stubModel,
  });
  await t.throwsAsync(
    () =>
      upgradeTool.invoke({
        prompt: 'Please commit.',
        powers: { gitMode: 'readWrite' },
      }),
    { message: /cannot upgrade Git authority/ },
  );

  const writableCallerTool = makeCodeModeDelegateTool({
    callerConfig: {
      model: {},
      powers: {
        workspace: harden({}),
        git: harden({}),
        gitMode: 'readWrite',
      },
    },
    model: stubModel,
  });
  await t.throwsAsync(
    () =>
      writableCallerTool.invoke({
        prompt: 'Please commit.',
        powers: { gitMode: 'readWrite' },
      }),
    { message: /cannot receive writable Git authority/ },
  );
});

test('lalCodeMode git loop edits workspace, commits, and reads previous tree', async t => {
  const repoRoot = await provisionGitWorktree(t);
  const workspace = makeNodeFilesystem({ rootPath: repoRoot });
  const { mount, lineageOf } = makeMountOverFilesystem(workspace);
  const backend = makeNativeGitBackend({ repoRoot });
  const git = makeGit({ mount, backend, lineageOf });

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
  const execute = async input => {
    const result = await makeCompartmentExecute({
      git,
      workspace,
      readFileText,
      writeFileText,
    })(input);
    executions.push(result);
    return result;
  };
  const agent = makeLalCodeModeGitLoopAgent({
    model: stubModel,
    workspace,
    git,
    execute,
    globals: harden([
      ...makeLalCodeModeGitLoopGlobals(),
      {
        name: 'readFileText',
        type: '(file: File) => Promise<string>',
        description: 'Read a UTF-8 file through an endo-fs File capability.',
      },
      {
        name: 'writeFileText',
        type: '(file: File, text: string) => Promise<void>',
        description: 'Write UTF-8 text through an endo-fs File capability.',
      },
    ]),
    streamFn: makeScriptedStreamFn([
      {
        content: [
          {
            type: 'toolCall',
            id: 'call-1-execute',
            name: 'execute',
            arguments: { source },
          },
        ],
        stopReason: 'toolUse',
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
      },
    ]),
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
