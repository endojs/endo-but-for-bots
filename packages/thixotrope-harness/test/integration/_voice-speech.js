// @ts-check
/**
 * Speech through the daemon (designs/m11-interfaces.md 13; W11.9), shared by
 * `voice-speak.test.js`, `voice-speech-restart.test.js`,
 * `voice-provider.test.js` and `perf/voice-session.perf.mjs`:
 *
 * - `fakeEngineSpeech(dir, modes?)`: `options.voice.speech` of the voice
 *   provisioning step (`scripts/provision-steps/70-voice.js`) for the fake
 *   process engines (`test/fixtures/fake-stt.mjs`, `fake-tts.mjs`), with
 *   their pid files and logs in `dir` (under the state root, so
 *   `processesUnder` and `killStrays` find them);
 * - `configureSpeech(state, speech)`: the step, run as provisioning runs it
 *   (`HarnessRoot.configureSpeech`, never a page: D-M11-21);
 * - `speechOf(powers)`: the page's `Speech` service (`GatewayPowers.extras`
 *   under `speech`);
 * - `openSpeechSocket(gateway, speech)`: `openAudio`, the `/audio` socket,
 *   HELLO and READY, as a page does (`test/adapter/_speech-host.js`
 *   `openAudioSocket`);
 * - `sendClip(socket, stream, clip, paceMs?)`: the clip as 85 ms AUDIO
 *   frames, back to back or one per `paceMs` (partials come while the
 *   audio streams; after END the engine's late partials are dropped);
 * - `journalTotal(client)`: durable deliveries of every worker so far;
 * - `pidsIn(file)`, `alive(pid)`, `engineLog(file)`.
 *
 * The importer must have installed the guest prelude first.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import url from 'node:url';

import { E } from '@endo/far';

import { frameKinds } from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { SPEECH_LABEL } from '../../resources/agent-host/impl/gateway/extensions/speech.js';
import { voiceStep } from '../../scripts/provision-steps/70-voice.js';
import { openAudioSocket } from '../adapter/_speech-host.js';
import { blocksOf } from '../fixtures/voice-clip.mjs';

const fixtures = url.fileURLToPath(new URL('../fixtures/', import.meta.url));

/** The fake voice of `test/fixtures/voices/` that speech out uses. */
export const FAKE_VOICE = 'en_US-test-medium';

/**
 * The fake engines' files in `dir`.
 * @param {string} dir
 */
export const engineFiles = dir => ({
  sttPids: path.join(dir, 'stt.pids'),
  sttLog: path.join(dir, 'stt.log'),
  ttsPids: path.join(dir, 'tts.pids'),
  ttsLog: path.join(dir, 'tts.log'),
});

/**
 * `options.voice.speech` for the fake process engines.
 * @param {string} dir created if missing
 * @param {{ stt?: string, tts?: string, warm?: boolean }} [modes] the
 *   fakes' `--mode` (default `normal`)
 */
export const fakeEngineSpeech = (dir, { stt, tts, warm = false } = {}) => {
  mkdirSync(dir, { recursive: true });
  const files = engineFiles(dir);
  return harden({
    speechIn: {
      kind: 'process',
      command: [
        process.execPath,
        path.join(fixtures, 'fake-stt.mjs'),
        '--pid-file',
        files.sttPids,
        '--log',
        files.sttLog,
        ...(stt === undefined ? [] : ['--mode', stt]),
      ],
      language: 'en',
      ...(warm ? { warm: true } : {}),
    },
    speechOut: {
      kind: 'process',
      command: [
        process.execPath,
        path.join(fixtures, 'fake-tts.mjs'),
        '--pid-file',
        files.ttsPids,
        '--log',
        files.ttsLog,
        ...(tts === undefined ? [] : ['--mode', tts]),
      ],
      voicesDir: path.join(fixtures, 'voices'),
      defaultVoice: FAKE_VOICE,
    },
  });
};

/**
 * Write the speech settings as provisioning does.
 * @param {{ client: any }} state
 * @param {any} speech `options.voice.speech`
 */
export const configureSpeech = (state, speech) =>
  voiceStep.run({
    client: state.client,
    options: /** @type {any} */ (harden({ voice: { speech } })),
  });

/**
 * The page's `Speech` service.
 * @param {any} powers `GatewayPowers`
 */
export const speechOf = powers => {
  const entry = powers.extras.find(
    (/** @type {any} */ extra) => extra.label === SPEECH_LABEL,
  );
  if (entry === undefined) throw Error('no speech service on this page');
  return entry.service;
};

/**
 * A bound `/audio` socket of a fresh port.
 * @param {{ port: number, origin: string }} gateway
 * @param {any} speech
 */
export const openSpeechSocket = async (gateway, speech) => {
  const { port, token } = await E(speech).openAudio();
  const socket = await openAudioSocket({
    port: gateway.port,
    origin: gateway.origin,
  });
  socket.hello(token);
  const ready = await socket.ready();
  return { port, socket, ready };
};

/**
 * Send `clip` on an utterance as 85 ms AUDIO frames.
 * @param {any} socket
 * @param {number} stream
 * @param {Uint8Array} clip
 * @param {number} [paceMs] wait this long after each frame (default 0)
 */
export const sendClip = async (socket, stream, clip, paceMs = 0) => {
  await null;
  for (const block of blocksOf(clip)) {
    socket.send(frameKinds.audio, stream, block);
    // eslint-disable-next-line no-await-in-loop
    if (paceMs > 0) await delay(paceMs);
  }
};

/**
 * Durable deliveries of every worker so far (the sum of journal lengths).
 * @param {any} client the control client
 */
export const journalTotal = async client => {
  const { workers } = await client.call('status');
  return workers.reduce(
    (/** @type {number} */ sum, /** @type {any} */ w) =>
      sum + Number(w.journalLength ?? 0),
    0,
  );
};

/**
 * The pids a fake engine wrote to its pid file (one line per start).
 * @param {string} file
 * @returns {number[]}
 */
export const pidsIn = file => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

/** @param {number} pid */
export const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The JSON lines of a fake engine's log.
 * @param {string} file
 * @returns {any[]}
 */
export const engineLog = file => {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
};
