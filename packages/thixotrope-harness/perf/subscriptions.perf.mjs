// @ts-check
/**
 * M4 perf, part 1 (W4.8; `designs/m4-interfaces.md` 18): the round path.
 * Split from the contract's single `subscriptions.perf.mjs` (510 s timed,
 * about 595 s with setup, too near the 10-minute box): the renewal,
 * catalogue and first-open windows are `subscriptions-lifecycle.perf.mjs`.
 *
 * - `subscriptions.select`: member order for one round, 16 members, 256
 *   served sessions, in process (W4.2's core); 60 s. Budget median <= 0.5 ms,
 *   0 deliveries.
 * - `subscriptions.turnStart`: submit to the provider request on a pool
 *   backend, one session; 60 s. Budget median <= 350 ms, 0 manager
 *   deliveries per turn (session frames per turn reported).
 * - `subscriptions.handover`: a 429 on the first member then the next,
 *   measured at the fake server as the time between the two requests less
 *   the 429's answer time; 60 s. Budget <= 50 ms added, 1 manager delivery
 *   per refusal.
 * - `subscriptions.servedWrites`: manager deliveries while one session runs
 *   turns on its sticky member; 60 s. Budget <= 1 per session per 60 s.
 * - `subscriptions.bundles`: session, exec, factory and manager bundle
 *   bytes (one build). Budget: session and exec + <= 64 bytes over
 *   `3588cab190` (186,448 and 84,354), factory <= +6 KB (137,074).
 * - too-big probes (single runs): credential 8,193 bytes at read, audit
 *   limit 1,001, 17 members, `poolState` with 256 served records within
 *   `frameBytes` (W4.1's unit measure), each refused on the sending side.
 *   The secret 1 MiB + 1 and the 16 MiB + 1 SSE line probes are W4.4's and
 *   W4.3's adapter tests (not repeated here).
 *
 *   node scripts/run-lock.mjs --exclusive --label m4-subs -- node perf/subscriptions.perf.mjs
 */
import { performance } from 'node:perf_hooks';
import { emit, harnessRoot, runPerf, single, stats } from './_harness.mjs';

// Endo packages and the code that uses them load after `_harness.mjs`
// has locked down (`scripts/_init.mjs`): a static import would run first.
const { E } = await import('@endo/far');
const {
  FAKE_MS,
  WINDOW_MS,
  inWindow,
  makeFrameCounter,
  startPerfM4,
  useKeyFile,
  closeServers,
} = await import('./_m4.mjs');
const {
  CLAUDE_MODEL,
  credentialText,
  makePool,
  makeValueSecret,
  openSession,
  posts,
  runTurn,
  tokenOf,
} = await import('../test/integration/_m4.js');
const { exhaustedEntry } =
  await import('../test/fixtures/fake-subscription-server.mjs');
const { makePoolCore } =
  await import('../resources/agent-host/impl/subscriptions/pool.js');
const { subscriptionDefaults } = await import('../config/defaults-m4.js');
const { bundleGuest } = await import('../scripts/bundle-guest.mjs');
const { agentHostDirectory, execEntry, factoryEntry, guestRoot, sessionEntry } =
  await import('../scripts/provision-steps.js');

/** Bundle bytes at `3588cab190` (m4-interfaces.md 1.4). */
const BASE = harden({ session: 186_448, exec: 84_354, factory: 137_074 });

/** In process: 16 members, 256 served sessions, select per round. */
const measureSelect = async () => {
  const { Far } = /** @type {any} */ (globalThis);
  /** @type {any[]} */
  const members = Array.from({ length: 16 }, (_, i) =>
    harden({
      member: Far('PoolMember', {}),
      label: `member ${i}`,
      provider: 'claude',
      weight: 1,
      key: `k${i}`,
      state: 'active',
    }),
  );
  const now = Date.now();
  /** @type {Map<any, any>} */
  const readings = new Map(
    members.map((entry, i) => [
      entry.member,
      harden({
        at: now,
        source: 'observed',
        limitReached: false,
        windows: [
          {
            name: 'secondary',
            usedPercent: (i * 7) % 100,
            resetsAtMs: now + (i % 5) * 3_600_000,
          },
        ],
      }),
    ]),
  );
  const sessions = Array.from({ length: 256 }, () => Far('Session', {}));
  const core = makePoolCore({
    members,
    readingOf: member => readings.get(member),
    cacheLifetimeMs: subscriptionDefaults.cacheLifetimeMs,
    now: () => Date.now(),
    initial: {
      served: sessions.map((session, i) => ({
        session,
        member: members[i % 16].member,
        at: now - (i % 2) * 400_000,
      })),
    },
    settings: subscriptionDefaults,
  });
  let i = 0;
  const { samples } = await inWindow(async () => {
    const session = sessions[i % 256];
    i += 1;
    const t0 = performance.now();
    core.forSession(session).select();
    return performance.now() - t0;
  });
  await stats('subscriptions.select', samples, {
    budget: { median: 0.5 },
    extra: { members: 16, served: 256, deliveries: { count: 0, perOp: 0 } },
  });
};

