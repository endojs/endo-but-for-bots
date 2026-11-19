// @ts-check
/**
 * Speech across restarts (designs/m11-interfaces.md 8, 13; W11.9): the
 * speech extension in the real adapter with the fake process engines, the
 * gateway on a fixed port, a Node page:
 *
 * 21. after a clean restart no speech engine runs until the first
 *     `openAudio`, which starts speech in (`warm: true`) with a new pid and
 *     the settings written before the restart (D-M11-23, R8-29).
 * K11-1. SIGKILL of the supervisor during an utterance: within 5 s no
 *     engine process of the old incarnation is alive (they exit at stdin
 *     EOF, D-M11-15); the page reconnects and opens a new port; nothing was
 *     submitted; the utterance cost no vat delivery.
 * K11-2. SIGKILL during the playback of a live scripted turn: no fake TTS
 *     process alive within 5 s; the turn is recovered by M2 (settled, or
 *     outcome-unknown); nothing is spoken again by itself (O-7); Replay of
 *     a staged reply works on the new incarnation (A-4: `Content.read` of
 *     a Blob after a restart).
 *
 * The browser half of K11-1 (the compose box keeps the last partial) is
 * `test/browser/voice-ui.test.mjs`'s.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/voice-speech-restart.test.js
 */
import '../unit/_m1a-prelude.js';

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import { frameKinds } from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { emit } from '../../perf/_harness.mjs';
import { makeClip } from '../fixtures/voice-clip.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import {
  makeSlice,
  requestId,
  round1,
  sliceTemplate,
  turnWithInput,
  waitFor,
} from './_m1a-slice.js';
import { freePort, serveGateway, useTestWrappingKey } from './_m3-gateway.js';
import {
  alive,
  configureSpeech,
  engineFiles,
  engineLog,
  fakeEngineSpeech,
  journalTotal,
  openSpeechSocket,
  pidsIn,
  sendClip,
  speechOf,
} from './_voice-speech.js';

takeIntegrationLock(test, 'voice speech restart test');

const run = integrationEnabled ? test.serial : test.skip;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

const inputs = Object.freeze({ long: 'long live', big: 'big reply' });
const BIG_SENTENCES = 360;
const TITLE = 'voice restart';

