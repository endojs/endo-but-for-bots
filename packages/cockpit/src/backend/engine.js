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

/** @param {Record<string, unknown>} scope @param {string} name */
const requireCap = (scope, name) => {
  const cap = scope[name];
  if (cap === undefined || cap === null) {
    throw new Error(`no ${name} capability in scope`);
  }
  return cap;
};

/** @param {unknown} obj @param {string} method @param {string} capName */
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
      } else if ((lc.includes('spawn') || lc.includes('delegate')) && delegate) {
        emit({ kind: 'tool-call', data: 'delegateCodeMode(...)' });
        result = await delegate({ caps: [], prompt: text });
        emit({ kind: 'spawn', data: result });
      } else {
        result = `(mock) acknowledged: ${text}`;
      }
      tokens += tokenize(`${typeof result === 'string' ? result : JSON.stringify(result)}`).length;
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

  return { kind: 'mock', prompt };
};

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
  if (mode !== READ_WRITE) return Object.freeze(readOnly);
  return Object.freeze({
    ...readOnly,
    add: async () => undefined,
    commit: async message => ({ oid: 'cafef00d', summary: message || 'commit' }),
    push: async () => ({ pushed: true, branch }),
  });
};

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
  if (mode !== READ_WRITE) return Object.freeze(readOnly);
  return Object.freeze({ ...readOnly, write: async () => ({ written: true }) });
};

/**
 * Lazily wrap @endo/agentry's real code-mode runtime. Imported only when a
 * provider is configured; throws a clear error if the monorepo dependency is
 * not installed. Wiring is intentionally thin — the runtime owns the loop, the
 * cockpit owns the thread/stream/concurrency (design option (a)).
 *
 * @param {EngineContext & { config?: object, powers?: unknown }} ctx
 * @returns {Promise<Engine>}
 */
export const makeAgentryEngine = async ctx => {
  let agentry;
  try {
    // eslint-disable-next-line
    agentry = await import('@endo/agentry/code-mode-runtime');
  } catch (err) {
    throw new Error(
      '@endo/agentry is not available; install the monorepo and configure a ' +
        `provider, or use the mock engine. (${err instanceof Error ? err.message : err})`,
    );
  }
  const { emit } = ctx;
  const runtime = agentry.makeCodeModeRuntime({
    config: ctx.config,
    powers: ctx.powers,
  });
  /** @type {Engine['prompt']} */
  const prompt = async text => {
    emit({ kind: 'turn-start', data: text });
    await runtime.agent.prompt(text);
    await runtime.agent.waitForIdle();
    emit({ kind: 'turn-end', data: 'ok' });
    const tokens = runtime.agent.state?.messages?.length ?? 0;
    return { status: 'ok', result: 'see transcript', tokens };
  };
  return { kind: 'agentry', prompt };
};
