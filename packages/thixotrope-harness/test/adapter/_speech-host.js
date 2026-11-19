// @ts-check
/**
 * Scaffolding of the speech host's adapter tests (`AH/speech/host.js`,
 * `route.js`, `GW/extensions/speech.js`; designs/m11-interfaces.md 3.2, 4):
 *
 * - `makeVoiceStub(settings)`: the factory's `Voice` as an exo with the
 *   real `Voice` guard (`guest/lib/guards/factory.js`), whose
 *   `speechSettings()` answers the current record (`set` replaces it);
 * - `makeInTestKinds()`: in-test engines of `engine-types.js` for the
 *   `process` kind (speech in reports `"<bytes> bytes"` partials and a
 *   `"final <bytes>"` final; speech out writes 2 bytes of PCM per text unit (`pcmPerUnit`)
 *   at 22,050 Hz), with what they saw;
 * - `makeHostContext(...)`: a `GatewayContext` for the host;
 * - `serveAudio(t, host)`: a gateway server with the `/audio` route and
 *   `openAudioSocket(...)`, a Node `WebSocket` client of it.
 *
 * Only what the host reaches through its own interfaces: no product branch.
 */
import '../unit/_m1a-prelude.js';

import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { interfaces as factoryInterfaces } from '../../guest/lib/guards/factory.js';
import { ttsDefaults } from '../../guest/lib/voice-preferences.js';
/* eslint-enable import/no-relative-packages */
import { makeGatewayServer } from '../../resources/agent-host/impl/gateway/server.js';
import {
  AUDIO_PATH,
  frameKinds,
  speechTexts,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { makeSpeechKinds } from '../../resources/agent-host/impl/speech/kinds.js';
import {
  decodeFrame,
  encodeFrame,
  makeAudioRoute,
} from '../../resources/agent-host/impl/speech/route.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/** The test voice of the in-test catalogue. */
export const TEST_VOICE = 'en_US-test-medium';

/**
 * A `process` settings record of both directions (appendix A).
 * @param {number} [revision]
 * @param {boolean} [warm]
 */
export const processSettings = (revision = 1, warm = false) =>
  harden({
    speechIn: {
      kind: 'process',
      command: ['speech-in-engine'],
      language: 'en',
      ...(warm ? { warm: true } : {}),
    },
    speechOut: {
      kind: 'process',
      command: ['speech-out-engine'],
      voicesDir: 'voices',
      defaultVoice: TEST_VOICE,
    },
    revision,
  });

/**
 * The factory's `Voice` with the real guard; only `speechSettings` is
 * used by the host.
 * @param {any} settings
 */
export const makeVoiceStub = settings => {
  let current = settings;
  let reads = 0;
  let failing = false;
  const voice = makeExo('Voice', factoryInterfaces.Voice, {
    getPreferences: () => harden({}),
    setPreferences: () => harden({}),
    getVoicePreset: () => {
      throw Error('not in these tests');
    },
    setVoicePreset: () => {
      throw Error('not in these tests');
    },
    startVoiceSession: async () => {
      throw Error('not in these tests');
    },
    speechSettings: () => {
      reads += 1;
      if (failing) throw Error('the factory is gone');
      return current;
    },
  });
  return {
    voice,
    /** @param {any} next */
    set: next => {
      current = next;
    },
    /** @param {boolean} value */
    fail: value => {
      failing = value;
    },
    reads: () => reads,
  };
};

/**
 * In-test engines of the `process` kind.
 * @param {{ hangFinal?: boolean, voices?: any[], startFails?: boolean, pcmPerUnit?: number }} [modes]
 */
export const makeInTestKinds = (modes = {}) => {
  const seen = {
    sttMade: 0,
    ttsMade: 0,
    warmed: 0,
    ttsWarmed: 0,
    stopped: 0,
    /** @type {string[]} */
    sentences: [],
    /** @type {string[]} */
    utteranceLog: [],
    synthesisAborts: 0,
    pcmBytes: 0,
    /** @type {any[]} */
    sinks: [],
  };
  const makeStt = () => {
    seen.sttMade += 1;
    /** @type {Set<any>} */
    const open = new Set();
    return harden({
      state: () => 'ready',
      warm: async () => {
        seen.warmed += 1;
      },
      stop: async () => {
        seen.stopped += 1;
        for (const sink of [...open]) sink.abort(speechTexts.serviceStopped);
      },
      /** @param {any} sink */
      open: sink => {
        let bytes = 0;
        let live = true;
        open.add(sink);
        sink.phase('listening');
        return harden({
          /** @param {Uint8Array} pcm */
          audio: pcm => {
            if (!live) return;
            bytes += pcm.byteLength - (pcm.byteLength % 2);
            seen.utteranceLog.push(`audio ${pcm.byteLength}`);
            sink.partial(`${bytes} bytes`);
          },
          end: () => {
            seen.utteranceLog.push('end');
            sink.phase('transcribing');
            if (modes.hangFinal) return;
            live = false;
            open.delete(sink);
            sink.final(`final ${bytes}`);
          },
          abort: () => {
            seen.utteranceLog.push('abort');
            live = false;
            open.delete(sink);
          },
        });
      },
    });
  };
  const makeTts = () => {
    seen.ttsMade += 1;
    if (modes.startFails) throw Error('no such speech-out command');
    return harden({
      state: () => 'ready',
      catalogue: async () =>
        harden({
          voices: modes.voices ?? [
            {
              id: TEST_VOICE,
              name: 'English (US) — test (medium)',
              sampleRate: 22_050,
            },
          ],
          defaults: { ...ttsDefaults, voice: TEST_VOICE },
        }),
      warm: async () => {
        seen.ttsWarmed += 1;
      },
      stop: async () => {
        seen.stopped += 1;
      },
      /**
       * @param {any} options
       * @param {any} sink
       */
      open: (options, sink) => {
        let live = true;
        let queue = Promise.resolve();
        seen.sinks.push(sink);
        sink.phase('synthesizing');
        return harden({
          /** @param {string} sentence */
          sentence: sentence => {
            seen.sentences.push(sentence);
            queue = queue.then(async () => {
              if (!live) return;
              await sink.drained();
              if (!live) return;
              const bytes = sentence.length * (modes.pcmPerUnit ?? 2);
              seen.pcmBytes += bytes;
              sink.pcm(new Uint8Array(bytes), 22_050);
            });
          },
          end: () => {
            queue = queue.then(() => {
              if (live) sink.end();
            });
          },
          abort: () => {
            live = false;
            seen.synthesisAborts += 1;
          },
        });
      },
    });
  };
  const kinds = makeSpeechKinds({
    off: {},
    process: { speechIn: makeStt, speechOut: makeTts },
  });
  return { kinds, seen };
};

/**
 * A gateway context for the host.
 * @param {object} options
 * @param {any} options.voice the `Voice` presence `getVoice()` answers
 * @param {any} [options.live]
 * @param {any} [options.content]
 * @param {Record<string, unknown>[]} [options.logs]
 * @param {(grant: any) => Promise<string>} [options.readGrant]
 * @param {string} [options.stateDir] a real one when process engines run
 */
export const makeHostContext = ({
  voice,
  live = Far('Live', {}),
  content = Far('Content', {}),
  logs = [],
  readGrant = undefined,
  stateDir = 'no-state-dir',
}) => {
  let operatorReads = 0;
  const operator = Far('Operator', {
    getVoice: () => {
      operatorReads += 1;
      return voice;
    },
  });
  return {
    context: /** @type {any} */ (
      harden({
        live,
        composer: Far('Composer', {}),
        content,
        history: () => undefined,
        whenAttached: (/** @type {() => void} */ callback) => callback(),
        secretWriter: async () => Far('GatewaySecretWriter', {}),
        stateDir,
        log: (/** @type {Record<string, unknown>} */ event) => logs.push(event),
        operator: () => operator,
        ...(readGrant === undefined ? {} : { readGrant }),
      })
    ),
    logs,
    operatorReads: () => operatorReads,
  };
};

/**
 * A gateway server on loopback with the host's `/audio` route.
 * @param {import('ava').ExecutionContext} t
 * @param {{ hostNow: () => any, limits?: Record<string, number> }} options
 */
export const serveAudio = async (t, { hostNow, limits }) => {
  /** @type {Record<string, unknown>[]} */
  const logs = [];
  const server = await makeGatewayServer({
    port: 0,
    routes: [makeAudioRoute({ hostNow })],
    staticHandler: () => false,
    onSocket: socket => socket.close(1000, 'not under test'),
    log: event => logs.push(event),
    ...(limits === undefined ? {} : { limits }),
  });
  t.teardown(() => server.close());
  return { server, logs, origin: `http://127.0.0.1:${server.port}` };
};

/**
 * One `/audio` client socket.
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.origin
 */
export const openAudioSocket = async ({ port, origin }) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${AUDIO_PATH}`, {
    headers: { Origin: origin },
  });
  ws.binaryType = 'arraybuffer';
  /** @type {{ kind: number, stream: number, payload: Buffer }[]} */
  const frames = [];
  /** @type {{ code: number, reason: string } | undefined} */
  let closed;
  /** @type {Set<() => void>} */
  const waiters = new Set();
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  ws.onmessage = message => {
    const frame = decodeFrame(
      Buffer.from(/** @type {ArrayBuffer} */ (message.data)),
    );
    if (frame) frames.push(frame);
    wake();
  };
  ws.onclose = event => {
    closed = { code: event.code, reason: event.reason };
    wake();
  };
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve(undefined);
    ws.onerror = () => reject(Error('the audio socket did not open'));
  });
  /**
   * @template T
   * @param {() => T | undefined} probe
   * @param {number} [ms]
   * @returns {Promise<T>}
   */
  const until = (probe, ms = 5000) =>
    new Promise((resolve, reject) => {
      const look = () => {
        const found = probe();
        if (found !== undefined) {
          waiters.delete(look);
          clearTimeout(timer);
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(look);
        reject(Error('timed out waiting on the audio socket'));
      }, ms);
      waiters.add(look);
      look();
    });
  /** @param {number} stream */
  const eventsOf = stream =>
    frames
      .filter(f => f.kind === frameKinds.event && f.stream === stream)
      .map(f => JSON.parse(f.payload.toString('utf8')));
  return {
    ws,
    frames,
    closed: () => closed,
    /**
     * @param {number} kind
     * @param {number} stream
     * @param {Uint8Array} [payload]
     */
    send: (kind, stream, payload) =>
      ws.send(new Uint8Array(encodeFrame(kind, stream, payload))),
    /** @param {string} tokenHex */
    hello: tokenHex =>
      ws.send(
        new Uint8Array(
          encodeFrame(frameKinds.hello, 0, Buffer.from(tokenHex, 'hex')),
        ),
      ),
    ready: () =>
      until(() => {
        const frame = frames.find(f => f.kind === frameKinds.ready);
        return frame && JSON.parse(frame.payload.toString('utf8'));
      }),
    eventsOf,
    /**
     * @param {number} stream
     * @param {string} type
     * @param {number} [ms] default 5,000
     */
    event: (stream, type, ms) =>
      until(() => eventsOf(stream).find(e => e.type === type), ms),
    /** @param {number} stream */
    pcmBytes: stream =>
      frames
        .filter(f => f.kind === frameKinds.pcm && f.stream === stream)
        .reduce((sum, f) => sum + f.payload.length - 4, 0),
    whenClosed: (ms = 5000) => until(() => closed, ms),
    until,
    close: () => ws.close(),
  };
};

/** Let pending callbacks run. */
export const settle = () => delay(20);