const measureBundles = async () => {
  const sizes = {
    session: (await bundleGuest(sessionEntry, { guestRoot })).bytes,
    exec: (await bundleGuest(execEntry, { guestRoot })).bytes,
    factory: (await bundleGuest(factoryEntry, { guestRoot })).bytes,
  };
  // The manager vat's module (the native's durable half, with W4.1's part
  // bundled into it), bundled as a guest program from the package root.
  /** @type {number | null} */
  let manager = null;
  try {
    manager = (
      await bundleGuest(`${agentHostDirectory}/durable.js`, {
        guestRoot: harnessRoot,
      })
    ).bytes;
  } catch (error) {
    emit({
      metric: 'subscriptions.bundles.managerError',
      error: String(error).slice(0, 300),
    });
  }
  // Bytes are compared exactly (no slack).
  for (const [name, over, budget] of /** @type {const} */ ([
    ['session', sizes.session - BASE.session, 64],
    ['exec', sizes.exec - BASE.exec, 64],
    ['factory', sizes.factory - BASE.factory, 6144],
  ]))
    emit({
      metric: `subscriptions.bundles.${name}`,
      unit: 'bytes over 3588cab190',
      value: over,
      bytes: sizes[name],
      budget: { value: budget },
      pass: over <= budget,
    });
  emit({
    metric: 'subscriptions.bundles.manager',
    unit: 'bytes',
    value: manager,
  });
};

