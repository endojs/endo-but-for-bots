// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop */

// Floot — a streaming agent harness for the Endo daemon.
//
// Floot mirrors fae's factory/driver/guest topology (see @endo/fae) but trades
// fae's mailbox-driven, fully-buffered reply for a *pull-based streaming*
// interface: the agent exposes `converse(text) -> replyReader`, where
// replyReader is a Far StreamReader (src/stream.js) that yields reply-token
// deltas as the LLM produces them. This is the same wire the voice Space
// already consumes for transcripts (audio-server-caplet.js), so a client can
// stream the assistant's reply token-by-token and (later) feed it to TTS.
//
// Persistence and provisioning match fae: per-session conversation history lives
// in the session guest's petstore via @endo/conversation-tree, and a single
// pinned factory caplet revives every session on daemon restart.

import { execFile } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import {
  makeConversationTree,
  makeEndoPetstoreBackend,
} from '@endo/conversation-tree';
import { runAgenticTurn } from '@endo/fae/src/turn-engine.js';
import {
  SubagentSpawnerInterface,
  assertSubagentName,
  isSameFormula,
  makeSubagentDelegations,
} from '@endo/fae/src/subagent.js';
import { DEFAULT_MAX_SUBAGENT_DEPTH } from '@endo/fae/src/subagent-host.js';
import { resolveAuthToken } from '@endo/fae/src/credentials.js';
import {
  assertHostedBackendDescriptor,
  normalizeHostedModelDescriptor,
} from '@endo/hosted-agent';

import { createStreamingProvider } from './providers/index.js';
import { runClaudeTurn } from './src/claude-turn.js';
import { runHostedTurn } from './src/hosted-turn.js';
import { makeReplyChannel } from './src/stream.js';
import { makeEndoToolSet, makeFlootToolRegistry } from './src/tool-registry.js';

// Cap the tool-call loop so a misbehaving model can't spin forever before it
// produces a spoken reply. A safety ceiling, not a work budget: a coding turn
// routinely takes dozens of tool rounds, and at 8 sessions bailed out mid-task
// with the tool-step fallback. `FLOOT_MAX_TOOL_ROUNDS` overrides it per
// deployment. The hosted backends run their own loops and never reach it.
const DEFAULT_MAX_TOOL_ROUNDS = 48;
const AGENT_SHUTDOWN_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);

const withTimeout = async (operation, label) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Error(`${label} timed out`)),
      AGENT_SHUTDOWN_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

// Initialize a fresh, empty directory as a git repository so a daemon git cap
// can be derived from it: provideGit requires an existing worktree, but a new
// scratch mount is just an empty dir. The exo git backend supplies its own
// author identity for the commits it makes; we only pin signing off here (so
// creation doesn't depend on a user-global commit.gpgSign) and seed an empty
// initial commit so the repo has a HEAD on the default branch.
const initGitRepo = async repoRoot => {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await execFileAsync('git', ['config', '--local', 'commit.gpgsign', 'false'], {
    cwd: repoRoot,
  });
  await execFileAsync('git', ['config', '--local', 'tag.gpgsign', 'false'], {
    cwd: repoRoot,
  });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.email=floot@endo',
      '-c',
      'user.name=Floot',
      'commit',
      '--allow-empty',
      '-m',
      'Initialize workspace',
    ],
    { cwd: repoRoot },
  );
};

/**
 * A writer (same shape as makeReplyChannel's) that buffers a turn's output
 * instead of streaming it, resolving `done` with the final text once the turn
 * ends. Used for inbox/mail turns, whose reply is sent as one buffered message
 * rather than streamed token-by-token.
 *
 * @returns {{ writer: object, done: Promise<{ ok: boolean, text?: string, error?: string }> }}
 */
const makeBufferingWriter = () => {
  let text = '';
  /** @type {(result: { ok: boolean, text?: string, error?: string }) => void} */
  let settle = () => {};
  const done = new Promise(resolve => {
    settle = resolve;
  });
  const writer = harden({
    setPhase: () => {},
    /** @param {string} t */
    delta: t => {
      text += t;
    },
    /** @param {string} t */
    final: t => {
      text = `${t}`;
    },
    toolCall: () => {},
    toolResult: () => {},
    usage: () => {},
    end: () => settle({ ok: true, text }),
    /** @param {unknown} reason */
    abort: reason => settle({ ok: false, error: `${reason}` }),
  });
  return { writer, done };
};

const FlootFactoryInterface = M.interface('FlootFactory', {
  createSession: M.callWhen()
    .optional(M.any(), M.string(), M.string())
    .returns(M.remotable()),
  listSessions: M.callWhen().returns(M.arrayOf(M.record())),
  listPresets: M.callWhen().returns(M.arrayOf(M.record())),
  listBackends: M.callWhen().returns(M.arrayOf(M.record())),
  listModels: M.callWhen().optional(M.string()).returns(M.arrayOf(M.record())),
  getSession: M.callWhen(M.string()).returns(M.remotable()),
  renameSession: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  deleteSession: M.callWhen(M.string()).returns(M.undefined()),
  refreshCredentials: M.callWhen().returns(M.undefined()),
  getAccount: M.callWhen().optional(M.boolean()).returns(M.record()),
  getAccountOracle: M.callWhen().returns(M.remotable()),
  help: M.call().optional(M.string()).returns(M.string()),
});

// The session facet handed to the UI. `converse` is synchronous (it returns the
// reply reader immediately, then streams), so it is guarded with `M.call`; the
// rest are async (`M.callWhen`). Guards are permissive — the daemon path is not
// runtime-tested here.
const FlootSessionInterface = M.interface('FlootSession', {
  getInfo: M.callWhen().returns(M.record()),
  converse: M.call(M.any()).returns(M.remotable()),
  getHistory: M.callWhen().returns(M.any()),
  getUsage: M.callWhen().returns(M.any()),
  getAccount: M.callWhen().optional(M.boolean()).returns(M.record()),
  help: M.call().returns(M.string()),
});

const defaultSystemPrompt = `\
You are Floot, a warm, concise voice assistant living inside the Endo daemon.

Your replies are spoken aloud, so:
- Keep responses short and conversational — usually one to three sentences.
- Avoid markdown, code blocks, bullet lists, and emoji; write as you would speak.
- Answer directly. If you need to think, do it silently and give only the answer.

You live inside the Endo daemon as a guest with your own petstore — a private
namespace of named capabilities (objects you can call). You have tools to work
with it; use them silently, then speak only the result — never read code or raw
tool output aloud.

How the environment works: everything around you is an object capability. A
capability is a live remote object, not data — you act by CALLING its methods,
not by reading its fields. In exec, reach a capability through \`powers\` (your
guest interface) or by looking one up, and call methods with eventual-send:
\`const x = await E(ref).someMethod(args)\`. Always \`await\` and always go
through \`E(...)\` for capability calls.

When a tool result is itself a capability it shows as
\`[remote capability] callable methods: [...]\` listing the methods you can call
— that is a usable object, not an empty result. To work with it, look it up (or
store it) and call one of those methods via exec. Plain data (strings, numbers,
JSON) shows as its value.

Petstore tools:
- list — see the petnames currently in your petstore.
- lookup — get a stored object by its petname so you can use it.
- store — save an object (or a result) under a petname for later.
- remove — forget a petname.
- exec — run JavaScript with your guest powers in scope as \`powers\`. This is
  your most general power: call any daemon capability, do math, transform data.
  Reach for it whenever no other tool fits.

Mail tools — other agents and people can send you messages, optionally with
objects attached:
- listMessages — read your inbox. Each message has a number, sender, text, and
  the edge names of any attached objects.
- adopt — take an attached object into your petstore by giving the message
  number and the object's edge name, plus a petname to file it under.
- send — send a message (and optionally objects) to another party.
- reply — respond to a message by its number.

Delegation — when spawnSubagent, askSubagent, and stopSubagent are listed among
your tools, you may hand a self-contained piece of work to a helper agent:
- spawnSubagent — create one, giving it standing instructions for its role.
- askSubagent — mail it a task and wait for its reply. It cannot see this
  conversation, so put everything it needs in the task.
- stopSubagent — release it once its work is done.
Use this for work whose details you don't need to keep — a long search, a
self-contained draft — not for things you can simply do yourself.

Caplet tools dropped into your \`tools/\` directory are discovered automatically,
so your abilities can grow over time. When asked what you can do, you can list
your tools and petnames to find out.
`;

// Flagship "vibe code a new project" persona: the base voice persona plus the
// framing that the session starts with a writable, git-backed workspace object
// already in its petstore (provisioned by the "new-project" preset).
export const newProjectSystemPrompt = `${defaultSystemPrompt}
You are starting a fresh project. Your petstore already contains a writable,
git-backed project workspace under the petname "workspace" — an EndoGit
capability. Use it via exec:
- \`const wt = await E(workspace).worktree()\` gives the working tree, a mount you
  can write to: \`E(wt).makeFile(path, text)\`, \`E(wt).writeText(path, text)\`,
  \`E(wt).remove(path)\`, \`E(wt).move(from, to)\`. A path argument is an array
  of segments — \`E(wt).writeText(['src', 'main.js'], text)\`; a bare string is
  a single name, and slash-joined strings are rejected. \`E(wt).entry('src/main.js')\`
  splits a slash path into a token any path argument accepts.
- \`E(workspace).status()\` returns \`{ entries, truncated }\`; each entry is
  copy data with \`path\`, \`index\`, and \`worktree\` fields, and \`truncated\`
  tells you whether the result was limited. \`E(workspace).diff()\` inspects
  changes.
- To stage one desired row: \`const result = await E(workspace).status(); const row = result.entries.find(({ path }) => path === "src/main.js"); if (!row) throw new Error("row not found"); await E(workspace).add([row.path])\`.
  Then \`E(workspace).commit(message)\` records them.
Build what the user asks for in the workspace, committing as you reach working
states. Speak short, plain summaries of what you did — never read code aloud.`;
harden(newProjectSystemPrompt);

// "Full control" persona: the base voice persona plus a reference to the daemon
// host itself ("endo") and the framing that this is dangerous, high-trust
// access that must be exercised carefully.
const fullControlSystemPrompt = `${defaultSystemPrompt}
You hold full control of this Endo daemon. Your petstore contains "endo" — a
reference to the daemon host itself, the most powerful capability there is.
Through it you can read, create, move, and destroy ANY capability in the daemon,
mint new agents, and run arbitrary code. Treat this access with great care:
- Move slowly and deliberately. Before anything destructive or irreversible —
  removing or cancelling a capability, overwriting a name, deleting an agent —
  say plainly what you are about to do and wait for the user to agree first.
- Prefer reading over writing. Inspect with list and lookup before you change
  anything; when unsure what a capability is, look before you act on it.
- Make the smallest change that satisfies the request. Don't tidy, reorganize,
  or "improve" the daemon's namespace unasked.
- Guard secrets. Never read API keys, tokens, or host filesystem paths aloud,
  and don't hand the "endo" reference (or anything derived from it) to another
  agent unless the user explicitly tells you to.

Operating the daemon — reach the host in exec with
\`const endo = await E(powers).lookup('endo')\`, then:
- \`E(endo).list()\` shows the names in the daemon's namespace; \`E(endo).lookup(name)\`
  retrieves one as a live capability.
- \`E(endo).makeDirectory(name)\` creates a sub-namespace; \`E(endo).move(from, to)\`,
  \`E(endo).copy(from, to)\`, and \`E(endo).remove(name)\` manage names.
- \`E(endo).evaluate(...)\` runs code in a worker — use it to build new caplets or
  one-off tools.
- \`E(endo).provideGuest(name)\` and \`E(endo).provideHost(name)\` mint new agents;
  \`E(endo).provideWorker(name)\` mints a worker.
- \`E(endo).cancel(name)\` tears a capability down — destructive, so confirm first.

Your petstore also contains "endo-src" — a READ-ONLY mount of the Endo
codebase you run inside. Use it to understand the capabilities you operate
before acting through "endo". In exec, look it up and read from it:
- \`const src = await E(powers).lookup('endo-src')\`
- \`E(src).list()\` lists the root; one segment per argument goes deeper:
  \`E(src).list('packages', 'daemon')\`.
- \`E(src).readText(path)\` reads a file. A path is an array of segments —
  \`E(src).readText(['packages', 'daemon', 'src', 'interfaces.js'])\` — never a
  slash-joined string. \`E(src).entry('packages/daemon/src/interfaces.js')\` is
  the one call that splits on "/"; its token works wherever a path does.
- It is strictly read-only — you cannot modify it. It may be absent if the
  daemon host does not have the source on disk; if a lookup fails, carry on
  without it.
Speak short, plain summaries of what you did — never read code or raw capability
output aloud.`;

