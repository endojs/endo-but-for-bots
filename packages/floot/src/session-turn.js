// @ts-check
// A Floot turn the daemon owns.
//
// The turn runs against a reply channel the daemon holds and drains here, so
// the turn's progress does not depend on anyone consuming it. A caller observes
// through `watch()`, which hands out a fresh buffered reader per viewer, and
// stops the work through `cancel()` — nothing else. Losing an observer (a
// component unmounts, a tab closes, a gateway drops) closes that viewer's
// stream and leaves the turn running, which is the whole point: under
// exo-stream a severed CapTP connection abandons the synchronize chain, and a
// reply channel handed straight to the browser reads that as the consumer
// hanging up.
//
// See designs/floot-daemon-owned-turns.md and designs/ui-view-not-driver.md.

import { makeExo } from '@endo/exo';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { M } from '@endo/patterns';

import { makeReplyChannel } from './stream.js';

/** @import { BufferedReaderKit } from '@endo/exo-stream' */
/** @import { ReplyEvent } from './stream.js' */

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
 * @typedef {{ inputTokens: number, outputTokens: number, turns: number }} TurnUsage
 */

/**
 * A turn's state coalesced from its reply events: what a view renders if it
 * repaints from scratch. `messages` holds the assistant and tool messages the
 * turn has completed; `streamingText` is the assistant text still arriving.
 *
 * @typedef {{
 *   phase: string,
 *   streamingText: string,
 *   messages: TurnMessage[],
 *   done: boolean,
 *   error: string | null,
 *   usage: TurnUsage | null,
 * }} TurnStatus
 */

/**
 * What `watch()` yields: the turn's state as of the moment the view opened,
 * then the reply events that follow it.
 *
 * @typedef {{ type: 'snapshot', status: TurnStatus } | ReplyEvent} TurnViewEvent
 */

const FlootTurnInterface = M.interface('FlootTurn', {
  getStatus: M.callWhen().returns(M.record()),
  watch: M.call().returns(M.remotable()),
  cancel: M.callWhen().returns(M.undefined()),
  whenFinished: M.callWhen().returns(M.undefined()),
});

/**
 * Copy the live status. The drain loop mutates message records in place (a tool
 * call's result lands after the call), so a snapshot must copy each one rather
 * than harden the originals out from under it.
 *
 * @param {TurnStatus} status
 * @returns {TurnStatus}
 */
const snapshotOf = status =>
  harden({
    phase: status.phase,
    streamingText: status.streamingText,
    messages: status.messages.map(message => ({ ...message })),
    done: status.done,
    error: status.error,
    usage: status.usage ? { ...status.usage } : null,
  });

/**
 * Fold the turn's reply events into `status`, forwarding each one to the views
 * before folding it — so a view that opened on the preceding snapshot applies
 * exactly the events that snapshot does not already account for.
 *
 * @param {object} reader
 * @param {TurnStatus} status
 * @param {(event: ReplyEvent) => void} emit
 * @returns {Promise<ReplyEvent | null>} the terminal event the channel carried,
 *   or null if it was closed without one.
 */
const drainReplyReader = async (reader, status, emit) => {
  /** @type {Map<string, TurnMessage>} */
  const pendingTools = new Map();
  /** @type {ReplyEvent | null} */
  let terminal = null;

  const flushStreamingText = () => {
    if (status.streamingText.trim()) {
      status.messages.push({
        role: 'assistant',
        text: status.streamingText.trim(),
      });
    }
    status.streamingText = '';
  };

  for await (const raw of iterateReader(reader, { buffer: 8 })) {
    const event = /** @type {any} */ (raw);
    emit(event);
    if (event.type === 'delta') {
      status.streamingText += event.text;
    } else if (event.type === 'final') {
      status.streamingText = event.text;
    } else if (event.type === 'tool_call') {
      // The assistant text that preceded the call is a finished message: a tool
      // round follows it, and more text after that is a separate message.
      flushStreamingText();
      /** @type {TurnMessage} */
      const toolMessage = {
        role: 'tool',
        id: event.id,
        name: event.name,
        args: event.args,
        result: null,
      };
      pendingTools.set(event.id, toolMessage);
      status.messages.push(toolMessage);
    } else if (event.type === 'tool_result') {
      // Concurrent calls in one round settle out of order, so pair by id.
      const toolMessage = pendingTools.get(event.id);
      if (toolMessage) {
        toolMessage.result = event.result;
        pendingTools.delete(event.id);
      }
    } else if (event.type === 'phase') {
      status.phase = event.phase;
    } else if (event.type === 'usage') {
      status.usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        turns: event.turns,
      };
    } else if (event.type === 'end') {
      terminal = event;
      break;
    } else if (event.type === 'abort') {
      status.error = event.reason;
      terminal = event;
      break;
    }
  }
  flushStreamingText();
  return terminal;
};

