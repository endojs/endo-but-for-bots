// @ts-check
//
// Per-thread agent engine. The cockpit wraps a code-mode runtime — design
// option (a) in designs/garden-cockpit.md § "Per-thread engine". An engine is
// constructed per thread; it streams events through `emit` and resolves a turn
// when the agent goes idle.
//
// Two engines ship:
//   - makeMockEngine: deterministic, LLM-free. Powers the M0 tracer, the test
//     suite, and the offline revoke-a-cap demo.
//   - makeAgentryEngine: lazily wraps @endo/agentry's real code-mode runtime.
//     Only loaded when a provider is configured; absent that, the cockpit runs
//     entirely on the mock engine.

import { READ_WRITE } from './caps.js';

/**
 * @typedef {object} ThreadEvent
 * @property {string} kind  'turn-start'|'token'|'tool-call'|'tool-result'|'error'|'turn-end'|'spawn'
 * @property {unknown} [token]
 * @property {unknown} [data]
 * @property {string} [message]
 *
 * @typedef {object} EngineContext
 * @property {() => Record<string, unknown>} getScope  live lexical scope (caps drop out when revoked)
 * @property {(event: ThreadEvent) => void} emit
 * @property {(spec: { templateName?: string, caps: unknown[], prompt: string }) => Promise<unknown>} [delegate]
 *
 * @typedef {object} Engine
 * @property {(text: string) => Promise<{ status: string, result?: unknown, error?: string, tokens: number }>} prompt
 * @property {string} kind
 */

const tokenize = s => `${s}`.split(/(\s+)/).filter(Boolean);

/**
 * @param {Record<string, unknown>} scope
 * @param {string} name
 */
const requireCap = (scope, name) => {
  const cap = scope[name];
  if (cap === undefined || cap === null) {
    throw new Error(`no ${name} capability in scope`);
  }
  return cap;
};

/**
 * @param {unknown} obj
 * @param {string} method
 * @param {string} capName
 */
const requireMethod = (obj, method, capName) => {
  const fn = /** @type {Record<string, unknown>} */ (obj)[method];
  if (typeof fn !== 'function') {
    throw new Error(`${capName} capability has no ${method} (attenuated away)`);
  }
  return fn;
};

/**
 * Deterministic engine. It reads the live scope on every turn, so a cap
 * revoked between turns is simply gone the next time the agent reaches for it —
 * the thesis made testable.
 *
 * @param {EngineContext} ctx
 * @returns {Engine}
 */
export const makeMockEngine = ctx => {
  const { getScope, emit, delegate } = ctx;

  /** @type {Engine['prompt']} */
  const prompt = async text => {
    emit({ kind: 'turn-start', data: text });
    const scope = getScope();
    let tokens = 0;
    for (const tok of tokenize(`Working on: ${text}`)) {
      tokens += 1;
      emit({ kind: 'token', token: tok });
    }
    const lc = `${text}`.toLowerCase();
    await null;
    try {
      let result;
      if (lc.includes('branch')) {
        const git = requireCap(scope, 'git');
        emit({ kind: 'tool-call', data: 'E(git).currentBranch()' });
        result = `current branch: ${await requireMethod(git, 'currentBranch', 'git')()}`;
      } else if (lc.includes('status')) {
        const git = requireCap(scope, 'git');
        emit({ kind: 'tool-call', data: 'E(git).status()' });
        result = await requireMethod(git, 'status', 'git')();
      } else if (lc.includes('push')) {
        const git = requireCap(scope, 'git');
        emit({ kind: 'tool-call', data: 'E(git).push()' });
        result = await requireMethod(git, 'push', 'git')();
      } else if (lc.includes('write') || lc.includes('edit')) {
        const ws = requireCap(scope, 'workspace');
        emit({ kind: 'tool-call', data: 'E(workspace).write()' });
        result = await requireMethod(ws, 'write', 'workspace')();
      } else if (
        (lc.includes('spawn') || lc.includes('delegate')) &&
        delegate
      ) {
        emit({ kind: 'tool-call', data: 'delegateCodeMode(...)' });
        result = await delegate({ caps: [], prompt: text });
        emit({ kind: 'spawn', data: result });
      } else {
        result = `(mock) acknowledged: ${text}`;
      }
      tokens += tokenize(
        `${typeof result === 'string' ? result : JSON.stringify(result)}`,
      ).length;
      emit({ kind: 'tool-result', data: result });
      emit({ kind: 'turn-end', data: 'ok' });
      return { status: 'ok', result, tokens };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ kind: 'error', message });
      emit({ kind: 'turn-end', data: 'error' });
      return { status: 'error', error: message, tokens };
    }
  };

  return harden({ kind: 'mock', prompt });
};
harden(makeMockEngine);

