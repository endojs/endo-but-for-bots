// @ts-check
// A spoken view of a daemon-owned turn.
//
// Speech is a *view* of the turn, like the transcript a browser renders: it
// opens the same snapshot-first `watch()` stream, feeds the assistant text that
// stream carries to a TtsServer's text wire (voice/tts-server-caplet.js), and
// hands the resulting audio stream back to whoever asked. It runs where the
// turn runs, so reply text never round-trips through a browser to be spoken,
// and it neither keeps the turn alive nor stops it: the audio consumer hanging
// up (barge-in, mute, a settings change that restarts speech) closes this view
// and nothing else.
//
// Because every view opens on a snapshot of the turn so far, restarting speech
// with different options is just opening another one: the new audio stream
// begins with everything already said and continues with the deltas still to
// come. The client drops the earlier stream, and the branch feeding it closes
// with it.

import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

/** @import { BufferedReaderKit } from '@endo/exo-stream' */
/** @import { TurnStatus, TurnViewEvent } from './session-turn.js' */

/**
 * The TTS text wire: append-only deltas and one terminal event. The same shape
 * a browser feeds `synthesize` for a replay of a finished message.
 *
 * @typedef {(
 *   | { type: 'delta', text: string }
 *   | { type: 'end' }
 *   | { type: 'abort', reason: string }
 * )} SpeechTextEvent
 */

/**
 * Everything the turn has said as of a snapshot, as one string for the
 * sentence chunker: the assistant messages completed before tool rounds, then
 * the text still streaming. Messages are newline-separated so a sentence never
 * straddles two of them, and the streaming text comes last, unterminated, so
 * the deltas that follow the snapshot extend it seamlessly.
 *
 * @param {TurnStatus} status
 * @returns {string}
 */
const saidSoFar = status => {
  const completed = status.messages
    .filter(message => message.role === 'assistant' && message.text)
    .map(message => `${message.text}\n`)
    .join('');
  return `${completed}${status.streamingText}`;
};

/**
 * Fold the view's events into text-wire events. Tracks the assistant text
 * streamed for the current message so a `final` that merely restates the
 * deltas is not spoken twice, while one that arrives with no deltas at all (a
 * backend that reports only a final answer) is.
 *
 * @param {AsyncIterable<unknown>} view
 * @param {(event: SpeechTextEvent) => void} push
 */
const feedView = async (view, push) => {
  // The current assistant message as streamed so far. A tool round ends the
  // message; the text after it is a new one.
  let streamed = '';
  await null;
  try {
    for await (const raw of view) {
      const event = /** @type {TurnViewEvent} */ (raw);
      switch (event.type) {
        case 'snapshot': {
          const opening = saidSoFar(event.status);
          if (opening) push({ type: 'delta', text: opening });
          streamed = event.status.streamingText;
          break;
        }
        case 'delta': {
          streamed += event.text;
          push({ type: 'delta', text: event.text });
          break;
        }
        case 'final': {
          // Speak only what the final text adds to what already streamed. A
          // final that revises the streamed text cannot be unsaid; it is
          // left to the transcript.
          if (event.text.startsWith(streamed)) {
            const rest = event.text.slice(streamed.length);
            if (rest) push({ type: 'delta', text: rest });
          }
          streamed = event.text;
          break;
        }
        case 'tool_call': {
          if (streamed) {
            push({ type: 'delta', text: '\n' });
            streamed = '';
          }
          break;
        }
        case 'end': {
          push({ type: 'end' });
          return;
        }
        case 'abort': {
          push({ type: 'abort', reason: event.reason });
          return;
        }
        default:
        // Phases, tool results, and usage are not spoken.
      }
    }
    // The view ended without a terminal event: it was closed from this side
    // because the audio consumer hung up, and there is nobody left to tell.
  } catch (error) {
    push({
      type: 'abort',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Speak a turn through a TtsServer: open a view of it, feed the assistant text
 * that view carries to `synthesize`, and resolve with the audio stream.
 *
 * @param {object} options
 * @param {() => object} options.watch Opens a snapshot-first view of the turn
 *   (`FlootTurn.watch`); a fresh one per call.
 * @param {any} options.ttsServer A TtsServer capability, which may be remote.
 * @param {Record<string, unknown>} [options.ttsOptions] Synthesis options
 *   (voice, speed, …), passed through to `synthesize` untouched.
 * @returns {Promise<object>} The audio reader `synthesize` returned. Rejects
 *   when synthesis could not start (an unknown voice, an unreachable server);
 *   the view is closed again in that case.
 */
export const speakTurn = async ({ watch, ttsServer, ttsOptions = {} }) => {
  const view = iterateReader(/** @type {any} */ (watch()), { buffer: 8 });
  /** @type {BufferedReaderKit<SpeechTextEvent>} */
  const text = makeBufferedReader({
    // The TTS side stopped reading text: its audio consumer hung up. Close the
    // view too; the turn is not this branch's to end.
    onClose: () => {
      view.return().catch(() => {});
    },
  });
  const audioReaderP = E(ttsServer).synthesize(
    text.reader,
    harden({ ...ttsOptions }),
  );
  // Synthesis that never starts leaves nobody to drain the text wire. Release
  // the view rather than feed it a whole reply; the caller sees the rejection.
  audioReaderP.catch(() => text.close());
  void feedView(view, text.push);
  return audioReaderP;
};
harden(speakTurn);
