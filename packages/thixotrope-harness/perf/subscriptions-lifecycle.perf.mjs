// @ts-check
/**
 * M4 perf, part 2 (W4.8; `designs/m4-interfaces.md` 18): renewal, the
 * first open after a restart and the pool catalogue. Split from the
 * contract's single `subscriptions.perf.mjs` (see part 1).
 *
 * - `subscriptions.renewal`: 16 concurrent rounds on a pool whose only
 *   member's access token expired; repeated expiries over 60 s (the
 *   operator writes an expired credential with a fresh refresh token each
 *   time). Budget: exactly 1 refresh POST per expiry; round start <= the
 *   fake OAuth server's time + 50 ms over the same 16 rounds unexpired.
 * - `subscriptions.firstOpen`: restarts of the daemon over a 150 s window;
 *   after each, the first turn on a pool session (the pool's open and its
 *   one `poolState`), submit to provider request. Budget median <= 750 ms,
 *   1 manager crank for `poolState` per restart (manager frames reported).
 * - `catalog.pool`: in the same restart cycle (the catalogue cache is the
 *   incarnation's, so a restart is the invalidation): one cold
 *   `listModels` of a 2-member pool through its Backend, then one warm.
 *   Budget warm median <= 300 ms, cold median <= 2 s. Folded into the
 *   restart window instead of its own 60 s window, so this file has two
 *   timed windows (210 s).
 *
 *   node scripts/run-lock.mjs --exclusive --label m4-life -- node perf/subscriptions-lifecycle.perf.mjs
 */
import { performance } from 'node:perf_hooks';
import { runPerf, single, stats, emit } from './_harness.mjs';

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
  listPools,
  makePool,
  makeValueSecret,
  openSession,
  posts,
  runTurn,
  tokenOf,
  waitFor,
} = await import('../test/integration/_m4.js');
const { requestId } = await import('../test/integration/_m1a-slice.js');
const { startFakeOAuthServer } =
  await import('../test/fixtures/fake-oauth-server.mjs');
const { sealTo } = await import('../resources/agent-host/impl/secrets/seal.js');

const RESTART_WINDOW_MS = Number(process.env.M4_RESTART_WINDOW_MS ?? 150_000);
const CONCURRENT = 16;

/** @param {number[]} values */
const median = values => {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)];
};

