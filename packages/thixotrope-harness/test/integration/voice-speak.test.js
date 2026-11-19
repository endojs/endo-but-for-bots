// @ts-check
/**
 * Speech through the daemon (designs/m11-interfaces.md 13; W11.9): the
 * speech extension in the real agent-host adapter, its settings written by
 * the voice provisioning step, the fake process engines, and a Node page
 * (CapTP over `/ws`, binary frames over `/audio`) against the gateway
 * served on a state from the m1a template, with a scripted backend:
 *
 *  1. an utterance of the 16 kHz clip in 85 ms frames gives cumulative
 *     partials and a final after END, a trailing odd byte dropped; ABORT
 *     and a closed socket abort the utterance (the fake logs
 *     `stream_abort`); the utterance costs no vat delivery (D-M11-1).
 *  4. `speak` on a live scripted turn of two rounds with a tool call speaks
 *     the deltas, breaks the sentence at the tool call, never the tool
 *     result, and adds nothing at the final; the same turn, finished, plays
 *     to the end again; an older turn answers `turnNotLive`. The page's
 *     own `Session` presence reaches the same channel inside the adapter
 *     (A-1).
 *  7. barge-in (the server half): the page's ABORT of a playback kills its
 *     fake TTS process, the turn completes and is recorded, and the next
 *     message sent while the turn runs is queued behind it.
 * 11. `Speech.replay(port, pieces)` with an inline piece and the Blob of a
 *     staged reply plays both (A-3: a gateway-local port as an argument;
 *     the Blob read through `Content` in process).
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/voice-speak.test.js
 */
import '../unit/_m1a-prelude.js';

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import {
  frameKinds,
  speechTexts,
} from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { emit } from '../../perf/_harness.mjs';
import { makeClip } from '../fixtures/voice-clip.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import {
  collect,
  makeSlice,
  requestId,
  round1,
  sliceTemplate,
  waitFor,
} from './_m1a-slice.js';
import { serveGateway, useTestWrappingKey } from './_m3-gateway.js';
import {
  alive,
  configureSpeech,
  engineFiles,
  engineLog,
  fakeEngineSpeech,
  journalTotal,
  openSpeechSocket,
  sendClip,
  speechOf,
} from './_voice-speech.js';

takeIntegrationLock(test, 'voice speak test');

const run = integrationEnabled ? test.serial : test.skip;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** Inputs of the script. */
const inputs = Object.freeze({
  live: 'speak live',
  long: 'long live',
  big: 'big reply',
});

/** Sentences of the staged reply (over `inlineBytes` as one text). */
const BIG_SENTENCES = 360;

const speakScript = harden({
  turns: [
    {
      input: inputs.live,
      rounds: [
        {
          chunks: [{ text: 'Let me check ' }, { text: 'the file. One' }],
          chunkDelayMs: 300,
          toolCalls: [
            {
              name: 'echo',
              args: JSON.stringify({ text: 'secret tool output.' }),
            },
          ],
          usage,
        },
        {
          chunks: [{ text: 'Done: ' }, { text: 'all good.' }],
          chunkDelayMs: 300,
          usage,
        },
      ],
    },
    {
      input: inputs.long,
      rounds: [
        {
          chunks: Array.from({ length: 30 }, (_, i) => ({
            text: `Sentence ${i} of the long reply. `,
          })),
          chunkDelayMs: 100,
          usage,
        },
      ],
    },
    {
      input: inputs.big,
      rounds: [
        {
          chunks: [
            {
              text: Array.from(
                { length: BIG_SENTENCES },
                (_, i) => `Sentence number ${i} is here.`,
              ).join(' '),
            },
          ],
          usage,
        },
      ],
    },
    { rounds: [{ chunks: [{ text: 'ok' }], usage }] },
  ],
});

/** @type {any} */
let world;

/**
 * The sentences the fake TTS processes read after `from` log lines.
 * @param {string} log
 * @param {number} from
 */
