// @ts-check
// The speech host (`AH/speech/host.js`; designs/m11-interfaces.md 3.2,
// 6.1, 6.4, D-M11-2, D-M11-19, D-M11-23, acceptance 2, 5, 19): settings
// read through the gateway's `Operator` from a `Voice` exo with the real
// guard, at first use and again at `configuration` or `openAudio` once stale; a
// failed read makes both directions `failed` and the next `openAudio`
// retries; a new revision drops the idle engine at once and a busy one when
// its last stream ends; `warm: true` warms speech in at the read; a
// speech-in engine that cannot be made leaves speech out working; options
// are checked at `speak`/`replay` with the R5-41 texts and open no stream;
// an unusable default voice turns speech out off; `Speech` and every port
// never leave the gateway. In-test engines; no supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { ttsRanges } from '../../guest/lib/voice-preferences.js';
/* eslint-enable import/no-relative-packages */
import { isNeverLeaving } from '../../resources/agent-host/impl/gateway/powers.js';
import {
  frameKinds,
  speechTextOf,
  speechTexts,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { makeSpeechHost } from '../../resources/agent-host/impl/speech/host.js';
import {
  makeSpeechKinds,
  speechKinds,
} from '../../resources/agent-host/impl/speech/kinds.js';
import { makeSpeechText } from '../../resources/agent-host/impl/speech/speech-text.js';
import { scratch } from '../_helpers.js';
import {
  TEST_VOICE,
  makeHostContext,
  makeInTestKinds,
  makeVoiceStub,
  openAudioSocket,
  processSettings,
  serveAudio,
  settle,
} from './_speech-host.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

const pipeline = harden({
  makeSpeechText,
  openTurnView: async () => harden({ close: () => {} }),
});

/**
 * @param {import('ava').ExecutionContext} t
 * @param {object} [options]
 * @param {any} [options.settings]
 * @param {any} [options.kinds]
 * @param {Parameters<typeof makeInTestKinds>[0]} [options.modes]
 * @param {number} [options.settingsMaxAgeMs]
 * @param {string} [options.stateDir]
 */
const world = async (t, options = {}) => {
  const stub = makeVoiceStub(options.settings ?? processSettings());
  const inTest = makeInTestKinds(options.modes);
  const made = makeHostContext({
    voice: stub.voice,
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
  });
  const host = makeSpeechHost({
    context: made.context,
    kinds: options.kinds ?? inTest.kinds,
    pipeline,
    options:
      options.settingsMaxAgeMs === undefined
        ? {}
        : { settingsMaxAgeMs: options.settingsMaxAgeMs },
  });
  t.teardown(() => host.stop());
  const served = await serveAudio(t, { hostNow: () => host });
  const open = async () => {
    const grant = await E(host.speech).openAudio();
    const socket = await openAudioSocket({
      port: served.server.port,
      origin: served.origin,
    });
    t.teardown(() => socket.close());
    socket.hello(grant.token);
    const ready = await socket.ready();
    return { ...grant, socket, ready };
  };
  return { host, stub, seen: inTest.seen, made, open };
};

test('Speech and each AudioPort never leave the gateway', async t => {
  const { host } = await world(t);
  t.true(isNeverLeaving(host.speech));
  const { port } = await E(host.speech).openAudio();
  t.true(isNeverLeaving(port));
});

test('settings: read at first use through Operator.getVoice, kept, and read again at openAudio once stale', async t => {
  const { host, stub, made } = await world(t, { settingsMaxAgeMs: 100 });
  t.is(stub.reads(), 0, 'nothing is read at construction (D-M11-23)');
  const configuration = await E(host.speech).configuration();
  t.is(stub.reads(), 1);
  t.is(made.operatorReads(), 1);
  t.true(configuration.speechIn);
  t.true(configuration.speechOut);
  t.is(configuration.language, 'en');
  t.deepEqual(
    configuration.voices.map((/** @type {any} */ v) => v.id),
    [TEST_VOICE],
  );
  t.is(configuration.defaults.voice, TEST_VOICE);
  t.deepEqual(configuration.ranges.speed, { ...ttsRanges.speed });
  await E(host.speech).openAudio();
  await settle();
  t.is(stub.reads(), 1, 'fresh: not read again');
  await delay(150);
  await E(host.speech).openAudio();
  await settle();
  t.is(stub.reads(), 2, 'stale: read again at openAudio');
  t.is(made.operatorReads(), 1, 'the Voice presence is kept');
});

test('the configuration read sees newly enabled directions with no audio port open', async t => {
  const { host, stub } = await world(t, {
    settings: {
      speechIn: { kind: 'off' },
      speechOut: { kind: 'off' },
      revision: 0,
    },
    settingsMaxAgeMs: 5,
  });
  const off = await E(host.speech).configuration();
  t.false(off.speechIn);
  t.false(off.speechOut);
  stub.set(processSettings(1));
  await delay(10);
  const on = await E(host.speech).configuration();
  t.true(on.speechIn);
  t.true(on.speechOut);
  t.is(stub.reads(), 2);
});

test('a failed read makes both directions failed; the next openAudio retries', async t => {
  const { host, stub, made } = await world(t);
  stub.fail(true);
  const configuration = await E(host.speech).configuration();
  t.false(configuration.speechIn);
  t.false(configuration.speechOut);
  t.is(configuration.warning, 'the factory is gone');
  const failed = await E(host.speech).status();
  t.is(failed.speechIn, 'failed');
  t.is(failed.speechOut, 'failed');
  t.is(failed.error, 'the factory is gone');
  stub.fail(false);
  await E(host.speech).openAudio();
  await settle();
  const recovered = await E(host.speech).status();
  t.is(recovered.speechIn, 'idle');
  t.is(recovered.error, undefined);
  t.is(made.operatorReads(), 2, 'the Voice presence is asked again');
});

test('warm: true warms speech in at the settings read', async t => {
  const { host, seen } = await world(t, {
    settings: processSettings(1, true),
  });
  t.is(seen.sttMade, 0);
  await E(host.speech).configuration();
  await settle();
  t.is(seen.sttMade, 1);
  t.is(seen.warmed, 1);
  t.is((await E(host.speech).status()).speechIn, 'ready');
});

test('configuration() warms speech out for its spare (D-M11-12)', async t => {
  const { host, seen } = await world(t);
  t.is(seen.ttsWarmed, 0);
  await E(host.speech).configuration();
  await settle();
  t.is(seen.ttsWarmed, 1);
});

test('a new revision drops the idle engine at once and a busy one when its last stream ends', async t => {
  const { stub, seen, open } = await world(t, { settingsMaxAgeMs: 0 });
  const page = await open();
  const first = await E(page.port).transcribe();
  t.is(seen.sttMade, 1);
  stub.set(processSettings(2));
  const other = await open();
  await settle();
  t.is(seen.stopped, 0, 'busy: kept until its stream ends');
  const second = await E(other.port).transcribe();
  t.is(seen.sttMade, 2, 'the new revision makes a new engine');
  page.socket.send(frameKinds.end, first.stream);
  await page.socket.event(first.stream, 'end');
  await settle();
  t.is(seen.stopped, 1, 'the old engine stops after its last stream');
  stub.set(processSettings(3));
  other.socket.send(frameKinds.abort, second.stream);
  await settle();
  await open();
  await settle();
  t.is(seen.stopped, 2, 'idle: stopped at once');
});

test('speech in that cannot be made fails alone; speech out still plays (acceptance 2)', async t => {
  const inTest = makeInTestKinds();
  const kinds = makeSpeechKinds({
    off: {},
    process: {
      speechIn: () => {
        throw Error('no such speech-in command');
      },
      speechOut: /** @type {any} */ (inTest.kinds.process).speechOut,
    },
  });
  const { host, open } = await world(t, { kinds });
  const { port, socket, ready } = await open();
  t.true(ready.speechOut);
  await t.throwsAsync(() => E(port).transcribe(), {
    message: speechTexts.engineUnavailable,
  });
  const status = await E(host.speech).status();
  t.is(status.speechIn, 'failed');
  t.is(status.error, 'no such speech-in command');
  t.is(status.speechOut, 'idle');
  const { stream } = await E(host.speech).replay(port, [
    'Speech out still works today.',
  ]);
  await socket.event(stream, 'end');
  t.true(socket.pcmBytes(stream) > 0);
});

test('a kind without a maker is failed, off is off', async t => {
  const settings = harden({
    speechIn: { kind: 'off' },
    speechOut: {
      kind: 'openai-audio',
      baseUrl: 'http://127.0.0.1:9',
      model: 'm',
      voices: ['v'],
    },
    revision: 1,
  });
  const { kinds } = makeInTestKinds();
  const { host, open } = await world(t, { settings, kinds });
  const { port, ready } = await open();
  t.false(ready.speechIn);
  t.false(ready.speechOut);
  await t.throwsAsync(() => E(port).transcribe(), {
    message: speechTexts.speechInOff,
  });
  await t.throwsAsync(() => E(port).speak(port, 't1'), {
    message: speechTexts.synthFailed,
  });
  const status = await E(host.speech).status();
  t.is(status.speechIn, 'off');
  t.is(status.speechOut, 'failed');
  t.is(status.streams, 0);
});

test('options are checked at speak and replay with the R5-41 texts; no stream is opened', async t => {
  const { host, open } = await world(t);
  const { port } = await open();
  const { speed } = ttsRanges;
  /** @type {[Record<string, unknown>, string][]} */
  const cases = [
    [{ speed: 4.05 }, speechTextOf.outOfRange('speed', speed.min, speed.max)],
    [
      { speed: Number.NaN },
      speechTextOf.outOfRange('speed', speed.min, speed.max),
    ],
    [
      { sentenceSilence: Infinity },
      speechTextOf.outOfRange(
        'sentenceSilence',
        ttsRanges.sentenceSilence.min,
        ttsRanges.sentenceSilence.max,
      ),
    ],
    [{ voice: 'en_XX-none-low' }, speechTextOf.unknownVoice('en_XX-none-low')],
  ];
  for (const [options, message] of cases) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => E(host.speech).replay(port, ['Some text.'], harden(options)),
      { message },
    );
  }
  await t.throwsAsync(() => E(port).speak(port, 't1', harden({ speed: 0.1 })), {
    message: speechTextOf.outOfRange('speed', speed.min, speed.max),
  });
  t.is((await E(host.speech).status()).streams, 0);
});