/**
 * A mock git capability whose read-only flavour literally lacks the mutating
 * methods — faithful to exo-git's read-only attenuation, so "push" on a
 * read-only cap fails because the method is absent, not because a flag says so.
 *
 * @param {{ branch?: string, mode?: string }} [options]
 */
export const makeMockGit = ({ branch = 'main', mode = READ_WRITE } = {}) => {
  const readOnly = {
    currentBranch: async () => branch,
    status: async () => [{ path: 'README.md', worktree: 'clean' }],
    log: async () => [{ oid: 'deadbeef', summary: 'initial commit' }],
  };
  if (mode !== READ_WRITE) return harden(readOnly);
  return harden({
    ...readOnly,
    add: async () => undefined,
    commit: async message => ({
      oid: 'cafef00d',
      summary: message || 'commit',
    }),
    push: async () => ({ pushed: true, branch }),
  });
};
harden(makeMockGit);

/**
 * A mock workspace (filesystem) capability.
 *
 * @param {{ mode?: string }} [options]
 */
export const makeMockWorkspace = ({ mode = READ_WRITE } = {}) => {
  const readOnly = {
    read: async () => 'file contents',
    list: async () => ['README.md'],
  };
  if (mode !== READ_WRITE) return harden(readOnly);
  return harden({ ...readOnly, write: async () => ({ written: true }) });
};
harden(makeMockWorkspace);

/**
 * @typedef {object} AgentryProfile
 * @property {string} provider
 * @property {string} apiKey
 * @property {string} [baseUrl]
 *
 * @typedef {object} AgentryPowerSpec
 * @property {string} [workspacePetName]
 * @property {string} [gitPetName]
 * @property {'readOnly' | 'readWrite'} [gitMode]
 *
 * @typedef {object} AgentryConfigMapping
 * @property {{ provider: string, model: string, baseUrl?: string }} configModel
 * @property {{ workspacePetName?: string, gitPetName?: string, gitMode?: string }} configPowers
 * @property {() => string} getApiKey
 */

/**
 * Pure mapping from a provider profile + model name + power pet names to the
 * pieces an agentry code-mode runtime needs: a `config.model` record
 * ({ provider, model, baseUrl }), a `config.powers` record (pet names + git
 * mode), and a `getApiKey` callback. The apiKey is deliberately kept OUT of the
 * returned `configModel` record — `code-mode-runtime`'s `getApiKey` callback is
 * the highest-precedence key source, so the secret flows through the callback,
 * never through the config that ends up in prompts or tool schemas.
 *
 * @param {object} args
 * @param {AgentryProfile} args.profile
 * @param {string} args.model            model name (e.g. 'gpt-4o', 'qwen3')
 * @param {AgentryPowerSpec} [args.powers]
 * @returns {AgentryConfigMapping}
 */
export const mapProfileToAgentryConfig = ({ profile, model, powers = {} }) => {
  if (!profile || typeof profile.provider !== 'string') {
    throw new Error('agentry config requires a profile with a provider');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('agentry config requires a model name');
  }
  const { provider, apiKey, baseUrl } = profile;
  const configModel = harden({
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
  });
  const configPowers = harden({
    workspacePetName: powers.workspacePetName || 'workspace',
    gitPetName: powers.gitPetName || 'git',
    gitMode: powers.gitMode || 'readWrite',
  });
  return harden({
    configModel,
    configPowers,
    getApiKey: () => apiKey,
  });
};
harden(mapProfileToAgentryConfig);

/**
 * Best-effort: turn the agent's accumulated transcript messages into cockpit
 * thread events. The code-mode runtime is non-streaming at this layer, so we
 * diff `state.messages` after the turn settles and emit a token / tool-call /
 * tool-result event per new message. This is "non-streaming but real" — the v1
 * acceptable mode; a future revision can wire pi's stream hook for true deltas.
 *
 * @param {ReadonlyArray<unknown>} messages
 * @param {number} fromIndex
 * @param {(event: ThreadEvent) => void} emit
 * @returns {number} a token count derived from message usage
 */
const emitTranscriptDelta = (messages, fromIndex, emit) => {
  let tokens = 0;
  for (let i = fromIndex; i < messages.length; i += 1) {
    const msg = /** @type {Record<string, unknown>} */ (messages[i]);
    const role = msg.role;
    const usage = /** @type {{ totalTokens?: number }} */ (msg.usage);
    if (usage && typeof usage.totalTokens === 'number') {
      tokens += usage.totalTokens;
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const part of content) {
      const p = /** @type {Record<string, unknown>} */ (part);
      if (p.type === 'text' && typeof p.text === 'string') {
        emit({ kind: 'token', token: p.text });
      } else if (p.type === 'toolCall') {
        emit({
          kind: 'tool-call',
          data: `${p.name}(${JSON.stringify(p.arguments)})`,
        });
      } else if (p.type === 'toolResult') {
        emit({ kind: 'tool-result', data: p.result ?? p.content });
      }
    }
    if (role === 'tool') {
      emit({ kind: 'tool-result', data: msg.content });
    }
  }
  return tokens;
};

