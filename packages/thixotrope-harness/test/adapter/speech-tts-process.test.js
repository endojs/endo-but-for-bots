// @ts-check
// Speech out, `process` kind (`AH/speech/tts-process.js`;
// designs/m11-interfaces.md 6.2, acceptance 5 and 10, D-M11-12): the
// catalogue and its defaults, an unusable default voice, one process per
// playback started at the first sentence with the checked flags, PCM in
// whole samples at the voice's rate, the sentence timeout and a failing
// process (the next sentence plays on a new process), a command that cannot
// start, abort, backpressure through `PlaybackSink.drained`, the sentence
// backlog bound, the warm spare and stop. The engine is
// `test/fixtures/fake-tts.mjs`; `[real-piper]` runs only with
// THIX_HARNESS_REAL_SPEECH=piper.
import test from '@endo/ses-ava/test.js';

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { makeProcessTtsEngine } from '../../resources/agent-host/impl/speech/tts-process.js';
import { checkTtsOptions } from '../../resources/agent-host/impl/speech/voice-catalogue.js';
import { speechTexts } from '../../resources/agent-host/impl/speech/audio-protocol.js';
/* eslint-disable-next-line import/no-relative-packages -- the guest tree is its own private package */
import { ttsDefaults } from '../../guest/lib/voice-preferences.js';

const FAKE_TTS = fileURLToPath(
  new URL('../fixtures/fake-tts.mjs', import.meta.url),
);
const VOICES = fileURLToPath(new URL('../fixtures/voices', import.meta.url));
const VOICE = 'en_US-test-medium';
const RATE = 22_050;

/**
 * Bytes of the fake's tone for one sentence.
 * @param {string} text
 * @param {number} [speed]
 * @param {number} [rate]
 */
const toneBytes = (text, speed = 1, rate = RATE) =>
  2 *
  Math.round((Math.max(1, Math.ceil(text.length / 10)) * 0.1 * rate) / speed);

/**
 * @param {() => boolean} condition
 * @param {number} ms
 */
const waitFor = async (condition, ms) => {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
};

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @param {number} pid */
const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A fake Piper in a fresh directory, with its pid file and log.
 * @param {import('ava').ExecutionContext} t
 * @param {object} [setup]
 * @param {string} [setup.mode]
 * @param {Partial<import('../../resources/agent-host/impl/speech/tts-process.js').ProcessTtsSettings>} [setup.settings]
 * @param {import('../../resources/agent-host/impl/speech/tts-process.js').ProcessTtsOptions} [setup.options]
 */
