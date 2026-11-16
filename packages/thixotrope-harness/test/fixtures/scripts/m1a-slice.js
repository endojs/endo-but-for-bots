// @ts-check
/**
 * Scripted-provider scripts for the M1a slice tests and perf checks
 * (`designs/m1a-interfaces.md` section 10; `shapes.Script`). A script turn
 * is chosen by the turn's input text; the turn without `input` answers
 * everything else.
 *
 * Each export is plain data; callers `harden` it before `makeBackend`.
 */

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string} [callId]
 */
const echo = (name, args, callId) => ({
  name,
  args: JSON.stringify(args),
  ...(callId === undefined ? {} : { callId }),
});

/** A closing round of text, after a tool round. */
const closing = { chunks: [{ text: 'done' }], usage };

/** Inputs the slice script knows. */
export const inputs = Object.freeze({
  hi: 'hi',
  echoOne: 'echo one',
  echoTwo: 'echo two',
  echoOrder: 'echo order',
  slow: 'slow',
  stall: 'stall',
  undispatched: 'undispatched',
  echoHang: 'echo hang',
  bigReply: 'big reply',
  bigEcho: 'big echo',
  keys: 'keys',
});

/** Delay of each echo call in the parallel-round test (acceptance 3). */
export const ECHO_DELAY_MS = 1000;

/** The slice's one script: every scenario of acceptance 1-10. */
export const sliceScript = {
  turns: [
    {
      input: inputs.hi,
      rounds: [
        {
          chunks: [{ text: 'Hel' }, { text: 'lo' }, { text: '!' }],
          chunkDelayMs: 20,
          usage,
        },
      ],
    },
    {
      input: inputs.echoOne,
      rounds: [
        {
          chunks: [{ text: 'one call' }],
          toolCalls: [echo('echo', { text: 'a', delayMs: ECHO_DELAY_MS })],
          usage,
        },
        closing,
      ],
    },
    {
      input: inputs.echoTwo,
      rounds: [
        {
          chunks: [{ text: 'two calls' }],
          toolCalls: [
            echo('echo', { text: 'a', delayMs: ECHO_DELAY_MS }),
            echo('echo', { text: 'b', delayMs: ECHO_DELAY_MS }),
          ],
          usage,
        },
        closing,
      ],
    },
    {
      // The second call finishes first: results are recorded in completion
      // order and presented in call order.
      input: inputs.echoOrder,
      rounds: [
        {
          chunks: [{ text: 'order' }],
          toolCalls: [
            echo('echo', { text: 'first', delayMs: 900 }, 'call-first'),
            echo('echo', { text: 'second', delayMs: 100 }, 'call-second'),
          ],
          usage,
        },
        closing,
      ],
    },
    {
      input: inputs.slow,
      rounds: [
        {
          chunks: [{ text: 'slow', delayMs: 1500 }, { text: ' reply' }],
          usage,
        },
      ],
    },
    {
      input: inputs.stall,
      rounds: [{ chunks: [{ text: 'stalling' }], stall: 'untilCancel' }],
    },
    {
      // The adapter waits ten minutes before dispatching(0).
      input: inputs.undispatched,
      rounds: [{ dispatchDelayMs: 600_000, chunks: [{ text: 'never' }] }],
    },
    {
      input: inputs.echoHang,
      rounds: [
        {
          chunks: [{ text: 'calling' }],
          toolCalls: [echo('echo', { text: 'slow', delayMs: 600_000 })],
          usage,
        },
        closing,
      ],
    },
    {
      // 64 KiB of reply text: over frameBytes.
      input: inputs.bigReply,
      rounds: [{ chunks: [{ text: 'x', repeat: 65_536 }], usage }],
    },
    {
      // A 64 KiB echo result: cut to toolOutputUnits, still over frameBytes.
      input: inputs.bigEcho,
      rounds: [
        {
          chunks: [{ text: 'big' }],
          toolCalls: [echo('echo', { text: 'y', bytes: 65_536 })],
          usage,
        },
        closing,
      ],
    },
    {
      // 2,000 distinct keys in the arguments' JSON text (about 19 KB).
      input: inputs.keys,
      rounds: [
        {
          chunks: [{ text: 'keys' }],
          toolCalls: [{ name: 'echo', argsKeys: 2000 }],
          usage,
        },
        closing,
      ],
    },
    {
      rounds: [
        {
          chunks: [{ text: 'o' }, { text: 'k' }, { text: '.' }],
          chunkDelayMs: 5,
          usage,
        },
      ],
    },
  ],
};

/** Inputs the perf script adds. */
export const perfInputs = Object.freeze({
  start: 'perf start',
  startProbe: 'perf start probe',
  stream: 'perf stream',
  plain: 'perf plain',
  tools: 'perf tools',
  bigReply: 'perf big reply',
  echo300k: 'perf echo 300k',
  keys: 'perf keys',
});

/** Chunks per `perf stream` turn and the delay before each. */
export const STREAM_CHUNKS = 50;
export const STREAM_DELAY_MS = 40;

/** The perf checks' script (turn, restart, session): the slice's turns too. */
export const perfScript = {
  turns: [
    {
      input: perfInputs.start,
      rounds: [{ chunks: [{ text: 'ok' }], usage }],
    },
    {
      // The first chunk waits, so the session's journal can be read while
      // nothing but the start has reached it.
      input: perfInputs.startProbe,
      rounds: [{ chunks: [{ text: 'ok', delayMs: 1500 }], usage }],
    },
    {
      input: perfInputs.stream,
      rounds: [
        {
          chunks: Array.from({ length: STREAM_CHUNKS }, (_, i) => ({
            text: `t${i} `,
          })),
          chunkDelayMs: STREAM_DELAY_MS,
          usage,
        },
      ],
    },
    {
      input: perfInputs.plain,
      rounds: [
        { chunks: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], usage },
      ],
    },
    {
      input: perfInputs.tools,
      rounds: [
        {
          chunks: [{ text: 'tools' }],
          toolCalls: [
            echo('echo', { text: 'a' }),
            echo('echo', { text: 'b' }),
          ],
          usage,
        },
        closing,
      ],
    },
    {
      input: perfInputs.bigReply,
      rounds: [{ chunks: [{ text: 'x', repeat: 65_536 }], usage }],
    },
    {
      // 300,000 characters: cut in the callee to toolOutputUnits, still
      // over frameBytes.
      input: perfInputs.echo300k,
      rounds: [
        {
          chunks: [{ text: 'big' }],
          toolCalls: [echo('echo', { text: 'z', bytes: 300_000 })],
          usage,
        },
        closing,
      ],
    },
    {
      input: perfInputs.keys,
      rounds: [
        {
          chunks: [{ text: 'keys' }],
          toolCalls: [{ name: 'echo', argsKeys: 2000 }],
          usage,
        },
        closing,
      ],
    },
    ...sliceScript.turns,
  ],
};
