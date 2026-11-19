// @ts-check
/**
 * Voice through the daemon (`designs/m11-interfaces.md` 14.1; W11.9): the
 * m1b template (the real session and exec programs, the factory's spare
 * pool), a scripted backend, the speech settings written by the voice
 * provisioning step for the fake process engines, the gateway served on
 * loopback and a Node CapTP page (`/ws`) with its `/audio` socket.
 *
 * - `voice.preferences`: `Voice.setPreferences` from the page to its
 *   answer. Budget median <= 50 ms, 1 delivery per call.
 * - `voice.launchDuplicate`: `startVoiceSession` with an invocation id
 *   already made. Budget median <= 50 ms.
 * - `voice.startSession`: `startVoiceSession` from the shortcut preset
 *   pinned to a backend and model, the pool settled before each (few
 *   samples, reported as such). Budget median <= 950 ms.
 * - `voice.settingsRead`: a fresh speech host's first settings read
 *   (`configuration()`: `Operator.getVoice` then `Voice.speechSettings`
 *   through the control client's presence, then the voice catalogue).
 *   Budget median <= 100 ms, 2 deliveries per read.
 * - `voice.speakOpen`: `AudioPort.speak` from the page to its answer, on a
 *   spoken turn. Budget median <= 10 ms.
 * - `voice.deliveries` (gate row, inside the `voice.speakOpen` window): the
 *   vat deliveries of each spoken turn (utterance, the send of its final,
 *   speak, the playback to its end) minus a typed turn's (the median of
 *   three typed turns before the window). Budget 0 on every turn.
 *
 * Windows: VOICE_SESSION_WINDOW_MS (default 60,000) per row, scaled by
 * PERF_WINDOW_SCALE; five windows plus the template start, about 6.5
 * minutes.
 *
 *   node perf/voice-session.perf.mjs            # exclusive
 *   node perf/voice-session.perf.mjs --shared   # a smoke during a unit
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { runWindow, windowFields, windowMs } from './_window.mjs';

await import('../scripts/_init.mjs');
await import('../test/unit/_m1a-prelude.js');
const { deliveries, emit, runPerf, stats } = await import('./_harness.mjs');
const { E } = await import('@endo/far');
const { execTemplate } = await import('../test/integration/_m1b-exec.js');
const { collect, makeSlice, requestId } =
  await import('../test/integration/_m1a-slice.js');
const { serveGateway, useTestWrappingKey } =
  await import('../test/integration/_m3-gateway.js');
const {
  configureSpeech,
  fakeEngineSpeech,
  openSpeechSocket,
  sendClip,
  speechOf,
} = await import('../test/integration/_voice-speech.js');
const { makeHostContext, makeVoiceStub } =
  await import('../test/adapter/_speech-host.js');
const { makeSpeechHost } =
  await import('../resources/agent-host/impl/speech/host.js');
const { speechKinds } =
  await import('../resources/agent-host/impl/speech/kinds.js');
const { makeSpeechText } =
  await import('../resources/agent-host/impl/speech/speech-text.js');
const { openTurnView } =
  await import('../resources/agent-host/impl/speech/turn-view.js');
const { frameKinds } =
  await import('../resources/agent-host/impl/speech/audio-protocol.js');
const { makeClip } = await import('../test/fixtures/voice-clip.mjs');

const WINDOW = windowMs('VOICE_SESSION_WINDOW_MS', 60_000);
const PINNED_MODEL = 'scripted-voice';
const TYPED_TURNS = 3;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
const script = harden({
  turns: [
    { rounds: [{ chunks: [{ text: 'Hello there. All good here.' }], usage }] },
  ],
});

/** @param {number[]} values */
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// The wrapping key outlives the supervisor (runPerf stops it last).
const key = useTestWrappingKey('voice-perf');
await runPerf('voice-session', async ({ provision }) => {
  const state = await provision({
    template: await execTemplate(),
    secretsKeyFile: key.file,
  });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(script);
  await E(slice.harness).configure(harden({ backends: [made.backend] }));
  await configureSpeech(
    state,
    fakeEngineSpeech(path.join(state.root, 'voice-engines')),
  );
  const gateway = await serveGateway(state, { secretsKeyFile: key.file });
  const page = await gateway.connect();
  const { powers } = page;
  const speech = speechOf(powers);
  const voice = await E(powers.operator).getVoice();
  const factory = await E(powers.operator).getFactory();
  const catalog = await E(powers.operator).getPresets();
  const [pageBackend] = await E(factory).listBackends();

  // ---- voice.preferences
  let before = await state.counters();
  const prefs = await runWindow(
    i => E(voice).setPreferences(harden({ speed: i % 2 ? 1.1 : 1 })),
    { ms: WINDOW },
  );
  let after = await state.counters();
  await stats('voice.preferences', prefs.samples, {
    budget: { median: 50, deliveriesPerOp: 1 },
    before,
    after,
    ...windowFields(prefs),
  });

  // The shortcut preset: a user preset pinned to a backend and model.
  const { revision } = await E(catalog).configuration();
  const { preset } = await E(catalog).create(
    harden({
      template: 'general',
      label: 'Talker',
      backend: pageBackend,
      modelId: PINNED_MODEL,
    }),
    revision,
  );
  await E(voice).setVoicePreset(
    preset,
    (await E(catalog).configuration()).revision,
  );

  // ---- voice.launchDuplicate
  await E(slice.harness).whenSettled();
  const first = await E(voice).startVoiceSession(
    harden({ invocationId: 'launch-perf', at: Date.now() }),
  );
  // The pool's refill after that take is not the duplicate's.
  await E(slice.harness).whenSettled();
  before = await state.counters();
  const duplicates = await runWindow(
    () => E(voice).startVoiceSession(harden({ invocationId: 'launch-perf' })),
    { ms: WINDOW },
  );
  after = await state.counters();
  await stats('voice.launchDuplicate', duplicates.samples, {
    budget: { median: 50 },
    before,
    after,
    ...windowFields(duplicates),
    extra: {
      allDuplicate: duplicates.results.every(
        (/** @type {any} */ a) => a.duplicate && a.key === first.key,
      ),
    },
  });

  // ---- voice.startSession (the pool settled before each sample)
  /** @type {number[]} */
  const startMs = [];
  const starts = await runWindow(
    async i => {
      await E(slice.harness).whenSettled();
      const t0 = performance.now();
      const answer = await E(voice).startVoiceSession(
        harden({ invocationId: `start-${i}`, at: Date.now() }),
      );
      startMs.push(performance.now() - t0);
      return answer;
    },
    { ms: WINDOW, min: 3 },
  );
  await stats('voice.startSession', startMs, {
    budget: { median: 950 },
    ...windowFields({ ...starts, samples: startMs }),
    extra: {
      pinnedModel: true,
      warnings: starts.results.filter((/** @type {any} */ a) => a.warning)
        .length,
      windowIncludes: 'the pool settle before each sample',
    },
  });

  // ---- voice.settingsRead: a fresh host per sample.
  const controlOperator = await E(slice.harness).getOperator();
  const base = makeHostContext({
    voice: makeVoiceStub(harden({})).voice,
    stateDir: state.root,
  });
  const context = harden({
    ...base.context,
    operator: () => controlOperator,
  });
  // The pool's refill after the last take is not the reads'.
  await E(slice.harness).whenSettled();
  before = await state.counters();
  const reads = await runWindow(
    async () => {
      const host = makeSpeechHost({
        context,
        kinds: speechKinds,
        pipeline: harden({ openTurnView, makeSpeechText }),
      });
      try {
        const configuration = await E(host.speech).configuration();
        if (!configuration.speechIn) throw Error('the settings were not read');
      } finally {
        await host.stop();
      }
    },
    { ms: WINDOW },
  );
  after = await state.counters();
  await stats('voice.settingsRead', reads.samples, {
    budget: { median: 100, deliveriesPerOp: 2 },
    before,
    after,
    ...windowFields(reads),
    extra: { includes: 'the voice catalogue read (4 files)' },
  });

  // ---- voice.speakOpen and the voice.deliveries gate.
  const [chatOnly] = await E(factory).listPresets();
  const session = await E(factory).createSession(
    harden({
      title: 'spoken',
      preset: chatOnly,
      backend: pageBackend,
      at: Date.now(),
    }),
  );
  const { rev } = await E(session).watch();
  const feed = collect(await E(powers.live).subscribe(session, rev));
  const audio = await openSpeechSocket(gateway, speech);
  /**
   * The turn id of the next turn-start after delivery `from`, and that
   * turn's end (0 deliveries: the page's own Live feed).
   * @param {number} from
   */
  const nextTurn = async from => {
    const at = await feed.until(e => e.type === 'turn-start', 30_000, from);
    const { turnId } = feed.deliveries[at].event;
    const ended = feed.until(
      e => (e.type === 'end' || e.type === 'abort') && e.turnId === turnId,
      30_000,
      at,
    );
    return { turnId, ended };
  };
  await E(slice.harness).whenSettled();
  await delay(500);
  /** @type {number[]} */
  const typed = [];
  for (let i = 0; i < TYPED_TURNS; i += 1) {
    const from = feed.deliveries.length;

    const b = await state.counters();

    await E(powers.composer).submit(session, `typed ${i}`, requestId());

    const { ended } = await nextTurn(from);

    await ended;

    await delay(300);

    const a = await state.counters();
    typed.push(deliveries(b, a, 1).count);
  }
  const typedTurn = median(typed);
  const clip = makeClip({ seconds: 1 });
  /** @type {number[]} */
  const openMs = [];
  /** @type {number[]} */
  const extra = [];
  const spoken = await runWindow(
    async i => {
      const from = feed.deliveries.length;
      const b = await state.counters();
      const { stream } = await E(audio.port).transcribe();
      await sendClip(audio.socket, stream, clip);
      audio.socket.send(frameKinds.end, stream);
      const final = await audio.socket.event(stream, 'final', 20_000);
      await E(powers.composer).submit(
        session,
        `${final.text} ${i}`,
        requestId(),
      );
      const { turnId, ended } = await nextTurn(from);
      await ended;
      const t0 = performance.now();
      const playback = await E(audio.port).speak(session, turnId);
      openMs.push(performance.now() - t0);
      await audio.socket.event(playback.stream, 'end', 20_000);
      await delay(300);
      const a = await state.counters();
      extra.push(deliveries(b, a, 1).count - typedTurn);
      audio.socket.frames.length = 0;
    },
    { ms: WINDOW },
  );
  await feed.stop();
  audio.socket.close();
  await stats('voice.speakOpen', openMs, {
    budget: { median: 10 },
    ...windowFields({ ...spoken, samples: openMs }),
  });
  const worst = Math.max(...extra);
  emit({
    metric: 'voice.deliveries',
    unit: 'deliveries',
    gate: true,
    typedTurn,
    typed,
    spokenTurns: extra.length,
    perTurnMinusTyped: extra,
    max: worst,
    min: Math.min(...extra),
    budget: { value: 0 },
    pass: extra.every(n => n === 0),
    ...(extra.every(n => n === 0) ? {} : { exceeded: [`max ${worst} > 0`] }),
    window: { ms: WINDOW, elapsedMs: Math.round(spoken.elapsedMs) },
  });
  if (!extra.every(n => n === 0)) process.exitCode = 1;
  page.close();
});
key.remove();