await runPerf('subscriptions', async ({ provision }) => {
  const dropKey = useKeyFile('perf-subs');
  try {
    await measureSelect();
    await measureBundles();

    const tokens = { a: tokenOf('a'), b: tokenOf('b') };
    const tags = new Map(Object.entries(tokens).map(([k, v]) => [v, k]));
    const { m4, server } = await startPerfM4(provision, {
      credentialTag: value => tags.get(value) ?? 'other',
    });
    const counter = await makeFrameCounter(m4);
    /** @type {{ label: string, credential: any }[]} */
    const members = [];
    for (const [tag, accessToken] of Object.entries(tokens)) {
      // eslint-disable-next-line no-await-in-loop
      const { secret } = await makeValueSecret(
        m4,
        `perf ${tag}`,
        credentialText('claude', { accessToken }),
      );
      members.push({ label: `member ${tag}`, credential: secret });
    }

    // ---- turnStart and servedWrites: one session, sticky ----
    const sticky = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Perf sticky',
      members,
      baseUrl: server.url,
    });
    const s = await openSession(m4, sticky.backend, { modelId: CLAUDE_MODEL });
    const { key } = await E(s.session).getInfo();
    const sessionLabel = `session ${key}`;
    for (let i = 0; i < 3; i += 1)
      // eslint-disable-next-line no-await-in-loop
      await runTurn(m4, s.session, s.live, `warm ${i}`);
    const managerBefore = await counter.frames();
    const sessionBefore = await counter.frames(sessionLabel);
    let n = 0;
    const { samples, elapsedMs } = await inWindow(async () => {
      const from = posts(server).length;
      const t0 = performance.now();
      n += 1;
      await runTurn(m4, s.session, s.live, `turn ${n}`);
      const request = posts(server)[from];
      return request === undefined ? NaN : request.receivedAt - t0;
    });
    const managerFrames = (await counter.frames()) - managerBefore;
    const sessionFrames = (await counter.frames(sessionLabel)) - sessionBefore;
    const turnStarts = samples.filter(Number.isFinite);
    await stats('subscriptions.turnStart', turnStarts, {
      budget: { median: 350 },
      extra: {
        windowMs: Math.round(elapsedMs),
        turns: samples.length,
        managerFramesPerTurn: +(managerFrames / samples.length).toFixed(3),
        sessionFramesPerTurn: +(sessionFrames / samples.length).toFixed(2),
      },
    });
    const perMinute = (managerFrames * 60_000) / elapsedMs;
    await single('subscriptions.servedWrites', perMinute, {
      budget: { value: 1 },
      extra: {
        unit: 'manager frames per session per 60 s',
        windowMs: Math.round(elapsedMs),
        managerFrames,
        turns: samples.length,
      },
    });

    // ---- handover: the first member refuses (exhausted), the next serves
    const handPool = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Perf handover',
      members: members.map(m => ({ ...m, label: `${m.label} h` })),
      baseUrl: server.url,
      extra: { cacheLifetimeMs: 1 },
    });
    const h = await openSession(m4, handPool.backend, {
      modelId: CLAUDE_MODEL,
    });
    await runTurn(m4, h.session, h.live, 'warm handover');
    /** @type {number[]} */
    const added = [];
    /** @type {number[]} */
    const refusalFrames = [];
    let failed = 0;
    let k = 0;
    await inWindow(async () => {
      // Each mark is dated 1-2 s ahead, so the refused member is back
      // before the next round (the window holds fewer, slower samples).
      const resetSec = Math.ceil(Date.now() / 1000) + 1;
      server.push(
        { ...exhaustedEntry('claude', resetSec), firstByteDelayMs: FAKE_MS },
        { sse: 'claude-text.sse', firstByteDelayMs: FAKE_MS },
      );
      const from = posts(server).length;
      const before = await counter.frames();
      k += 1;
      const turn = await runTurn(m4, h.session, h.live, `handover ${k}`);
      const after = await counter.frames();
      const [first, second] = posts(server).slice(from);
      if (turn.status.state !== 'completed' || second === undefined) {
        failed += 1;
        server.setPlan([]);
      } else {
        added.push(second.receivedAt - first.receivedAt - FAKE_MS);
        refusalFrames.push(after - before);
      }
      const wait = resetSec * 1000 - Date.now() + 100;
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    });
    if (added.length > 0)
      await stats('subscriptions.handover', added, {
        budget: { median: 50 },
        extra: {
          unit: 'ms added between the two requests',
          failed,
          managerFramesPerRefusal: +(
            refusalFrames.reduce((a, b) => a + b, 0) / refusalFrames.length
          ).toFixed(2),
          note: 'manager frames per handover turn include its served stamp',
        },
      });
    else emit({ metric: 'subscriptions.handover', pass: false, failed });

    // ---- too-big probes (single runs, on the sending side) ----
    /** @type {Record<string, string>} */
    const probes = {};
    const big = await makeValueSecret(
      m4,
      'perf big',
      JSON.stringify({ version: 1, provider: 'claude', pad: 'x'.repeat(8193) }),
    );
    const bigPool = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Perf big',
      members: [{ label: 'big member', credential: big.secret }],
      baseUrl: server.url,
    });
    const bigSession = await openSession(m4, bigPool.backend, {
      modelId: CLAUDE_MODEL,
    }).catch(error => ({ error }));
    if ('error' in bigSession) probes.credential = String(bigSession.error);
    else {
      const sent = posts(server).length;
      const turn = await runTurn(
        m4,
        bigSession.session,
        bigSession.live,
        'big',
      );
      probes.credential = `${turn.status.state}: ${turn.status.error}; requests ${posts(server).length - sent}`;
    }
    const reader = await E(m4.secrets).auditReader();
    probes.audit1001 = await E(reader)
      .page(harden({ limit: 1001 }))
      .then(
        () => 'accepted',
        error => `refused: ${String(error).slice(0, 120)}`,
      );
    const seventeen = await Promise.all(
      Array.from({ length: 17 }, (_, i) =>
        E(m4.subs).makeMember(
          harden({
            provider: 'claude',
            label: `m17 ${i}`,
            credential: big.secret,
          }),
        ),
      ),
    ).catch(error => error);
    probes.members17 = Array.isArray(seventeen)
      ? await E(m4.subs)
          .makePool(
            harden({
              kind: 'claude-pool',
              label: 'Seventeen',
              members: seventeen,
            }),
          )
          .then(
            () => 'accepted',
            error => `refused: ${String(error).slice(0, 120)}`,
          )
      : `members refused: ${String(seventeen).slice(0, 120)}`;
    await single('subscriptions.probes', 0, {
      extra: {
        unit: 'single runs',
        ...probes,
        halted: false,
        poolStateFrame:
          'm4-manager unit: largest PoolState 15,839 bytes < frameBytes 24,576',
      },
    });
    emit({ metric: 'subscriptions.window', windowMs: WINDOW_MS });
  } finally {
    await closeServers();
    dropKey();
  }
});