test('an unusable default voice turns speech out off; speech in still works', async t => {
  const { host, open } = await world(t, {
    modes: {
      voices: [{ id: 'en_GB-other-low', name: 'other', sampleRate: 16_000 }],
    },
  });
  const configuration = await E(host.speech).configuration();
  t.true(configuration.speechIn);
  t.false(configuration.speechOut);
  const { port, socket } = await open();
  const { stream } = await E(port).transcribe();
  socket.send(frameKinds.end, stream);
  await socket.event(stream, 'final');
});

test('stop closes every port with serviceStopped and stops the engines', async t => {
  const { host, open, seen } = await world(t);
  const { port, socket } = await open();
  await E(port).transcribe();
  await host.stop();
  const closed = await socket.whenClosed();
  t.is(closed.reason, speechTexts.serviceStopped);
  await settle();
  t.is(seen.stopped, 1);
  t.throws(() => host.speech.openAudio(), {
    message: speechTexts.serviceStopped,
  });
});

test("the incarnation's kinds run the process engines (the fake engines of their tests)", async t => {
  const stateDir = await scratch(t, 'spk-');
  mkdirSync(join(stateDir, 'agent-host'));
  const fixture = (/** @type {string} */ name) =>
    fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const settings = harden({
    speechIn: {
      kind: 'process',
      command: [execPath, fixture('fake-stt.mjs')],
      language: 'en',
    },
    speechOut: {
      kind: 'process',
      command: [execPath, fixture('fake-tts.mjs')],
      voicesDir: fixture('voices'),
      defaultVoice: TEST_VOICE,
      spareSynth: false,
    },
    revision: 1,
  });
  const { host, open } = await world(t, {
    settings,
    kinds: speechKinds,
    stateDir,
  });
  const { port, socket, ready } = await open();
  t.true(ready.speechIn);
  t.true(ready.speechOut);
  const { stream } = await E(port).transcribe();
  socket.send(frameKinds.audio, stream, new Uint8Array(32_000));
  socket.send(frameKinds.end, stream);
  const final = await socket.event(stream, 'final');
  t.regex(final.text, /^final \d+$/);
  await socket.event(stream, 'end');
  const replay = await E(host.speech).replay(port, [
    'The fake engine speaks this sentence.',
  ]);
  await socket.event(replay.stream, 'end');
  t.true(socket.pcmBytes(replay.stream) > 0);
});
