// @ts-check
/**
 * Node microbenchmark of the session's history page and turn start (J-9153,
 * J-9156). No vat and no Ironhorse workload, so it needs no run lock. Rows
 * are JSON lines through `perf/_harness.mjs` (`PERF_OUT` appends them) with
 * commit, crank budget (recorded, not applicable) and load average. A vat
 * pays roughly 100-150 x these Node costs per pattern check (J-0201, J-0243);
 * the rows compare the guards, they do not predict vat times.
 *
 *   node test/unit/m1a-session.bench.mjs
 *
 * Metrics:
 * - `session.history.guard.strict`: `mustMatch(page, shapes.HistoryPage)` of
 *   a full page (28 turns fit one frame) of 8 records per turn (every record against the `M.or` of
 *   eight shapes; the return guard before J-9156).
 * - `session.history.guard.view`: the same page through the return guard of
 *   `Session.getHistoryPage` as built now (structure and bounds; each record
 *   checked as a copy record).
 * - `session.history.page32x8`: `Session.getHistoryPage()` on that session,
 *   guard included (previews cached after the first read).
 * - `session.turn.claim.held`: `enqueueOnce` on an idle session with held
 *   ports, to the `startRound` (one claim crank's Node work).
 *
 * BENCH_ROUNDS (default 200) sets the samples.
 */
import '../../scripts/_init.mjs';

import { performance } from 'node:perf_hooks';

// After lockdown (a static import would evaluate before _init's await).
const { installGuestPrelude } = await import('../../scripts/guest-prelude.js');
installGuestPrelude();

const { stats } = await import('../../perf/_harness.mjs');
/* eslint-disable import/no-relative-packages */
const { makeSession } = await import('../../guest/session/session.js');
const { shapes, interfaces, methodNames } =
  await import('../../guest/lib/interfaces.js');
/* eslint-enable import/no-relative-packages */

const { Far, mustMatch, makeExo } = /** @type {any} */ (globalThis);

const rounds = Number(process.env.BENCH_ROUNDS ?? 200);
const AT = 1_763_000_000_000;
const extra = { note: 'Node, no vat; algorithmic cost only' };
const drain = () => new Promise(resolve => setImmediate(resolve));

/**
 * @param {number} n
 * @param {number} at
 */
const rid = (n, at) =>
  `${at}-0123abcd-4567-89ab-cdef-${`${n}`.padStart(12, '0')}`;
const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

const makeRig = () => {
  /** @type {{ req: any, calls: any[] }} */
  const pending = { req: undefined, calls: [] };
  const endpoint = Far('Endpoint', {
    holdTurn: () => new Promise(() => {}),
    releaseTurn: () => {},
    startRound: (/** @type {any} */ req) => {
      pending.req = req;
    },
    cancelRound: () => {},
    armDeadline: () => {},
    disarm: () => {},
  });
  const echo = Far('AdapterTool', {
    execute: () => harden({ status: 'ok', text: 'echoed text' }),
  });
  const publisher = Far('LivePublisher', { publish: () => {} });
  const ports = harden({
    endpoint,
    publisher,
    tools: [harden({ name: 'echo', tool: echo })],
    since: AT - 1,
  });
  const { session } = makeSession({
    config: harden({
      key: 's1',
      title: 'bench',
      backendTitle: 'fake',
      modelId: 'scripted',
      preset: harden({ label: 'chat-only' }),
      createdAt: AT,
      userInitiated: true,
    }),
    services: {
      backend: Far('Backend', { open: () => ports }),
      host: Far('SessionHostFacet', { liveChannel: () => publisher }),
    },
    rowReporter: Far('RowReporter', { changed: () => {} }),
  });
  return { session, pending };
};

/**
 * A turn of 8 records: started, dispatched, a round with two echo calls
 * (round-settled, tool-intents, two results), the final round, settled.
 * @param {ReturnType<typeof makeRig>} rig
 * @param {number} n
 */
const toolTurn = async ({ session, pending }, n) => {
  const at = AT + n;
  session.enqueueOnce(harden({ text: `question ${n}` }), rid(n, at), at);
  await drain();
  const call = (/** @type {string} */ callId) =>
    harden({ callId, name: 'echo', args: '{"text":"echoed text"}' });
  pending.req.sink.dispatching(0);
  pending.req.sink.roundFinal(
    harden({
      round: 0,
      text: 'let me check',
      toolCalls: [call('a'), call('b')],
      usage,
      at,
    }),
  );
  await drain();
  await drain();
  pending.req.sink.roundFinal(
    harden({ round: 1, text: `answer ${n}`, toolCalls: [], usage, at }),
  );
  await drain();
};

const rig = makeRig();
await drain();
for (let n = 1; n <= 32; n += 1) {
  // eslint-disable-next-line no-await-in-loop
  await toolTurn(rig, n);
}
const page = rig.session.getHistoryPage();
const recordsPerTurn = page.turns.map(
  (/** @type {any} */ turn) => turn.records.length,
);
if (recordsPerTurn.some(n => n !== 8)) {
  throw Error(`unexpected page ${JSON.stringify(recordsPerTurn)}`);
}

/** @param {() => void} fn */
const sample = fn => {
  const samples = [];
  for (let i = 0; i < rounds + 20; i += 1) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    if (i >= 20) samples.push(t1 - t0);
  }
  return samples;
};

await stats(
  'session.history.guard.strict',
  sample(() => mustMatch(page, shapes.HistoryPage)),
  { extra: { ...extra, turns: page.turns.length, recordsPerTurn: 8 } },
);
// The return guard as the Session's interface holds it: an exo with that
// interface whose getHistoryPage returns the page already built.
const stub = makeExo('Session', interfaces.Session, {
  ...Object.fromEntries(methodNames.Session.map(name => [name, () => {}])),
  getHistoryPage: () => page,
});
await stats(
  'session.history.guard.view',
  sample(() => stub.getHistoryPage()),
  { extra: { ...extra, turns: page.turns.length, recordsPerTurn: 8 } },
);
await stats(
  'session.history.page32x8',
  sample(() => rig.session.getHistoryPage()),
  {
    extra: {
      ...extra,
      turns: page.turns.length,
      recordsPerTurn: 8,
      guard: 'view',
    },
  },
);

// The claim crank's Node work with held ports: enqueueOnce to startRound.
const claimSamples = [];
const claimRig = makeRig();
await drain();
for (let i = 0; i < rounds + 20; i += 1) {
  const at = AT + 100_000 + i;
  claimRig.pending.req = undefined;
  const t0 = performance.now();
  claimRig.session.enqueueOnce(harden({ text: `m${i}` }), rid(i, at), at);
  // eslint-disable-next-line no-await-in-loop
  while (claimRig.pending.req === undefined) await null;
  const t1 = performance.now();
  if (i >= 20) claimSamples.push(t1 - t0);
  claimRig.pending.req.sink.dispatching(0);
  claimRig.pending.req.sink.roundFinal(
    harden({ round: 0, text: 'ok', toolCalls: [], usage, at }),
  );
  // eslint-disable-next-line no-await-in-loop
  await drain();
}
await stats('session.turn.claim.held', claimSamples, { extra });