const sentencesAfter = (log, from) =>
  engineLog(log)
    .slice(from)
    .filter(line => line.type === 'sentence');

/**
 * A value's first `{ blob }` record, depth first (a staged message text).
 * @param {unknown} value
 * @returns {any}
 */
const firstBlob = value => {
  if (value === null || typeof value !== 'object') return undefined;
  if ('blob' in value && /** @type {any} */ (value).blob) {
    return /** @type {any} */ (value).blob;
  }
  for (const child of Object.values(value)) {
    const found = firstBlob(child);
    if (found !== undefined) return found;
  }
  return undefined;
};

run('setup: state, fake engines, gateway, page', async t => {
  t.timeout(3 * 60_000);
  const t0 = performance.now();
  const key = useTestWrappingKey('voice-speak');
  t.teardown(() => key.remove());
  const state = await startFromTemplate(await sliceTemplate(), {
    secretsKeyFile: key.file,
  });
  const dir = path.join(state.root, 'voice-engines');
  const files = engineFiles(dir);
  try {
    const slice = await makeSlice(state);
    const { backend } = await slice.makeBackend(speakScript);
    await E(slice.harness).configure(harden({ backends: [backend] }));
    const step = await configureSpeech(state, fakeEngineSpeech(dir));
    t.false(step.skipped);
    const gateway = await serveGateway(state, { secretsKeyFile: key.file });
    const page = await gateway.connect();
    const speech = speechOf(page.powers);
    const factory = await E(page.powers.operator).getFactory();
    const [preset] = await E(factory).listPresets();
    const [pageBackend] = await E(factory).listBackends();
    const session = await E(factory).createSession(
      harden({ title: 'voice', preset, backend: pageBackend, at: Date.now() }),
    );
    const { rev } = await E(session).watch();
    const feed = collect(await E(page.powers.live).subscribe(session, rev));
    const audio = await openSpeechSocket(gateway, speech);
    t.deepEqual(audio.ready, {
      speechIn: true,
      speechOut: true,
      sampleRate: 16_000,
      audioFrameBytes: 65_536,
    });
    world = { state, slice, gateway, page, speech, session, feed, audio };
    world.files = files;
    world.cleanup = async () => {
      await feed.stop();
      audio.socket.close();
      page.close();
      await state.cleanup();
    };
    emit({
      check: 'voice-speak.setup',
      ms: round1(performance.now() - t0),
      by: 'W11.9',
    });
  } catch (error) {
    await state.cleanup();
    throw error;
  }
});

test.after.always(async () => {
  await world?.cleanup();
});

/**
 * Submit from the page; answer the receipt and its turn id once started.
 * @param {string} text
 */
const submit = async text => {
  const receipt = await E(world.page.powers.composer).submit(
    world.session,
    text,
    requestId(),
  );
  return receipt;
};

/** @param {any} receipt */
const turnIdOf = async receipt => {
  await null;
  const turn =
    receipt.turn ??
    (await waitFor(
      async () => {
        const current = await E(world.session).getSubmissionReceipt(
          receipt.requestId,
        );
        return current?.turn;
      },
      30_000,
      'the turn',
    ));
  return (await E(turn).getStatus()).turnId;
};

/** @param {string} turnId */
const turnEnd = turnId =>
  world.feed.until(
    (/** @type {any} */ event) =>
      (event.type === 'end' || event.type === 'abort') &&
      event.turnId === turnId,
    60_000,
  );

