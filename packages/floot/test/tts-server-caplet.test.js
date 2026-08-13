// @ts-check
// The TTS caplet's streaming pipeline, driven against a fake piper binary
// (test/fixtures/fake-piper.mjs) that mimics piper's wire shape: one utterance
// per stdin line, audio streamed to stdout per line, exit 0 on stdin EOF.
import test from '@endo/ses-ava/prepare-endo.js';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { make } from '../voice/tts-server-caplet.js';

const fakePiper = fileURLToPath(
  new URL('./fixtures/fake-piper.mjs', import.meta.url),
);

// Stand up the caplet over a temp voice dir and the fake piper binary.
const makeTtsServer = async t => {
  const dir = await mkdtemp(nodePath.join(os.tmpdir(), 'floot-tts-test-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const modelPath = nodePath.join(dir, 'en_US-test-low.onnx');
  await writeFile(modelPath, 'fake onnx');
  await writeFile(
    `${modelPath}.json`,
    JSON.stringify({ audio: { sample_rate: 16_000 } }),
  );
  await chmod(fakePiper, 0o755);
  const logPath = nodePath.join(dir, 'spawns.log');
  process.env.FAKE_PIPER_LOG = logPath;
  t.teardown(() => {
    delete process.env.FAKE_PIPER_LOG;
  });
  const server = await make(undefined, undefined, {
    env: {
      FLOOT_TTS_BINARY: fakePiper,
      FLOOT_TTS_MODEL: modelPath,
    },
  });
  const spawnCount = async () => {
    try {
      const log = await readFile(logPath, 'utf-8');
      return log.split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  return { server, spawnCount };
};

const collect = async reader => {
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(value);
  }
  return events;
};

test('one piper process serves a whole multi-sentence reply', async t => {
  t.timeout(20_000);
  const { server, spawnCount } = await makeTtsServer(t);

  const { push, reader: textReader } = makeBufferedReader();
  // The static reader type carries no remotable brand, but at runtime the
  // buffered reader is an exo — cast across the guarded Passable boundary.
  const audioReader = server.synthesize(/** @type {any} */ (textReader));
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
  // read may split or merge sentences), but order and content must hold. The
  // fixture's total output length is even, like real s16le PCM — the caplet's
  // sample-alignment carry drops a trailing half-sample, never a full one.
  const audio = bytesEvents.map(e => atob(e.b64)).join('');
  t.is(audio, '[First sentence here.][Second sentence goes on.][And the tail]');
  // The latency regression under test: the previous design spawned one piper
  // (with a full ONNX model load) PER SENTENCE; now one process serves the
  // whole reply.
  t.is(await spawnCount(), 1);
});

test('an empty reply spawns no piper at all', async t => {
  t.timeout(20_000);
  const { server, spawnCount } = await makeTtsServer(t);
  const { push, reader: textReader } = makeBufferedReader();
  // The static reader type carries no remotable brand, but at runtime the
  // buffered reader is an exo — cast across the guarded Passable boundary.
  const audioReader = server.synthesize(/** @type {any} */ (textReader));
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
  // The static reader type carries no remotable brand, but at runtime the
  // buffered reader is an exo — cast across the guarded Passable boundary.
  const audioReader = server.synthesize(/** @type {any} */ (textReader));
  push({ type: 'delta', text: 'Something to say. ' });
  push({ type: 'abort', reason: 'barge-in' });
  const events = await collect(audioReader);
  t.is(events.at(-1)?.type, 'abort');
  t.is(events.at(-1)?.reason, 'barge-in');
});