// Catalog of session presets. Each preset pairs a system prompt with a set of
// objects to provision (idempotently) into the session guest's petstore the
// first time the session's agent is built. Provisioned objects are referenced
// ONLY by the session guest, so the daemon's GC reaps them (and their on-disk
// backing) when the session is deleted — there is no manual cleanup.
const PRESETS = [
  {
    id: 'general',
    title: 'General assistant',
    description: 'A blank session with no project workspace.',
    systemPrompt: defaultSystemPrompt,
    objects: [],
  },
  {
    id: 'new-project',
    title: 'New project',
    description:
      'Start a project with a writable, git-backed workspace ready to populate.',
    systemPrompt: newProjectSystemPrompt,
    objects: [{ kind: 'git-workspace', petName: 'workspace' }],
  },
  {
    id: 'full-control',
    title: 'Full Endo control',
    description:
      'Full control of the Endo daemon via an "endo" host reference. High access — handle with care.',
    systemPrompt: fullControlSystemPrompt,
    objects: [
      { kind: 'host-powers', petName: 'endo' },
      { kind: 'code-mount', petName: 'endo-src', required: false },
    ],
  },
];
const DEFAULT_PRESET_ID = 'general';
const getPreset = id =>
  PRESETS.find(p => p.id === id) ||
  /** @type {(typeof PRESETS)[number]} */ (
    PRESETS.find(p => p.id === DEFAULT_PRESET_ID)
  );

// Catalog of models selectable for a new session. A session that does not pin
// one of these follows the factory's configured default model (the `model` in
// the `llm-provider` config, or the provider's own fallback). Ids are passed
// verbatim to the provider, so they must be valid for the configured backend —
// these are the Anthropic ids used by the default provider.
const MODELS = [
  {
    id: 'claude-opus-4-8',
    title: 'Claude Opus 4.8',
    description: 'Most capable — best for hard reasoning and agentic work.',
  },
  {
    id: 'claude-sonnet-4-6',
    title: 'Claude Sonnet 4.6',
    description: 'Balanced speed and capability — a good default.',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    title: 'Claude Haiku 4.5',
    description: 'Fastest and cheapest — best for quick, simple turns.',
  },
  {
    id: 'claude-cli',
    title: 'Claude Code CLI (sandbox)',
    description:
      'A sandboxed Claude Code session (@endo/claude-sandbox) — the CLI runs ' +
      'its own tools inside the container over a 9P-projected workspace.',
  },
];
// Not an LLM id: sessions pinned to this entry route through a ClaudeClient
// capability (@endo/claude-sandbox) instead of the streaming API provider.
const CLAUDE_CLI_MODEL_ID = 'claude-cli';
// Mirrors createStreamingProvider's fallback so the UI's notion of "default"
// agrees with what an unpinned session actually runs.
const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';
const isKnownModel = id => MODELS.some(m => m.id === id);
const hostedModelId = (backendId, modelId) => `${backendId}:${modelId}`;

/**
 * Provision a preset's objects into a session guest's petstore, referenced ONLY
 * by the guest so deleting the session collects them (and their on-disk backing)
 * automatically. Idempotent: an object whose petname already exists is left
 * untouched, so this is safe to call on every revival.
 *
 * @param {any} host - the factory's own host powers
 * @param {string} agentName - petname (in the host) of the session's guest agent
 * @param {any} sessionGuest - the resolved guest facet (for `has` checks)
 * @param {string} id - session id (used to namespace temporary host petnames)
 * @param {Array<{ kind: string, petName: string, required?: boolean }>} objects
 * @param {string} [codePath] - absolute host path to the Endo codebase, for the
 *   `code-mount` object kind (read-only). Absent when the daemon host has no
 *   source on disk; such objects are then skipped.
 */
const provisionPresetObjects = async (
  host,
  agentName,
  sessionGuest,
  id,
  objects,
  codePath,
) => {
  for (const obj of objects) {
    const alreadyPresent = await E(sessionGuest).has(obj.petName);
    if (alreadyPresent) {
      // Idempotent: a revived session already has its provisioned objects.
    } else if (obj.kind === 'git-workspace') {
      // Mint a daemon-managed scratch mount, derive a git cap over it, then move
      // the git cap into the guest's petstore and drop the host-side scratch
      // petname. The git formula keeps the mount alive by reference (daemon GC:
      // git depends on its mount), so the only petstore reference left is the
      // guest's — deleting the session reaps the whole chain (and the scratch
      // dir on disk). Temporary host petnames are namespaced by session id and
      // cleared first in case a prior attempt aborted mid-way.
      const scratchTmp = `_floot-scratch-${id}`;
      const gitTmp = `_floot-git-${id}`;
      for (const tmp of [gitTmp, scratchTmp]) {
        if (await E(host).has(tmp)) await E(host).remove(tmp);
      }
      const mount = await E(host).provideScratchMount(scratchTmp);
      // provideGit requires an existing worktree, but a fresh scratch mount is
      // an empty dir — git-init it first. The factory is an unconfined,
      // fully-privileged host caplet, so resolving the host path and running
      // git here is in-bounds; that path never reaches the session guest or the
      // UI (they only ever receive the derived git cap, not its filesystem
      // location).
      const repoRoot = await E(host).provideHostPath(mount);
      await initGitRepo(repoRoot);
      await E(host).provideGit(mount, gitTmp);
      await E(host).move([gitTmp], [agentName, obj.petName]);
      await E(host).remove(scratchTmp);
    } else if (obj.kind === 'host-powers') {
      // Copy the factory's own host agent (@agent — the full host powers, not
      // the weaker @self handle) into the guest's petstore, granting the
      // session full daemon control. The host outlives every session, so this
      // only adds a name in the guest; deleting the session drops that name and
      // reaps nothing else.
      await E(host).copy(['@agent'], [agentName, obj.petName]);
    } else if (obj.kind === 'code-mount') {
      // Mount the Endo codebase read-only so the session can read the source it
      // runs inside. Skip silently when no path was configured (the daemon host
      // may not have the source on disk). The mount points at an EXISTING
      // external directory — unlike a scratch mount it does not own that dir, so
      // GC of the formula when the session is deleted never touches the source.
      // Provide into a session-scoped temp host name (cleared first in case a
      // prior attempt aborted), then move it into the guest's petstore so the
      // guest is the only reference.
      if (!codePath) {
        if (obj.required !== false) {
          throw Error(
            `No code path is configured for required preset object "${obj.petName}"`,
          );
        }
        console.warn(
          `[floot-factory] optional code mount "${obj.petName}" is unavailable for session ${id}`,
        );
      } else {
        const mountTmp = `_floot-codemount-${id}`;
        if (await E(host).has(mountTmp)) await E(host).remove(mountTmp);
        await E(host).provideMount(codePath, mountTmp, { readOnly: true });
        await E(host).move([mountTmp], [agentName, obj.petName]);
      }
    } else {
      throw Error(`Unknown required preset object kind "${obj.kind}"`);
    }
  }
};

/**
 * @typedef {object} ProviderConstructorConfig
 * @property {string} host
 * @property {string} model
 * @property {string} authToken
 */

/**
 * @typedef {object} InjectedProviderConfig
 * @property {{ chatStream: (messages: any[], tools: any[], onDelta: (delta: string) => void, signal?: AbortSignal) => Promise<any> }} provider
 */

/**
 * @typedef {object} LateProviderConfig
 * @property {() => Promise<any>} provideProvider - Resolved once per turn
 *   rather than held, so dropping a cached provider (`refreshCredentials`)
 *   reaches a session that is already open.
 */

/**
 * @typedef {object} ClaudeClientConfig
 * @property {any} claudeClient - A ClaudeClient capability
 *   (@endo/claude-sandbox): `send(prompt) -> reply reader` of raw stream-json
 *   events. Turns bypass the provider tool loop — the CLI runs its own tools
 *   in the sandbox and keeps its own conversation continuity.
 */

/**
 * Build a streaming agent over a guest's powers. The returned object exposes
 * `converse(input, writer)`, which appends to the conversation tree, streams the
 * model's reply through `writer` (src/stream.js), and persists the assistant
 * turn so subsequent calls keep context.
 *
 * The user message (`input`) is streamable too: it may be a plain string, or a
 * Far reader yielding transcript-style events (the same wire the audio caplet's
 * `transcribe` emits — `{type:'partial'|'final', text}` with replace semantics,
 * terminated by `end`/`abort`). Either way the message is fully assembled before
 * the LLM call, since Anthropic/Claude need a complete user turn — but the
 * interface accepts the stream now so callers (and a future streaming backend)
 * need not change. This lets the voice Space pipe transcribe()'s reader straight
 * into converse().
 *
 * Unlike fae's `spawnWorkerLoop`, this does NOT follow the inbox; it is driven
 * by direct method calls (the caller owns the loop), which is what lets the
 * reply stream straight back to that caller over CapTP.
 *
 * @param {any} powers - Guest powers (petstore for conversation history)
 * @param {Promise<object> | object | undefined} _context
 * @param {ProviderConstructorConfig | InjectedProviderConfig | LateProviderConfig | ClaudeClientConfig | { hostedClient: any }} providerConfig
 * @param {string} [systemPrompt]
 * @param {object} [options]
 * @param {any} [options.spawner] - A `SubagentSpawner` capability. Absent for a
 *   session at the delegation bound, which withholds the subagent tools.
 * @param {any} [options.accountOracle] - A read-only `HostedAccount`. Absent
 *   when the deployment has provisioned no oracle, which withholds
 *   `accountStatus`.
 * @param {string} [options.modelId] - The model this session runs, used to
 *   price its usage.
 * @param {number} [options.maxToolRounds] - Provider calls one turn may make
 *   before the tool-step fallback. Defaults to `DEFAULT_MAX_TOOL_ROUNDS`.
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [options.timers]
 * @returns {Promise<{
 *   converse: (
 *     input: string | object,
 *     writer: object,
 *     meta?: object,
 *     signal?: AbortSignal,
 *   ) => Promise<void>,
 *   getHistory: () => Promise<Array<Record<string, any>>>,
 *   getUsage: () => Promise<{ inputTokens: number, outputTokens: number, turns: number }>,
 *   startInbox: () => void,
 *   shutdown: (allowBackendQuarantine?: boolean) => Promise<void>,
 * }>}
 */
