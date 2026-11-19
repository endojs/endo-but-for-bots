// @ts-check
/**
 * The `openai-audio` speech engines (`designs/m11-interfaces.md` section
 * 6.3, D-M11-5): an HTTP speech provider with the OpenAI audio API's shape,
 * speech in (`SttEngine`) and speech out (`TtsEngine`) of
 * `engine-types.js`. Node only (adapter); nothing here reaches a vat, the
 * hub or a log line beyond kinds, stages and statuses.
 *
 * - The base URL is checked by `providers/http.js` `providerBaseUrl`
 *   (`https:`, or `http:` to loopback; no user info, query or fragment): a
 *   refused URL throws `BASE_URL_REFUSED` from the maker, before any key is
 *   read.
 * - The key, when the settings carry a `key` grant, is read with
 *   `readGrant(key)` at every request (D-6) and sent as
 *   `Authorization: Bearer`; it is never logged, never in a failure text,
 *   never in an event. A read failure fails the request like a 401.
 * - Speech in: at `end()`, `POST <base>/audio/transcriptions` (multipart: a
 *   16 kHz WAV of the utterance, `model`, `language`,
 *   `response_format=json`), the answer `{ text }` read with
 *   `openAiAudio.answerBytes` bound. While the utterance is open, every
 *   `partialIntervalMs` the audio so far is re-posted when it changed and
 *   is at most `partialMaxBytes`, one request in flight per utterance; a
 *   partial answering after a newer one, or after `end()`, is dropped. Any
 *   failed request (401/403, 429, 5xx, network, an unreadable answer)
 *   aborts the utterance with `speechTexts.engineFailed` (no retry: the user
 *   is waiting); no final within `engineTimeoutMs` of `end()` aborts it with
 *   `speechTexts.engineTimeout` (D-M11-10). No audio for `sttIdleMs` aborts
 *   it with `speechTexts.sttIdle`; at `audioLimits.utteranceBytes` the
 *   utterance ends itself (the final follows).
 * - Speech out: per sentence `POST <base>/audio/speech` `{ model, input,
 *   voice, speed, response_format: 'pcm' }`, the body streamed as PCM at
 *   `openAiAudio.pcmSampleRate` in whole samples and frames of at most
 *   `pcmFrameBytes - 4` bytes, awaiting `PlaybackSink.drained()` after each
 *   frame (backpressure); sentences are requested one after another. No
 *   PCM for `synthTimeoutMs` (the clock stops while the sink is not
 *   drained), a non-2xx status other than 401/403, a network failure or an
 *   empty body: that sentence is `sentenceFailed` and the next is requested.
 *   401/403 or a key read failure aborts the playback with
 *   `speechTexts.synthFailed` (every further sentence would fail the same
 *   way). The catalogue is the settings' `voices` (ids as names, 24 kHz);
 *   `noiseScale`, `noiseW`, `sentenceSilence` are accepted and ignored;
 *   speed is clamped to the provider's range.
 *
 * Test levers are the makers' `timeouts`, `limits` and `fetch` options
 * only (contract 3.3).
 */
import { Buffer } from 'node:buffer';
import { setTimeout as setTimer, clearTimeout } from 'node:timers';

import {
  audioLimits,
  audioTimeouts,
  speechTexts,
  speechTextOf,
  sttFormat,
} from './audio-protocol.js';
import { openAiAudio } from './engine-protocol.js';
import {
  BASE_URL_REFUSED,
  HttpFailure,
  bodyChunks,
  boundedChunks,
  discardBody,
  failureKind,
  postJson,
  providerBaseUrl,
  requestSignalOf,
} from '../providers/http.js';
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { ttsDefaults } from '../../../../guest/lib/voice-preferences.js';
/* eslint-enable import/no-relative-packages */

export { BASE_URL_REFUSED };

/** The engine kind this module serves (`engine-protocol.js` `speechEngineKinds`). */
export const OPENAI_AUDIO_KIND = 'openai-audio';

/** A maker given settings of another kind (a wiring fault of the caller). */
export const KIND_REFUSED =
  'openai-audio engine made from settings of another kind';

/**
 * The most PCM one sentence's answer may stream (bytes): 300 s at 24 kHz.
 * A sentence is at most `audioLimits.sentenceUnits` units, far less audio;
 * a body over this is a provider fault and the sentence fails.
 */
