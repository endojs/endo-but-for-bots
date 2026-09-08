// @ts-check
// The TTS caplet's streaming pipeline, driven against a fake piper binary
// (test/fixtures/fake-piper.mjs) that mimics piper's wire shape: one utterance
// per stdin line, audio streamed to stdout per line, exit 0 on stdin EOF. The
// fixture logs its spawns and SIGTERMs beside the voice model, so each test's
// temp directory is its own record of how the caplet drove it.
import test from '@endo/ses-ava/prepare-endo.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { make, takeWholeSamples } from '../voice/tts-server-caplet.js';

const fakePiper = fileURLToPath(
  new URL('./fixtures/fake-piper.mjs', import.meta.url),
);

/**
 * Stand up the caplet over a temp voice dir and the fake piper binary.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {object} [options]
 * @param {object} [options.mode] the fixture's failure mode (fake-piper.json)
 * @param {Record<string, string>} [options.env] extra caplet env
 * @param {unknown} [options.context] the daemon caplet context
 * @param {(dir: string) => Promise<void>} [options.seed] extra files to add
 */
const makeTtsServer = async (t, { mode, env, context, seed } = {}) => {
  const dir = await mkdtemp(nodePath.join(os.tmpdir(), 'floot-tts-test-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const modelPath = nodePath.join(dir, 'en_US-test-low.onnx');
  await writeFile(modelPath, 'fake onnx');
  await writeFile(
    `${modelPath}.json`,
    JSON.stringify({ audio: { sample_rate: 16_000 } }),
  );
  if (mode) {
    await writeFile(
      nodePath.join(dir, 'fake-piper.json'),
      JSON.stringify(mode),
    );
  }
  if (seed) await seed(dir);
  // The exo's guard-derived parameter types are bare Passables; the readers
  // handed to synthesize below are exo StreamReaders, so treat the server as
  // the untyped capability a caller sees over CapTP.
  /** @type {any} */
  const server = await make(undefined, context, {
    env: {
      FLOOT_TTS_BINARY: fakePiper,
      FLOOT_TTS_MODEL: modelPath,
      ...env,
    },
  });
  // What the fixture recorded: one line per spawn or SIGTERM. No log file yet
  // means no spawn yet.
  const spawnLog = async () => {
    const log = await readFile(nodePath.join(dir, 'spawns.log'), 'utf-8').catch(
      () => '',
    );
    return log.split('\n').filter(Boolean);
  };
  const spawnCount = async () => {
    const lines = await spawnLog();
    return lines.length;
  };
  return { server, modelPath, spawnLog, spawnCount };
};

/**
 * Read an audio wire to completion.
 *
 * @param {any} reader
 * @returns {Promise<any[]>}
 */
const collect = async reader => {
  /** @type {any[]} */
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(value);
  }
  return events;
};

/**
 * A text wire whose close (the caplet letting go of it) the test can observe.
 */
const makeTextWire = () => {
  const kit = makeBufferedReader();
  let closed = false;
  kit.setOnClose(() => {
    closed = true;
  });
  return { ...kit, closed: () => closed };
};

/**
 * Wait, with real time passing, until `predicate` holds — a signal to the
 * fixture process and its log line back take longer than a microtask.
 *
 * @param {() => Promise<boolean> | boolean} predicate
 */
const eventually = async predicate => {
  const deadline = Date.now() + 5000;
  await null;
  // eslint-disable-next-line no-await-in-loop
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error('the expected state never arrived');
    // eslint-disable-next-line no-await-in-loop
    await delay(10);
  }
};

test('one piper process serves a whole multi-sentence reply', async t => {
  t.timeout(20_000);
  const { server, spawnCount } = await makeTtsServer(t);

  const { push, reader: textReader } = makeBufferedReader();
  const audioReader = server.synthesize(textReader);
  // Deltas arrive as an LLM would stream them; the chunker flushes a sentence
  // once its trailing whitespace confirms the boundary.
  push({ type: 'delta', text: 'First sentence here. Second sentence ' });
  push({ type: 'delta', text: 'goes on. And the tail' });
  push({ type: 'end' });

  const events = await collect(audioReader);
  t.deepEqual(events[0], { type: 'phase', phase: 'synthesizing' });
  t.is(events.at(-1)?.type, 'end');
  const bytesEvents = events.filter(e => e.type === 'bytes');
  t.true(bytesEvents.length >= 1);
  for (const e of bytesEvents) {
    t.is(e.sampleRate, 16_000);
  }
  // Reassemble the streamed audio: chunk framing carries no meaning (a pipe
  // read may split or merge sentences), but order and content must hold.
  const audio = bytesEvents.map(e => atob(e.b64)).join('');
  t.is(audio, '[First sentence here.][Second sentence goes on.][And the tail]');
  // The latency regression under test: the previous design spawned one piper
  // (with a full ONNX model load) PER SENTENCE; now one process serves the
  // whole reply.
  t.is(await spawnCount(), 1);
});

