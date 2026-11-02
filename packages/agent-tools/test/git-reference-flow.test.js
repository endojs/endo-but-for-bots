// @ts-check

// The worked end-to-end reference flow from the bot-fork roadmap, pinned as a
// regression test: a maintainer's prompt → branch off `llm` via `Git` → edit
// files via the `EndoMount` file tools → `status` / `diff` / `commit` via `Git`
// → push a draft-PR branch via `GitRemote` → inspect the pushed ref via
// `filesystemAt`.
//
// `git-worked-loop.test.js` calls each tool by hand. This test puts a real
// pi-agent-core loop in the driver's seat instead: the prompt goes to a
// `PiAgent` whose tools are the provisioned catalog bridged through
// `toPiAgentTool`, and a scripted model reads each tool result before it
// chooses the next call. The remote runs under the Agent MVP profile
// (daemon-git-remotes § Agent MVP Profile): fetch allowed, push only to
// `refs/heads/agent/*`, no force, tags, or delete. The pushed ref is inspected
// from a separate reviewer checkout of the remote, so the test proves what the
// remote received rather than what the agent's own object store holds.

import test from '@endo/ses-ava/prepare-endo.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { Agent as PiAgent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { makeGitRemote } from '@endo/exo-git';

import {
  advanceRemoteBranch,
  composeGitOverWorktree,
} from './git-remote-fixtures.js';
import { toPiAgentTool } from '../src/adapters/pi.js';
import {
  provisionWorkspaceTools,
  provisionHistoryTools,
} from '../src/workspace.js';

const execFileAsync = promisify(execFile);

const BASE = 'llm';
const DRAFT_BRANCH = 'agent/greeting';
const DRAFT_REF = `refs/heads/${DRAFT_BRANCH}`;
const PROMPT =
  `Branch off the latest \`${BASE}\`, change the greeting in README.md to ` +
  '"Hello, reviewer.", add a NOTES.md that explains the change, commit it, ' +
  `and push it as the draft-PR branch \`${DRAFT_BRANCH}\`.`;

/** @type {any} */
const stubModel = harden({
  id: 'scripted-model',
  name: 'scripted/scripted-model',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'http://invalid.example',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
});

/**
 * @typedef {{ role: string, toolName?: string, isError?: boolean, content?: any }} TranscriptMessage
 * @typedef {{ name: string, arguments: Record<string, unknown> }} ScriptedCall
 * @typedef {(observe: (toolName: string) => TranscriptMessage) => ScriptedCall[] | string} ScriptedTurn
 */

/**
 * The text of a tool-result message, as the model reads it.
 *
 * @param {TranscriptMessage} message
 */
const textOf = message =>
  message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');

/**
 * A scripted `streamFn` standing in for the model. Each turn is a function of
 * the transcript so far: it may read the latest result of any tool (as the
 * text a model would see) and returns either the tool calls to make or, as a
 * plain string, the closing reply. No provider is contacted.
 *
 * @param {ScriptedTurn[]} turns
 */
const makeScriptedStreamFn = turns => {
  let turn = 0;
  let callId = 0;
  return (_model, context, _options) => {
    /** @type {TranscriptMessage[]} */
    const messages = context.messages;
    /** @param {string} toolName */
    const observe = toolName => {
      const found = messages.findLast(
        message =>
          message.role === 'toolResult' && message.toolName === toolName,
      );
      if (!found) throw Error(`the model has not seen a ${toolName} result`);
      return found;
    };
    const script = turns[turn] ?? (() => 'done');
    turn += 1;
    const step = script(observe);
    const content =
      typeof step === 'string'
        ? [{ type: 'text', text: step }]
        : step.map(call => {
            callId += 1;
            return { type: 'toolCall', id: `call-${callId}`, ...call };
          });
    const stopReason = typeof step === 'string' ? 'stop' : 'toolUse';
    /** @type {any} */
    const message = harden({
      role: 'assistant',
      content,
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
      stopReason,
      timestamp: Date.now(),
    });
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({
      type: 'done',
      reason: /** @type {'toolUse' | 'stop'} */ (stopReason),
      message,
    });
    stream.end(message);
    return stream;
  };
};

/**
 * Seed a bare remote whose only branch is `llm`, holding a README with a
 * greeting, the way the bot fork's integration branch looks to an agent.
 *
 * @param {import('ava').ExecutionContext} t
 */
