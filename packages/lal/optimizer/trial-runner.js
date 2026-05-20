// @ts-check
/* global setTimeout, clearTimeout, process */
/* eslint-disable no-await-in-loop */
/**
 * In-process trial runner for the lal prompt optimizer.
 *
 * LAL ADAPTATION (vs. fae's daemon-trial.js + daemon-runner.js): lal's
 * agent is exercised directly with `makeMockPowers` (in-memory
 * GuestPowers) and a real LLM provider via `pi-agent-core`. Nothing
 * forks a daemon; nothing reads a `worker.log`. The trace is captured
 * via lal's `Hooks` API.
 *
 * Inputs the trial runner accepts:
 *   - `example.prompt`     -- string or string[] (multi-prompt rounds)
 *   - `example.attachments[].edgeName` -- pre-existing edge seeded into
 *     the mock directory before the agent loop runs. Two attachment
 *     shapes are recognized:
 *       { edgeName, kind: 'directory', files: { [fileName]: text } }
 *       { edgeName, kind: 'tree',      files: { [fileName]: text } }
 *     These install an in-memory readable+writable tree-shaped object
 *     under the given pet name. `kind` defaults to 'directory' when
 *     `files` is present, and is otherwise stored as the literal
 *     `edgeName` placeholder string (the mock-powers default).
 *   - `example.notification` -- optional inbound message body to deliver
 *     in place of the default greeting.
 *
 * The runner is bounded by `LAL_TRIAL_TIMEOUT_MS` (default 60_000) so a
 * hung LLM does not block the optimizer.
 */

import '@endo/agentry/optimizer/init';

import { spawnWorkerLoop } from '../agent.js';
import { makeMockPowers } from '../tools/mock-powers.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Race a promise against a timeout. Resolves to `{ timedOut: true }`
 * (and stops the racer) when the timer wins.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<{ timedOut: false, value: T } | { timedOut: true }>}
 */