run(
  '1: an utterance gives cumulative partials and a final; ABORT and a closed socket abort it; no vat delivery',
  async t => {
    if (!world) throw Error('setup failed');
    const { socket, port } = world.audio;
    const before = await journalTotal(world.state.client);
    const t0 = performance.now();
    const { stream } = await E(port).transcribe();
    await socket.event(stream, 'phase');
    const clip = makeClip({ seconds: 2 });
    // A trailing odd byte on the last frame.
    const odd = new Uint8Array(clip.length + 1);
    odd.set(clip);
    await sendClip(socket, stream, odd, 85);
    socket.send(frameKinds.end, stream);
    const final = await socket.event(stream, 'final', 20_000);
    const finalMs = performance.now() - t0;
    await socket.event(stream, 'end');
    t.is(final.text, `final ${clip.length}`, 'the odd byte is dropped');
    const events = socket.eventsOf(stream);
    t.deepEqual(
      events.filter(e => e.type === 'phase').map(e => e.phase),
      ['listening', 'transcribing'],
    );
    /** @type {string[]} */
    const partials = events
      .filter(e => e.type === 'partial')
      .map(e => String(e.text));
    t.true(partials.length >= 3, 'partials while the audio streams');
    /** @type {number[]} */
    const counts = partials.map(text => Number.parseInt(text, 10));
    t.deepEqual(
      counts,
      [...counts].sort((a, b) => a - b),
      'each partial is the whole transcript so far (replace, not append)',
    );
    t.true(counts.every(n => n > 0 && n <= clip.length));
    const after = await journalTotal(world.state.client);
    t.is(after - before, 0, 'no vat delivery for an utterance');

    // ABORT from the page.
    const aborted = await E(port).transcribe();
    await sendClip(socket, aborted.stream, makeClip({ seconds: 0.5 }));
    socket.send(frameKinds.abort, aborted.stream);
    // The socket closing aborts an open utterance.
    const second = await openSpeechSocket(world.gateway, world.speech);
    const cut = await E(second.port).transcribe();
    await sendClip(second.socket, cut.stream, makeClip({ seconds: 0.5 }));
    await delay(200);
    second.socket.close();
    const aborts = await waitFor(
      () => {
        const lines = engineLog(world.files.sttLog);
        const n = lines.filter(line => line.type === 'stream_abort').length;
        return n >= 2 ? n : 0;
      },
      10_000,
      'two stream_abort lines',
    );
    t.true(aborts >= 2);
    t.is(socket.closed(), undefined, 'the first socket stays open');
    emit({
      check: 'voice-speak.utterance',
      finalMs: round1(finalMs),
      partials: partials.length,
      deliveries: after - before,
      by: 'W11.9',
    });
  },
);

run(
  '4: speak on a live turn of two rounds with a tool call; replay to the end; an older turn is not live',
  async t => {
    if (!world) throw Error('setup failed');
    const { socket, port } = world.audio;
    const { ttsLog } = world.files;
    const mark = engineLog(ttsLog).length;
    const receipt = await submit(inputs.live);
    const turnId = await turnIdOf(receipt);
    const s0 = performance.now();
    const { stream } = await E(port).speak(world.session, turnId);
    const speakMs = performance.now() - s0;
    await socket.event(stream, 'end', 30_000);
    await turnEnd(turnId);
    const spoken = sentencesAfter(ttsLog, mark).map(line => line.text);
    t.deepEqual(spoken, ['Let me check the file.', 'One', 'Done: all good.']);
    t.false(
      spoken.some(text => text.includes('secret tool output')),
      'the tool result is not spoken',
    );
    t.true(Number(socket.pcmBytes(stream)) > 0, 'PCM reached the page');
    t.deepEqual(
      socket
        .eventsOf(stream)
        .filter(e => e.type === 'phase')
        .map(e => e.phase),
      ['synthesizing'],
    );

    // The finished last turn plays to the end again.
    const again = engineLog(ttsLog).length;
    const replayed = await E(port).speak(world.session, turnId);
    await socket.event(replayed.stream, 'end', 30_000);
    t.deepEqual(
      sentencesAfter(ttsLog, again).map(line => line.text),
      spoken,
    );

    // A newer turn makes this one older.
    const newer = await turnIdOf(await submit('anything'));
    await turnEnd(newer);
    await t.throwsAsync(() => E(port).speak(world.session, turnId), {
      message: speechTexts.turnNotLive,
    });
    emit({
      check: 'voice-speak.speak',
      speakOpenMs: round1(speakMs),
      sentences: spoken.length,
      by: 'W11.9',
    });
  },
);