export const sentencePcmBytes = 300 * openAiAudio.pcmSampleRate * 2;

/** Bytes of the RIFF header `wavOf` writes. */
export const WAV_HEADER_BYTES = 44;

/**
 * A RIFF WAV of 16-bit mono PCM.
 * @param {Uint8Array} pcm s16le
 * @param {number} [sampleRate]
 */
export const wavOf = (pcm, sampleRate = sttFormat.sampleRate) => {
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(wav.buffer);
  /**
   * @param {number} at
   * @param {string} text
   */
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i += 1)
      view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, WAV_HEADER_BYTES);
  return wav;
};
harden(wavOf);

/**
 * Why a provider request failed. `stage` is what the log line names; no
 * body, URL or key is ever kept.
 * @typedef {'key' | 'status' | 'network' | 'timeout' | 'answer' | 'aborted'} FailureStage
 */
class SpeechRequestFailure extends Error {
  /**
   * @param {FailureStage} stage
   * @param {number} [status]
   */
  constructor(stage, status) {
    super(`speech provider request failed: ${stage}`);
    /** @type {FailureStage} */
    this.stage = stage;
    /** @type {number | undefined} */
    this.status = status;
  }
}

/** @param {unknown} error */
const stageOf = error => {
  if (error instanceof SpeechRequestFailure) return error.stage;
  if (error instanceof HttpFailure)
    return error.kind === 'aborted' ? 'aborted' : error.kind;
  return 'network';
};

/**
 * @typedef {object} OpenAiAudioOptions
 * @property {any} settings the direction's `SpeechInSettings` or
 *   `SpeechOutSettings` record of kind `openai-audio` (appendix A)
 * @property {(grant: any) => Promise<string>} readGrant the speech
 *   extension's key reader (`GatewayContext.readGrant`, D-M11-22)
 * @property {(event: Record<string, unknown>) => void} [log]
 * @property {Partial<Record<keyof typeof audioTimeouts | 'requestTimeoutMs', number>>} [timeouts]
 *   `requestTimeoutMs` defaults to `openAiAudio.requestTimeoutMs`
 * @property {Partial<Record<keyof typeof audioLimits, number>>} [limits]
 * @property {typeof globalThis.fetch} [fetch]
 */

/**
 * What both directions share: the checked URL of a path, the key header,
 * the failure log line.
 * @param {OpenAiAudioOptions} options
 * @param {'in' | 'out'} direction
 */
const makeProviderAccess = (
  { settings, readGrant, log = () => {}, fetch = globalThis.fetch },
  direction,
) => {
  if (settings?.kind !== OPENAI_AUDIO_KIND) throw Error(KIND_REFUSED);
  if (typeof settings.baseUrl !== 'string') throw Error(BASE_URL_REFUSED);
  const base = providerBaseUrl(settings.baseUrl, '');
  /** @returns {Promise<Record<string, string>>} */
  const authorization = async () => {
    if (settings.key === undefined) return {};
    /** @type {string} */
    let key;
    try {
      key = await readGrant(settings.key);
    } catch {
      throw new SpeechRequestFailure('key');
    }
    return { authorization: `Bearer ${key}` };
  };
  /** @param {unknown} error */
  const logFailure = error => {
    const stage = stageOf(error);
    if (stage === 'aborted') return;
    const status =
      error instanceof SpeechRequestFailure ? error.status : undefined;
    log({
      event:
        stage === 'timeout' ? 'speech-engine-timeout' : 'speech-engine-failed',
      kind: OPENAI_AUDIO_KIND,
      direction,
      stage,
      ...(status === undefined ? {} : { status }),
    });
  };
  return harden({
    /** @param {string} path */
    urlOf: path => `${base}${path}`,
    authorization,
    logFailure,
    fetch,
  });
};

/**
 * Read a small JSON answer, at most `maxBytes`.
 * @param {Response} response
 * @param {number} maxBytes
 */
const readJson = async (response, maxBytes) => {
  /** @type {Uint8Array[]} */
  const parts = [];
  for await (const chunk of boundedChunks(
    bodyChunks(response),
    maxBytes,
    () => new SpeechRequestFailure('answer'),
  ))
    parts.push(chunk);
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new SpeechRequestFailure('answer');
  }
};

/**
 * The `openai-audio` speech-in engine (`SttEngine`).
 * @param {OpenAiAudioOptions} options
 * @returns {import('./engine-types.js').SttEngine}
 */