const seedLlmRemote = async t => {
  const parent = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'git-reference-flow-'),
  );
  t.teardown(() => fs.promises.rm(parent, { recursive: true, force: true }));
  const seedRoot = path.join(parent, 'seed');
  const remoteRoot = path.join(parent, 'remote.git');
  await fs.promises.mkdir(seedRoot);
  await execFileAsync('git', ['init', '-q', '-b', BASE], { cwd: seedRoot });
  await fs.promises.writeFile(
    path.join(seedRoot, 'README.md'),
    '# Project\n\nHello, world.\n',
  );
  await execFileAsync('git', ['add', 'README.md'], { cwd: seedRoot });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'seed'],
    { cwd: seedRoot },
  );
  await execFileAsync('git', ['clone', '-q', '--bare', seedRoot, remoteRoot]);
  return { parent, remoteRoot };
};

/**
 * Clone the remote into a fresh worktree under `parent` and compose a
 * `mount -> Git` over it.
 *
 * @param {string} parent
 * @param {string} remoteRoot
 * @param {string} name
 * @param {{ identity?: { authorName: string, authorEmail: string } }} [options]
 */
const cloneAndCompose = async (parent, remoteRoot, name, options) => {
  const root = path.join(parent, name);
  await execFileAsync('git', ['clone', '-q', remoteRoot, root]);
  return composeGitOverWorktree(root, options);
};

/**
 * @param {string} remoteRoot
 * @param {string} ref
 */
const remoteOid = async (remoteRoot, ref) => {
  const { stdout } = await execFileAsync('git', ['rev-parse', ref], {
    cwd: remoteRoot,
  });
  return stdout.trim();
};