run(
  '7: barge-in stops the playback and its synthesis; the turn completes; the next message queues behind it',
  async t => {
    if (!world) throw Error('setup failed');
    const { socket, port } = world.audio;
    const { ttsLog } = world.files;
    const mark = engineLog(ttsLog).length;
    const receipt = await submit(inputs.long);
    const turnId = await turnIdOf(receipt);
    const { stream } = await E(port).speak(world.session, turnId);
    await socket.until(() =>
      socket.frames.find(
        (/** @type {any} */ f) =>
          f.kind === frameKinds.pcm && f.stream === stream,
      ),
    );
    const synthesis = sentencesAfter(ttsLog, mark)[0]?.pid;
    t.true(Number.isInteger(synthesis), 'a synthesis process spoke');
    // Barge-in: the page stops its playback (the turn is not touched).
    const b0 = performance.now();
    socket.send(frameKinds.abort, stream);
    await waitFor(() => !alive(synthesis), 5000, 'the synthesis process gone');
    const killMs = performance.now() - b0;
    // The user's next message, sent while the turn still runs.
    const next = await submit('after barge-in');
    t.is(next.state, 'queued', 'queued behind the running turn');
    const frames = socket.frames.filter(
      (/** @type {any} */ f) => f.stream === stream,
    ).length;
    await turnEnd(turnId);
    const nextTurn = await turnIdOf(next);
    await turnEnd(nextTurn);
    const ended = world.feed
      .events()
      .find(
        (/** @type {any} */ event) =>
          event.type === 'end' && event.turnId === turnId,
      );
    t.is(ended?.status, 'completed', 'the interrupted turn completed');
    t.is(
      socket.frames.filter((/** @type {any} */ f) => f.stream === stream)
        .length,
      frames,
      'nothing more on the stopped playback',
    );
    t.false(
      socket.eventsOf(stream).some(e => e.type === 'end'),
      "the page's ABORT sends no event",
    );
    emit({
      check: 'voice-speak.bargeIn',
      synthesisGoneMs: round1(killMs),
      by: 'W11.9',
    });
  },
);

run(
  '11: Speech.replay plays an inline piece and a staged Blob piece',
  async t => {
    if (!world) throw Error('setup failed');
    const { socket, port } = world.audio;
    const { ttsLog } = world.files;
    const turnId = await turnIdOf(await submit(inputs.big));
    await turnEnd(turnId);
    const history = await E(world.session).getHistoryPage();
    const turn = history.turns.find(
      (/** @type {any} */ entry) =>
        entry.records[0]?.kind === 'turn-started' &&
        entry.records[0].input === inputs.big,
    );
    const blob = firstBlob(turn?.records);
    t.truthy(blob, 'the reply was staged as a Blob');
    const mark = engineLog(ttsLog).length;
    const r0 = performance.now();
    const { stream } = await E(world.speech).replay(
      port,
      harden(['Inline first piece here.', blob]),
    );
    await socket.event(stream, 'end', 60_000);
    const replayMs = performance.now() - r0;
    const spoken = sentencesAfter(ttsLog, mark).map(line => line.text);
    t.is(spoken[0], 'Inline first piece here.');
    t.is(spoken.at(-1), `Sentence number ${BIG_SENTENCES - 1} is here.`);
    t.is(spoken.length, BIG_SENTENCES + 1);
    emit({
      check: 'voice-speak.replay',
      replayMs: round1(replayMs),
      sentences: spoken.length,
      pcmBytes: socket.pcmBytes(stream),
      by: 'W11.9',
    });
  },
);
