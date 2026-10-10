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

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { passStyleOf } from '@endo/pass-style';

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

/** @param {string} text */
const collapse = text => text.replace(/\s+/g, ' ').trim();

/**
 * What a `final` adds to the text already spoken, if anything. A final that
 * restates spoken text — the current message's, or the whole turn's, as a
 * backend that accumulates its final across tool rounds reports it — adds
 * nothing; one with no deltas before it at all (a backend that reports only a
 * final answer) is spoken whole. Whitespace is collapsed for the comparison:
 * message separators and trimmed line ends differ between the two sides.
 *
 * @param {string} final
 * @param {string} spoken everything spoken this turn
 * @param {string} streamed the current message as streamed so far
 * @returns {string}
 */
const unspokenOf = (final, spoken, streamed) => {
  const finalText = collapse(final);
  if (!finalText) return '';
  const spokenText = collapse(spoken);
  if (spokenText.endsWith(finalText)) return '';
  if (finalText.startsWith(spokenText)) {
    return finalText.slice(spokenText.length);
  }
  const streamedText = collapse(streamed);
  if (finalText.startsWith(streamedText)) {
    return finalText.slice(streamedText.length);
  }
  // A final that revises what streamed cannot be unsaid; it is left to the
  // transcript rather than spoken twice.
  return '';
};

/**
 * Fold the view's events into text-wire events, so that each character the
 * turn says reaches the wire exactly once.
 *
 * @param {AsyncIterable<unknown>} view
 * @param {(event: SpeechTextEvent) => void} push
 */
const feedView = async (view, push) => {
  // The current assistant message as streamed so far. A tool round ends the
  // message; the text after it is a new one.
  let streamed = '';
  // Everything spoken so far this turn (see unspokenOf).
  let spoken = '';
  /** @param {string} text */
  const say = text => {
    spoken += text;
    push({ type: 'delta', text });
  };
  // A view opened on a turn already over ends on a synthetic terminal. An
  // error the turn ended on is old news to a replay: its text is final and
  // worth hearing to the end, not cut off at the first sentence.
  let finishedAtOpen = false;
  await null;
  try {
    for await (const raw of view) {
      const event = /** @type {TurnViewEvent} */ (raw);
      switch (event.type) {
        case 'snapshot': {
          const opening = saidSoFar(event.status);
          if (opening) say(opening);
          streamed = event.status.streamingText;
          finishedAtOpen = event.status.done === true;
          break;
        }
        case 'delta': {
          streamed += event.text;
          say(event.text);
          break;
        }
        case 'final': {
          const rest = unspokenOf(event.text, spoken, streamed);
          if (rest) say(rest);
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
          if (finishedAtOpen) {
            push({ type: 'end' });
          } else {
            push({ type: 'abort', reason: event.reason });
          }
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
  const audioReaderP = E(ttsServer)
    .synthesize(text.reader, harden({ ...ttsOptions }))
    .then((/** @type {unknown} */ audioReader) => {
      // The turn's guard refuses a non-remotable to the caller; refuse it
      // here too, so the view is released along with it.
      passStyleOf(audioReader) === 'remotable' ||
        Fail`synthesize must return an audio reader, got ${q(audioReader)}`;
      return audioReader;
    });
  // Synthesis that never starts leaves nobody to drain the text wire. Release
  // the view rather than feed it a whole reply; the caller sees the rejection.
  audioReaderP.catch(() => text.close());
  void feedView(view, text.push);
  return audioReaderP;
};
harden(speakTurn);