export const makeOpenAiSpeechIn = options => {
  const access = makeProviderAccess(options, 'in');
  const { settings } = options;
  const timeouts = { ...audioTimeouts, ...options.timeouts };
  const limits = { ...audioLimits, ...options.limits };
  const requestTimeoutMs =
    options.timeouts?.requestTimeoutMs ?? openAiAudio.requestTimeoutMs;
  const partialIntervalMs =
    settings.partialIntervalMs ?? openAiAudio.partialIntervalMs;
  const url = access.urlOf(openAiAudio.transcriptions);
  /** @type {Set<(reason: string) => void>} */
  const open = new Set();
  let stopped = false;

  /**
   * One transcription request of `pcm`.
   * @param {Uint8Array} pcm
   * @param {AbortSignal} cancel
   * @param {number} timeoutMs
   * @returns {Promise<string>}
   */
  const transcribe = async (pcm, cancel, timeoutMs) => {
    const headers = await access.authorization();
    const form = new FormData();
    form.append(
      'file',
      new Blob([wavOf(pcm)], { type: 'audio/wav' }),
      'utterance.wav',
    );
    form.append('model', settings.model);
    form.append('language', settings.language);
    form.append('response_format', 'json');
    const signal = requestSignalOf(cancel, timeoutMs);
    /** @type {Response} */
    let response;
    try {
      response = await access.fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers,
        body: form,
      });
    } catch (error) {
      throw new HttpFailure(failureKind(error, cancel, signal));
    }
    if (!response.ok) {
      discardBody(response);
      throw new SpeechRequestFailure('status', response.status);
    }
    /** @type {any} */
    let answer;
    try {
      answer = await readJson(response, openAiAudio.answerBytes);
    } catch (error) {
      if (error instanceof SpeechRequestFailure) throw error;
      throw new HttpFailure(failureKind(error, cancel, signal));
    }
    if (typeof answer?.text !== 'string')
      throw new SpeechRequestFailure('answer');
    return answer.text;
  };

  /** @type {import('./engine-types.js').SttEngine['open']} */
  const openUtterance = sink => {
    /** @type {Uint8Array[]} */
    let chunks = [];
    let bytes = 0;
    let postedBytes = 0;
    let over = false;
    let ending = false;
    let partialBusy = false;
    let partialSeq = 0;
    let shownSeq = 0;
    const cancel = new AbortController();
    /** @type {ReturnType<typeof setTimer> | undefined} */
    let idleTimer;
    /** @type {ReturnType<typeof setTimer> | undefined} */
    let partialTimer;

    const clearTimers = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (partialTimer !== undefined) clearTimeout(partialTimer);
      idleTimer = undefined;
      partialTimer = undefined;
    };
    /** @param {() => void} report */
    const finish = report => {
      if (over) return;
      over = true;
      clearTimers();
      cancel.abort();
      open.delete(stop);
      chunks = [];
      report();
    };
    /** @param {string} reason */
    const stop = reason => finish(() => sink.abort(reason));
    /**
     * @param {unknown} error
     * @param {string} [reason]
     */
    const fail = (error, reason = speechTexts.engineFailed) => {
      if (over) return;
      access.logFailure(error);
      stop(reason);
    };
    const audioSoFar = () => {
      if (chunks.length > 1) chunks = [Buffer.concat(chunks)];
      return chunks[0] ?? new Uint8Array(0);
    };
    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimer(() => stop(speechTexts.sttIdle), timeouts.sttIdleMs);
      idleTimer.unref?.();
    };
    const partial = () => {
      partialTimer = undefined;
      if (over || ending) return;
      schedulePartial();
      if (partialBusy || bytes === postedBytes) return;
      if (bytes > openAiAudio.partialMaxBytes) return;
      partialBusy = true;
      postedBytes = bytes;
      partialSeq += 1;
      const seq = partialSeq;
      transcribe(audioSoFar(), cancel.signal, requestTimeoutMs).then(
        text => {
          partialBusy = false;
          if (over || ending || seq <= shownSeq) return;
          shownSeq = seq;
          sink.partial(text);
        },
        error => {
          partialBusy = false;
          if (!ending) fail(error);
        },
      );
    };
    const schedulePartial = () => {
      partialTimer = setTimer(partial, partialIntervalMs);
      partialTimer.unref?.();
    };

    const end = () => {
      if (over || ending) return;
      ending = true;
      clearTimers();
      sink.phase('transcribing');
      const finalCancel = new AbortController();
      cancel.signal.addEventListener('abort', () => finalCancel.abort());
      let timedOut = false;
      const deadline = setTimer(() => {
        timedOut = true;
        finalCancel.abort();
      }, timeouts.engineTimeoutMs);
      deadline.unref?.();
      transcribe(audioSoFar(), finalCancel.signal, requestTimeoutMs).then(
        text => {
          clearTimeout(deadline);
          finish(() => sink.final(text));
        },
        error => {
          clearTimeout(deadline);
          if (timedOut) {
            access.logFailure(new SpeechRequestFailure('timeout'));
            stop(speechTexts.engineTimeout);
          } else fail(error);
        },
      );
    };

    open.add(stop);
    sink.phase('listening');
    armIdle();
    schedulePartial();
    return harden({
      /** @param {Uint8Array} pcm */
      audio: pcm => {
        if (over || ending) return;
        const whole = pcm.byteLength - (pcm.byteLength % 2);
        const room = limits.utteranceBytes - bytes;
        const take = Math.min(whole, room - (room % 2));
        if (take > 0) {
          chunks.push(Uint8Array.prototype.slice.call(pcm, 0, take));
          bytes += take;
        }
        armIdle();
        if (bytes >= limits.utteranceBytes) end();
      },
      end,
      abort: () => finish(() => {}),
    });
  };

  return harden({
    state: () => (stopped ? 'off' : 'ready'),
    open: sink => {
      if (stopped) {
        sink.abort(speechTexts.serviceStopped);
        return harden({ audio: () => {}, end: () => {}, abort: () => {} });
      }
      return openUtterance(sink);
    },
    warm: async () => {},
    stop: async () => {
      stopped = true;
      for (const stop of [...open]) stop(speechTexts.serviceStopped);
    },
  });
};
harden(makeOpenAiSpeechIn);