await runPerf('subscriptions-lifecycle', async ({ provision }) => {
  const dropKey = useKeyFile('perf-life');
  const oauth = await startFakeOAuthServer({ delayMs: FAKE_MS });
  try {
    const { run, m4, server } = await startPerfM4(provision);

    // ---- renewal: 16 concurrent rounds on an expired member ----
    const renewing = await makeValueSecret(
      m4,
      'perf renewing',
      credentialText('claude', { accessToken: tokenOf('r') }),
    );
    const renewPool = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Perf renewal',
      members: [{ label: 'renewing', credential: renewing.secret }],
      baseUrl: server.url,
      tokenUrl: oauth.tokenUrl,
    });
    const sessions = [];
    for (let i = 0; i < CONCURRENT; i += 1)
      sessions.push(
        // eslint-disable-next-line no-await-in-loop
        await openSession(m4, renewPool.backend, { modelId: CLAUDE_MODEL }),
      );
    /**
     * All 16 rounds at once: the start of each (submit to its request).
     * @param {string} tag
     */
    const burst = async tag => {
      const from = posts(server).length;
      const t0 = performance.now();
      await Promise.all(
        sessions.map((s, i) => runTurn(m4, s.session, s.live, `${tag} ${i}`)),
      );
      const sent = posts(server).slice(from);
      return sent.map(r => r.receivedAt - t0);
    };
    await burst('warm');
    /** @type {number[]} */
    const baseline = [];
    for (let i = 0; i < 3; i += 1)
      // eslint-disable-next-line no-await-in-loop
      baseline.push(...(await burst(`base ${i}`)));
    /** @type {number[]} */
    const expiredStarts = [];
    /** @type {number[]} */
    const postsPerExpiry = [];
    const refreshes = () =>
      oauth.requests().filter(r => r.grant === 'refresh_token').length;
    let k = 0;
    const { elapsedMs: renewalMs } = await inWindow(async () => {
      const issued = oauth.issue();
      await E(m4.writer).replace(
        renewing.secret,
        sealTo(
          m4.publicKey,
          credentialText('claude', {
            accessToken: tokenOf('expired'),
            refreshToken: issued.refreshToken,
            expiresAtMs: Date.now() - 1000,
          }),
        ),
      );
      const before = refreshes();
      k += 1;
      expiredStarts.push(...(await burst(`expired ${k}`)));
      postsPerExpiry.push(refreshes() - before);
    });
    const added = median(expiredStarts) - median(baseline) - FAKE_MS;
    await single('subscriptions.renewal', added, {
      budget: { value: 50 },
      extra: {
        unit: 'ms added to the median round start (16 concurrent)',
        windowMs: Math.round(renewalMs),
        expiries: postsPerExpiry.length,
        refreshPostsPerExpiry: postsPerExpiry,
        onePostEach: postsPerExpiry.every(n => n === 1),
        medianExpiredMs: median(expiredStarts),
        medianBaselineMs: median(baseline),
        rounds: expiredStarts.length,
      },
    });
    if (!postsPerExpiry.every(n => n === 1))
      emit({
        metric: 'subscriptions.renewal.posts',
        pass: false,
        postsPerExpiry,
      });

    // ---- firstOpen and catalog.pool: restarts ----
    const tokens = [tokenOf('c1'), tokenOf('c2')];
    const catMembers = [];
    for (const [i, accessToken] of tokens.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const { secret } = await makeValueSecret(
        m4,
        `perf cat ${i}`,
        credentialText('claude', { accessToken }),
      );
      catMembers.push({ label: `cat ${i}`, credential: secret });
    }
    await makePool(m4, {
      kind: 'claude-pool',
      label: 'Perf open',
      members: catMembers,
      baseUrl: server.url,
    });
    const poolIndex = (await listPools(m4)).length - 1;
    const opened = await openSession(m4, (await listPools(m4))[poolIndex], {
      modelId: CLAUDE_MODEL,
    });
    const { key } = await E(opened.session).getInfo();
    await runTurn(m4, opened.session, opened.live, 'before restarts');
    /** @type {number[]} */
    const firstOpen = [];
    /** @type {number[]} */
    const firstOpenManager = [];
    /** @type {number[]} */
    const cold = [];
    /** @type {number[]} */
    const warm = [];
    /** @type {number[]} */
    const restartMs = [];
    let r = 0;
    const { elapsedMs: restartWindowMs } = await inWindow(async () => {
      const t0 = performance.now();
      await run.restart('subscriptions.firstOpen');
      restartMs.push(performance.now() - t0);
      await m4.refresh();
      const counter = await makeFrameCounter(m4);
      const pool = (await listPools(m4))[poolIndex];
      const session = await E(m4.slice.factory).findSession(key);
      // The first open: submit to the provider request.
      const before = await counter.frames();
      const from = posts(server).length;
      const t1 = performance.now();
      r += 1;
      await E(m4.slice.composer).submit(
        session,
        `after restart ${r}`,
        requestId(),
      );
      await waitFor(
        () => posts(server).length > from,
        30_000,
        'the request',
        5,
      );
      firstOpen.push(posts(server)[from].receivedAt - t1);
      await waitFor(
        async () =>
          (await E(session).getHistoryPage()).turns.some(
            (/** @type {any} */ tp) =>
              tp.records[0]?.input === `after restart ${r}` &&
              tp.state !== 'running',
          ),
        30_000,
        'the turn settled',
        50,
      );
      firstOpenManager.push((await counter.frames()) - before);
      // The catalogue, cold then warm.
      const t2 = performance.now();
      await E(pool).listModels();
      cold.push(performance.now() - t2);
      const t3 = performance.now();
      await E(pool).listModels();
      warm.push(performance.now() - t3);
    }, RESTART_WINDOW_MS);
    await stats('subscriptions.firstOpen', firstOpen, {
      budget: { median: 750 },
      extra: {
        windowMs: Math.round(restartWindowMs),
        restarts: firstOpen.length,
        medianRestartMs: Math.round(median(restartMs)),
        managerFramesPerFirstTurn: firstOpenManager,
      },
    });
    await stats('catalog.pool.cold', cold, { budget: { median: 2000 } });
    await stats('catalog.pool.warm', warm, { budget: { median: 300 } });
    emit({ metric: 'subscriptions-lifecycle.window', windowMs: WINDOW_MS });
  } finally {
    await oauth.close();
    await closeServers();
    dropKey();
  }
});
