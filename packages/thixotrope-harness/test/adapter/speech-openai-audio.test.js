// @ts-check
// The `openai-audio` speech engines (AH/speech/openai-audio.js;
// designs/m11-interfaces.md 6.3, 14.2) against the fake speech server on
// 127.0.0.1: partials and the final, PCM per sentence, 401, 429, 500, hang,
// slow and stalled bodies, bounded answers, backpressure, the key through
// the grant per request and never in a log line or an event. The
// `[real-provider]` case runs only with THIX_HARNESS_REAL_SPEECH=provider.
import test from '@endo/ses-ava/test.js';

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Far } from '@endo/far';

import {
  BASE_URL_REFUSED,
  WAV_HEADER_BYTES,
  makeOpenAiSpeechIn,
  makeOpenAiSpeechOut,
  openAiAudioKind,
  wavOf,
} from '../../resources/agent-host/impl/speech/openai-audio.js';
import {
  speechTextOf,
  speechTexts,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import {
  FAKE_SPEECH_RATE,
  SPEECH_BODY_MARKER,
  fakeSpeechPcm,
  sha256Of,
  startFakeSpeechServer,
} from '../fixtures/fake-speech-server.mjs';

// Built at run time so no committed string looks like a provider key.
const KEY = ['placeholder', 'speech', 'value'].join('-');
const grant = Far('ReadGrant', {});
/** @param {unknown} g */
const readGrant = async g => {
  if (g !== grant) throw Error('not this grant');
  return KEY;
};
/** A reader that counts its reads (tests of one file run at once). */
const countingReader = () => {
  let reads = 0;
  return {
    /** @param {unknown} g */
    readGrant: async g => {
      reads += 1;
      return readGrant(g);
    },
    reads: () => reads,
  };
};

const fast = harden({
  sttIdleMs: 2000,
  engineTimeoutMs: 300,
  synthTimeoutMs: 300,
  requestTimeoutMs: 2000,
});

/**
 * @param {import('../fixtures/fake-speech-server.mjs').FakeSpeechServer} server
 * @param {object} [extra]
 */
const inSettings = (server, extra = {}) =>
  harden({
    kind: 'openai-audio',
    baseUrl: server.baseUrl,
    model: 'fake-stt-model',
    language: 'en',
    key: grant,
    partialIntervalMs: 40,
    ...extra,
  });

/**
 * @param {import('../fixtures/fake-speech-server.mjs').FakeSpeechServer} server
 * @param {object} [extra]
 */
const outSettings = (server, extra = {}) =>
  harden({
    kind: 'openai-audio',
    baseUrl: server.baseUrl,
    model: 'fake-tts-model',
    voices: ['alloy', 'verse'],
    key: grant,
    ...extra,
  });

const checked = harden({
  voice: 'verse',
  speed: 1,
  noiseScale: 0.667,
  noiseW: 0.8,
  sentenceSilence: 0.2,
});

/** A recording `UtteranceSink`; `done` resolves at final or abort. */
const utteranceSink = () => {
  /** @type {any[]} */
  const events = [];
  /** @type {(value: any) => void} */
  let settle = () => {};
  const done = new Promise(resolve => {
    settle = resolve;
  });
  const sink = harden({
    /** @param {string} phase */
    phase: phase => events.push({ phase }),
    /** @param {string} text */
    partial: text => events.push({ partial: text }),
    /** @param {string} text */
    final: text => {
      events.push({ final: text });
      settle({ final: text });
    },
    /** @param {string} reason */
    abort: reason => {
      events.push({ abort: reason });
      settle({ abort: reason });
    },
  });
  return { sink, events, done };
};

/**
 * A recording `PlaybackSink`; `done` resolves at end or abort. `gate`, when
 * given, is awaited by `drained()`.
 * @param {{ gate?: () => Promise<void> }} [options]
 */
const playbackSink = ({ gate } = {}) => {
  /** @type {any[]} */
  const events = [];
  let pcmBytes = 0;
  /** @type {(value: any) => void} */
  let settle = () => {};
  const done = new Promise(resolve => {
    settle = resolve;
  });
  const sink = harden({
    /**
     * @param {Uint8Array} pcm
     * @param {number} rate
     */
    pcm: (pcm, rate) => {
      pcmBytes += pcm.byteLength;
      events.push({ pcm: pcm.byteLength, rate });
    },
    drained: async () => (gate === undefined ? undefined : gate()),
    /** @param {string} phase */
    phase: phase => events.push({ phase }),
    /** @param {number} index */
    sentenceFailed: index => events.push({ sentenceFailed: index }),
    end: () => {
      events.push({ end: true });
      settle({ end: true });
    },
    /** @param {string} reason */
    abort: reason => {
      events.push({ abort: reason });
      settle({ abort: reason });
    },
  });
  return { sink, events, done, pcmBytes: () => pcmBytes };
};

/**
 * Zeros of `bytes` (16 kHz s16le).
 * @param {number} bytes
 */
const pcmOf = bytes => new Uint8Array(bytes);

/**
 * @param {import('ava').ExecutionContext} t
 * @param {unknown[]} logs
 * @param {unknown[]} events
 */
const assertNothingLeaks = (t, logs, events) => {
  const seen = JSON.stringify([logs, events]);
  t.false(seen.includes(KEY), 'the key is in no log line or event');
  t.false(seen.includes(SPEECH_BODY_MARKER), 'no provider body is shown');
};

const startServer = async t => {
  const server = await startFakeSpeechServer({ slowMs: 60 });
  t.teardown(server.close);
  return server;
};

test('wavOf writes a 16 kHz mono 16-bit RIFF header', t => {
  const wav = wavOf(new Uint8Array([1, 2, 3, 4]));
  t.is(wav.byteLength, WAV_HEADER_BYTES + 4);
  const view = new DataView(wav.buffer);
  t.is(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  t.is(view.getUint32(24, true), 16_000);
  t.is(view.getUint16(34, true), 16);
  t.is(view.getUint32(40, true), 4);
  t.deepEqual([...wav.slice(WAV_HEADER_BYTES)], [1, 2, 3, 4]);
});

test('the kind record has one maker per direction', t => {
  t.is(openAiAudioKind.speechIn, makeOpenAiSpeechIn);
  t.is(openAiAudioKind.speechOut, makeOpenAiSpeechOut);
});

test('a base URL that is not https or loopback http is refused before any key read', async t => {
  const server = await startServer(t);
  const reader = countingReader();
  for (const baseUrl of [
    'ftp://127.0.0.1/v1',
    'http://127.0.0.1/v1?x=1',
    'http://user:pw@127.0.0.1/v1',
    'not a url',
  ]) {
    t.throws(
      () =>
        makeOpenAiSpeechIn({
          settings: inSettings(server, { baseUrl }),
          readGrant: reader.readGrant,
        }),
      { message: BASE_URL_REFUSED },
    );
    t.throws(
      () =>
        makeOpenAiSpeechOut({
          settings: outSettings(server, { baseUrl }),
          readGrant: reader.readGrant,
        }),
      { message: BASE_URL_REFUSED },
    );
  }
  t.is(reader.reads(), 0);
  t.is(server.requests().length, 0);
});

test('speech in: cumulative partials while open, then the final after end; the key is a bearer read per request', async t => {
  const server = await startServer(t);
  /** @type {any[]} */
  const logs = [];
  const reader = countingReader();
  const engine = makeOpenAiSpeechIn({
    settings: inSettings(server),
    readGrant: reader.readGrant,
    log: line => logs.push(line),
    timeouts: fast,
  });
  t.is(engine.state(), 'ready');
  await engine.warm();
  const { sink, events, done } = utteranceSink();
  const utterance = engine.open(sink);
  t.deepEqual(events[0], { phase: 'listening' });
  for (let i = 0; i < 6; i += 1) {
    utterance.audio(pcmOf(2720));
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
  utterance.audio(pcmOf(3)); // a trailing odd byte is dropped
  await sleep(80);
  utterance.end();
  const result = await done;
  const total = 6 * 2720 + 2;
  t.deepEqual(result, { final: `final ${total}` });
  const partials = events.filter(e => 'partial' in e).map(e => e.partial);
  t.true(partials.length >= 1, 'at least one partial');
  const sizes = partials.map(text => Number(text.split(' ')[1]));
  t.deepEqual(
    sizes,
    [...sizes].sort((a, b) => a - b),
    'partials replace each other in order',
  );
  t.true(sizes.every(n => n > 0 && n <= total));
  const transcribing = events.findIndex(e => e.phase === 'transcribing');
  t.true(transcribing > 0);
  t.false(
    events.slice(transcribing).some(e => 'partial' in e),
    'no partial after end',
  );
  const requests = server.requests();
  t.true(requests.every(r => r.path === '/v1/audio/transcriptions'));
  t.true(
    requests.every(r => r.authorizationSha256 === sha256Of(`Bearer ${KEY}`)),
  );
  const last = requests[requests.length - 1];
  t.like(last, {
    model: 'fake-stt-model',
    language: 'en',
    responseFormat: 'json',
    pcmBytes: total,
    wavRate: 16_000,
  });
  t.is(reader.reads(), requests.length, 'one key read per request');
  assertNothingLeaks(t, logs, events);
});

test('speech in: no partial while the audio is unchanged; no authorization without a key', async t => {
  const server = await startServer(t);
  const engine = makeOpenAiSpeechIn({
    settings: inSettings(server, { key: undefined, partialIntervalMs: 20 }),
    readGrant,
    timeouts: fast,
  });
  const { sink, done } = utteranceSink();
  const utterance = engine.open(sink);
  utterance.audio(pcmOf(3200));
  await sleep(150);
  t.is(server.requests().length, 1, 'one partial for one change');
  utterance.end();
  t.deepEqual(await done, { final: 'final 3200' });
  t.true(server.requests().every(r => r.authorizationSha256 === undefined));
});

for (const status of ['401', '403', '429', '500']) {
  test(`speech in: ${status} aborts the utterance with engineFailed and logs the status only`, async t => {
    const server = await startServer(t);
    /** @type {any[]} */
    const logs = [];
    const engine = makeOpenAiSpeechIn({
      settings: inSettings(server, { partialIntervalMs: 60_000 }),
      readGrant,
      log: line => logs.push(line),
      timeouts: fast,
    });
    server.setModes([status]);
    const { sink, events, done } = utteranceSink();
    const utterance = engine.open(sink);
    utterance.audio(pcmOf(2720));
    utterance.end();
    t.deepEqual(await done, { abort: speechTexts.engineFailed });
    t.deepEqual(logs, [
      {
        event: 'speech-engine-failed',
        kind: 'openai-audio',
        direction: 'in',
        stage: 'status',
        status: Number(status),
      },
    ]);
    assertNothingLeaks(t, logs, events);
  });
}

test('speech in: a failed partial aborts the utterance (no retry)', async t => {
  const server = await startServer(t);
  const engine = makeOpenAiSpeechIn({
    settings: inSettings(server, { partialIntervalMs: 20 }),
    readGrant,
    timeouts: fast,
  });
  server.setModes(['429']);
  const { sink, done } = utteranceSink();
  const utterance = engine.open(sink);
  utterance.audio(pcmOf(2720));
  t.deepEqual(await done, { abort: speechTexts.engineFailed });
  utterance.audio(pcmOf(2720));
  utterance.end();
  await sleep(50);
  t.is(server.requests().length, 1, 'nothing more is sent after the abort');
});

test('speech in: a final that hangs aborts with engineTimeout after engineTimeoutMs', async t => {
  const server = await startServer(t);
  /** @type {any[]} */
  const logs = [];
  const engine = makeOpenAiSpeechIn({
    settings: inSettings(server, { partialIntervalMs: 60_000 }),
    readGrant,
    log: line => logs.push(line),
    timeouts: fast,
  });
  server.setModes(['hang']);
  const { sink, done } = utteranceSink();
  const utterance = engine.open(sink);
  utterance.audio(pcmOf(2720));
  const t0 = Date.now();
  utterance.end();
  t.deepEqual(await done, { abort: speechTexts.engineTimeout });
  const waited = Date.now() - t0;
  t.true(waited >= 280 && waited < 1500, `waited ${waited} ms`);
  t.like(logs[0], { event: 'speech-engine-timeout', stage: 'timeout' });
  await sleep(50);
  t.true(server.requests()[0].closed, 'the request was cancelled');
});

test('speech in: a slow answer within the timeout is read', async t => {
  const server = await startServer(t);
  const engine = makeOpenAiSpeechIn({
    settings: inSettings(server, { partialIntervalMs: 60_000 }),
    readGrant,
    timeouts: fast,
  });
  server.setModes(['slow-body']);
  const { sink, done } = utteranceSink();
  const utterance = engine.open(sink);
  utterance.audio(pcmOf(100));
  utterance.end();
  t.deepEqual(await done, { final: 'final 100' });
});

for (const mode of ['huge-json', 'bad-json']) {
  test(`speech in: ${mode} fails the bounded read with engineFailed`, async t => {
    const server = await startServer(t);
    /** @type {any[]} */
    const logs = [];
    const engine = makeOpenAiSpeechIn({
      settings: inSettings(server, { partialIntervalMs: 60_000 }),
      readGrant,
      log: line => logs.push(line),
      timeouts: fast,
    });
    server.setModes([mode]);
    const { sink, done } = utteranceSink();
    const utterance = engine.open(sink);
    utterance.audio(pcmOf(100));
    utterance.end();
    t.deepEqual(await done, { abort: speechTexts.engineFailed });
    t.like(logs[0], { stage: 'answer' });
  });
}

test('speech in: a key read failure fails without a request', async t => {
  const server = await startServer(t);
  /** @type {any[]} */
  const logs = [];
  const engine = makeOpenAiSpeechIn({
    settings: inSettings(server, {
      key: Far('ReadGrant', {}),
      partialIntervalMs: 60_000,
    }),
    readGrant,
    log: line => logs.push(line),
    timeouts: fast,
  });
  const { sink, done } = utteranceSink();
  const utterance = engine.open(sink);
  utterance.end();
  t.deepEqual(await done, { abort: speechTexts.engineFailed });
  t.like(logs[0], { stage: 'key' });
  t.is(server.requests().length, 0);
});

test('speech in: no audio for sttIdleMs aborts; the utterance bound ends it with a final', async t => {
  const server = await startServer(t);
  const idle = makeOpenAiSpeechIn({
    settings: inSettings(server, { partialIntervalMs: 60_000 }),
    readGrant,
    timeouts: { ...fast, sttIdleMs: 60 },
  });
  const first = utteranceSink();
  idle.open(first.sink).audio(pcmOf(100));
  t.deepEqual(await first.done, { abort: speechTexts.sttIdle });

  const bounded = makeOpenAiSpeechIn({
    settings: inSettings(server, { partialIntervalMs: 60_000 }),
    readGrant,
    timeouts: fast,
    limits: { utteranceBytes: 5000 },
  });
  const second = utteranceSink();
  const utterance = bounded.open(second.sink);
  utterance.audio(pcmOf(2720));
  utterance.audio(pcmOf(2720));
  utterance.audio(pcmOf(2720)); // ignored: already ending
  t.deepEqual(await second.done, { final: 'final 5000' });
  t.true(second.events.some(e => e.phase === 'transcribing'));
});

test('speech in: abort and stop end utterances with at most one sink call', async t => {
  const server = await startServer(t);
  const engine = makeOpenAiSpeechIn({
    settings: inSettings(server, { partialIntervalMs: 60_000 }),
    readGrant,
    timeouts: fast,
  });
  server.setModes(['hang', 'hang']);
  const aborted = utteranceSink();
  const one = engine.open(aborted.sink);
  one.audio(pcmOf(100));
  one.end();
  await sleep(30);
  one.abort();
  const stopped = utteranceSink();
  const two = engine.open(stopped.sink);
  two.audio(pcmOf(100));
  await engine.stop();
  t.deepEqual(await stopped.done, { abort: speechTexts.serviceStopped });
  t.is(engine.state(), 'off');
  await sleep(400);
  t.deepEqual(aborted.events, [
    { phase: 'listening' },
    { phase: 'transcribing' },
  ]);
  const late = utteranceSink();
  engine.open(late.sink);
  t.deepEqual(await late.done, { abort: speechTexts.serviceStopped });
});

test('speech out: the catalogue is the settings voices at 24 kHz; an unusable default voice warns', async t => {
  const server = await startServer(t);
  const engine = makeOpenAiSpeechOut({
    settings: outSettings(server, { defaultVoice: 'verse', defaultSpeed: 1.5 }),
    readGrant,
  });
  const catalogue = await engine.catalogue();
  t.deepEqual(catalogue.voices, [
    { id: 'alloy', name: 'alloy', sampleRate: FAKE_SPEECH_RATE },
    { id: 'verse', name: 'verse', sampleRate: FAKE_SPEECH_RATE },
  ]);
  t.like(catalogue.defaults, { voice: 'verse', speed: 1.5 });
  t.is(catalogue.warning, undefined);
  const first = makeOpenAiSpeechOut({
    settings: outSettings(server),
    readGrant,
  });
  t.is((await first.catalogue()).defaults.voice, 'alloy');
  const broken = makeOpenAiSpeechOut({
    settings: outSettings(server, { defaultVoice: 'missing' }),
    readGrant,
  });
  t.is(
    (await broken.catalogue()).warning,
    speechTextOf.unknownVoice('missing'),
  );
});

test('speech out: PCM per sentence at 24 kHz, sentences requested one after another', async t => {
  const server = await startServer(t);
  /** @type {any[]} */
  const logs = [];
  const engine = makeOpenAiSpeechOut({
    settings: outSettings(server),
    readGrant,
    log: line => logs.push(line),
    timeouts: fast,
    limits: { pcmFrameBytes: 2004 },
  });
  const { sink, events, done, pcmBytes } = playbackSink();
  const synthesis = engine.open({ ...checked, speed: 8 }, sink);
  t.deepEqual(events, [], 'nothing before the first sentence (lazy)');
  const sentences = ['Hello there, this is one.', 'And here is two.'];
  for (const sentence of sentences) synthesis.sentence(sentence);
  synthesis.end();
  t.deepEqual(await done, { end: true });
  t.deepEqual(events[0], { phase: 'synthesizing' });
  t.is(events.filter(e => e.phase).length, 1);
  const expected = sentences
    .map(s => fakeSpeechPcm(s, 4).length)
    .reduce((a, b) => a + b, 0);
  t.is(pcmBytes(), expected, 'speed 8 is clamped to 4');
  /** @type {{ pcm: number, rate: number }[]} */
  const frames = events.filter(e => 'pcm' in e);
  t.true(frames.every(f => f.rate === FAKE_SPEECH_RATE));
  t.true(frames.every(f => f.pcm <= 2000 && f.pcm % 2 === 0));
  const requests = server.requests();
  t.deepEqual(
    requests.map(r => r.json),
    sentences.map(input => ({
      model: 'fake-tts-model',
      input,
      voice: 'verse',
      speed: 4,
      response_format: 'pcm',
    })),
  );
  t.true(requests.every(r => r.completed));
  t.true(
    requests.every(r => r.authorizationSha256 === sha256Of(`Bearer ${KEY}`)),
  );
  assertNothingLeaks(t, logs, events);
});

test('speech out: odd body chunks are forwarded as whole samples', async t => {
  const server = await startServer(t);
  const engine = makeOpenAiSpeechOut({
    settings: outSettings(server),
    readGrant,
    timeouts: fast,
  });
  server.setModes(['odd-chunks']);
  const { sink, events, done, pcmBytes } = playbackSink();
  const synthesis = engine.open(checked, sink);
  synthesis.sentence('Twenty characters ok.');
  synthesis.end();
  await done;
  t.is(pcmBytes(), fakeSpeechPcm('Twenty characters ok.').length);
  t.true(events.filter(e => 'pcm' in e).every(f => f.pcm % 2 === 0));
});

for (const status of ['429', '500']) {
  test(`speech out: ${status} fails that sentence and the next plays`, async t => {
    const server = await startServer(t);
    /** @type {any[]} */
    const logs = [];
    const engine = makeOpenAiSpeechOut({
      settings: outSettings(server),
      readGrant,
      log: line => logs.push(line),
      timeouts: fast,
    });
    server.setModes([status]);
    const { sink, events, done, pcmBytes } = playbackSink();
    const synthesis = engine.open(checked, sink);
    synthesis.sentence('First sentence here.');
    synthesis.sentence('Second sentence here.');
    synthesis.end();
    t.deepEqual(await done, { end: true });
    t.true(events.some(e => e.sentenceFailed === 0));
    t.is(pcmBytes(), fakeSpeechPcm('Second sentence here.').length);
    t.like(logs[0], {
      direction: 'out',
      stage: 'status',
      status: Number(status),
    });
    assertNothingLeaks(t, logs, events);
  });
}

for (const status of ['401', '403']) {
  test(`speech out: ${status} aborts the playback with synthFailed`, async t => {
    const server = await startServer(t);
    const engine = makeOpenAiSpeechOut({
      settings: outSettings(server),
      readGrant,
      timeouts: fast,
    });
    server.setModes([status]);
    const { sink, done } = playbackSink();
    const synthesis = engine.open(checked, sink);
    synthesis.sentence('First sentence here.');
    synthesis.sentence('Second sentence here.');
    t.deepEqual(await done, { abort: speechTexts.synthFailed });
    await sleep(30);
    t.is(server.requests().length, 1, 'the second sentence is not requested');
  });
}

for (const mode of ['hang', 'stall-body', 'empty-body']) {
  test(`speech out: ${mode} fails that sentence (synthTimeoutMs) and the next plays`, async t => {
    const server = await startServer(t);
    const engine = makeOpenAiSpeechOut({
      settings: outSettings(server),
      readGrant,
      timeouts: fast,
    });
    server.setModes([mode]);
    const { sink, events, done, pcmBytes } = playbackSink();
    const synthesis = engine.open(checked, sink);
    synthesis.sentence('First sentence here.');
    synthesis.sentence('Second sentence here.');
    synthesis.end();
    const t0 = Date.now();
    t.deepEqual(await done, { end: true });
    t.true(events.some(e => e.sentenceFailed === 0));
    t.false(events.some(e => e.sentenceFailed === 1));
    t.true(pcmBytes() >= fakeSpeechPcm('Second sentence here.').length);
    if (mode !== 'empty-body') {
      t.true(Date.now() - t0 >= 250, 'waited for synthTimeoutMs');
      await sleep(30);
      t.true(server.requests()[0].closed, 'the request was cancelled');
    }
  });
}

test('speech out: a slow body within synthTimeoutMs plays whole', async t => {
  const server = await startServer(t);
  const engine = makeOpenAiSpeechOut({
    settings: outSettings(server),
    readGrant,
    timeouts: fast,
  });
  server.setModes(['slow-body']);
  const { sink, events, done, pcmBytes } = playbackSink();
  const synthesis = engine.open(checked, sink);
  synthesis.sentence('A sentence of thirty characters.');
  synthesis.end();
  t.deepEqual(await done, { end: true });
  t.false(events.some(e => 'sentenceFailed' in e));
  t.is(pcmBytes(), fakeSpeechPcm('A sentence of thirty characters.').length);
});

test('speech out: nothing more is read while the sink is not drained, and the clock stops', async t => {
  const server = await startServer(t);
  /** @type {() => void} */
  let open = () => {};
  let gate = new Promise(resolve => {
    open = () => resolve(undefined);
  });
  const engine = makeOpenAiSpeechOut({
    settings: outSettings(server),
    readGrant,
    timeouts: { ...fast, synthTimeoutMs: 100 },
    limits: { pcmFrameBytes: 2004 },
  });
  const { sink, events, done } = playbackSink({ gate: () => gate });
  const synthesis = engine.open(checked, sink);
  synthesis.sentence('A sentence that has forty characters ok.');
  synthesis.end();
  await sleep(300);
  t.is(events.filter(e => 'pcm' in e).length, 1, 'paused after one frame');
  t.false(
    events.some(e => 'sentenceFailed' in e),
    'no timeout while paused',
  );
  gate = Promise.resolve();
  open();
  t.deepEqual(await done, { end: true });
  t.true(events.filter(e => 'pcm' in e).length > 1);
});

test('speech out: abort stops the request with no further sink call; stop aborts with serviceStopped', async t => {
  const server = await startServer(t);
  const engine = makeOpenAiSpeechOut({
    settings: outSettings(server),
    readGrant,
    timeouts: fast,
  });
  server.setModes(['slow-body', 'slow-body']);
  const first = playbackSink();
  const synthesis = engine.open(checked, first.sink);
  synthesis.sentence('A long sentence that keeps on going for a while.');
  await sleep(90);
  synthesis.abort();
  const count = first.events.length;
  await sleep(200);
  t.is(first.events.length, count, 'no sink call after abort');
  t.true(server.requests()[0].closed);

  const second = playbackSink();
  engine.open(checked, second.sink).sentence('Another sentence here.');
  await sleep(30);
  await engine.stop();
  t.deepEqual(await second.done, { abort: speechTexts.serviceStopped });
  t.is(engine.state(), 'off');
});

const realProvider = process.env.THIX_HARNESS_REAL_SPEECH === 'provider';
(realProvider ? test : test.skip)(
  '[real-provider] a short synthesis transcribes back (THIX_HARNESS_SPEECH_BASE_URL, THIX_HARNESS_SPEECH_KEY_FILE)',
  async t => {
    const baseUrl = String(process.env.THIX_HARNESS_SPEECH_BASE_URL);
    const keyFile = String(process.env.THIX_HARNESS_SPEECH_KEY_FILE);
    const realKey = readFileSync(keyFile, 'utf8').trim();
    const realGrant = Far('ReadGrant', {});
    const realRead = async () => realKey;
    /** @type {any[]} */
    const logs = [];
    const out = makeOpenAiSpeechOut({
      settings: harden({
        kind: 'openai-audio',
        baseUrl,
        model: process.env.THIX_HARNESS_SPEECH_TTS_MODEL ?? 'tts-1',
        voices: ['alloy'],
        key: realGrant,
      }),
      readGrant: realRead,
      log: line => logs.push(line),
    });
    /** @type {Uint8Array[]} */
    const pcm = [];
    const played = playbackSink();
    const sink = harden({
      ...played.sink,
      /** @param {Uint8Array} chunk */
      pcm: chunk => pcm.push(chunk),
    });
    const synthesis = out.open({ ...checked, voice: 'alloy' }, sink);
    synthesis.sentence('Hello from the speech test.');
    synthesis.end();
    t.deepEqual(await played.done, { end: true });
    // 24 kHz to 16 kHz by dropping every third sample.
    const all = Buffer.concat(pcm);
    const down = Buffer.alloc(Math.floor(all.length / 3) * 2);
    for (let i = 0, o = 0; o < down.length; i += 6, o += 4) {
      all.copy(down, o, i, i + 4);
    }
    const stt = makeOpenAiSpeechIn({
      settings: harden({
        kind: 'openai-audio',
        baseUrl,
        model: process.env.THIX_HARNESS_SPEECH_STT_MODEL ?? 'whisper-1',
        language: 'en',
        key: realGrant,
        partialIntervalMs: 60_000,
      }),
      readGrant: realRead,
      log: line => logs.push(line),
    });
    const heard = utteranceSink();
    const utterance = stt.open(heard.sink);
    utterance.audio(down);
    utterance.end();
    const result = await heard.done;
    t.log(result);
    t.regex(String(result.final), /hello/i);
    t.false(JSON.stringify([logs, heard.events]).includes(realKey));
  },
);