const withTimeout = async (promise, ms) => {
  let timer;
  const timed = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    const result = await Promise.race([
      promise.then(value => ({ timedOut: false, value })),
      timed,
    ]);
    return /** @type {any} */ (result);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Build a thin in-memory tree capability shaped like a ReadableTree +
 * WritableTree composite. Sufficient for the basic `readText` /
 * `writeText` paths the lal tool surface exercises.
 *
 * @param {Record<string, string>} initialFiles
 */
const makeMemoryTree = initialFiles => {
  const files = new Map(Object.entries(initialFiles));
  return harden({
    async readText(fileName) {
      const value = files.get(String(fileName));
      if (value === undefined) {
        throw new Error(`no such file: ${fileName}`);
      }
      return value;
    },
    async writeText(fileName, content) {
      files.set(String(fileName), String(content));
    },
    async list() {
      return [...files.keys()].sort();
    },
    async has(fileName) {
      return files.has(String(fileName));
    },
    async help() {
      return 'In-memory tree (test fixture).';
    },
  });
};

/**
 * Seed the example's pre-existing edges into the mock directory before
 * the agent loop starts. The mock directory just stores opaque values
 * keyed by pet name, so we install the capability under its
 * `edgeName`. The example's `acceptableTraces` then expect tool calls
 * like `readText(["primer"], "smallcaps.md")` to find the right value.
 *
 * @param {ReturnType<typeof makeMockPowers>} mock
 * @param {Array<{
 *   edgeName: string,
 *   kind?: string,
 *   files?: Record<string, string>,
 *   value?: unknown,
 * }>} attachments
 */
const seedAttachments = async (mock, attachments) => {
  for (const attachment of attachments) {
    if (attachment.value !== undefined) {
      await mock.powers.storeValue(attachment.value, attachment.edgeName);
    } else if (attachment.files) {
      const tree = makeMemoryTree(attachment.files);
      await mock.powers.storeValue(tree, attachment.edgeName);
    }
    // else: leave the edge un-seeded; the agent will get "Unknown" on
    // any lookup, which is the right shape for "missing" negative
    // examples.
  }
};

/**
 * @typedef {import('@endo/agentry/optimizer/trace-metric').TraceEvent} TraceEvent
 *
 * @typedef {{
 *   id: string,
 *   prompt: string | string[],
 *   attachments?: Array<{
 *     edgeName: string,
 *     kind?: string,
 *     files?: Record<string, string>,
 *     value?: unknown,
 *   }>,
 *   notification?: string,
 * }} TrialExample
 */

/**
 * Try to render the args record as a stable JSON string. Best-effort:
 * non-JSON-serializable args (BigInt, promises, etc.) fall back to
 * `String(args)`.
 *
 * @param {unknown} args
 * @returns {string}
 */
const stableRawArgs = args => {
  if (args === undefined || args === null) return '';
  try {
    return JSON.stringify(args, (_key, value) =>
      typeof value === 'bigint' ? `+${value.toString()}` : value,
    );
  } catch {
    try {
      return String(args);
    } catch {
      return '';
    }
  }
};

/**
 * Build a `Hooks` implementation that records the LLM's per-event
 * stream into a `TraceEvent[]`. The trace shape is documented at the
 * top of `@endo/agentry/optimizer/trace-metric`.
 *
 * The pi-agent-core event union widens slightly between versions; we
 * read only the fields lal's `round-runner.js` exposes today, so this
 * implementation does not regress when pi-agent-core adds new event
 * variants.
 *
 * @returns {{ hooks: import('../hooks/index.js').Hooks, trace: TraceEvent[] }}
 */
const makeTraceHooks = () => {
  /** @type {TraceEvent[]} */
  const trace = [];

  /**
   * pi-agent-core emits ToolCallStart + ToolCallEnd in pairs. We attach
   * the result/error from the matching End to the start record so the
   * scorer sees one `tool-call` event per call (ok/error included).
   *
   * @type {Array<{ index: number, name: string }>}
   */
  const pendingCalls = [];

  const hooks = harden({
    onEvent: _evt => {},
    /**
     * @param {{ toolName: string, args?: unknown }} event
     */
    onToolCallStart: event => {
      const rawArgs = stableRawArgs(event.args);
      /** @type {TraceEvent} */
      const record = {
        kind: 'tool-call',
        name: event.toolName,
        args: /** @type {Record<string, unknown> | undefined} */ (
          event.args && typeof event.args === 'object'
            ? /** @type {any} */ (event.args)
            : undefined
        ),
        rawArgs,
        ok: true,
      };
      pendingCalls.push({ index: trace.length, name: event.toolName });
      trace.push(record);
    },
    /**
     * @param {{ toolName: string, result?: unknown, error?: { message: string } }} event
     */
    onToolCallEnd: event => {
      const pendingIndex = pendingCalls
        .map((c, i) => ({ c, i }))
        .reverse()
        .find(({ c }) => c.name === event.toolName);
      if (!pendingIndex) {
        return;
      }
      pendingCalls.splice(pendingIndex.i, 1);
      const slot = trace[pendingIndex.c.index];
      if (slot.kind !== 'tool-call') return;
      const error = event.error;
      const updated = /** @type {TraceEvent} */ ({
        ...slot,
        ok: !error,
        result: error ? undefined : event.result,
        error: error ? error.message : undefined,
      });
      trace[pendingIndex.c.index] = updated;
    },
    /**
     * @param {{ role: string, content?: string }} event
     */
    onMessage: event => {
      trace.push({
        kind: 'message',
        role: event.role,
        content: event.content,
      });
    },
  });
  return { hooks, trace };
};

/**
 * Run one trial. Spins up `makeMockPowers`, seeds attachments, drives
 * the lal worker loop with the example's notification, and waits for
 * the agent to dismiss the initial message (or the timeout fires).
 *
 * @param {{
 *   example: TrialExample,
 *   systemPrompt?: string,
 *   model?: string,
 *   env?: Record<string, string | undefined>,
 *   timeoutMs?: number,
 * }} input
 * @returns {Promise<{
 *   trace: TraceEvent[],
 *   replyText: string,
 *   workerLog?: string,
 *   timedOut: boolean,
 *   sent: Array<{ recipient: string, strings: string[] }>,
 * }>}
 */
export const runTrial = async ({
  example,
  // The `systemPrompt` field is the variable Ax mutates and lal will
  // eventually honor here; lal's `spawnWorkerLoop` does not yet
  // parameterize the system prompt at the call site (it imports
  // `systemPrompt` from `prompts/system.js` directly). When that seam
  // lands, pass it through to `spawnWorkerLoop`; until then the
  // optimizer just records a baseline against the current prompt.
  // eslint-disable-next-line no-unused-vars
  systemPrompt = '',
  model,
  env = /** @type {any} */ (process?.env || {}),
  timeoutMs,
}) => {
  const effectiveTimeout =
    timeoutMs ??
    (Number(env.LAL_TRIAL_TIMEOUT_MS) > 0
      ? Number(env.LAL_TRIAL_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS);

  const prompts = Array.isArray(example.prompt)
    ? example.prompt
    : [example.prompt];
  const initialMessage = {
    number: 1,
    from: '@host',
    to: 'lal-self-id',
    type: 'package',
    strings: [example.notification || prompts[0] || ''],
    names: [],
    ids: [],
    messageId: 'mock-msg-trial',
  };

  const mock = makeMockPowers({ initialMessage });
  await seedAttachments(mock, example.attachments || []);

  const workerEnv = {
    LAL_HOST: env.LAL_HOST,
    LAL_MODEL: model || env.LAL_MODEL,
    LAL_AUTH_TOKEN: env.LAL_AUTH_TOKEN,
  };

  const { hooks, trace } = makeTraceHooks();

  // Spawn the worker loop; let any error propagate into the trial
  // result rather than throwing through the runner.
  const workerPromise = spawnWorkerLoop(
    mock.powers,
    null,
    /** @type {any} */ (workerEnv),
    hooks,
  ).catch(error => {
    trace.push({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });

  // Wait for the agent to dismiss the inbound message, bounded by
  // the configured timeout. Then drain the worker loop best-effort.
  const result = await withTimeout(mock.whenDismissed(1), effectiveTimeout);

  // Best-effort drain: give the worker a brief grace period to finish
  // any pending tool calls before we return.
  await Promise.race([workerPromise, sleep(50)]);

  const sent = mock.sent.map(s => ({
    recipient: s.recipient,
    strings: s.strings,
  }));
  const replyText =
    [...sent]
      .reverse()
      .find(s => s.strings.length > 0)
      ?.strings.join('') || '';

  return harden({
    trace: /** @type {TraceEvent[]} */ (harden([...trace])),
    replyText,
    timedOut: result.timedOut === true,
    sent,
  });
};
harden(runTrial);