const makeFake = (t, { mode = 'normal', settings = {}, options = {} } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'thix-tts-'));
  const pidFile = join(dir, 'pids');
  const logFile = join(dir, 'received');
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const engine = makeProcessTtsEngine(
    {
      kind: 'process',
      command: [
        process.execPath,
        FAKE_TTS,
        '--mode',
        mode,
        '--pid-file',
        pidFile,
        '--log',
        logFile,
      ],
      voicesDir: VOICES,
      defaultVoice: VOICE,
      spareSynth: false,
      ...settings,
    },
    {
      log: event => events.push(event),
      ...options,
      timeouts: { synthTimeoutMs: 400, killGraceMs: 500, ...options.timeouts },
    },
  );
  t.teardown(async () => {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const pids = () =>
    existsSync(pidFile)
      ? readFileSync(pidFile, 'utf8').trim().split('\n').map(Number)
      : [];
  /** @returns {Record<string, any>[]} */
  const received = () =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
      : [];
  /** @param {Record<string, unknown>} [given] */
  const checked = async (given = {}) =>
    checkTtsOptions(given, await engine.catalogue());
  return { engine, events, pids, received, checked };
};

/**
 * A sink that records every call and resolves when the playback is over.
 * @param {object} [options]
 * @param {() => Promise<void>} [options.drained]
 */
const makeSink = ({ drained = () => Promise.resolve() } = {}) => {
  /** @type {[string, unknown?][]} */
  const calls = [];
  let pcmBytes = 0;
  /** @type {number[]} */
  const rates = [];
  let oddChunks = 0;
  /** @type {(value: [string, unknown?]) => void} */
  let resolveDone = () => {};
  /** @type {Promise<[string, unknown?]>} */
  const done = new Promise(resolve => {
    resolveDone = resolve;
  });
  /** @type {import('../../resources/agent-host/impl/speech/engine-types.js').PlaybackSink} */
  const sink = harden({
    pcm: (pcm, sampleRate) => {
      pcmBytes += pcm.byteLength;
      if (pcm.byteLength % 2) oddChunks += 1;
      if (!rates.includes(sampleRate)) rates.push(sampleRate);
    },
    drained,
    phase: phase => {
      calls.push(['phase', phase]);
    },
    sentenceFailed: index => {
      calls.push(['sentence-failed', index]);
    },
    end: () => {
      calls.push(['end']);
      resolveDone(['end']);
    },
    abort: reason => {
      calls.push(['abort', reason]);
      resolveDone(['abort', reason]);
    },
  });
  return {
    sink,
    calls,
    done,
    pcmBytes: () => pcmBytes,
    rates,
    oddChunks: () => oddChunks,
  };
};

const SENTENCES = harden([
  'The first sentence is here.',
  'A second one follows it closely.',
  'And the third ends the reply.',
]);

test('the catalogue lists the usable voices with the settings defaults', async t => {
  const { engine } = makeFake(t, { settings: { defaultSpeed: 1.25 } });
  const catalogue = await engine.catalogue();
  t.deepEqual(
    catalogue.voices.map(voice => voice.id),
    ['en_GB-other-low', VOICE],
  );
  t.deepEqual(catalogue.defaults, {
    ...ttsDefaults,
    voice: VOICE,
    speed: 1.25,
  });
  t.is(catalogue.warning, undefined);
  t.is(engine.state(), 'idle');
  t.is(await engine.catalogue(), catalogue, 'read once, then kept');
});

test('an unusable default voice turns speech out off with a warning', async t => {
  const { engine, pids } = makeFake(t, {
    settings: { defaultVoice: 'en_US-broken-medium' },
  });
  const catalogue = await engine.catalogue();
  t.true(typeof catalogue.warning === 'string');
  t.true(catalogue.warning?.includes(speechTexts.speechOutOff));
  t.is(engine.state(), 'off');
  const { sink, done } = makeSink();
  const synthesis = engine.open(harden({ ...ttsDefaults, voice: VOICE }), sink);
  synthesis.sentence('Nobody will hear this sentence.');
  t.deepEqual(await done, ['abort', speechTexts.speechOutOff]);
  t.deepEqual(pids(), [], 'no process started');
});

test('one process per playback, started at the first sentence, with the checked flags; whole samples at the voice rate', async t => {
  const { engine, pids, received, checked } = makeFake(t);
  const options = await checked({
    speed: 2,
    noiseScale: 0.5,
    sentenceSilence: 0.1,
  });
  const recorded = makeSink();
  const synthesis = engine.open(options, recorded.sink);
  await sleep(150);
  t.deepEqual(pids(), [], 'nothing runs before the first sentence (R5-38)');
  for (const text of SENTENCES) synthesis.sentence(text);
  synthesis.end();
  t.deepEqual(await recorded.done, ['end']);
  t.deepEqual(recorded.calls, [['phase', 'synthesizing'], ['end']]);
  t.is(
    recorded.pcmBytes(),
    SENTENCES.reduce((sum, text) => sum + toneBytes(text, 2), 0),
  );
  t.is(recorded.oddChunks(), 0);
  t.deepEqual(recorded.rates, [RATE]);
  const log = received();
  const starts = log.filter(entry => entry.type === 'start');
  t.is(starts.length, 1);
  t.like(starts[0], {
    voice: `${VOICE}.onnx`,
    lengthScale: 0.5,
    noiseScale: 0.5,
    noiseW: ttsDefaults.noiseW,
    sentenceSilence: 0.1,
  });
  t.deepEqual(
    log.filter(entry => entry.type === 'sentence').map(entry => entry.text),
    [...SENTENCES],
  );
  const [pid] = pids();
  t.true(await waitFor(() => !isAlive(pid), 2000), 'exits at end of input');
});

test('a sentence with no PCM in time is skipped and the next plays on a new process', async t => {
  const { engine, pids, events, checked } = makeFake(t, { mode: 'hang-on=1' });
  const recorded = makeSink();
  const synthesis = engine.open(await checked(), recorded.sink);
  for (const text of SENTENCES) synthesis.sentence(text);
  synthesis.end();
  t.deepEqual(await recorded.done, ['end']);
  t.deepEqual(recorded.calls, [
    ['phase', 'synthesizing'],
    ['sentence-failed', 1],
    ['end'],
  ]);
  t.is(recorded.pcmBytes(), toneBytes(SENTENCES[0]) + toneBytes(SENTENCES[2]));
  const [hung, next] = pids();
  t.true(next !== undefined && next !== hung, 'a new process');
  t.true(await waitFor(() => !isAlive(hung), 3000), 'the hung one is killed');
  t.true(
    events.some(
      event =>
        event.event === 'speech-engine-timeout' && event.reason === 'sentence',
    ),
  );
});

test('a process that dies before any PCM fails its sentence; two in a row abort the playback', async t => {
  const { engine, pids, checked } = makeFake(t, { mode: 'crash-at-start' });
  const recorded = makeSink();
  const synthesis = engine.open(await checked(), recorded.sink);
  for (const text of SENTENCES) synthesis.sentence(text);
  synthesis.end();
  t.deepEqual(await recorded.done, ['abort', speechTexts.synthFailed]);
  t.deepEqual(recorded.calls, [
    ['phase', 'synthesizing'],
    ['sentence-failed', 0],
    ['sentence-failed', 1],
    ['abort', speechTexts.synthFailed],
  ]);
  t.is(pids().length, 2);
});

test('a command that cannot be spawned aborts the playback', async t => {
  const { engine, checked } = makeFake(t, {
    settings: { command: [join(VOICES, 'no-such-piper')] },
  });
  const recorded = makeSink();
  const synthesis = engine.open(await checked(), recorded.sink);
  synthesis.sentence(SENTENCES[0]);
  t.deepEqual(await recorded.done, ['abort', speechTexts.synthFailed]);
});

test('abort kills the process and no sink call follows', async t => {
  const { engine, pids, checked } = makeFake(t, { mode: 'slow-ms=300' });
  const recorded = makeSink();
  const synthesis = engine.open(await checked(), recorded.sink);
  synthesis.sentence(SENTENCES[0]);
  t.true(await waitFor(() => pids().length === 1, 2000));
  synthesis.abort();
  const [pid] = pids();
  t.true(await waitFor(() => !isAlive(pid), 3000));
  await sleep(400);
  t.deepEqual(recorded.calls, [['phase', 'synthesizing']]);
  t.is(recorded.pcmBytes(), 0);
});

test('output pauses while the sink is not drained, without failing a sentence', async t => {
  const { engine, checked } = makeFake(t);
  /** @type {() => void} */
  let release = () => {};
  let holding = true;
  const recorded = makeSink({
    drained: () =>
      holding
        ? new Promise(resolve => {
            release = () => resolve(undefined);
          })
        : Promise.resolve(),
  });
  const long = 'word '.repeat(200);
  const synthesis = engine.open(await checked(), recorded.sink);
  for (let i = 0; i < 3; i += 1) synthesis.sentence(`${long}${i}.`);
  synthesis.end();
  t.true(await waitFor(() => recorded.pcmBytes() > 0, 3000));
  // Longer than synthTimeoutMs (400 ms): paused output must not count.
  await sleep(900);
  const held = recorded.pcmBytes();
  t.true(held < toneBytes(`${long}0.`), `held ${held} bytes`);
  holding = false;
  release();
  t.deepEqual(await recorded.done, ['end']);
  t.false(recorded.calls.some(([kind]) => kind === 'sentence-failed'));
  t.is(recorded.pcmBytes(), 3 * toneBytes(`${long}0.`));
});

test('sentences waiting past the backlog bound abort the playback', async t => {
  const { engine, checked } = makeFake(t, {
    mode: 'slow-ms=2000',
    options: { limits: { sentenceBacklogUnits: 60 } },
  });
  const recorded = makeSink();
  const synthesis = engine.open(await checked(), recorded.sink);
  for (const text of SENTENCES) synthesis.sentence(text);
  synthesis.sentence('One more sentence to overflow the backlog.');
  t.deepEqual(await recorded.done, ['abort', speechTexts.textBacklog]);
});

test('the warm spare serves the first sentence and is renewed; other options drop it', async t => {
  const { engine, pids, received, checked } = makeFake(t, {
    settings: { spareSynth: true },
  });
  await engine.warm();
  t.true(await waitFor(() => pids().length === 1, 2000), 'warm starts it');
  const [spare] = pids();
  t.is(engine.state(), 'ready');

  const first = makeSink();
  const one = engine.open(await checked(), first.sink);
  one.sentence(SENTENCES[0]);
  one.end();
  t.deepEqual(await first.done, ['end']);
  const sentenceOne = received().find(entry => entry.type === 'sentence');
  t.is(sentenceOne?.pid, spare, 'the spare took the first sentence');
  t.true(await waitFor(() => pids().length === 2, 2000), 'a new spare');
  const renewed = pids()[1];
  t.true(isAlive(renewed));

  const second = makeSink();
  const two = engine.open(await checked({ speed: 2 }), second.sink);
  two.sentence(SENTENCES[1]);
  two.end();
  t.deepEqual(await second.done, ['end']);
  t.true(await waitFor(() => !isAlive(renewed), 3000), 'the old spare dropped');
  const log = received();
  const sentenceTwo = log.filter(entry => entry.type === 'sentence')[1];
  t.false([spare, renewed].includes(sentenceTwo.pid));
  const latest = log.filter(entry => entry.type === 'start').at(-1);
  t.is(latest?.lengthScale, 0.5, 'the new spare follows the new options');
});

test('stop aborts open playbacks and ends every process', async t => {
  const { engine, pids, checked } = makeFake(t, {
    mode: 'slow-ms=1000',
    settings: { spareSynth: true },
  });
  await engine.warm();
  const recorded = makeSink();
  const synthesis = engine.open(await checked(), recorded.sink);
  synthesis.sentence(SENTENCES[0]);
  await engine.stop();
  t.deepEqual(await recorded.done, ['abort', speechTexts.serviceStopped]);
  for (const pid of pids()) t.false(isAlive(pid));
  t.is(engine.state(), 'idle');
  const late = makeSink();
  engine.open(await checked(), late.sink).sentence(SENTENCES[1]);
  t.deepEqual(await late.done, ['abort', speechTexts.serviceStopped]);
});

const realPiper =
  process.env.THIX_HARNESS_REAL_SPEECH === 'piper' ? test : test.skip;

// The operator's Piper and voices (O-4): THIX_HARNESS_PIPER (default
// `piper`) and THIX_HARNESS_PIPER_VOICES with THIX_HARNESS_PIPER_VOICE.
realPiper('[real-piper] a sentence synthesizes to PCM', async t => {
  const env = process.env;
  const engine = makeProcessTtsEngine({
    kind: 'process',
    command: [env.THIX_HARNESS_PIPER ?? 'piper'],
    voicesDir: env.THIX_HARNESS_PIPER_VOICES ?? '',
    defaultVoice: env.THIX_HARNESS_PIPER_VOICE ?? ttsDefaults.voice,
  });
  t.teardown(() => engine.stop());
  const catalogue = await engine.catalogue();
  t.is(catalogue.warning, undefined);
  const recorded = makeSink();
  const synthesis = engine.open(checkTtsOptions({}, catalogue), recorded.sink);
  synthesis.sentence('Hello from the harness.');
  synthesis.end();
  t.deepEqual(await recorded.done, ['end']);
  t.true(recorded.pcmBytes() > 0);
});
