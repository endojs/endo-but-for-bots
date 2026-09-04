// @ts-check
// Shared streaming-wire helpers for the browser-side voice servers.
//
// This is a browser-safe port of @endo/floot's src/buffered-channel.js: a
// buffered Far StreamReader paired with an imperative `push`. A producer pushes
// events as they occur; the caller pulls them over CapTP via `next()`. The
// buffer lets the producer run ahead of a slow consumer, and `next()` parks on
// a promise when caught up.
//
// IMPORTANT: unlike the daemon caplets (which run inside a SES worker where
// `harden` is a global), this module runs HOST-side in the browser alongside
// floot-component.js, where `harden` is NOT a global. So we import it
// explicitly from '@endo/harden' — exactly as floot-component.js does.
//
// On top of the generic buffered reader this also layers the two typed writer
// helpers the voice servers need, mirroring the daemon caplets' channels:
//   - makeTranscriptChannel() mirrors audio-server-caplet.js's makeTextChannel
//     (STT output; REPLACE semantics — text is always the full transcript).
//   - makeAudioOutChannel(onClose) mirrors tts-server-caplet.js's
//     makeAudioChannel (TTS output; one bytes event per synthesized sentence).

import { Far } from '@endo/far';
import harden from '@endo/harden';

/** Terminal events close the stream; they match across all wires. */
const isTerminal = event => event.type === 'end' || event.type === 'abort';

/**
 * @param {string} name Far interface name for the reader.
 * @param {{ onClose?: (() => void) | null }} [opts]
 * @returns {{
 *   push: (event: object) => void,
 *   reader: object,
 *   isClosed: () => boolean,
 *   setOnClose: (fn: () => void) => void,
 * }}
 */
export const makeBufferedReader = (name, { onClose = null } = {}) => {
  const buffer = [];
  let finished = false;
  let cursor = 0;
  // A FIFO of parked next() resolvers. A single slot would drop an earlier
  // parker when a second next() overlaps it, hanging that call forever; draining
  // every waiter keeps concurrent consumers safe (each re-checks on wake).
  /** @type {Array<() => void>} */
  const waiters = [];
  let closeHook = onClose;

  const drainWake = () => {
    while (waiters.length) {
      const wake = waiters.shift();
      if (wake) wake();
    }
  };

  const push = event => {
    if (finished) return;
    buffer.push(harden(event));
    if (isTerminal(event)) finished = true;
    drainWake();
  };

  // Consumer stopped pulling: finish, unblock any parked next(), and signal the
  // producer so in-flight work is aborted rather than left running.
  const finalize = () => {
    const wasFinished = finished;
    finished = true;
    cursor = buffer.length;
    drainWake();
    if (!wasFinished && closeHook) closeHook();
  };

  const reader = Far(name, {
    next: async () => {
      for (;;) {
        if (cursor < buffer.length) {
          const value = buffer[cursor];
          cursor += 1;
          return harden({ value, done: false });
        }
        if (finished) return harden({ value: undefined, done: true });
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => {
          waiters.push(() => resolve(undefined));
        });
      }
    },
    return: async () => {
      finalize();
      return harden({ value: undefined, done: true });
    },
    throw: async error => {
      finalize();
      throw error;
    },
  });

  return {
    push,
    reader,
    isClosed: () => finished,
    setOnClose: fn => {
      closeHook = fn;
    },
  };
};
harden(makeBufferedReader);

/**
 * STT output channel (the `textReader` returned by `transcribe`). Mirrors
 * audio-server-caplet.js's makeTextChannel: text events carry the *full current
 * transcript* (REPLACE semantics), not deltas, because recognizer partials are
 * cumulative and may revise earlier words mid-stream. `setOnClose` lets the
 * producer be wired AFTER construction (the pump loop hooks it once it has an
 * in-flight utterance to abort when the consumer stops pulling).
 *
 * @returns {{
 *   writer: {
 *     setPhase: (phase: string) => void,
 *     partial: (text: string) => void,
 *     final: (text: string) => void,
 *     end: () => void,
 *     abort: (reason: string) => void,
 *   },
 *   reader: object,
 *   setOnClose: (fn: () => void) => void,
 * }}
 */
export const makeTranscriptChannel = () => {
  const { push, reader, setOnClose } = makeBufferedReader('TranscriptReader');
  const writer = {
    setPhase: phase => push({ type: 'phase', phase: `${phase}` }),
    partial: text => push({ type: 'partial', text: `${text}` }),
    final: text => push({ type: 'final', text: `${text}` }),
    end: () => push({ type: 'end' }),
    abort: reason => push({ type: 'abort', reason: `${reason}` }),
  };
  return harden({ writer, reader, setOnClose });
};
harden(makeTranscriptChannel);

/**
 * TTS output channel (the `audioReader` returned by `synthesize`). Mirrors
 * tts-server-caplet.js's makeAudioChannel: one `bytes` event per synthesized
 * sentence chunk, carrying raw s16le mono PCM as base64 plus its sample rate.
 * `onClose` fires when the consumer stops pulling so the producer (the model
 * worker) can be aborted instead of synthesizing audio no one will receive.
 *
 * @param {(() => void) | null} [onClose]
 * @returns {{
 *   writer: {
 *     setPhase: (phase: string) => void,
 *     bytes: (b64: string, sampleRate: number) => void,
 *     end: () => void,
 *     abort: (reason: string) => void,
 *   },
 *   reader: object,
 *   isClosed: () => boolean,
 * }}
 */
export const makeAudioOutChannel = (onClose = null) => {
  const { push, reader, isClosed } = makeBufferedReader('AudioReader', {
    onClose,
  });
  const writer = {
    setPhase: phase => push({ type: 'phase', phase: `${phase}` }),
    bytes: (b64, sampleRate) => push({ type: 'bytes', b64, sampleRate }),
    end: () => push({ type: 'end' }),
    abort: reason => push({ type: 'abort', reason: `${reason}` }),
  };
  return harden({ writer, reader, isClosed });
};
harden(makeAudioOutChannel);