/**
 * Lazily build `@endo/agentry`'s real code-mode runtime — the powerful,
 * async first half of constructing the cockpit's real engine. Imported only
 * when a daemon is online and an agentry thread is built; throws a clear error
 * if the monorepo dependency is missing.
 *
 * The runtime is built with `defineCodeModeAgent({ config }).make({ powers,
 * getApiKey })`. `getApiKey` (the profile's apiKey) is the highest-precedence
 * key source, so the secret never enters the config.
 *
 * @param {object} args
 * @param {object} args.config   normalized `{ model, powers }` runtime config
 * @param {unknown} args.powers  live daemon host powers (pet-name lookup root)
 * @param {(provider: string) => string | Promise<string | undefined> | undefined} [args.getApiKey]
 * @returns {Promise<import('@endo/agentry/code-mode-runtime').CodeModeRuntime>}
 */
export const prepareAgentryRuntime = async ({ config, powers, getApiKey }) => {
  let agentry;
  await null;
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    agentry = await import('@endo/agentry/code-mode-runtime');
  } catch (err) {
    throw new Error(
      '@endo/agentry is not available; install the monorepo and configure a ' +
        `provider, or use the mock engine. (${err instanceof Error ? err.message : err})`,
    );
  }
  return agentry.defineCodeModeAgent({ config }).make({ powers, getApiKey });
};
harden(prepareAgentryRuntime);

/**
 * Wrap an already-built code-mode runtime as a cockpit Engine — the synchronous
 * second half. Wiring is intentionally thin: the runtime owns the loop, the
 * cockpit owns the thread/stream/concurrency (design option (a)).
 *
 * LIVE-REVOKE LIMITATION: the workspace/git capabilities are resolved by pet
 * name and bound into the agent's Compartment at the runtime's make() time.
 * Revoking a cap from a *running* agentry thread therefore cannot retract it
 * mid-turn — the Compartment already closed over the live object. Selection-time
 * enforcement still holds (the runtime only resolves the caps the thread was
 * created with), so live-revoke takes effect at (re-)creation, not mid-run. The
 * mock engine, which re-reads `getScope()` every turn, does honor mid-run
 * revoke; that difference is intrinsic to a real Compartment-bound runtime.
 *
 * @param {import('@endo/agentry/code-mode-runtime').CodeModeRuntime} runtime
 * @param {EngineContext} ctx
 * @returns {Engine}
 */
export const makeAgentryEngineFromRuntime = (runtime, ctx) => {
  const { emit } = ctx;
  /** @type {Engine['prompt']} */
  const prompt = async text => {
    emit({ kind: 'turn-start', data: text });
    const before = runtime.agent.state?.messages?.length ?? 0;
    await null;
    try {
      await runtime.agent.prompt(text);
      await runtime.agent.waitForIdle();
      const messages = runtime.agent.state?.messages ?? [];
      const tokens = emitTranscriptDelta(messages, before, emit);
      emit({ kind: 'turn-end', data: 'ok' });
      return { status: 'ok', result: 'see transcript', tokens };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ kind: 'error', message });
      emit({ kind: 'turn-end', data: 'error' });
      return { status: 'error', error: message, tokens: 0 };
    }
  };
  return harden({ kind: 'agentry', prompt });
};
harden(makeAgentryEngineFromRuntime);

/**
 * Lazily wrap `@endo/agentry`'s real code-mode runtime in one async call —
 * convenience over `prepareAgentryRuntime` + `makeAgentryEngineFromRuntime` for
 * callers that already hold the emit/ctx (e.g. a future synchronous-async
 * thread factory). The registry prefers the two-stage form so thread
 * construction stays synchronous on the mock path.
 *
 * @param {EngineContext & {
 *   config?: object,
 *   powers?: unknown,
 *   getApiKey?: (provider: string) => string | Promise<string | undefined> | undefined,
 * }} ctx
 * @returns {Promise<Engine>}
 */
export const makeAgentryEngine = async ctx => {
  const runtime = await prepareAgentryRuntime({
    config: /** @type {object} */ (ctx.config),
    powers: ctx.powers,
    getApiKey: ctx.getApiKey,
  });
  return makeAgentryEngineFromRuntime(runtime, ctx);
};
harden(makeAgentryEngine);