test('a maintainer prompt drives the reference flow from llm to a pushed draft-PR branch', async t => {
  t.timeout(60_000);

  const identity = harden({
    authorName: 'Fae Agent',
    authorEmail: 'fae@agents.invalid',
  });
  const { parent, remoteRoot } = await seedLlmRemote(t);

  // The host provisions the agent's workspace from a clone, then `llm` moves
  // on upstream, so the agent has to fetch to branch off the latest base.
  const workspace = await cloneAndCompose(parent, remoteRoot, 'agent', {
    identity,
  });
  const upstreamTip = await advanceRemoteBranch(t, remoteRoot, BASE);

  const { remote } = makeGitRemote({
    git: workspace.git,
    operations: workspace.operations,
    name: 'origin',
    policy: {
      url: pathToFileURL(remoteRoot).href,
      allowLocalFileTransport: true,
      allowedDirections: ['fetch', 'push'],
      fetchRefspecs: [`+refs/heads/${BASE}:refs/remotes/origin/${BASE}`],
      pushRefspecs: ['refs/heads/agent/*:refs/heads/agent/*'],
    },
  });

  const records = await provisionWorkspaceTools({
    git: workspace.git,
    remote,
  });
  const agentTools = records.map(record => toPiAgentTool(record));

  /** @type {string[]} */
  let dirtyPaths = [];
  /** @type {string} */
  let stagedDiff = '';
  /** @type {string} */
  let refusal = '';

  const streamFn = makeScriptedStreamFn([
    // Learn the remote's bounds, then bring `llm` up to date.
    () => [{ name: 'inspect', arguments: {} }],
    observe => {
      const bounds = JSON.parse(textOf(observe('inspect')));
      t.deepEqual(
        [...bounds.pushRefspecs],
        ['refs/heads/agent/*:refs/heads/agent/*'],
      );
      return [{ name: 'fetch', arguments: {} }];
    },
    () => [
      {
        name: 'createBranch',
        arguments: {
          name: DRAFT_BRANCH,
          options: { startPoint: `origin/${BASE}`, switchAfterCreate: true },
        },
      },
    ],
    // Read the file before editing it, then write the edit and the notes.
    () => [{ name: 'mountReadText', arguments: { path: 'README.md' } }],
    observe => [
      {
        name: 'mountWriteText',
        arguments: {
          path: 'README.md',
          content: textOf(observe('mountReadText')).replace(
            'Hello, world.',
            'Hello, reviewer.',
          ),
        },
      },
      {
        name: 'mountWriteText',
        arguments: {
          path: 'NOTES.md',
          content: 'The greeting now addresses the reviewer.\n',
        },
      },
    ],
    // Stage exactly what status reports as changed, review it, commit.
    () => [{ name: 'status', arguments: {} }],
    observe => {
      const status = JSON.parse(textOf(observe('status')));
      dirtyPaths = status.entries.map(entry => entry.path).sort();
      return [
        { name: 'add', arguments: { paths: dirtyPaths } },
        { name: 'diff', arguments: { options: { cached: true } } },
      ];
    },
    observe => {
      stagedDiff = textOf(observe('diff'));
      return [
        {
          name: 'commit',
          arguments: { message: 'docs: greet the reviewer' },
        },
      ];
    },
    // A push to the protected base is refused; the model reads the refusal
    // and publishes the draft-PR branch instead.
    () => [
      {
        name: 'push',
        arguments: {
          options: { source: DRAFT_REF, destination: `refs/heads/${BASE}` },
        },
      },
    ],
    observe => {
      const result = observe('push');
      t.true(result.isError, 'pushing to the protected base is refused');
      refusal = textOf(result);
      return [
        {
          name: 'push',
          arguments: {
            options: {
              source: DRAFT_REF,
              destination: DRAFT_REF,
              setUpstream: true,
            },
          },
        },
      ];
    },
    observe => {
      t.false(observe('push').isError, 'the draft-PR branch push succeeds');
      return `Pushed ${DRAFT_BRANCH}; it is ready to open as a draft PR.`;
    },
  ]);

  const agent = new PiAgent({
    initialState: {
      systemPrompt:
        'You are a coding agent working in a granted git workspace.',
      model: stubModel,
      tools: agentTools,
      messages: [],
      thinkingLevel: 'off',
    },
    convertToLlm: messages =>
      messages.filter(
        message =>
          message.role === 'user' ||
          message.role === 'assistant' ||
          message.role === 'toolResult',
      ),
    toolExecution: 'sequential',
    streamFn,
  });

  await agent.prompt(PROMPT);
  await agent.waitForIdle();

  // The loop ran to the model's closing reply with only the one refused push
  // failing along the way.
  const transcript = /** @type {TranscriptMessage[]} */ (agent.state.messages);
  const failures = transcript.filter(
    message => message.role === 'toolResult' && message.isError,
  );
  t.deepEqual(
    failures.map(message => message.toolName),
    ['push'],
  );
  t.notRegex(refusal, new RegExp(parent), 'the refusal names no host path');
  const last = transcript[transcript.length - 1];
  t.is(last.role, 'assistant');
  t.regex(textOf(last), /ready to open as a draft PR/);

  t.deepEqual(dirtyPaths, ['NOTES.md', 'README.md']);
  t.true(stagedDiff.includes('+Hello, reviewer.'));
  t.true(stagedDiff.includes('NOTES.md'));

  // The remote's `llm` is untouched and carries no agent commit; the draft
  // branch sits one commit on top of the upstream tip the agent fetched.
  t.is(await remoteOid(remoteRoot, `refs/heads/${BASE}`), upstreamTip);
  const draftTip = await remoteOid(remoteRoot, DRAFT_REF);
  t.is(await remoteOid(remoteRoot, `${DRAFT_REF}~1`), upstreamTip);

  // A reviewer inspects the pushed ref from their own checkout of the remote,
  // through `filesystemAt` and the read-only history tools.
  const reviewer = await cloneAndCompose(parent, remoteRoot, 'reviewer');
  const history = new Map(
    (
      await provisionHistoryTools({
        git: reviewer.git,
        ref: `origin/${DRAFT_BRANCH}`,
      })
    ).map(record => [record.name, record]),
  );
  const read = name =>
    /** @type {any} */ (history.get('mountReadText')).invoke({ path: name });
  t.is(await read('README.md'), '# Project\n\nHello, reviewer.\n');
  t.is(await read('NOTES.md'), 'The greeting now addresses the reviewer.\n');
  t.is(await read('upstream.txt'), 'upstream\n', 'built on the fetched tip');
  t.false(history.has('mountWriteText'), 'the pushed ref is read-only');

  // The formula-owned identity, not the model, attributed the pushed commit.
  const { stdout: attribution } = await execFileAsync(
    'git',
    ['show', '-s', '--format=%an|%ae|%cn|%ce', draftTip],
    { cwd: remoteRoot },
  );
  t.is(
    attribution.trim(),
    'Fae Agent|fae@agents.invalid|Fae Agent|fae@agents.invalid',
  );
});
