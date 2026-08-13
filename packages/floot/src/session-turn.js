// @ts-check
// Daemon-owned Floot turn: drain the reply channel locally, expose a disposable
// view stream, and cancel only on explicit `cancel()` — not on CapTP disconnect.

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

import { makeReplyChannel } from './stream.js';

/** @import { BufferedReaderKit, PassableReader } from '@endo/exo-stream' */

/**
 * @typedef {{
 *   role: 'assistant' | 'tool',
 *   text?: string,
 *   id?: string,
 *   name?: string,
 *   args?: string,
 *   result?: string | null,
 * }} TurnMessage
 */

/**
 * @typedef {{
 *   phase: string,
 *   streamingText: string,
 *   messages: TurnMessage[],
 *   done: boolean,
 *   error: string | null,
 *   usage: { inputTokens: number, outputTokens: number, turns: number } | null,
 * }} TurnStatus
 */

const FlootTurnInterface = M.interface('FlootTurn', {
  getStatus: M.callWhen().returns(M.any()),
  watch: M.call().returns(M.remotable()),
  cancel: M.callWhen().returns(M.undefined()),
  whenFinished: M.callWhen().returns(M.undefined()),
});

/**
 * @param {PassableReader} reader
 * @param {TurnStatus} status
 * @param {(event: object) => void} [tee]
 */
const drainReplyReader = async (reader, status, tee = () => {}) => {
  const replies = iterateReader(reader, { buffer: 8 });
  /** @type {Map<string, TurnMessage>} */
  const pendingTools = new Map();

  for await (const raw of replies) {
    const value = /** @type {any} */ (raw);
    tee(value);
    if (value.type === 'delta') {
      status.streamingText += value.text;
    } else if (value.type === 'final') {
      status.streamingText = value.text;
    } else if (value.type === 'tool_call') {
      if (status.streamingText.trim()) {
        status.messages.push({
          role: 'assistant',
          text: status.streamingText.trim(),
        });
      }
      status.streamingText = '';
      const toolMsg = {
        role: /** @type {const} */ ('tool'),
        id: value.id,
        name: value.name,
        args: value.args,
        result: /** @type {string | null} */ (null),
      };
      pendingTools.set(value.id, toolMsg);
      status.messages.push(toolMsg);
    } else if (value.type === 'tool_result') {
      const toolMsg = pendingTools.get(value.id);
      if (toolMsg) {
        toolMsg.result = value.result;
        pendingTools.delete(value.id);
      }
    } else if (value.type === 'phase') {
      status.phase = value.phase;
    } else if (value.type === 'usage') {
      status.usage = {
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        turns: value.turns,
      };
    } else if (value.type === 'end') {
      break;
    } else if (value.type === 'abort') {
      status.error = value.reason;
      break;
    }
  }
  if (status.streamingText.trim()) {
    status.messages.push({
      role: 'assistant',
      text: status.streamingText.trim(),
    });
    status.streamingText = '';
  }
};

/**
 * Start a turn on the daemon. The agent runs against a local reply channel;
 * the UI observes via `watch()` and stops work only through `cancel()`.
 *
 * @param {object} options
 * @param {(writer: object, signal: AbortSignal) => Promise<void>} options.run
 * @param {{ writer: object, reader: object, close: () => void }} [options.channel]
 * @returns {object} FlootTurn exo
 */
export const makeSessionTurn = ({ run, channel }) => {
  // makeReplyChannel returns `close` too; its `@returns` only declares the
  // writer/reader pair, so name the full shape here.
  const { writer, reader, close } =
    channel ??
    /** @type {{ writer: object, reader: object, close: () => void }} */ (
      makeReplyChannel()
    );

  const controller = new AbortController();

  /** @type {TurnStatus} */
  const status = {
    phase: 'thinking',
    streamingText: '',
    messages: [],
    done: false,
    error: null,
    usage: null,
  };

  /** @type {BufferedReaderKit} */
  let viewKit = makeBufferedReader();
  /** @type {(event: object) => void} */
  let teeToView = event => {
    viewKit.push(harden(event));
  };

  /** @type {Promise<void>} */
  let finished = Promise.resolve(undefined);
  /** @type {(value?: undefined) => void} */
  let finishResolve = () => {};
  finished = new Promise(resolve => {
    finishResolve = resolve;
  });

  (async () => {
    try {
      await run(writer, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      writer.abort(error instanceof Error ? error.message : String(error));
    }
  })();

  (async () => {
    try {
      await drainReplyReader(reader, status, event => teeToView(event));
    } catch (err) {
      status.error = /** @type {Error} */ (err)?.message || String(err);
    } finally {
      status.done = true;
      finishResolve(undefined);
    }
  })();

  return makeExo('FlootTurn', FlootTurnInterface, {
    async getStatus() {
      return harden({
        phase: status.phase,
        streamingText: status.streamingText,
        messages: [...status.messages],
        done: status.done,
        error: status.error,
        usage: status.usage ? { ...status.usage } : null,
      });
    },
    watch() {
      viewKit = makeBufferedReader();
      teeToView = event => {
        viewKit.push(harden(event));
      };
      return viewKit.reader;
    },
    async cancel() {
      if (status.done) return;
      controller.abort();
      close();
    },
    async whenFinished() {
      await finished;
    },
  });
};
harden(makeSessionTurn);