const script = harden({
  turns: [
    {
      input: inputs.long,
      rounds: [
        {
          chunks: Array.from({ length: 20 }, (_, i) => ({
            text: `Sentence ${i} of a long reply. `,
          })),
          chunkDelayMs: 300,
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

/**
 * A signed-in page with its `Speech`, the test session (found by title)
 * and a bound audio socket.
 */
const openPage = async () => {
  const page = await world.gateway.connect();
  const speech = speechOf(page.powers);
  const factory = await E(page.powers.operator).getFactory();
  const { rows } = await E(factory).listSessions(harden({ limit: 50 }));
  const row = rows.find((/** @type {any} */ r) => r.title === TITLE);
  const audio = await openSpeechSocket(world.gateway, speech);
  return { page, speech, factory, session: row?.session, audio };
};

/** Every engine pid the fakes wrote, both directions. */
const enginePids = () => [
  ...pidsIn(world.files.sttPids),
  ...pidsIn(world.files.ttsPids),
];

/**
 * Wait until none of `pids` is alive; answer how long it took.
 * @param {number[]} pids
 * @param {number} [ms]
 */
const allGone = async (pids, ms = 5000) => {
  const t0 = performance.now();
  await waitFor(() => pids.every(pid => !alive(pid)), ms, 'engines gone');
  return performance.now() - t0;
};

run('setup: state, fake engines, gateway on a fixed port', async t => {
  t.timeout(3 * 60_000);
  const key = useTestWrappingKey('voice-restart');
  const state = await startFromTemplate(await sliceTemplate(), {
    secretsKeyFile: key.file,
  });
  try {
    const dir = path.join(state.root, 'voice-engines');
    const slice = await makeSlice(state);
    const { backend } = await slice.makeBackend(script);
    await E(slice.harness).configure(harden({ backends: [backend] }));
    await configureSpeech(state, fakeEngineSpeech(dir, { warm: true }));
    const port = await freePort();
    const gateway = await serveGateway(state, {
      port,
      secretsKeyFile: key.file,
    });
    world = { state, key, gateway, files: engineFiles(dir), pages: [] };
    const page = await gateway.connect();
    world.pages.push(page);
    const factory = await E(page.powers.operator).getFactory();
    const [preset] = await E(factory).listPresets();
    const [pageBackend] = await E(factory).listBackends();
    await E(factory).createSession(
      harden({ title: TITLE, preset, backend: pageBackend, at: Date.now() }),
    );
    t.pass();
  } catch (error) {
    await state.cleanup();
    key.remove();
    throw error;
  }
});

test.after.always(async () => {
  if (!world) return;
  for (const page of world.pages) page.close();
  await world.state.cleanup();
  world.key.remove();
});

run(
  '21: after a clean restart the speech-in engine starts at the first openAudio, with the earlier settings',
  async t => {
    if (!world) throw Error('setup failed');
    // An incarnation that used speech in.
    const first = await openPage();
    world.pages.push(first.page);
    await waitFor(() => pidsIn(world.files.sttPids).length > 0, 10_000, 'stt');
    const oldPids = enginePids();
    const voice = await E(first.page.powers.operator).getVoice();
    const { revision } = await E(voice).speechSettings();
    const r0 = performance.now();
    await world.state.restart();
    const restartMs = performance.now() - r0;
    await allGone(oldPids);
    const linesAtStart = pidsIn(world.files.sttPids).length;
    await delay(2000);
    t.is(
      pidsIn(world.files.sttPids).length,
      linesAtStart,
      'no speech engine at start',
    );
    const second = await openPage();
    world.pages.push(second.page);
    await waitFor(
      () => pidsIn(world.files.sttPids).length > linesAtStart,
      10_000,
      'the engine started by the first openAudio',
    );
    const newPid = /** @type {number} */ (pidsIn(world.files.sttPids).at(-1));
    t.false(oldPids.includes(newPid), 'a new pid');
    t.true(alive(newPid));
    const voiceAfter = await E(second.page.powers.operator).getVoice();
    t.is((await E(voiceAfter).speechSettings()).revision, revision);
    t.true(second.audio.ready.speechIn);
    emit({
      check: 'voice-restart.engineFresh',
      restartMs: round1(restartMs),
      by: 'W11.9',
    });
  },
);

run(
  'K11-1: SIGKILL during an utterance leaves no engine; the page reconnects; nothing was submitted',
  async t => {
    if (!world) throw Error('setup failed');
    const { page, session, audio } = await openPage();
    world.pages.push(page);
    const { stream } = await E(audio.port).transcribe();
    const before = await journalTotal(world.state.client);
    await sendClip(audio.socket, stream, makeClip({ seconds: 1 }), 85);
    await audio.socket.event(stream, 'partial');
    const deliveries = (await journalTotal(world.state.client)) - before;
    t.is(deliveries, 0, 'no vat delivery for the utterance');
    // Still streaming when the supervisor dies.
    void sendClip(audio.socket, stream, makeClip({ seconds: 2 }), 85).catch(
      () => {},
    );
    await delay(300);
    const pids = enginePids().filter(alive);
    t.true(pids.length > 0, 'engines ran');
    await world.state.kill();
    const goneMs = await allGone(pids);
    await audio.socket.whenClosed(10_000);
    const r0 = performance.now();
    await world.state.restart();
    const restartMs = performance.now() - r0;
    const again = await openPage();
    world.pages.push(again.page);
    t.true(again.audio.ready.speechIn, 'a new port on the new incarnation');
    const history = await E(again.session).getHistoryPage();
    t.is(history.turns.length, 0, 'nothing was submitted');
    t.truthy(session);
    emit({
      check: 'voice-restart.K11-1',
      enginesGoneMs: round1(goneMs),
      restartMs: round1(restartMs),
      deliveries,
      by: 'W11.9',
    });
  },
);

run(
  'K11-2: SIGKILL during a playback leaves no TTS process; the turn is recovered; no re-speak; Replay works',
  async t => {
    if (!world) throw Error('setup failed');
    const { page, session, audio } = await openPage();
    world.pages.push(page);
    const composer = page.powers.composer;
    // A staged reply to replay after the restart.
    const big = await E(composer).submit(session, inputs.big, requestId());
    await waitFor(
      async () => {
        const turns = await E(session).getHistoryPage();
        const entry = turnWithInput(turns, inputs.big);
        return entry?.records.some(
          (/** @type {any} */ r) => r.kind === 'turn-settled',
        );
      },
      30_000,
      'the staged reply',
    );
    t.is(big.duplicate, false);
    const receipt = await E(composer).submit(session, inputs.long, requestId());
    const turn =
      receipt.turn ??
      (await waitFor(
        async () => {
          const current = await E(session).getSubmissionReceipt(
            receipt.requestId,
          );
          return current?.turn;
        },
        30_000,
        'the turn',
      ));
    const { turnId } = await E(turn).getStatus();
    const { stream } = await E(audio.port).speak(session, turnId);
    await audio.socket.until(() =>
      audio.socket.frames.find(
        (/** @type {any} */ f) =>
          f.kind === frameKinds.pcm && f.stream === stream,
      ),
    );
    const tts = pidsIn(world.files.ttsPids).filter(alive);
    t.true(tts.length > 0, 'a synthesis process runs');
    await world.state.kill();
    const goneMs = await allGone(enginePids());
    const r0 = performance.now();
    await world.state.restart();
    const restartMs = performance.now() - r0;
    const spokenAtRestart = engineLog(world.files.ttsLog).filter(
      line => line.type === 'sentence',
    ).length;
    const again = await openPage();
    world.pages.push(again.page);
    const settled = await waitFor(
      async () => {
        const turns = await E(again.session).getHistoryPage();
        const entry = turnWithInput(turns, inputs.long);
        return entry?.records.find(
          (/** @type {any} */ r) => r.kind === 'turn-settled',
        );
      },
      60_000,
      'the recovered turn',
    );
    t.true(
      ['completed', 'outcome-unknown', 'failed', 'cancelled'].includes(
        settled.status,
      ),
      `recovered as ${settled.status}`,
    );
    await delay(1500);
    t.is(
      engineLog(world.files.ttsLog).filter(line => line.type === 'sentence')
        .length,
      spokenAtRestart,
      'nothing is spoken again by itself (O-7)',
    );
    // A-4: the staged reply's Blob, read through Content after the restart.
    const turns = await E(again.session).getHistoryPage();
    const blob = firstBlob(turnWithInput(turns, inputs.big)?.records);
    t.truthy(blob, 'the staged reply');
    const mark = engineLog(world.files.ttsLog).length;
    const replay = await E(again.speech).replay(again.audio.port, [blob]);
    await again.audio.socket.event(replay.stream, 'end', 60_000);
    const replayed = engineLog(world.files.ttsLog)
      .slice(mark)
      .filter(line => line.type === 'sentence');
    t.is(replayed.length, BIG_SENTENCES);
    emit({
      check: 'voice-restart.K11-2',
      enginesGoneMs: round1(goneMs),
      restartMs: round1(restartMs),
      recovered: settled.status,
      by: 'W11.9',
    });
  },
);