test('whole samples are forwarded and the odd byte carried into the next read', t => {
  // Reads that split s16le samples: the driver forwards whole samples only
  // and holds the odd byte over, so nothing downstream is ever misaligned.
  const reads = [3, 15, 3, 3].map((length, i) =>
    Buffer.alloc(length, 0x41 + i),
  );
  /** @type {Buffer | null} */
  let carry = null;
  /** @type {Buffer[]} */
  const forwarded = [];
  for (const chunk of reads) {
    const aligned = takeWholeSamples(carry, chunk);
    carry = aligned.carry;
    if (aligned.whole) forwarded.push(aligned.whole);
  }
  t.deepEqual(
    forwarded.map(chunk => chunk.length),
    [2, 16, 2, 4],
  );
  t.deepEqual(Buffer.concat(forwarded), Buffer.concat(reads));
  t.is(carry, null);
  // A lone odd byte waits for the next read.
  const lone = takeWholeSamples(null, Buffer.from([0x7f]));
  t.is(lone.whole, null);
  t.deepEqual(lone.carry, Buffer.from([0x7f]));
});

test('audio split mid-sample across pipe reads is realigned, not dropped', async t => {
  t.timeout(20_000);
  // The fixture writes each utterance in two odd-length pieces a moment
  // apart, so reads straddle s16le samples — unless the pipe coalesces the
  // pieces first, which no writer can rule out, so how many events arrive is
  // not asserted; the alignment and reassembly always are.
  const { server } = await makeTtsServer(t, { mode: { split: true } });
  const { push, reader: textReader } = makeBufferedReader();
  const audioReader = server.synthesize(textReader);
  push({ type: 'delta', text: 'First sentence here. Second sentence ' });
  push({ type: 'delta', text: 'goes on. And the tail' });
  push({ type: 'end' });

  const events = await collect(audioReader);
  const chunks = events.filter(e => e.type === 'bytes').map(e => atob(e.b64));
  // Whole samples only, on every event — the carry holds the odd byte over.
  for (const chunk of chunks) {
    t.is(chunk.length % 2, 0);
  }
  t.is(
    chunks.join(''),
    '[First sentence here.][Second sentence goes on.][And the tail]',
  );
});

test('an empty reply spawns no piper at all', async t => {
  t.timeout(20_000);
  const { server, spawnCount } = await makeTtsServer(t);
  const { push, reader: textReader } = makeBufferedReader();
  const audioReader = server.synthesize(textReader);
  push({ type: 'end' });
  const events = await collect(audioReader);
  t.deepEqual(events, [
    { type: 'phase', phase: 'synthesizing' },
    { type: 'end' },
  ]);
  t.is(await spawnCount(), 0);
});

test('a text-side abort aborts the audio stream', async t => {
  t.timeout(20_000);
  const { server } = await makeTtsServer(t);
  const { push, reader: textReader } = makeBufferedReader();
  const audioReader = server.synthesize(textReader);
  push({ type: 'delta', text: 'Something to say. ' });
  push({ type: 'abort', reason: 'barge-in' });
  const events = await collect(audioReader);
  t.is(events.at(-1)?.type, 'abort');
  t.is(events.at(-1)?.reason, 'barge-in');
});

test('a piper that fails on its own ends the audio wire at once', async t => {
  t.timeout(20_000);
  const { server } = await makeTtsServer(t, { mode: { exitCode: 1 } });
  const text = makeTextWire();
  const audioReader = server.synthesize(text.reader);
  text.push({ type: 'delta', text: 'Something to say. ' });
  // No `end` is ever pushed: the failure alone must end the audio wire, or a
  // live reply would sit in "synthesizing" until the whole turn finished.
  const events = await collect(audioReader);
  t.deepEqual(events[0], { type: 'phase', phase: 'synthesizing' });
  t.is(events.at(-1)?.type, 'abort');
  t.regex(events.at(-1)?.reason, /piper exited with code 1/);
  // And it stops pulling the text wire, releasing whoever feeds it.
  await eventually(text.closed);
  t.true(text.closed());
});

