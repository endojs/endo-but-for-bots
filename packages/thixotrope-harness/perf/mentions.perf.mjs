// @ts-check
/**
 * M5 mentions perf check (W5.7; designs/m5-interfaces.md 8.2):
 *
 * - `mentions.turnStart`: turn start (the `turn-start` event's stamp to the
 *   scripted provider's `request` line, as `labels.full`) of a message with
 *   32 attachments through the Composer, then of a plain message, each over
 *   its own window (60 s each, `MENTIONS_WINDOW_MS`), one session. Budget:
 *   median <= the plain median + 100 ms and <= 350 ms. Deliveries per turn
 *   (`status().timings`, over 10 turns of each kind) are reported; the
 *   contract's "<= 3 deliveries" is read as no extra delivery for the
 *   attachments (32 handles ride the claim's one larger frame).
 *
 *   node scripts/run-lock.mjs --exclusive --label mentions -- node perf/mentions.perf.mjs
 */
import { performance } from 'node:perf_hooks';

import { deliveries, emit, runPerf, single, summarize } from './_harness.mjs';
import { windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
/* eslint-disable import/no-relative-packages */
const { limitsM5 } = await import('../guest/lib/limits-m5.js');
/* eslint-enable import/no-relative-packages */
const { makeSlice, requestId, sliceTemplate, waitFor } =
  await import('../test/integration/_m1a-slice.js');

const WINDOW_MS = windowMs('MENTIONS_WINDOW_MS', 60_000);
const WARMUP = 3;
const COUNTED = 10;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
const script = harden({
  turns: [{ input: 'hello', rounds: [{ chunks: [{ text: 'hi' }], usage }] }],
});

await runPerf('mentions', async ({ provision }) => {
  const template = await sliceTemplate();
  const run = await provision({ template });
  const slice = await makeSlice(run);
  const made = await slice.makeBackend(script);
  /** @type {{ label: string, value: any }[]} */
  const attachments = [];
  const t0 = performance.now();
  for (let i = 0; i < limitsM5.maxAttachments; i += 1) {
    const { backend } = await slice.makeBackend(harden({ turns: [] }));
    attachments.push({ label: `obj${i}`, value: backend });
  }
  const session = await slice.createSession(made.backend, 'mentions perf');
  const live = await slice.subscribe(session);
  emit({
    metric: 'mentions.setup',
    unit: 'ms',
    value: +(performance.now() - t0).toFixed(1),
  });

  /**
   * One turn; answers its start latency (ms).
   * @param {boolean} attached
   */
  const turn = async attached => {
    const from = live.deliveries.length;
    const receipt = await (attached
      ? E(slice.composer).submit(
          session,
          'hello',
          requestId(),
          harden({ attachments }),
        )
      : E(slice.composer).submit(session, 'hello', requestId()));
    const { turnId } = await E(receipt.turn).getStatus();
    const end = await waitFor(
      () =>
        live.deliveries.find(
          (/** @type {any} */ d, /** @type {number} */ i) =>
            i >= from &&
            (d.event.type === 'end' || d.event.type === 'abort') &&
            d.event.turnId === turnId,
        ),
      60_000,
      'turn end',
      5,
    );
    if (end.event.type !== 'end') throw Error(`turn ${turnId} failed`);
    const started = live.deliveries.find(
      (/** @type {any} */ d, /** @type {number} */ i) =>
        i >= from && d.event.type === 'turn-start' && d.event.turnId === turnId,
    );
    const request = made
      .log()
      .find(
        (/** @type {any} */ l) => l.kind === 'request' && l.turnId === turnId,
      );
    return Number(request?.at) - Number(started?.event.at);
  };

  /** @param {boolean} attached */
  const window = async attached => {
    for (let i = 0; i < WARMUP; i += 1) await turn(attached);
    /** @type {number[]} */
    const samples = [];
    const end = performance.now() + WINDOW_MS;
    while (performance.now() < end) samples.push(await turn(attached));
    return samples;
  };
  /** @param {boolean} attached */
  const counted = async attached => {
    const before = await run.counters();
    for (let i = 0; i < COUNTED; i += 1) await turn(attached);
    const after = await run.counters();
    return /** @type {number} */ (deliveries(before, after, COUNTED).perOp);
  };

  const withSamples = await window(true);
  const plainSamples = await window(false);
  const withDeliveries = await counted(true);
  const plainDeliveries = await counted(false);
  const withAttachments = summarize(withSamples);
  const plain = summarize(plainSamples);
  const added = +(withAttachments.median - plain.median).toFixed(3);
  const extraDeliveries = +(withDeliveries - plainDeliveries).toFixed(2);
  await single('mentions.turnStart', withAttachments.median, {
    budget: { value: Math.min(350, plain.median + 100) },
    extra: {
      what: 'median turn start (turn-start stamp to provider request), 32 attachments',
      attachments: limitsM5.maxAttachments,
      withAttachments,
      plain,
      addedMs: added,
      addedPass: added <= 100,
      deliveriesPerTurn: {
        withAttachments: withDeliveries,
        plain: plainDeliveries,
      },
      extraDeliveries,
      deliveriesPass: extraDeliveries <= 0.5,
      windowMs: WINDOW_MS,
      samples: withSamples.length + plainSamples.length,
      by: 'W5.7',
    },
  });
  await live.stop();
});