export const makeStreamingAgent = async (
  powers,
  _context,
  providerConfig,
  systemPrompt,
  {
    spawner,
    accountOracle,
    modelId,
    timers,
    maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
  } = {},
) => {
  const claudeClient = /** @type {any} */ (providerConfig).claudeClient;
  const hostedClient = /** @type {any} */ (providerConfig).hostedClient;
  const provideProvider = /** @type {any} */ (providerConfig).provideProvider;
  /** @type {any} */
  const staticProvider =
    claudeClient || hostedClient || provideProvider
      ? null
      : /** @type {any} */ (providerConfig).provider ||
        createStreamingProvider({
          LAL_HOST: /** @type {any} */ (providerConfig).host,
          LAL_MODEL: /** @type {any} */ (providerConfig).model,
          LAL_AUTH_TOKEN: /** @type {any} */ (providerConfig).authToken,
        });

  /**
   * The provider this turn runs on.
   *
   * Resolved per turn rather than captured at construction: a provider pins the
   * auth token as of the moment it was built, so a session holding one would go
   * on using a rotated — or revoked — credential until the daemon restarted.
   * `refreshCredentials()` drops the factory's cache, and the next turn asks
   * for it again.
   */
  const currentProvider = async () =>
    provideProvider ? provideProvider() : staticProvider;

  const effectivePrompt = systemPrompt || defaultSystemPrompt;
  const tree = makeConversationTree(makeEndoPetstoreBackend(powers));

  // Cumulative token usage for this session, persisted to the guest petstore so
  // it survives a daemon restart. Loaded lazily; updated after each turn.
  const USAGE_NAME = 'floot-usage';
  /** @type {{ inputTokens: number, outputTokens: number, turns: number } | undefined} */
  let usage;
  const findRecordedUsage = async () => {
    let nodeId = await getOrCreateLeaf();
    while (nodeId) {
      const node = await tree.getNode(nodeId);
      if (!node) break;
      const recorded = /** @type {any} */ (node.metadata?.usageTotals);
      if (recorded) {
        return {
          inputTokens: Number(recorded.inputTokens) || 0,
          outputTokens: Number(recorded.outputTokens) || 0,
          turns: Number(recorded.turns) || 0,
        };
      }
      nodeId = node.parentId;
    }
    return undefined;
  };
  const loadUsage = async () => {
    if (usage) return usage;
    const recorded = await findRecordedUsage();
    if (recorded) {
      usage = recorded;
    } else if (await E(powers).has(USAGE_NAME)) {
      const stored = /** @type {any} */ (await E(powers).lookup(USAGE_NAME));
      usage = {
        inputTokens: Number(stored?.inputTokens) || 0,
        outputTokens: Number(stored?.outputTokens) || 0,
        turns: Number(stored?.turns) || 0,
      };
    } else {
      usage = { inputTokens: 0, outputTokens: 0, turns: 0 };
    }
    return usage;
  };
  // Serialize writes to the legacy summary cache. The authoritative totals are
  // also committed in conversation-node metadata, so a crash or cache write
  // failure can be recovered by walking back from the durable leaf.
  let usageWrite = Promise.resolve();
  const saveUsage = () => {
    const snapshot = harden({ ...usage });
    usageWrite = usageWrite
      .then(async () => {
        await null;
        if (await E(powers).has(USAGE_NAME)) await E(powers).remove(USAGE_NAME);
        await E(powers).storeValue(snapshot, USAGE_NAME);
      })
      .catch(error => {
        console.error(
          '[floot] could not persist usage:',
          error instanceof Error ? error.message : String(error),
        );
      });
    return usageWrite;
  };

  // Delegation state is per session and lives beside the inbox loop that feeds
  // it: `claim` below is the only reader of the mailbox stream.
  const delegations = makeSubagentDelegations(
    harden({ powers, ...(timers ? { timers } : {}) }),
  );
  const toolRegistry = makeFlootToolRegistry(powers, {
    ...(spawner ? { spawner, delegations } : {}),
    ...(accountOracle
      ? {
          accountOracle,
          // The oracle prices what this session actually spent, so the tool
          // reads the same totals the UI shows rather than a second tally.
          getUsage: () => getUsage(),
          getModelId: () => modelId || '',
        }
      : {}),
  });

  // One session = one guest = one linear conversation. The guest's petstore
  // holds a conversation-tree root and a linear branch beneath it. We cache the
  // current leaf in memory and rediscover it from the tree on first use after a
  // restart. The match is NOT keyed on the system prompt: that orphaned all
  // history whenever the prompt changed. Instead we reuse the root with the
  // deepest branch — the one that actually holds the conversation — ignoring any
  // empty roots a past prompt change may have spawned. The current prompt is
  // applied at call time (see runTurn), so reusing an old root never leaks a
  // stale prompt.
  /** @type {string | undefined} */
  let cachedLeaf;

  const getOrCreateLeaf = async () => {
    if (cachedLeaf !== undefined) return cachedLeaf;

    const roots = await tree.getRoots();
    /** @type {{ leaf: string, depth: number } | undefined} */
    let best;
    for (const r of roots) {
      // Walk down the (linear) branch to its deepest node, counting depth.
      let leaf = r.id;
      let depth = 0;
      for (;;) {
        const kids = await tree.getChildren(leaf);
        if (!kids || kids.length === 0) break;
        leaf = kids[kids.length - 1].id;
        depth += 1;
      }
      if (best === undefined || depth > best.depth) {
        best = { leaf, depth };
      }
    }
    if (best !== undefined) {
      cachedLeaf = best.leaf;
      return best.leaf;
    }

    const root = await tree.addNode(null, [
      { role: 'system', content: effectivePrompt },
    ]);
    cachedLeaf = root.id;
    return root.id;
  };

  // Serialize turns: a streaming reply must finish (and persist its assistant
  // node) before the next converse() reads the path, or context would race.
  let turnChain = Promise.resolve();
  let stopped = false;
  let quarantineError;
  const turnControllers = new Set();

  // Assemble the user message. A string is used as-is; a reader is drained
  // (replace semantics — each partial/final carries the full text so far) until
  // it ends, so the complete turn is ready before the (non-streaming) LLM call.
  const resolveUserText = async input => {
    if (typeof input === 'string') return input;
    let text = '';
    for await (const value of iterateReader(input, { buffer: 4 })) {
      if (value?.type === 'end') break;
      if (value?.type === 'partial' || value?.type === 'final') {
        text = `${value.text}`;
      } else if (value?.type === 'abort') {
        throw new Error(value.reason || 'user message aborted');
      }
    }
    return text;
  };

  const runTurn = async (input, writer, meta, signal) => {
    const text = await resolveUserText(input);
    const baseLeafId = await getOrCreateLeaf();
    const baseNode = await tree.getNode(baseLeafId);
    const acknowledgedCheckpoint =
      typeof baseNode?.metadata?.backendCheckpoint === 'string'
        ? baseNode.metadata.backendCheckpoint
        : undefined;

    const commitExternalTurn = async (
      replyText,
      turnUsage,
      backendCheckpoint,
      toolCalls = [],
    ) => {
      const current = await loadUsage();
      const nextUsage = {
        inputTokens: current.inputTokens + (turnUsage?.inputTokens || 0),
        outputTokens: current.outputTokens + (turnUsage?.outputTokens || 0),
        turns: current.turns + 1,
      };
      const messages = [
        { role: 'user', content: `${text}`, ...(meta ? { meta } : {}) },
      ];
      if (toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.args },
          })),
        });
        messages.push(
          ...toolCalls.map(call => ({
            role: 'tool',
            tool_call_id: call.id,
            content: call.result ?? '',
          })),
        );
      }
      messages.push({ role: 'assistant', content: replyText });
      // One addNode commits the external turn as a unit. A failed/cancelled
      // runtime call therefore cannot leave a deeper orphaned user branch that
      // recovery mistakes for committed history.
      const finalNode = await tree.addNode(baseLeafId, messages, {
        usageTotals: harden({ ...nextUsage }),
        ...(backendCheckpoint ? { backendCheckpoint } : {}),
      });
      cachedLeaf = finalNode.id;
      usage = nextUsage;
      await saveUsage();
      if (backendCheckpoint && hostedClient) {
        try {
          await E(hostedClient).acknowledge(backendCheckpoint);
        } catch (error) {
          // The durable tree node is the source of truth. The checkpoint rides
          // on the next send and safely completes acknowledgement after a
          // transient failure or reincarnation.
          console.error(
            `[floot] backend checkpoint acknowledgement deferred: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      writer.usage(nextUsage);
      writer.final(replyText);
      writer.end();
    };

    if (claudeClient) {
      // Claude-CLI turn: one send to the ClaudeClient capability. The CLI runs
      // its own agentic loop in the sandbox (tools, continuity via the
      // workspace), so the provider tool loop below is bypassed; the persisted
      // history keeps only the user turn and the final assistant text.
      writer.setPhase('thinking');
      const { finalContent: replyText, usage: turnUsage } = await runClaudeTurn(
        { client: claudeClient, text, writer, signal },
      );
      if (signal?.aborted) return;
      await commitExternalTurn(replyText, turnUsage);
      return;
    }

    if (hostedClient) {
      writer.setPhase('thinking');
      const {
        finalContent: replyText,
        usage: turnUsage,
        toolCalls,
        checkpoint,
      } = await runHostedTurn({
        client: hostedClient,
        text,
        writer,
        signal,
        systemPrompt: effectivePrompt,
        acknowledgedCheckpoint,
      });
      if (signal?.aborted) return;
      await commitExternalTurn(replyText, turnUsage, checkpoint, toolCalls);
      return;
    }

    // `meta` rides along on the user node (the provider ignores unknown fields)
    // so getHistory can mark, e.g., turns that arrived via mail rather than the
    // local UI.
    const stagedMessages = [
      { role: 'user', content: `${text}`, ...(meta ? { meta } : {}) },
    ];

    // Agentic loop: stream a reply; if it calls tools, run them, persist the
    // assistant turn plus tool results, and loop again until the model returns a
    // plain (spoken) answer. Tools are re-discovered each round so anything the
    // model creates mid-turn (e.g. via exec/store) is immediately callable.
    let finalContent = '';
    // Whether the model produced a plain (toolless) answer. If it never does
    // within maxToolRounds, we send a fallback instead of an empty reply.
    let answered = false;
    // Token usage accumulates across this turn's rounds (each tool round is its
    // own provider call).
    let turnInput = 0;
    let turnOutput = 0;
    writer.setPhase('thinking');

    const loop = await runAgenticTurn({
      leafId: baseLeafId,
      maxRounds: maxToolRounds,
      getTools: async () => {
        if (signal?.aborted) throw Error('Floot turn aborted');
        return toolRegistry.snapshot();
      },
      getContext: async () => {
        const path = await tree.getPath(baseLeafId);
        return [
          { role: 'system', content: effectivePrompt },
          ...path.filter(message => message.role !== 'system'),
          ...stagedMessages,
        ];
      },
      invoke: async (context, tools, round) => {
        console.error(
          `[floot] round ${round}: ${context.length} messages, ${tools.providerSchemas.length} tools`,
        );
        let streamed = '';
        const provider = await currentProvider();
        const { message, usage: roundUsage } = await provider.chatStream(
          context,
          tools.providerSchemas,
          delta => {
            streamed += delta;
            writer.delta(delta);
          },
          signal,
        );
        if (roundUsage) {
          turnInput += roundUsage.inputTokens || 0;
          turnOutput += roundUsage.outputTokens || 0;
        }
        return harden({
          message: message || { role: 'assistant', content: streamed },
        });
      },
      getToolCalls: message =>
        Array.isArray(message.tool_calls) ? message.tool_calls : [],
      runTools: async (calls, tools, round) => {
        writer.setPhase('using tools');
        const normalizedCalls = calls.map((call, index) => ({
          ...call,
          id: call.id || `floot-synth-${round}-${index}`,
        }));
        const runOne = async call => {
          const name = call.function?.name;
          let args = {};
          let parseError;
          try {
            args =
              typeof call.function?.arguments === 'string'
                ? JSON.parse(call.function.arguments || '{}')
                : call.function?.arguments || {};
          } catch (error) {
            parseError = error instanceof Error ? error.message : String(error);
          }
          writer.toolCall({
            id: call.id,
            name: `${name}`,
            args: JSON.stringify(args),
          });
          let resultText;
          if (parseError !== undefined) {
            resultText = `Error: could not parse tool arguments as JSON (${parseError}). Re-send this tool call with valid JSON arguments.`;
          } else {
            try {
              resultText = await tools.execute(name, args);
            } catch (error) {
              resultText = `Error: ${
                error instanceof Error ? error.message : String(error)
              }`;
            }
          }
          writer.toolResult({
            id: call.id,
            name: `${name}`,
            result: `${resultText}`,
          });
          console.error(
            `[floot] tool ${name} -> ${`${resultText}`.length} chars`,
          );
          return {
            role: 'tool',
            tool_call_id: call.id,
            content: `${resultText}`,
          };
        };
        const results = await Promise.all(normalizedCalls.map(runOne));
        return harden({ normalizedCalls, results });
      },
      commitStep: async (currentLeafId, message, step) => {
        stagedMessages.push(
          { ...message, tool_calls: step.normalizedCalls },
          ...step.results,
        );
        writer.setPhase('thinking');
        return currentLeafId;
      },
      commitFinal: async (currentLeafId, message) => {
        finalContent = message.content || '';
        stagedMessages.push(message);
        return currentLeafId;
      },
    });
    answered = loop.answered;

    if (!answered) {
      // The loop hit maxToolRounds while the model still wanted to call tools,
      // so it never produced a spoken answer. Persist and speak a fallback so the
      // turn ends on a well-formed assistant message instead of an empty reply
      // sitting atop a dangling tool_result.
      finalContent =
        "I wasn't able to finish that within my tool-step limit. Could you narrow it down or try again?";
      stagedMessages.push({ role: 'assistant', content: finalContent });
      console.error(
        `[floot] turn hit maxToolRounds (${maxToolRounds}); sent fallback reply`,
      );
    }

    // Fold this turn's token usage into the session total, persist it, and emit
    // it so the UI can surface per-session cost.
    // Compute the next totals without touching the cache, then adopt them only
    // once the node carrying them is durable — the same discipline as
    // `commitExternalTurn`. Mutating the live cache first meant a failed
    // `addNode` left the in-memory counters permanently inflated by a turn
    // that produced nothing, and the next successful turn committed that
    // inflated figure as authoritative metadata.
    const current = await loadUsage();
    const totals = harden({
      inputTokens: current.inputTokens + turnInput,
      outputTokens: current.outputTokens + turnOutput,
      turns: current.turns + 1,
    });
    // Persist the complete logical turn and its accounting in one node. A
    // provider failure therefore leaves no deeper branch for revival to adopt.
    const committedNode = await tree.addNode(baseLeafId, stagedMessages, {
      usageTotals: totals,
    });
    cachedLeaf = committedNode.id;
    usage = { ...totals };
    await saveUsage();
    writer.usage(totals);
    writer.final(finalContent);
    writer.end();
  };

  /**
   * Close the inbox loop.
   *
   * Quarantine and shutdown both mean this agent will never take another turn,
   * but the loop is parked in `messages.next()` and would otherwise keep
   * accepting mail: for every message it would call `converse`, drop an
   * unobserved rejection, and mail the quarantine error back to the sender —
   * indefinitely, and with no way to stop it short of a daemon restart.
   * Declared before `converse` so its quarantine path can reach it; the
   * iterator it closes is bound later, which is why this is a function.
   */
  const stopInbox = () => {
    // eslint-disable-next-line no-use-before-define
    signalInboxStopped();
    // eslint-disable-next-line no-use-before-define
    wakeMailWorker();
    // eslint-disable-next-line no-use-before-define
    if (inboxIterator) {
      // eslint-disable-next-line no-use-before-define
      void Promise.resolve(inboxIterator.return()).catch(() => undefined);
    }
  };

  const converse = (input, writer, meta, signal) => {
    if (stopped || quarantineError) {
      const error =
        quarantineError || Error('Floot session agent is shutting down');
      writer.abort(error.message);
      return Promise.reject(error);
    }
    const turnController = new AbortController();
    turnControllers.add(turnController);
    const forwardAbort = () => turnController.abort();
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const result = turnChain.then(() =>
      stopped
        ? Promise.reject(Error('Floot session agent is shutting down'))
        : runTurn(input, writer, meta, turnController.signal).catch(err => {
            // A consumer that stopped pulling (reply reader closed) aborts `signal`,
            // tearing down the in-flight provider stream. That's a clean stop, not a
            // failure, and the writer is already settled, so swallow it.
            if (turnController.signal.aborted) {
              if (
                err?.name === 'HostedTurnCancellationError' ||
                `${err?.message || ''}`.includes(
                  'Hosted turn cancellation failed:',
                )
              ) {
                quarantineError = err;
                stopped = true;
                stopInbox();
                writer.abort(err.message);
                throw err;
              }
              if (stopped) writer.abort('Floot session agent shut down');
              return;
            }
            // runTurn has no internal catch, so on failure the writer is still
            // unsettled — abort it here or every consumer (UI stream and the mail
            // inbox's turnDone) would hang forever. Rethrow so callers still see it.
            writer.abort(err instanceof Error ? err.message : String(err));
            throw err;
          }),
    );
    const releaseTurn = () => {
      signal?.removeEventListener('abort', forwardAbort);
      turnControllers.delete(turnController);
      if (stopped) writer.abort('Floot session agent shut down');
    };
    result.then(releaseTurn, releaseTurn);
    // Keep the chain alive even if a turn rejects.
    turnChain = result.catch(() => {});
    return result;
  };

  // Inbox loop: a session is also addressable by mail. We follow the guest's
  // inbox and feed each incoming message through the SAME turn machinery as
  // converse() (so mail and UI turns share one conversation thread and are
  // serialized by turnChain), then send the reply back as one buffered mail
  // message via reply(). Streaming-over-mail is a later phase; for now the
  // reply is the assembled final text.
  let inboxStarted = false;
  let inboxIterator;
  let inboxLoop = Promise.resolve();
  /**
   * Settles when this agent stops, so the pump can leave without waiting for
   * the mailbox to say something.
   *
   * `inboxIterator.return()` is not enough: the reader pump awaits a
   * synchronization node only *between* pulls, so once it is parked in the
   * source's `next()` on a quiet mailbox it never observes the close, and the
   * cancel hangs with it. Racing the read against this is what lets a session
   * with nothing in its inbox shut down promptly instead of timing out.
   */
  let signalInboxStopped = () => {};
  const inboxStopped = new Promise(resolve => {
    signalInboxStopped = resolve;
  });
  /** Wakes the mail worker; rebound when a pump starts. */
  let wakeMailWorker = () => {};
  const startInbox = () => {
    if (inboxStarted || stopped) return;
    inboxStarted = true;
    inboxLoop = (async () => {
      const selfLocator = await E(powers).locate('@self');
      const messages = iterateReader(E(powers).followMessages());
      inboxIterator = messages;
      if (stopped) {
        await messages.return();
        return;
      }
      // followMessages can deliver the same message twice: its initial drain
      // iterates a *live* Map that our own reply() mutates (so the iterator
      // re-yields the freshly-added reply), and that reply is also republished
      // to the topic the drain later consumes. Process each number once, or the
      // second dismiss() of an already-removed message throws and kills the loop.
      const handled = new Set();
      // A mail turn is run by the worker below rather than awaited in the loop.
      //
      // `askSubagent` blocks inside a turn until `delegations.claim` observes
      // the subagent's reply, and the only reader that feeds `claim` is this
      // loop. Awaiting the turn here therefore waits on a message the loop can
      // no longer read: every ask from a mail-triggered turn times out.
      //
      // The queue is deliberately unbounded. What it holds is a reference to a
      // message the daemon is holding anyway, and it drains monotonically.
      // Declining past a bound would be worse: `followMessages` first drains
      // the whole live mailbox, far faster than the model answers, so a
      // backlog — a restart with unread mail, say — would be refused wholesale
      // even though the session goes idle moments later.
      /** @type {Array<{ number: any, text: string, fromName: any }>} */
      const pendingMail = [];
      /** @type {(() => void) | undefined} */
      let parkedWorker;
      let pumpEnded = false;
      const wakeMail = () => {
        const notify = parkedWorker;
        parkedWorker = undefined;
        if (notify) notify();
      };
      // Reachable from `stopInbox`, so a shutdown releases a parked worker
      // rather than depending on the pump to notice.
      wakeMailWorker = wakeMail;

      /**
       * Dismissal is bookkeeping, and `followMessages` can re-deliver a number
       * whose message this loop already removed. Letting that throw would kill
       * the pump — and with it delegation for the rest of the session.
       *
       * @param {any} messageNumber
       */
      const dismissQuietly = async messageNumber =>
        E(powers)
          .dismiss(messageNumber)
          .catch(error => {
            console.error(
              `[floot] could not dismiss message #${messageNumber}:`,
              error instanceof Error ? error.message : String(error),
            );
          });

      const mailWorker = (async () => {
        for (;;) {
          if (pendingMail.length === 0) {
            if (pumpEnded || stopped) return;
            // eslint-disable-next-line no-await-in-loop
            await new Promise(resolve => {
              parkedWorker = resolve;
            });
            // eslint-disable-next-line no-continue
            continue;
          }
          const { number, text, fromName } = /** @type {any} */ (
            pendingMail.shift()
          );
          try {
            if (stopped || quarantineError) return;
            const { writer, done: turnDone } = makeBufferingWriter();
            // Route through converse so the turn joins turnChain and shares
            // context. Tag the turn as mail so getHistory can mark it (and the
            // UI can show the sender) rather than render it like local input.
            // The turn's outcome is read from the writer, so the promise itself
            // is deliberately unused — but it must still be observed, or a turn
            // that rejects before reaching the writer becomes an unhandled
            // rejection in the daemon worker.
            const turnP = converse(text, writer, {
              mail: { from: fromName },
            }).then(
              () => undefined,
              error =>
                harden({ ok: false, error: `${error?.message || error}` }),
            );
            // Raced, not simply awaited: `runTurn` has early exits that return
            // *successfully* without settling the writer, and only
            // `releaseTurn`'s shutdown-time abort rescues them. A turn
            // controller aborted for any other reason would park this worker
            // on `turnDone` for good, so the second racer has to be a terminal
            // value rather than a hand-off back to `turnDone`. On every normal
            // path `writer.end()` runs before the turn resolves, so `turnDone`
            // wins and this never fires.
            // eslint-disable-next-line no-await-in-loop
            const result = await Promise.race([
              turnDone,
              turnP.then(
                outcome =>
                  outcome ||
                  harden({
                    ok: false,
                    error: 'turn ended without settling its reply',
                  }),
              ),
            ]);
            // A turn that finished is answered and dismissed whatever else is
            // happening: its history is committed and the model was paid for.
            // Only a turn shutdown aborted is left in the inbox, for the next
            // incarnation — an aborted turn commits nothing, so replaying it
            // cannot duplicate anything.
            if (!result.ok && stopped) return;
            const replyText = result.ok
              ? result.text || ''
              : `Error: ${result.error}`;
            // eslint-disable-next-line no-await-in-loop
            await E(powers).reply(number, [replyText], [], []);
            // Dismiss after handling so the message leaves the inbox and is not
            // reprocessed when followMessages replays on the next daemon
            // restart. Bookkeeping, like the pump's: a failure here must not
            // be reported as "could not complete mail turn", which the turn
            // plainly did.
            // eslint-disable-next-line no-await-in-loop
            await dismissQuietly(number);
          } catch (error) {
            console.error(
              `[floot] could not complete mail turn #${number}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      })();
      // Raced against the stop signal on every pull: the reader pump observes a
      // close only *between* pulls, so a session whose mailbox has gone quiet
      // cannot be cancelled through the iterator alone. Derived once — inside
      // the loop it would append a reaction per message to a promise that stays
      // pending for the session's whole life.
      const whenStopped = inboxStopped.then(() =>
        harden({ value: undefined, done: true }),
      );
      // The tail below runs however this loop leaves — normally, by shutdown,
      // or by a throw. Without it, a pump that died left the worker parked on a
      // wake that would never come, holding every message it had already read.
      try {
        for (;;) {
          const next = await Promise.race([messages.next(), whenStopped]);
          const { value: message, done } = next;
          if (done) break;
          const {
            from: fromId,
            number,
            type,
            strings,
            names,
            done: messageDone = true,
          } = message;
          if (handled.has(number)) {
            // eslint-disable-next-line no-continue
            continue;
          }
          // A sender may reveal a message progressively and settle it later with
          // `editMessage`; the daemon re-emits the settled revision under the
          // same number. Marking the partial handled would swallow that revision
          // — including a subagent's reply, which `claim` deliberately refuses
          // while it is still partial — and would answer a half-written message.
          if (messageDone === false) {
            // eslint-disable-next-line no-continue
            continue;
          }
          handled.add(number);
          // Offer every message — this session's own outbound mail included —
          // to the delegation registry first. It learns a delegation's identity
          // from the echo of the send and consumes the matching reply, which
          // the awaiting `askSubagent` call returns instead of this loop
          // turning it into a conversation (and replying to it, which with a
          // subagent would be an unbounded exchange).
          if (delegations.claim(message).claimed) {
            // Dismissed like every other message this loop handles. Leaving it
            // would mean that after a restart — when no ask is pending — the
            // reply replays as an ordinary message, this session answers it,
            // and the subagent answers back: two models in an unbounded
            // exchange. The cost is that a reply's attachments are not
            // retained, which `askSubagent` says plainly.
            await dismissQuietly(number);
            // eslint-disable-next-line no-continue
            continue;
          }
          // Skip our own outbound messages echoed back into the inbox.
          // Compare formulas, not locator strings: `locate` decorates with the
          // transport hints currently published by `@nets` while a message's
          // `from` is always hint-free, so a daemon with network addresses
          // would fail string equality and answer its own mail.
          if (isSameFormula(fromId, selfLocator)) {
            await dismissQuietly(number);
            // eslint-disable-next-line no-continue
            continue;
          }

          let text;
          if (type === 'package' && Array.isArray(strings)) {
            const parts = [];
            const namesArray = Array.isArray(names) ? names : [];
            for (let i = 0; i < strings.length; i += 1) {
              parts.push(strings[i]);
              if (i < namesArray.length) parts.push(`@${namesArray[i]}`);
            }
            text = parts.join('').trim();
            // This message is dismissed once this turn ends, so any attached
            // object must be adopted now. Tell the model the message number
            // and edge names so it can call adopt within this same turn.
            if (namesArray.length) {
              const edges = namesArray.map(n => `"${n}"`).join(', ');
              text += `\n\n(System: message #${number} attaches object(s) with edge name(s) ${edges}. To keep any of them, call the adopt tool with message number ${number} and the edge name during this turn — the message is dismissed afterward.)`;
            }
          } else {
            text = `(${type || 'unknown'} message)`;
          }

          // Resolve a friendly sender name for the history entry: the
          // petname(s) this guest has for the sender, falling back to the
          // locator. The reply is sent to the same sender by message number.
          let fromName;
          try {
            const senderNames = await E(powers).reverseLocate(fromId);
            fromName =
              Array.isArray(senderNames) && senderNames.length
                ? senderNames[0]
                : fromId;
          } catch {
            fromName = fromId;
          }

          if (stopped || quarantineError) break;
          pendingMail.push({ number, text, fromName });
          wakeMail();
        }
      } finally {
        // Nothing can feed `claim` once this loop is out — and nothing restarts
        // it — so an ask that kept waiting would hold the queue open for its
        // whole timeout, five minutes by default, for a reply that can no
        // longer arrive. The reason names the cause, because a session whose
        // pump died of something transient goes on answering the UI while
        // delegation is permanently gone, and an opaque error there would
        // connect to nothing in the log.
        pumpEnded = true;
        delegations.close(
          Error(
            'Floot session inbox loop ended; delegation is unavailable until the session is recreated',
          ),
        );
        wakeMail();
      }
      // Let queued replies finish before the loop resolves, so a shutdown that
      // awaits `inboxLoop` waits for mail this session already answered.
      await mailWorker;
    })().catch(error => {
      if (stopped) return;
      // Deliberately not resetting `inboxStarted`: nothing calls `startInbox`
      // twice, and a second pump would race a permanently-resolved
      // `inboxStopped` and a closed delegation registry. The session keeps
      // serving the UI; what it has lost is mail and delegation, which is what
      // this says.
      console.error(
        '[floot] inbox loop ended in error; this session no longer receives mail or delegates:',
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  const shutdownAgent = async (allowBackendQuarantine = false) => {
    stopped = true;
    for (const controller of turnControllers) controller.abort();
    // Release the pump and any parked worker before awaiting either. The
    // iterator's own `return()` cannot do it: the reader pump observes a close
    // only between pulls, so a session whose mailbox is quiet would otherwise
    // sit here until the shutdown timeout.
    // `stopInbox` already asked the iterator to close and fired the stop
    // signal the pump races against. Its `return()` is deliberately *not*
    // awaited here: the reader pump observes a close only between pulls, so on
    // a quiet mailbox that promise never settles and would hold this shutdown
    // to its timeout even though the loop it guards has already left.
    stopInbox();
    const closing = [turnChain, inboxLoop];
    const settled = await withTimeout(
      Promise.allSettled(closing),
      'Floot session agent shutdown',
    );
    const failures = /** @type {PromiseRejectedResult[]} */ (settled)
      .filter(result => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Floot session agent shutdown failed');
    }
    if (quarantineError && !allowBackendQuarantine) throw quarantineError;
  };

  // Replay the conversation for UI repaint: user prompts, the assistant's spoken
  // answers, and each tool call paired with its result so tool activity survives
  // a refresh. The system prompt (root) is omitted.
  const getHistory = async () => {
    const leafId = await getOrCreateLeaf();
    const path = await tree.getPath(leafId);
    const out = [];
    // Call IDs are provider-local and may repeat in later turns. Pair each raw
    // tool result with the earliest unmatched call of that ID as the linear
    // path is replayed, rather than globally indexing by ID and overwriting an
    // earlier turn's result.
    const pendingById = new Map();
    for (const m of path) {
      if (m.role === 'tool' && m.tool_call_id != null) {
        const pending = pendingById.get(m.tool_call_id);
        const index = pending?.shift();
        if (index !== undefined) out[index].result = m.content;
        // eslint-disable-next-line no-continue
        continue;
      }
      if (m.role !== 'user' && m.role !== 'assistant') {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (typeof m.content === 'string' && m.content.trim() !== '') {
        out.push({
          role: m.role,
          content: m.content,
          ...(m.meta ? { meta: m.meta } : {}),
        });
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const args = tc.function?.arguments;
          const index = out.length;
          out.push({
            role: 'tool',
            name: tc.function?.name || 'tool',
            args: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
            result: null,
          });
          const pending = pendingById.get(tc.id) || [];
          pending.push(index);
          pendingById.set(tc.id, pending);
        }
      }
    }
    return harden(out);
  };

  const getUsage = async () => harden({ ...(await loadUsage()) });

  return harden({
    converse,
    getHistory,
    getUsage,
    startInbox,
    shutdown: shutdownAgent,
  });
};
harden(makeStreamingAgent);

// ============================================================================
// Floot Factory — entry point (mirrors fae's factory recipe)
// ============================================================================

// Petname (in the factory guest's own petstore) where the session registry —
// an array of { id, title, createdAt } — is persisted.
const REGISTRY_NAME = 'floot-sessions';
const REGISTRY_PREFIX = 'floot-sessions-v1-';
/**
 * Snapshots retained behind the newest. One is enough for correctness — the
 * newest complete snapshot is the record — and a handful gives an operator
 * something to fall back on if the newest turns out to be unreadable.
 */
const REGISTRY_JOURNAL_DEPTH = 4;

const newSessionId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The Floot factory — a single long-lived, pinned caplet that owns every chat
 * session. The UI references ONLY this factory; it never sees a guest.
 *
 * Each session is, internally, its own EndoGuest (isolated petstore for
 * conversation history, tool endowments, and — later — an inbox). That a session
 * "is a guest" is an implementation detail hidden behind opaque session facets
 * (Far objects with `converse(input) -> replyReader` and `getHistory()`). The
 * factory operates each session guest's petstore directly via an in-process
 * `makeStreamingAgent`, so there is exactly one pin (the factory) rather than a
 * pin per session.
 *
 * Persistence is daemon-only: the session registry lives in the factory's own
 * petstore (REGISTRY_NAME), and each session's history lives in its guest's
 * petstore. On restart the daemon revives the pinned factory; sessions are
 * revived lazily (provideGuest is idempotent) on first use.
 *
 * IMPORTANT (reincarnation constraint, same as the fae/driver caplets): make()
 * must return synchronously WITHOUT awaiting remote references on its powers
 * host, or it deadlocks with the provision chain creating this very formula.
 * So the provider, registry, and per-session guests are all resolved lazily.
 *
 * @param {import('@endo/eventual-send').FarRef<object>} hostPowers
 * @param {Promise<object> | object | undefined} _context
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {object}
 */
/**
 * The system prompt a new session runs under.
 *
 * A caller of the public `createSession` speaks with the operator's own
 * authority, so a prompt it supplies replaces the preset's.
 *
 * A *delegated* session's prompt is composed instead. The parent model writes
 * the child's instructions, while the preset still decides which objects the
 * child gets — so substituting would let a model spawn a session with its own
 * tools and none of the operator's standing instructions. That is a way around
 * them, not a way to delegate.
 *
 * @param {object} options
 * @param {string} options.presetPrompt
 * @param {string} [options.requestedPrompt]
 * @param {boolean} [options.delegated]
 * @returns {string}
 */
export const composeSessionSystemPrompt = ({
  presetPrompt,
  requestedPrompt,
  delegated = false,
}) => {
  if (!requestedPrompt) return presetPrompt;
  if (!delegated) return `${requestedPrompt}`;
  return [
    presetPrompt,
    '---',
    'You are a subagent. Your parent agent gave you these standing ' +
      'instructions, which do not replace anything above:',
    `${requestedPrompt}`,
  ].join('\n\n');
};
harden(composeSessionSystemPrompt);

export const make = (hostPowers, _context, { env } = {}) => {
  /** @type {any} */
  const powers = hostPowers;
  const systemPrompt = env?.FLOOT_SYSTEM_PROMPT || undefined;
  // Absolute host path to the Endo codebase, mounted read-only into full-control
  // sessions (see the `code-mount` preset object). Resolved by the setup script
  // and passed through env; empty when the daemon host has no source on disk.
  const codePath = env?.FLOOT_CODE_PATH || undefined;

  // The factory runs with its own host powers, so it provisions session guests
  // directly — no introduced `host-agent` reference (that rehydrates as a
  // mail-only Handle after a restart, leaving provideGuest/locate unavailable on
  // revived sessions). `powers` here is the factory's own host.
  const getHost = () => powers;

  // The provider config (backend kind, default model, auth token) lives behind
  // the `llm-provider` capability handle. Resolve it once and cache it; every
  // per-model provider is built from it.
  let providerConfigP;
  const getProviderConfig = () => {
    if (!providerConfigP) {
      providerConfigP = E(powers)
        .lookup('llm-provider')
        .catch(error => {
          providerConfigP = undefined;
          throw error;
        });
    }
    return providerConfigP;
  };

  // The ClaudeClient capability backing `claude-cli` sessions, resolved lazily
  // from the factory host's petstore (FLOOT_CLAUDE_CLIENT names it; default
  // "claude-client"). Provisioned separately by @endo/claude-sandbox's setup —
  // sessions pinned to claude-cli fail with a clear error until it exists.
  // A ClaudeClient is a *session-scoped* capability, not a shared service: it
  // carries one CLI conversation (every turn after the first runs
  // `claude -p --continue`), one projected workspace, and one turn queue. Two
  // floot sessions sharing one client would therefore read and overwrite each
  // other's conversation and files, and serialize behind each other — breaking
  // the one-session-one-guest isolation the rest of this factory maintains.
  //
  // So each session binds its own client, looked up as `<base>-<sessionId>`.
  // The bare `<base>` name is accepted as a fallback for a single-session
  // setup, but is claimed exclusively: a second session asking for it fails
  // loudly rather than silently sharing a conversation.
  /** @type {Map<string, Promise<any>>} */
  const claudeClients = new Map();
  /** @type {string | undefined} */
  let sharedClientClaimedBy;
  const getClaudeClient = id => {
    let clientP = claudeClients.get(id);
    if (!clientP) {
      const base = env?.FLOOT_CLAUDE_CLIENT || 'claude-client';
      const perSession = `${base}-${id}`;
      clientP = (async () => {
        if (await E(powers).has(perSession)) {
          return E(powers).lookup(perSession);
        }
        if (
          sharedClientClaimedBy !== undefined &&
          sharedClientClaimedBy !== id
        ) {
          throw new Error(
            `floot: session ${id} cannot use the shared ClaudeClient "${base}" —` +
              ` session ${sharedClientClaimedBy} already holds it, and a client` +
              ` carries one CLI conversation and workspace. Provision` +
              ` "${perSession}" with @endo/claude-sandbox for this session.`,
          );
        }
        if (!(await E(powers).has(base))) {
          throw new Error(
            `floot: no ClaudeClient capability for session ${id} — provision` +
              ` "${perSession}" (or "${base}" for a single-session setup) with` +
              ` @endo/claude-sandbox, or set FLOOT_CLAUDE_CLIENT.`,
          );
        }
        const shared = await E(powers).lookup(base);
        sharedClientClaimedBy = id;
        return shared;
      })().catch(error => {
        claudeClients.delete(id);
        throw error;
      });
      claudeClients.set(id, clientP);
    }
    return clientP;
  };
  // Hand a session only the authority its turns need. A session runs prompts;
  // it has no business interrupting or terminating the sandbox session out
  // from under the factory that provisioned it, so the client is attenuated to
  // its `send` method before it reaches the agent.
  const makeSendOnlyClient = client =>
    harden({
      send: (prompt, opts) => E(client).send(prompt, opts),
      interrupt: () => E(client).interrupt(),
      acknowledge: checkpoint => E(client).acknowledge(checkpoint),
    });

  // Hosted backend factories are operator-endowed capabilities. Discovery is
  // explicit and bounded to configured petnames plus the conventional Codex
  // name; the session/model never receives a factory or lifecycle admin facet.
  const configuredBackendNames = [
    ...(env?.FLOOT_BACKEND_FACTORIES || '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
    'codex-backend',
  ];
  /** @type {Promise<Map<string, { factory: any, descriptor: any }>> | undefined} */
  let hostedBackendsP;
  const getHostedBackends = () => {
    if (!hostedBackendsP) {
      hostedBackendsP = (async () => {
        const backends = new Map();
        for (const name of [...new Set(configuredBackendNames)]) {
          // eslint-disable-next-line no-await-in-loop, @jessie.js/safe-await-separator
          if (await E(powers).has(name)) {
            // eslint-disable-next-line no-await-in-loop
            const factory = await E(powers).lookup(name);
            // eslint-disable-next-line no-await-in-loop
            const descriptor = assertHostedBackendDescriptor(
              await E(factory).describe(),
            );
            if (backends.has(descriptor.id)) {
              throw Error(`Invalid or duplicate hosted backend at "${name}"`);
            }
            backends.set(descriptor.id, { factory, descriptor });
          }
        }
        return backends;
      })().catch(error => {
        hostedBackendsP = undefined;
        throw error;
      });
    }
    return hostedBackendsP;
  };

  // The account oracle is an operator-endowed, read-only capability: it answers
  // what plan this deployment is on and how much quota is left, and it cannot
  // reach the credential it describes. Absent by default — a deployment that
  // has provisioned none simply has no `accountStatus` tool and a factory whose
  // `getAccount()` reports that nothing is available.
  const accountOracleName = env?.FLOOT_ACCOUNT_ORACLE || 'account-oracle';
  /** @type {Promise<any> | undefined} */
  let accountOracleP;
  const getAccountOracle = () => {
    if (!accountOracleP) {
      accountOracleP = (async () => {
        if (!(await E(powers).has(accountOracleName))) {
          // Do not cache the absence. An oracle is provisioned by re-running
          // setup, which binds the name without restarting this caplet, and a
          // remembered `undefined` would withhold `accountStatus` from every
          // session for the life of the daemon.
          accountOracleP = undefined;
          return undefined;
        }
        return E(powers).lookup(accountOracleName);
      })().catch(error => {
        accountOracleP = undefined;
        throw error;
      });
    }
    return accountOracleP;
  };

  /**
   * The model id a session's usage is priced against.
   *
   * An unpinned session — the default — records no model and follows the
   * factory's configured one, so asking `entry.model` alone yields `''` and
   * nothing can be priced. Both the `accountStatus` tool and the session
   * facet's `getAccount` must answer the same way, or a user gets a cost from
   * the model and a blank from the UI panel beside it.
   *
   * @param {any} entry
   * @returns {Promise<string>}
   */
  const sessionModelId = async entry => {
    if (entry?.backendId) {
      return hostedModelId(entry.backendId, entry.modelId || '');
    }
    if (entry?.model) return `${entry.model}`;
    try {
      return `${(await getProviderConfig()).model || ''}`;
    } catch {
      // Pricing is a nicety; a session that cannot read its provider config has
      // a larger problem, and it will surface on its next turn.
      return '';
    }
  };

  /** @type {Map<string, any>} */
  const backendAdmins = new Map();

  // One streaming provider per model. Sessions that don't pin a model share the
  // entry under the empty-string key (the factory's configured default model).
  //
  // The auth token is read from the `SecretBlob`, never held in the config
  // value, and re-read for every turn: a provider pins the token it was built
  // with, so a cache keyed on the model alone would go on presenting a revoked
  // credential until somebody thought to call `refreshCredentials()`. Keyed on
  // the bytes as well, a rotation or revocation takes effect by itself on the
  // next turn, and an unrotated deployment still reuses the provider it built.
  /** @type {Map<string, { token: string, providerP: Promise<any> }>} */
  const providersByModel = new Map();
  const getProvider = async model => {
    const key = model || '';
    const cfg = await getProviderConfig();
    // A revoked secret rejects here, which fails the turn rather than letting
    // a cached provider answer it.
    const token = await resolveAuthToken({ powers, config: cfg });
    const cached = providersByModel.get(key);
    if (cached && cached.token === token) return cached.providerP;
    const providerP = (async () =>
      createStreamingProvider({
        FLOOT_PROVIDER: cfg.provider,
        FLOOT_MODEL: model || cfg.model,
        FLOOT_AUTH_TOKEN: token,
      }))().catch(error => {
      if (providersByModel.get(key)?.token === token) {
        providersByModel.delete(key);
      }
      throw error;
    });
    providersByModel.set(key, { token, providerP });
    return providerP;
  };

  // In-memory session registry, mirrored to the factory's petstore. Loaded
  // lazily so make() never awaits.
  /** @type {Array<{ id: string, title: string, createdAt: number, presetId?: string, systemPrompt?: string, model?: string, backendId?: string, modelId?: string, reasoningEffort?: string, lifecycle?: string }> | undefined} */
  let registry;
  let registryLoadP;
  let registrySequence = 0n;
  const loadRegistry = () => {
    if (registry) return Promise.resolve(registry);
    if (!registryLoadP) {
      registryLoadP = (async () => {
        const names = await E(powers).list();
        const journalNames = (Array.isArray(names) ? names : [])
          .filter(
            name =>
              typeof name === 'string' &&
              name.startsWith(REGISTRY_PREFIX) &&
              /^[0-9]{20}$/.test(name.slice(REGISTRY_PREFIX.length)),
          )
          .sort();
        if (journalNames.length > 0) {
          const latestName = journalNames.at(-1);
          const stored = await E(powers).lookup(latestName);
          if (
            stored?.version !== 1 ||
            !Array.isArray(stored.sessions) ||
            typeof stored.sequence !== 'bigint' ||
            latestName !==
              `${REGISTRY_PREFIX}${`${stored.sequence}`.padStart(20, '0')}`
          ) {
            throw Error('Floot lifecycle registry journal is corrupt');
          }
          registry = [...stored.sessions];
          registrySequence = stored.sequence + 1n;
        } else if (await E(powers).has(REGISTRY_NAME)) {
          const stored = await E(powers).lookup(REGISTRY_NAME);
          registry = Array.isArray(stored) ? [...stored] : [];
        } else {
          registry = [];
        }
        return registry;
      })().catch(error => {
        registryLoadP = undefined;
        throw error;
      });
    }
    return registryLoadP;
  };
  // Serialize append-only lifecycle snapshots. Every registry version has a
  // unique name, so a crash leaves either the previous complete snapshot or the
  // next complete snapshot; it can never erase the sole recovery record.
  let registryWrite = Promise.resolve();
  const saveRegistry = () => {
    const result = registryWrite.then(async () => {
      const sequence = registrySequence;
      const name = `${REGISTRY_PREFIX}${`${sequence}`.padStart(20, '0')}`;
      await E(powers).storeValue(
        harden({
          version: 1,
          sequence,
          sessions: harden([...(registry || [])]),
        }),
        name,
      );
      registrySequence += 1n;
      // Append-only was never meant to be unbounded: every lifecycle
      // transition wrote a snapshot and nothing removed one, so the factory
      // host's pet store accumulated a full copy of the session array per
      // operation and every cold start listed and sorted all of them. Trim
      // only after the new snapshot is durable, so the journal is never
      // momentarily empty, and keep a few behind it so a snapshot that turns
      // out to be unreadable is not the only record.
      if (sequence >= BigInt(REGISTRY_JOURNAL_DEPTH)) {
        const oldest = sequence - BigInt(REGISTRY_JOURNAL_DEPTH);
        const staleName = `${REGISTRY_PREFIX}${`${oldest}`.padStart(20, '0')}`;
        await E(powers)
          .remove(staleName)
          .catch(() => undefined);
      }
    });
    // Keep the chain alive even if this write rejects.
    registryWrite = result.catch(() => {});
    return result;
  };

  // Per-session in-process streaming agent, built lazily over the session
  // guest's powers. provideGuest is idempotent, so this both creates a fresh
  // session guest and revives an existing one after a restart.
  /** @type {Map<string, Promise<any>>} */
  const agents = new Map();
  const getAgent = id => {
    let agentP = agents.get(id);
    if (!agentP) {
      agentP = (async () => {
        const host = getHost();
        const handleName = `session-${id}`;
        const agentName = `session-agent-${id}`;
        // provideGuest is idempotent (create-or-revive). The petname we pass
        // (and provideGuest's return value) bind to the guest's *handle* — a
        // mail-only facet that, after a restart, has none of the petstore/mail
        // control methods. So we pass an explicit agentName and look the
        // controlling *agent* up by that name to get the full guest facet for
        // the session's powers (the same agent fae runs its driver against).
        await E(host).provideGuest(handleName, { agentName });
        const sessionGuest = await E(host).lookup(agentName);
        // Introduce the user to the session under the petname "user" so the
        // agent can mail them directly (send/reply target "user"). The factory
        // host's own "@host" is the user — the @agent that provisioned the
        // factory — so copy it into the guest's petstore. A session's own
        // "@host" is this factory host, not the user, which is why a plain
        // send("@host") never reaches them. Idempotent: skip if already present
        // (the guest's petstore survives restarts).
        try {
          if (!(await E(sessionGuest).has('user'))) {
            await E(host).copy(['@host'], [agentName, 'user']);
          }
        } catch (err) {
          console.warn(
            `[floot-factory] could not register "user" for session ${id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
        // Resolve the session's preset to pick its system prompt and provision
        // its objects. The prompt was snapshotted into the registry at creation
        // (so catalog edits don't retroactively change live sessions); the
        // object set is read from the catalog by id (objects are provisioned
        // once and idempotency makes re-reads harmless).
        await loadRegistry();
        const entry = (registry || []).find(s => s.id === id);
        const preset = getPreset(entry?.presetId || DEFAULT_PRESET_ID);
        const sessionPrompt =
          entry?.systemPrompt || systemPrompt || preset.systemPrompt;
        await provisionPresetObjects(
          host,
          agentName,
          sessionGuest,
          id,
          preset.objects,
          codePath,
        );
        // Build (or reuse) the backend for this session's pinned model; an
        // unpinned session follows the factory's configured default. The
        // claude-cli pseudo-model routes through a ClaudeClient capability
        // instead of a streaming API provider.
        let agentConfig;
        if (entry?.backendId) {
          const backend = (await getHostedBackends()).get(entry.backendId);
          if (!backend) {
            throw Error(`Hosted backend "${entry.backendId}" is unavailable`);
          }
          const snapshot = await makeFlootToolRegistry(sessionGuest).snapshot();
          const toolSet = makeEndoToolSet(snapshot);
          const session = await E(backend.factory).create(
            harden({
              sessionId: id,
              model: entry.modelId || '',
              reasoningEffort: entry.reasoningEffort || '',
              systemPrompt: sessionPrompt,
            }),
            toolSet,
          );
          backendAdmins.set(id, session.admin);
          agentConfig = {
            hostedClient: makeSendOnlyClient(session.run),
          };
        } else if (entry?.model === CLAUDE_CLI_MODEL_ID) {
          agentConfig = {
            claudeClient: makeSendOnlyClient(await getClaudeClient(id)),
          };
        } else {
          // A thunk, not a resolved provider: `refreshCredentials()` clears
          // the factory's cache, and a session that had captured its provider
          // would keep using the token that provider was built with — the
          // rotation or revocation would reach only sessions opened after it.
          agentConfig = { provideProvider: () => getProvider(entry?.model) };
        }
        // A session may delegate only while its own depth leaves room. The
        // spawner is rebuilt on every revival rather than persisted, so the
        // durable record of the tree is the session registry alone.
        const sessionDepth = Number(entry?.subagentDepth) || 0;
        const oracle = await getAccountOracle();
        const agent = await makeStreamingAgent(
          sessionGuest,
          undefined,
          agentConfig,
          sessionPrompt,
          harden({
            maxToolRounds,
            ...(sessionDepth < maxSubagentDepth
              ? { spawner: makeSessionSpawner(id, sessionDepth + 1) }
              : {}),
            ...(oracle
              ? { accountOracle: oracle, modelId: await sessionModelId(entry) }
              : {}),
          }),
        );
        // Each session is addressable by mail: start following its inbox.
        agent.startInbox();
        return agent;
      })().catch(async error => {
        agents.delete(id);
        const admin = backendAdmins.get(id);
        if (admin) {
          // A stop, not a deletion: the backend keeps the session's durable
          // workspace and state, so a revival that failed past this point —
          // an oracle lookup, say — can be revived again with them intact.
          try {
            await E(admin).terminate();
            backendAdmins.delete(id);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `Floot session ${id} setup and hosted-backend rollback failed`,
              { cause: cleanupError },
            );
          }
        }
        throw error;
      });
      agents.set(id, agentP);
    }
    return agentP;
  };

  // Opaque session facet handed to the UI. It exposes a streaming conversation
  // and a history replay, but never reveals the backing guest.
  /** @type {Map<string, object>} */
  const facets = new Map();
  const assertSessionReady = async id => {
    await loadRegistry();
    const entry = (registry || []).find(session => session.id === id);
    if (!entry) throw Error(`Unknown session "${id}".`);
    if ((entry.lifecycle || 'ready') !== 'ready') {
      throw Error(
        `Session "${id}" is not operable while lifecycle is ${entry.lifecycle}`,
      );
    }
    return entry;
  };
  const getFacet = id => {
    let facet = facets.get(id);
    if (!facet) {
      facet = makeExo('FlootSession', FlootSessionInterface, {
        async getInfo() {
          const entry = await assertSessionReady(id);
          return harden({
            id,
            title: entry?.title || '',
            createdAt: entry?.createdAt || 0,
            presetId: entry?.presetId || DEFAULT_PRESET_ID,
            model: entry?.backendId
              ? hostedModelId(entry.backendId, entry.modelId || '')
              : entry?.model || '',
            backendId: entry?.backendId || 'provider',
            modelId: entry?.modelId || entry?.model || '',
            reasoningEffort: entry?.reasoningEffort || '',
            lifecycle: entry?.lifecycle || 'ready',
          });
        },
        /**
         * @param {string | object} input
         * @returns {object} replyReader
         */
        converse(input) {
          // Abort the in-flight turn when the consumer stops pulling the reply
          // (UI Stop / barge-in): makeReplyChannel fires onClose on
          // reader.return/throw, aborting the signal threaded into the provider
          // stream so the model stops generating instead of running on unseen.
          const controller = new AbortController();
          const { writer, reader } = makeReplyChannel(() => controller.abort());
          (async () => {
            try {
              await assertSessionReady(id);
              const agent = await getAgent(id);
              await agent.converse(input, writer, undefined, controller.signal);
            } catch (error) {
              if (controller.signal.aborted) return;
              writer.abort(
                error instanceof Error ? error.message : String(error),
              );
            }
          })();
          return reader;
        },
        async getHistory() {
          await assertSessionReady(id);
          const agent = await getAgent(id);
          return agent.getHistory();
        },
        async getUsage() {
          await assertSessionReady(id);
          const agent = await getAgent(id);
          return agent.getUsage();
        },
        /**
         * This session's share of the account: the deployment-wide plan and
         * rate limits, plus what this conversation has spent at the current
         * list price. Reported per session because that is the granularity a
         * user asks about ("what is this chat costing?").
         *
         * @param {boolean} [refresh]
         */
        async getAccount(refresh) {
          const entry = await assertSessionReady(id);
          const oracle = await getAccountOracle();
          if (!oracle) {
            return harden({
              available: false,
              reason: `No account oracle is bound to "${accountOracleName}".`,
            });
          }
          if (refresh) await E(oracle).refresh();
          const agent = await getAgent(id);
          const [plan, rateLimits, rateCard, usage] = await Promise.all([
            E(oracle).getPlan(),
            E(oracle).getRateLimits(),
            E(oracle).getRateCard(),
            agent.getUsage(),
          ]);
          const modelId = await sessionModelId(entry);
          const cost = modelId
            ? await E(oracle).estimateCost(
                harden({
                  modelId,
                  inputTokens: BigInt(
                    Math.max(0, Math.trunc(usage.inputTokens || 0)),
                  ),
                  outputTokens: BigInt(
                    Math.max(0, Math.trunc(usage.outputTokens || 0)),
                  ),
                }),
              )
            : undefined;
          return harden({
            available: true,
            plan,
            rateLimits,
            rateCard,
            usage,
            ...(cost ? { cost } : {}),
          });
        },
        help() {
          return 'Floot session: converse(input) returns a streaming reply reader; getHistory() replays the conversation; getUsage() returns cumulative { inputTokens, outputTokens, turns }; getAccount(refresh?) returns the plan, rate limits, and this session’s estimated cost; getInfo() returns { id, title, createdAt }.';
        },
      });
      facets.set(id, facet);
    }
    return facet;
  };

  const cleanupSessionResources = async entry => {
    const { id } = entry;
    const failures = [];
    const agentP = agents.get(id);
    if (agentP) {
      try {
        const agent = await agentP;
        // A hosted backend's admin/factory termination below is the
        // authoritative barrier for a quarantined native turn. Allow cleanup
        // to reach it; provider-only sessions still fail closed here.
        await agent.shutdown(Boolean(entry.backendId));
      } catch (error) {
        // Do not tear down the guest beneath live turn or inbox activity.
        throw new AggregateError(
          [error],
          `Floot session ${id} agent did not stop`,
          { cause: error },
        );
      }
    }
    const admin = backendAdmins.get(id);
    if (admin) {
      try {
        await E(admin).terminate();
        backendAdmins.delete(id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (entry.backendId) {
      // Termination is a stop: it releases the slice, the mount, and the
      // lease and keeps the workspace and Codex state. Deletion removes those
      // through the factory's idempotent destroy, which first stops any
      // instance it still runs — so it also reaches a backend instance whose
      // admin facet died with an earlier incarnation of this factory. Not
      // while termination is refusing, though: a session with an unsettled
      // Endo tool call stays intact for the lifecycle retry.
      if (failures.length === 0) {
        try {
          const backend = (await getHostedBackends()).get(entry.backendId);
          if (!backend) {
            throw Error(`Hosted backend "${entry.backendId}" is unavailable`);
          }
          await E(backend.factory).destroy(harden({ sessionId: id }));
        } catch (error) {
          failures.push(error);
        }
      }
    } else if (entry.model === CLAUDE_CLI_MODEL_ID) {
      // Terminate only a client this session actually obtained.
      // `getClaudeClient` has claim side effects, so calling it here would
      // let a deletion acquire the shared client *on behalf of* the session
      // being deleted and then destroy it — taking down a live sibling's
      // conversation and workspace — or, when a sibling already holds the
      // claim, throw and make this session permanently undeletable.
      const clientP = claudeClients.get(id);
      if (clientP) {
        try {
          await E(await clientP).terminate();
          claudeClients.delete(id);
          if (sharedClientClaimedBy === id) sharedClientClaimedBy = undefined;
        } catch (error) {
          // Keep the map entry so a lifecycle retry terminates it again
          // rather than silently skipping a client that is still running.
          failures.push(error);
        }
      } else if (sharedClientClaimedBy === id) {
        // Never built one, but the claim is recorded against this session;
        // releasing it lets a sibling take the shared client.
        sharedClientClaimedBy = undefined;
      }
    }
    // A hosted/CLI teardown failure can mean a host-side Endo tool call is
    // still settling. Keep the session guest and its capabilities alive until
    // backend termination succeeds on a later lifecycle retry.
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Floot session ${id} backend did not fully clean up`,
      );
    }
    const host = getHost();
    for (const name of [`session-${id}`, `session-agent-${id}`]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (await E(host).has(name)) {
          // eslint-disable-next-line no-await-in-loop
          await E(host).remove(name);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Floot session ${id} resources did not fully clean up`,
      );
    }
    agents.delete(id);
    facets.delete(id);
  };

  const finishSessionDeletion = async id => {
    const entry = (registry || []).find(session => session.id === id);
    if (!entry) return;
    try {
      await cleanupSessionResources(entry);
    } catch (error) {
      const current = (registry || []).findIndex(session => session.id === id);
      if (current >= 0) {
        const currentEntry = /** @type {any[]} */ (registry)[current];
        /** @type {any[]} */ (registry)[current] = harden({
          ...currentEntry,
          lifecycle: 'error',
        });
        await saveRegistry();
      }
      throw error;
    }
    registry = (registry || []).filter(session => session.id !== id);
    await saveRegistry();
    console.error(`[floot-factory] Deleted session "${id}"`);
  };

  /**
   * Create one session: its registry entry, its guest, and its running inbox
   * loop. Shared by the factory's public `createSession` and by the subagent
   * spawner, so a subagent session is an ordinary session that records which
   * session asked for it.
   *
   * @param {Record<string, any>} options
   * @returns {Promise<string>} the new session id
   */
  const provisionSession = async options => {
    await loadRegistry();
    const preset = getPreset(options.presetId || DEFAULT_PRESET_ID);
    const id = newSessionId();
    const { parentSessionId, subagentName, subagentDepth } = options;
    const delegationFields =
      parentSessionId === undefined
        ? {}
        : {
            parentSessionId: `${parentSessionId}`,
            subagentName: `${subagentName}`,
            subagentDepth: Number(subagentDepth),
          };
    let backendId;
    let modelId;
    const selectedModel = options.modelId || options.model || '';
    if (options.backendId && options.backendId !== 'provider') {
      backendId = `${options.backendId}`;
      modelId = `${options.modelId || ''}`;
    } else if (
      typeof selectedModel === 'string' &&
      selectedModel.includes(':')
    ) {
      [backendId, modelId] = selectedModel.split(/:(.*)/s, 2);
    }
    if (backendId) {
      const backend = (await getHostedBackends()).get(backendId);
      if (!backend) throw Error(`Unknown hosted backend "${backendId}"`);
      const models = await E(backend.factory).listModels();
      const chosen = models.find(candidate => candidate.id === modelId);
      if (!chosen) {
        throw Error(`Unknown model "${modelId}" for backend "${backendId}"`);
      }
      const projected = normalizeHostedModelDescriptor(chosen);
      const supportedEfforts = projected.reasoningEfforts;
      if (
        options.reasoningEffort &&
        !supportedEfforts.includes(options.reasoningEffort)
      ) {
        throw Error(
          `Unsupported reasoning effort "${options.reasoningEffort}" for ${backendId}:${modelId}`,
        );
      }
    }
    // Snapshot the preset's id and prompt so later catalog edits don't change
    // a live session. The object set is re-read from the catalog by id in
    // getAgent (objects are provisioned once, idempotently). A model is pinned
    // only when the caller chose a known one; otherwise the session follows
    // the factory's configured default model.
    const sessionPrompt = composeSessionSystemPrompt({
      presetPrompt: preset.systemPrompt,
      requestedPrompt: options.systemPrompt,
      delegated: parentSessionId !== undefined,
    });
    const entry = harden({
      id,
      title: options.title || 'New chat',
      createdAt: Date.now(),
      presetId: preset.id,
      systemPrompt: sessionPrompt,
      lifecycle: 'creating',
      ...delegationFields,
      ...(backendId
        ? {
            backendId,
            modelId,
            ...(options.reasoningEffort
              ? { reasoningEffort: `${options.reasoningEffort}` }
              : {}),
          }
        : isKnownModel(selectedModel)
          ? { model: selectedModel }
          : {}),
    });
    /** @type {any[]} */ (registry).push(entry);
    await saveRegistry();
    // Build the agent now so the new session immediately follows its inbox
    // (addressable by mail without waiting for a first UI converse) and its
    // preset objects are provisioned up front.
    try {
      await getAgent(id);
      const index = /** @type {any[]} */ (registry).findIndex(
        session => session.id === id,
      );
      const currentEntry = /** @type {any[]} */ (registry)[index];
      /** @type {any[]} */ (registry)[index] = harden({
        ...currentEntry,
        lifecycle: 'ready',
      });
      await saveRegistry();
    } catch (error) {
      const failed = (registry || []).findIndex(session => session.id === id);
      if (failed >= 0) {
        const failedEntry = /** @type {any[]} */ (registry)[failed];
        /** @type {any[]} */ (registry)[failed] = harden({
          ...failedEntry,
          lifecycle: 'error',
        });
      }
      // Recording the failure must not be able to skip the rollback: by this
      // point `getAgent` may have started the session's inbox loop, and only
      // `cleanupSessionResources` can stop it. Observe the write's outcome and
      // report it alongside, rather than letting it escape the catch.
      const markFailure = await saveRegistry().then(
        () => undefined,
        markError => markError,
      );
      // The agent deliberately stays in the map. `cleanupSessionResources`
      // shuts it down before removing the guest's pet names; dropping the
      // reference first would tear the guest out from under a live inbox loop
      // with nothing left that could ever stop it.
      try {
        await finishSessionDeletion(id);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError, ...(markFailure ? [markFailure] : [])],
          `Floot session ${id} creation and rollback failed`,
          { cause: cleanupError },
        );
      }
      if (markFailure) {
        throw new AggregateError(
          [error, markFailure],
          `Floot session ${id} creation failed and the failure could not be recorded`,
          { cause: markFailure },
        );
      }
      throw error;
    }
    console.error(
      `[floot-factory] Created session "${id}" (preset "${preset.id}"${
        entry.backendId
          ? `, backend "${entry.backendId}", model "${entry.modelId}"`
          : entry.model
            ? `, model "${entry.model}"`
            : ''
      })`,
    );
    return id;
  };

  /**
   * Delete one session and, depth-first, every subagent session beneath it. A
   * subagent that outlived its parent would keep an inbox loop (and a hosted
   * backend slice) alive with nobody left to read its replies.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  const releaseSession = async id => {
    await loadRegistry();
    const index = (registry || []).findIndex(session => session.id === id);
    if (index === -1) throw Error(`Unknown session "${id}".`);
    const children = (registry || []).filter(
      session => session.parentSessionId === id,
    );
    for (const child of children) {
      await releaseSession(child.id);
    }
    // `finishSessionDeletion` rebinds `registry`, so re-find rather than
    // reusing the index computed before the recursion.
    const current = (registry || []).findIndex(session => session.id === id);
    if (current === -1) return;
    /** @type {any[]} */ (registry)[current] = harden({
      .../** @type {any[]} */ (registry)[current],
      lifecycle: 'deleting',
    });
    await saveRegistry();
    await finishSessionDeletion(id);
  };

  // Layers of delegation a session tree may reach. 0 withholds the subagent
  // tools from every session.
  const maxSubagentDepth = (() => {
    const configured = env?.FLOOT_MAX_SUBAGENT_DEPTH;
    if (configured === undefined || configured === '') {
      return DEFAULT_MAX_SUBAGENT_DEPTH;
    }
    const value = Number(configured);
    if (!Number.isInteger(value) || value < 0) {
      throw Error(
        `Invalid FLOOT_MAX_SUBAGENT_DEPTH ${JSON.stringify(configured)}`,
      );
    }
    return value;
  })();

  // Provider calls one turn may make before the tool-step fallback. Read once
  // here, where a bad value is a deployment error the operator sees at
  // provisioning, rather than per session where it would surface as a failed
  // turn much later.
  const maxToolRounds = (() => {
    const configured = env?.FLOOT_MAX_TOOL_ROUNDS;
    if (configured === undefined || configured === '') {
      return DEFAULT_MAX_TOOL_ROUNDS;
    }
    const value = Number(configured);
    if (!Number.isInteger(value) || value < 1) {
      throw Error(
        `Invalid FLOOT_MAX_TOOL_ROUNDS ${JSON.stringify(configured)}`,
      );
    }
    return value;
  })();
  const MAX_SUBAGENTS_PER_SESSION = 8;

  /**
   * The whole of the authority a session gets over the factory: create, list,
   * and release sessions recorded as its own subagents. It cannot name, reach,
   * or delete any other session, and it never sees a session guest — the
   * locator it returns is the subagent's mail handle, which is exactly what
   * the parent needs to converse with it and nothing more.
   *
   * @param {string} parentId
   * @param {number} depth - Delegation depth of the subagents it creates.
   */
  const makeSessionSpawner = (parentId, depth) => {
    const listSubagents = async () => {
      await loadRegistry();
      return (registry || []).filter(
        session => session.parentSessionId === parentId,
      );
    };
    return makeExo('SubagentSpawner', SubagentSpawnerInterface, {
      /**
       * @param {string} name
       * @param {{ systemPrompt?: string }} [options]
       */
      async spawn(name, options = {}) {
        assertSubagentName(name);
        const { systemPrompt: childPrompt } = options;
        if (
          childPrompt !== undefined &&
          (typeof childPrompt !== 'string' || childPrompt.length > 32_768)
        ) {
          throw Error(
            'Subagent system prompt must be a string of at most 32768 characters',
          );
        }
        const siblings = await listSubagents();
        if (siblings.some(session => session.subagentName === name)) {
          throw Error(`Subagent "${name}" already exists.`);
        }
        if (siblings.length >= MAX_SUBAGENTS_PER_SESSION) {
          throw Error(
            `Subagent limit of ${MAX_SUBAGENTS_PER_SESSION} reached; stop one first.`,
          );
        }
        const parent = (registry || []).find(
          session => session.id === parentId,
        );
        // A subagent runs on the same backend and model as its parent: it is
        // extra context, not a way to reach a backend this session was not
        // provisioned for.
        const inheritedModel = parent?.backendId
          ? {
              backendId: parent.backendId,
              modelId: parent.modelId,
              ...(parent.reasoningEffort
                ? { reasoningEffort: parent.reasoningEffort }
                : {}),
            }
          : parent?.model
            ? { model: parent.model }
            : {};
        const childId = await provisionSession({
          title: `${parent?.title || 'Session'} / ${name}`,
          presetId: parent?.presetId,
          ...inheritedModel,
          ...(childPrompt ? { systemPrompt: childPrompt } : {}),
          parentSessionId: parentId,
          subagentName: name,
          subagentDepth: depth,
        });
        const locator = await E(getHost()).locate(`session-${childId}`);
        return harden({ name, locator });
      },

      /** @param {string} name */
      async stop(name) {
        assertSubagentName(name);
        await null;
        const entry = (await listSubagents()).find(
          session => session.subagentName === name,
        );
        if (!entry) throw Error(`No subagent named "${name}".`);
        await releaseSession(entry.id);
      },

      async list() {
        await null;
        const names = (await listSubagents())
          .map(session => `${session.subagentName}`)
          .sort();
        return harden(names);
      },

      /** @param {string} [methodName]  */
      help(methodName) {
        if (methodName === 'spawn') {
          return 'spawn(name, { systemPrompt? }) — Create a subagent session beneath this one and return { name, locator }.';
        }
        if (methodName === 'stop') {
          return 'stop(name) — Delete a subagent session and every session beneath it.';
        }
        if (methodName === 'list') {
          return 'list() — Names of this session’s live subagents.';
        }
        return 'Subagent spawner: create, list, and release sessions recorded as subagents of one parent session.';
      },
    });
  };

  // Revive every session's inbox loop after a restart, without blocking make()
  // (the reincarnation-deadlock constraint forbids awaiting remote refs here).
  // Fire-and-forget: load the registry and build each agent, which starts its
  // inbox loop. New sessions start their loops in getAgent at creation time.
  const startAllInboxes = async () => {
    const reg = await loadRegistry();
    for (const s of reg) {
      if (s.lifecycle === 'deleting' || s.lifecycle === 'error') {
        finishSessionDeletion(s.id).catch(error => {
          console.error(
            `[floot-factory] cleanup recovery failed for session-${s.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      } else {
        const recoverCreating = async () => {
          if (s.lifecycle === 'creating') {
            // `creating` is an incomplete transaction. Remove every resource
            // derivable from its stable session ID before provisioning anew.
            await cleanupSessionResources(s);
          }
          return getAgent(s.id);
        };
        recoverCreating()
          .then(async () => {
            if (s.lifecycle === 'creating') {
              /** @type {number} */
              const index = reg.findIndex(entry => entry.id === s.id);
              if (index >= 0) {
                reg[index] = harden({ ...reg[index], lifecycle: 'ready' });
                await saveRegistry();
              }
            }
          })
          .catch(error => {
            console.warn(
              `[floot-factory] could not start inbox for session-${s.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
    }
  };
  startAllInboxes().catch(error => {
    console.error(
      '[floot-factory] inbox revival error:',
      error instanceof Error ? error.message : String(error),
    );
  });

  return makeExo('FlootFactory', FlootFactoryInterface, {
    /**
     * @param {string | Record<string, any>} [titleOrOptions]
     * @param {string} [presetId]
     * @param {string} [model]
     * @returns {Promise<object>} an opaque session facet
     */
    async createSession(titleOrOptions, presetId, model) {
      const options =
        titleOrOptions && typeof titleOrOptions === 'object'
          ? titleOrOptions
          : {
              title: titleOrOptions,
              presetId,
              model,
            };
      // The delegation fields are minted by the spawner, never accepted from a
      // caller: a session that claimed another's parentage would join that
      // parent's subagent list and become stoppable by it.
      const {
        parentSessionId: _parentSessionId,
        subagentName: _subagentName,
        subagentDepth: _subagentDepth,
        ...publicOptions
      } = options;
      return getFacet(await provisionSession(publicOptions));
    },

    /**
     * @returns {Promise<Array<{ id: string, title: string, createdAt: number, presetId: string, model: string, backendId: string, modelId: string, reasoningEffort: string, lifecycle: string, parentSessionId: string, subagentName: string }>>}
     */
    async listSessions() {
      await loadRegistry();
      return harden(
        (registry || []).map(
          ({
            id,
            title,
            createdAt,
            presetId,
            model,
            backendId,
            modelId,
            reasoningEffort,
            lifecycle,
            parentSessionId,
            subagentName,
          }) => ({
            id,
            title,
            createdAt,
            presetId: presetId || DEFAULT_PRESET_ID,
            model: backendId
              ? hostedModelId(backendId, modelId || '')
              : model || '',
            backendId: backendId || 'provider',
            modelId: modelId || model || '',
            reasoningEffort: reasoningEffort || '',
            lifecycle: lifecycle || 'ready',
            // Empty for a session the user opened; set for one an agent
            // spawned, so a client can group or hide the delegated tree.
            parentSessionId: parentSessionId || '',
            subagentName: subagentName || '',
          }),
        ),
      );
    },

    /**
     * @returns {Promise<Array<{ id: string, title: string, description: string }>>}
     */
    async listPresets() {
      return harden(
        PRESETS.map(({ id, title, description }) => ({
          id,
          title,
          description,
        })),
      );
    },

    async listBackends() {
      const hosted = await getHostedBackends();
      return harden([
        harden({
          id: 'provider',
          title: 'LLM API',
          kind: 'api',
          continuity: 'explicit',
          toolOwnership: 'endo',
        }),
        ...[...hosted.values()].map(({ descriptor }) => descriptor),
      ]);
    },

    /**
     * The selectable models for a new session. `default` marks the model an
     * unpinned session runs (the factory's configured model, or the conventional
     * fallback when that is unset or not in the catalog).
     *
     * @param {string} [backendId]
     * @returns {Promise<Array<{ id: string, selectionId: string, backendId: string, modelId: string, title: string, description: string, default: boolean, defaultReasoningEffort: string | null, reasoningEfforts: string[] }>>}
     */
    async listModels(backendId) {
      if (backendId && backendId !== 'provider') {
        const backend = (await getHostedBackends()).get(backendId);
        if (!backend) throw Error(`Unknown hosted backend "${backendId}"`);
        const models = await E(backend.factory).listModels();
        return harden(
          models.map(candidate => {
            const projected = normalizeHostedModelDescriptor(candidate);
            return harden({
              id: hostedModelId(backendId, projected.id),
              selectionId: hostedModelId(backendId, projected.id),
              backendId,
              modelId: projected.id,
              title: projected.title,
              description: projected.description,
              default: projected.default,
              defaultReasoningEffort: projected.defaultReasoningEffort,
              reasoningEfforts: projected.reasoningEfforts,
            });
          }),
        );
      }
      let defaultModel = '';
      try {
        const cfg = await getProviderConfig();
        defaultModel = (cfg && cfg.model) || '';
      } catch {
        // Provider config not resolvable yet — fall back to the conventional
        // default so the picker still has a sensible pre-selection.
      }
      if (!isKnownModel(defaultModel)) defaultModel = DEFAULT_MODEL_ID;
      const providerModels = MODELS.map(({ id, title, description }) => ({
        id,
        selectionId: id,
        backendId: 'provider',
        modelId: id,
        title,
        description,
        default: id === defaultModel,
        defaultReasoningEffort: null,
        reasoningEfforts: [],
      }));
      if (backendId === 'provider') return harden(providerModels);
      const hosted = await getHostedBackends();
      const hostedModels = [];
      for (const [id, backend] of hosted.entries()) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const models = await E(backend.factory).listModels();
          hostedModels.push(
            ...models.map(candidate => {
              const projected = normalizeHostedModelDescriptor(candidate);
              return harden({
                id: hostedModelId(id, projected.id),
                selectionId: hostedModelId(id, projected.id),
                backendId: id,
                modelId: projected.id,
                title: projected.title,
                description: projected.description,
                default: false,
                defaultReasoningEffort: projected.defaultReasoningEffort,
                reasoningEfforts: projected.reasoningEfforts,
              });
            }),
          );
        } catch (error) {
          console.error(
            `[floot-factory] model catalog unavailable for backend ${id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return harden([...providerModels, ...hostedModels]);
    },

    /**
     * @param {string} id
     * @returns {Promise<object>} the session facet
     */
    async getSession(id) {
      await assertSessionReady(id);
      return getFacet(id);
    },

    /**
     * @param {string} id
     * @param {string} title
     */
    async renameSession(id, title) {
      await loadRegistry();
      const reg = registry || [];
      const idx = reg.findIndex(s => s.id === id);
      if (idx === -1) throw new Error(`Unknown session "${id}".`);
      // Entries are hardened, so replace rather than mutate in place.
      reg[idx] = harden({ ...reg[idx], title });
      await saveRegistry();
    },

    /**
     * @param {string} id
     */
    async deleteSession(id) {
      await releaseSession(id);
    },

    /**
     * Drop the memoized provider config and the providers built from it.
     *
     * A rotation (`SecretAdmin.replaceBase64`) or a revocation needs no help:
     * a turn re-reads the secret and the provider cache is keyed on the bytes,
     * so it reaches every open session by itself. What this is for is a change
     * to the *config* — a different host, provider kind, or default model
     * bound at `llm-provider` — which is read once and would otherwise need a
     * daemon restart. Sessions on a hosted backend are unaffected either way:
     * their credentials belong to the backend, not to Floot.
     */
    async refreshCredentials() {
      providersByModel.clear();
      providerConfigP = undefined;
      console.error(
        '[floot-factory] Dropped the cached provider config; the next turn re-reads it.',
      );
    },

    /**
     * The subscription plan, rate limits, and price list behind this
     * deployment's credential, as capability-free data.
     *
     * Every section carries `observedAt` and a `source` of observed, declared,
     * remembered, or unavailable, so a caller can tell a measurement from an
     * assertion. Counts are bigints — a published quota is a natural number
     * whose range is the provider's to choose.
     *
     * @param {boolean} [refresh] - Re-read the provider before answering.
     */
    async getAccount(refresh) {
      const oracle = await getAccountOracle();
      if (!oracle) {
        return harden({
          available: false,
          reason: `No account oracle is bound to "${accountOracleName}". Provision one to report plan and rate limits.`,
        });
      }
      if (refresh) await E(oracle).refresh();
      const [plan, rateLimits, rateCard] = await Promise.all([
        E(oracle).getPlan(),
        E(oracle).getRateLimits(),
        E(oracle).getRateCard(),
      ]);
      return harden({ available: true, plan, rateLimits, rateCard });
    },

    /**
     * The oracle itself, for a caller that wants to hold it — a monitor, or an
     * agent that should be able to check its own quota. It is read-only and has
     * no path to the credential, which is why handing it out is safe where
     * handing out the factory would not be.
     */
    async getAccountOracle() {
      const oracle = await getAccountOracle();
      if (!oracle) {
        throw Error(
          `No account oracle is bound to "${accountOracleName}" in this factory.`,
        );
      }
      return oracle;
    },

    /**
     * @param {string} [methodName]
     * @returns {string}
     */
    help(methodName) {
      if (methodName === undefined) {
        return 'Floot factory: createSession({title,presetId,backendId,modelId,reasoningEffort} | title?, presetId?, model?) -> session facet; listSessions() includes backend/model/reasoning/lifecycle metadata; listBackends(); listModels(backendId?); listPresets(); getSession(id); renameSession(id,title); deleteSession(id); refreshCredentials(); getAccount(refresh?); getAccountOracle(). Session facets expose converse(), getHistory(), getUsage(), and getInfo().';
      }
      const docs = {
        createSession:
          'createSession(options | title?, presetId?, model?) — Create an isolated session. Options can select title, presetId, backendId, modelId, and reasoningEffort. Returns its opaque facet.',
        listBackends:
          'listBackends() — Return the live provider and hosted backend descriptors.',
        listSessions:
          'listSessions() — Return metadata [{id, title, createdAt, presetId, model, backendId, modelId, reasoningEffort, lifecycle}] for all sessions.',
        listPresets:
          'listPresets() — Return the available session presets [{id, title, description}].',
        listModels:
          'listModels(backendId?) — Return backend-scoped models with compound selection ids and supported reasoning efforts; no argument returns the flattened compatibility catalog.',
        getSession: 'getSession(id) — Return the session facet for an id.',
        renameSession: 'renameSession(id, title) — Rename a session.',
        deleteSession:
          'deleteSession(id) — Delete a session, its backing guest, and every subagent session beneath it.',
        refreshCredentials:
          'refreshCredentials() — Re-read the `llm-provider` config on the next turn. A rotated or revoked secret needs no call: a turn reads it afresh.',
        getAccount:
          'getAccount(refresh?) — { available, plan, rateLimits, rateCard }. Each section carries observedAt and a source of observed | declared | remembered | unavailable; counts are bigints, and null means the provider does not publish that figure.',
        getAccountOracle:
          'getAccountOracle() — The read-only HostedAccount capability itself, for a holder that should be able to check plan and quota without reaching the credential.',
      };
      return docs[methodName] || `No documentation for method "${methodName}".`;
    },
  });
};
harden(make);