/**
 * Start a turn the daemon owns, and return a handle to it.
 *
 * @param {object} options
 * @param {(writer: object, signal: AbortSignal) => Promise<void>} options.run
 *   Runs the turn, writing reply events to `writer` and honouring `signal`.
 *   `signal` aborts only on `cancel()`.
 * @returns {object} a FlootTurn exo
 */
export const makeSessionTurn = ({ run }) => {
  const { writer, reader, close } = makeReplyChannel();
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

  // One buffered channel per viewer. A viewer's channel closing removes that
  // viewer and nothing else — the turn is not an observer's to end.
  /** @type {Set<BufferedReaderKit>} */
  const views = new Set();

  /** @param {ReplyEvent} event */
  const emit = event => {
    for (const view of [...views]) {
      view.push(event);
    }
  };

  let cancelled = false;
  /** @type {() => void} */
  let finish = () => {};
  /** @type {Promise<void>} */
  const finished = new Promise(resolve => {
    finish = () => resolve(undefined);
  });

  /**
   * The terminal event a view should end on, for a turn that produced none of
   * its own. A cancelled turn ends cleanly: the caller asked for it.
   *
   * @returns {ReplyEvent}
   */
  const syntheticTerminal = () =>
    status.error
      ? harden({ type: /** @type {const} */ ('abort'), reason: status.error })
      : harden({ type: /** @type {const} */ ('end') });

  (async () => {
    try {
      await run(writer, controller.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        // A cancelled turn ends without settling its writer, so this is the
        // only place a failure during teardown can be seen. A hosted backend
        // that could not confirm the cancellation quarantines its session;
        // record that rather than let the stop read as clean.
        if (!status.error) status.error = message;
        return;
      }
      writer.abort(message);
    }
  })();

  (async () => {
    /** @type {ReplyEvent | null} */
    let terminal = null;
    try {
      terminal = await drainReplyReader(reader, status, emit);
    } catch (error) {
      status.error = error instanceof Error ? error.message : String(error);
    } finally {
      status.done = true;
      // `cancel()` closes the channel out from under the drain, so the reply
      // events stop without a terminal one. Views still have to end.
      if (!terminal) emit(syntheticTerminal());
      views.clear();
      finish();
    }
  })();

  return makeExo('FlootTurn', FlootTurnInterface, {
    /**
     * The turn's state right now, for a caller that wants to poll rather than
     * hold a stream.
     */
    async getStatus() {
      return snapshotOf(status);
    },
    /**
     * A view of the turn: a snapshot of where it has got to, then the events
     * that follow. Opening one costs a round trip, and the snapshot is what
     * closes the gap — a view that started from the live events alone would
     * miss everything emitted while `watch()` was in flight. It is also what
     * lets a reloaded tab reattach to a turn already in progress.
     *
     * Disposable: closing the returned reader detaches this viewer. Others keep
     * their streams and the turn keeps running.
     */
    watch() {
      const view = makeBufferedReader();
      view.push(harden({ type: 'snapshot', status: snapshotOf(status) }));
      if (status.done) {
        // Nothing more is coming: end the stream so a late viewer repaints from
        // the snapshot instead of parking on a channel that will never speak.
        view.push(syntheticTerminal());
        return view.reader;
      }
      views.add(view);
      view.setOnClose(() => {
        views.delete(view);
      });
      return view.reader;
    },
    /**
     * Stop the turn. The only thing that does.
     */
    async cancel() {
      if (cancelled || status.done) return;
      cancelled = true;
      // Abort before closing, so the turn's own teardown — a hosted backend's
      // interrupt, a provider stream — starts while its writer is still live.
      controller.abort();
      // An aborted turn returns without settling its writer, so nothing else
      // would release the drain above.
      close();
    },
    /**
     * Settles once the turn has emitted its last event and `getStatus()` is
     * final. A cancellation the backend is still unwinding does not hold this
     * open; the session's own turn chain serializes that against the next turn.
     */
    async whenFinished() {
      await finished;
    },
  });
};
harden(makeSessionTurn);