/**
 * The `openai-audio` speech-out engine (`TtsEngine`).
 * @param {OpenAiAudioOptions} options
 * @returns {import('./engine-types.js').TtsEngine}
 */
export const makeOpenAiSpeechOut = options => {
  const access = makeProviderAccess(options, 'out');
  const { settings } = options;
  const timeouts = { ...audioTimeouts, ...options.timeouts };
  const limits = { ...audioLimits, ...options.limits };
  const url = access.urlOf(openAiAudio.speech);
  const rate = openAiAudio.pcmSampleRate;
  const frameBytes = limits.pcmFrameBytes - 4;
  /** @type {readonly string[]} */
  const voiceIds = harden([...(settings.voices ?? [])]);
  /** @type {Set<(reason: string) => void>} */
  const open = new Set();
  let stopped = false;

  const defaultVoice =
    settings.defaultVoice ?? voiceIds[0] ?? ttsDefaults.voice;
  /** @type {import('./engine-types.js').TtsCatalogue} */
  const catalogue = harden({
    voices: voiceIds.map(id => harden({ id, name: id, sampleRate: rate })),
    defaults: {
      ...ttsDefaults,
      voice: defaultVoice,
      speed: settings.defaultSpeed ?? ttsDefaults.speed,
    },
    ...(voiceIds.includes(defaultVoice)
      ? {}
      : { warning: speechTextOf.unknownVoice(defaultVoice) }),
  });

  /** @type {import('./engine-types.js').TtsEngine['open']} */
  const openSynthesis = (checked, sink) => {
    const speed = Math.min(
      openAiAudio.speedMax,
      Math.max(openAiAudio.speedMin, checked.speed),
    );
    /** @type {{ text: string, index: number }[]} */
    const queue = [];
    let next = 0;
    let ended = false;
    let over = false;
    let running = false;
    let phased = false;
    /** @type {AbortController | undefined} */
    let current;
    /** @type {() => void} */
    let release = () => {};
    const overPromise = new Promise(resolve => {
      release = () => resolve(undefined);
    });

    /** @param {() => void} report */
    const finish = report => {
      if (over) return;
      over = true;
      current?.abort();
      open.delete(stop);
      queue.length = 0;
      release();
      report();
    };
    /** @param {string} reason */
    const stop = reason => finish(() => sink.abort(reason));

    /**
     * Speak one sentence; answers whether it played, failed, or ended the
     * playback (`fatal`).
     * @param {string} text
     * @returns {Promise<'played' | 'failed' | 'fatal'>}
     */
    const speakOne = async text => {
      const cancel = new AbortController();
      current = cancel;
      let timedOut = false;
      /** @type {ReturnType<typeof setTimer> | undefined} */
      let timer;
      const disarm = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
      const arm = () => {
        disarm();
        timer = setTimer(() => {
          timedOut = true;
          cancel.abort();
        }, timeouts.synthTimeoutMs);
        timer.unref?.();
      };
      let sent = 0;
      try {
        const headers = await access.authorization();
        if (over) return 'played';
        arm();
        /** @type {Response} */
        const response = await postJson({
          url,
          headers,
          body: {
            model: settings.model,
            input: text,
            voice: checked.voice,
            speed,
            response_format: 'pcm',
          },
          signal: cancel.signal,
          fetch: access.fetch,
        });
        if (!response.ok) {
          discardBody(response);
          throw new SpeechRequestFailure('status', response.status);
        }
        /** @type {Uint8Array | undefined} */
        let carry;
        for await (let chunk of boundedChunks(
          bodyChunks(response),
          sentencePcmBytes,
          () => new SpeechRequestFailure('answer'),
        )) {
          disarm();
          if (over) return 'played';
          if (carry !== undefined) {
            chunk = Buffer.concat([carry, chunk]);
            carry = undefined;
          }
          const whole = chunk.byteLength - (chunk.byteLength % 2);
          if (whole < chunk.byteLength) carry = chunk.slice(whole);
          for (let at = 0; at < whole; at += frameBytes) {
            sink.pcm(chunk.slice(at, Math.min(whole, at + frameBytes)), rate);
            sent += Math.min(whole, at + frameBytes) - at;
            // eslint-disable-next-line no-await-in-loop
            await Promise.race([sink.drained(), overPromise]);
            if (over) return 'played';
          }
          arm();
        }
        disarm();
        if (sent === 0) throw new SpeechRequestFailure('answer');
        return 'played';
      } catch (error) {
        disarm();
        if (over) return 'played';
        const failure = timedOut ? new SpeechRequestFailure('timeout') : error;
        access.logFailure(failure);
        const status =
          failure instanceof SpeechRequestFailure ? failure.status : undefined;
        if (stageOf(failure) === 'key' || status === 401 || status === 403)
          return 'fatal';
        return 'failed';
      } finally {
        disarm();
        if (current === cancel) current = undefined;
      }
    };

    const pump = async () => {
      if (running) return;
      running = true;
      try {
        while (!over && queue.length > 0) {
          const { text, index } =
            /** @type {{ text: string, index: number }} */ (queue.shift());
          // eslint-disable-next-line no-await-in-loop
          const outcome = await speakOne(text);
          if (over) return;
          if (outcome === 'fatal') {
            stop(speechTexts.synthFailed);
            return;
          }
          if (outcome === 'failed') sink.sentenceFailed(index);
        }
        if (!over && ended) finish(() => sink.end());
      } finally {
        running = false;
      }
    };

    open.add(stop);
    return harden({
      /** @param {string} text */
      sentence: text => {
        if (over || ended) return;
        if (!phased) {
          phased = true;
          sink.phase('synthesizing');
        }
        queue.push({ text, index: next });
        next += 1;
        void pump();
      },
      end: () => {
        if (over || ended) return;
        ended = true;
        void pump();
      },
      abort: () => finish(() => {}),
    });
  };

  return harden({
    state: () => (stopped ? 'off' : 'ready'),
    catalogue: async () => catalogue,
    open: (checked, sink) => {
      if (stopped) {
        sink.abort(speechTexts.serviceStopped);
        return harden({ sentence: () => {}, end: () => {}, abort: () => {} });
      }
      return openSynthesis(checked, sink);
    },
    stop: async () => {
      stopped = true;
      for (const stop of [...open]) stop(speechTexts.serviceStopped);
    },
  });
};
harden(makeOpenAiSpeechOut);

/**
 * The kind record `AH/speech/kinds.js` (W11.5) lists under `openai-audio`:
 * one maker per direction, each taking `OpenAiAudioOptions`.
 */
export const openAiAudioKind = harden({
  speechIn: makeOpenAiSpeechIn,
  speechOut: makeOpenAiSpeechOut,
});