test('an audio consumer that hangs up kills piper and releases the text wire', async t => {
  t.timeout(20_000);
  const { server, spawnLog } = await makeTtsServer(t);
  const text = makeTextWire();
  const audio = iterateReader(server.synthesize(text.reader));
  text.push({ type: 'delta', text: 'First sentence here. ' });
  // Wait until piper is demonstrably running (its first audio arrived), then
  // stop pulling — what barge-in, mute, or a settings change looks like here.
  /** @type {any} */
  let first;
  do {
    // eslint-disable-next-line no-await-in-loop
    first = (await audio.next()).value;
  } while (first?.type !== 'bytes');
  await audio.return();
  await eventually(async () => {
    const lines = await spawnLog();
    return lines.includes('sigterm');
  });
  t.deepEqual(await spawnLog(), ['spawn', 'sigterm']);
  await eventually(text.closed);
  t.true(text.closed());
});

test('cancelling the caplet stops every synthesis in flight', async t => {
  t.timeout(20_000);
  /** @type {(reason: Error) => void} */
  let cancel = () => {};
  const context = harden({
    whenCancelled: () =>
      new Promise((_resolve, reject) => {
        cancel = reject;
      }),
  });
  const { server, spawnLog } = await makeTtsServer(t, { context });
  const text = makeTextWire();
  const audio = iterateReader(server.synthesize(text.reader));
  text.push({ type: 'delta', text: 'First sentence here. ' });
  /** @type {any} */
  let first;
  do {
    // eslint-disable-next-line no-await-in-loop
    first = (await audio.next()).value;
  } while (first?.type !== 'bytes');
  cancel(Error('formula removed'));
  /** @type {any[]} */
  const rest = [];
  for await (const event of audio) rest.push(event);
  t.is(rest.at(-1)?.type, 'abort');
  t.is(rest.at(-1)?.reason, 'TTS capability cancelled');
  await eventually(async () => {
    const lines = await spawnLog();
    return lines.includes('sigterm');
  });
  await eventually(text.closed);
  t.true(text.closed());
});

test('getConfiguration advertises voices, defaults, and ranges the options are held to', async t => {
  t.timeout(20_000);
  const { server } = await makeTtsServer(t, {
    env: { FLOOT_TTS_SPEED: '1.5' },
    seed: async dir => {
      // A sibling voice with a config that is really an HTML error page (a
      // failed download) is skipped, not allowed to take the caplet down.
      await writeFile(nodePath.join(dir, 'de_DE-broken-low.onnx'), 'x');
      await writeFile(
        nodePath.join(dir, 'de_DE-broken-low.onnx.json'),
        '<html>404</html>',
      );
      await writeFile(nodePath.join(dir, 'en_GB-other-x_low.onnx'), 'x');
      await writeFile(
        nodePath.join(dir, 'en_GB-other-x_low.onnx.json'),
        JSON.stringify({ audio: { sample_rate: 22_050 } }),
      );
    },
  });
  const config = server.getConfiguration();
  t.deepEqual(config.voices, [
    { id: 'en_GB-other-x_low', name: 'English (UK / Europe) — other (x_low)' },
    { id: 'en_US-test-low', name: 'English (US) — test (low)' },
  ]);
  t.like(config.defaults, { voice: 'en_US-test-low', speed: 1.5 });
  t.deepEqual(config.ranges.speed, { min: 0.25, max: 4, step: 0.05 });

  const wire = () => makeBufferedReader().reader;
  t.throws(() => server.synthesize(wire(), { voice: 'nope' }), {
    message: /Unknown TTS voice "nope"/,
  });
  t.throws(() => server.synthesize(wire(), { speed: 10 }), {
    message: /TTS speed must be a number between 0.25 and 4, got 10/,
  });
  // A number, not anything Number() would coerce.
  t.throws(() => server.synthesize(wire(), { speed: '1.5' }), {
    message: /TTS speed must be a number/,
  });
  t.throws(() => server.synthesize(wire(), { noiseScale: null }), {
    message: /TTS noiseScale must be a number/,
  });
});

test('a configured default speed outside the advertised range is refused at stand-up', async t => {
  t.timeout(20_000);
  // Otherwise every synthesize() would fail validating the default against
  // the range, with no hint at stand-up.
  await t.throwsAsync(
    () => makeTtsServer(t, { env: { FLOOT_TTS_SPEED: '5' } }),
    { message: /FLOOT_TTS_SPEED must be a number between 0.25 and 4, got "5"/ },
  );
});
