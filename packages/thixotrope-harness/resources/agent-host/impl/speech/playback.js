// @ts-check
/**
 * One playback of the speech host (`designs/m11-interfaces.md` sections
 * 3.3 and 4, R5-34..R5-38, R5-44, R5-47): a text source (the speech view of
 * a turn, or the pieces of a replay) feeds a `SpeechText`, whose sentences
 * go to one `Synthesis` of the speech-out engine, whose PCM goes out as
 * PCM frames on the port's socket.
 *
 * `makePlayback(options)` answers the playback: `sink` is the
 * `TurnTextSink` the source writes to; `start()` sends what the source
 * wrote so far and everything after it; `stop()` is the page's ABORT or the
 * socket closing (synthesis killed, the source closed, no event, the turn
 * untouched: R5-47); `replace()` aborts it for a newer playback on the same
 * port (`speechTexts.replaced`, R5-44); `abort(reason)` ends it with that
 * reason. `onOver` is called once, when the playback is over for any
 * reason.
 *
 * Bounds (retained state): the text the `SpeechText` holds back plus the
 * sentences written before `start()` stay under
 * `audioLimits.sentenceBacklogUnits` (over it: abort `textBacklog`); PCM is
 * written in frames of at most `audioLimits.pcmFrameBytes` and the engine
 * waits on `drained()` while the socket holds more than
 * `audioLimits.pcmBufferedBytes` (backpressure, R5-68 fixed).
 *
 * Node only (agent-host adapter). No text, sentence or PCM is logged.
 */
import { clearTimeout, setTimeout } from 'node:timers';

import { speechTexts } from './audio-protocol.js';

/** @import { AudioConnection } from './route.js' */
/** @import { CheckedTtsOptions, PlaybackSink, SpeechText, Synthesis, TtsEngine, TurnTextSink } from './engine-types.js' */

/** How often a waiting `drained()` looks at the socket's queue. */
export const drainPollMs = 5;

/**
 * @param {object} options
 * @param {number} options.stream the playback's stream number
 * @param {AudioConnection} options.connection the port's socket
 * @param {TtsEngine} options.engine
 * @param {CheckedTtsOptions} options.options
 * @param {SpeechText} options.speechText
 * @param {{ pcmFrameBytes: number, pcmBufferedBytes: number, sentenceBacklogUnits: number }} options.limits
 * @param {(event: Record<string, unknown>) => void} options.log
 * @param {() => void} options.onOver
 */
export const makePlayback = ({
  stream,
  connection,
  engine,
  options,
  speechText,
  limits,
  log,
  onOver,
}) => {
  let started = false;
  let over = false;
  /** @type {string[]} sentences written before `start()` */
  let early = [];
  let earlyUnits = 0;
  let sourceEnded = false;
  /** @type {Synthesis | undefined} */
  let synthesis;
  /** @type {() => void} */
  let closeSource = () => {};
  /** @type {Set<() => void>} waiting `drained()` callers */
  const waiting = new Set();

  /** Largest PCM chunk in one frame (whole samples, after the rate). */
  const chunkBytes = Math.max(
    2,
    2 * Math.floor((limits.pcmFrameBytes - 4) / 2),
  );

  /**
   * @param {(() => void) | undefined} [last]
   */
  const finish = last => {
    if (over) return;
    over = true;
    for (const wake of waiting) wake();
    waiting.clear();
    early = [];
    try {
      closeSource();
    } catch {
      // The source's close must not stop the rest.
    }
    last?.();
    onOver();
  };

  /** @param {string} reason */
  const abortWith = reason => {
    if (over) return;
    const running = synthesis;
    finish(() => {
      running?.abort();
      connection.event(stream, harden({ type: 'abort', reason }));
    });
    log({ event: 'speech-stream-abort', direction: 'out' });
  };

  /** @type {PlaybackSink} */
  const playbackSink = harden({
    pcm: (pcm, sampleRate) => {
      if (over) return;
      for (let at = 0; at < pcm.byteLength; at += chunkBytes) {
        connection.pcm(
          stream,
          sampleRate,
          pcm.subarray(at, Math.min(pcm.byteLength, at + chunkBytes)),
        );
      }
    },
    drained: () => {
      if (over || connection.bufferedBytes() < limits.pcmBufferedBytes) {
        return Promise.resolve();
      }
      return new Promise(resolve => {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        const wake = () => {
          if (timer !== undefined) clearTimeout(timer);
          waiting.delete(wake);
          resolve(undefined);
        };
        const look = () => {
          if (over || connection.bufferedBytes() < limits.pcmBufferedBytes) {
            wake();
            return;
          }
          timer = setTimeout(look, drainPollMs);
          timer.unref?.();
        };
        waiting.add(wake);
        look();
      });
    },
    phase: phase => {
      if (!over) connection.event(stream, harden({ type: 'phase', phase }));
    },
    sentenceFailed: index => {
      if (!over) {
        connection.event(stream, harden({ type: 'sentence-failed', index }));
      }
    },
    end: () => finish(() => connection.event(stream, harden({ type: 'end' }))),
    abort: reason => {
      if (over) return;
      finish(() => connection.event(stream, harden({ type: 'abort', reason })));
    },
  });

  /** @param {string[]} sentences */
  const feed = sentences => {
    if (over || sentences.length === 0) return;
    if (!started) {
      for (const sentence of sentences) {
        early.push(sentence);
        earlyUnits += sentence.length;
      }
    } else {
      for (const sentence of sentences) {
        /** @type {Synthesis} */ (synthesis).sentence(sentence);
      }
    }
  };

  const checkBacklog = () => {
    if (speechText.pendingUnits() + earlyUnits > limits.sentenceBacklogUnits) {
      abortWith(speechTexts.textBacklog);
    }
  };

  /** @type {TurnTextSink} */
  const sink = harden({
    text: text => {
      if (over || sourceEnded) return;
      feed(speechText.push(text));
      checkBacklog();
    },
    lineBreak: () => {
      if (over || sourceEnded) return;
      feed(speechText.lineBreak());
    },
    end: () => {
      if (over || sourceEnded) return;
      sourceEnded = true;
      feed(speechText.finish());
      if (started) /** @type {Synthesis} */ (synthesis).end();
    },
    abort: reason => abortWith(reason),
  });

  const start = () => {
    if (over || started) return;
    started = true;
    synthesis = engine.open(options, playbackSink);
    const sentences = early;
    early = [];
    earlyUnits = 0;
    for (const sentence of sentences) synthesis.sentence(sentence);
    if (sourceEnded && !over) synthesis.end();
  };

  return harden({
    sink,
    start,
    /** @param {() => void} close the source's release (the view's `close`) */
    setSource: close => {
      if (over) {
        close();
        return;
      }
      closeSource = close;
    },
    stop: () => {
      const running = synthesis;
      finish(() => running?.abort());
    },
    replace: () => abortWith(speechTexts.replaced),
    abort: abortWith,
    isOver: () => over,
  });
};
harden(makePlayback);
