// @ts-check
/**
 * M4 perf: account status (W4.8; `designs/m4-interfaces.md` 18).
 *
 * - `accounts.push`: a new reading to an in-process subscriber (the
 *   gateway's position), W4.5's accounts core in this process with the real
 *   timers; 60 s. Budget median <= 5 ms, 0 vat deliveries per change and
 *   per viewer (none can occur: the channel is adapter-local; 4 viewers).
 * - `accounts.refresh`: an on-demand read of a 2-member pool through the
 *   daemon (`Accounts.refresh(pool)`; the fake usage route answers at
 *   20 ms); 60 s. Budget median <= 20 + 100 ms; manager frames reported.
 *
 *   node scripts/run-lock.mjs --exclusive --label m4-accounts -- node perf/accounts.perf.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { harnessRoot, runPerf, stats } from './_harness.mjs';

// Endo packages and the code that uses them load after `_harness.mjs`
// has locked down (`scripts/_init.mjs`): a static import would run first.
const { E } = await import('@endo/far');
const {
  FAKE_MS,
  inWindow,
  makeFrameCounter,
  startPerfM4,
  useKeyFile,
  closeServers,
} = await import('./_m4.mjs');
const { credentialText, makePool, makeValueSecret, tokenOf } =
  await import('../test/integration/_m4.js');
const { makeAccounts } =
  await import('../resources/agent-host/impl/subscriptions/accounts.js');
const { makeTimers } = await import('../resources/agent-host/impl/timers.js');

const VIEWERS = 4;

const measurePush = async () => {
  const { Far } = /** @type {any} */ (globalThis);
  const dir = mkdtempSync(path.join(harnessRoot, 'tmp', 'w48-accounts-'));
  const core = makeAccounts({
    file: path.join(dir, 'readings.json'),
    timers: makeTimers(),
    now: () => Date.now(),
  });
  try {
    const backend = Far('Backend', {});
    /** @type {any} */
    const member = harden({
      member: Far('PoolMember', {}),
      label: 'push member',
      provider: 'claude',
      weight: 1,
      key: 'k1',
      state: 'active',
    });
    core.register(backend, {
      kind: 'claude-pool',
      label: 'Push pool',
      members: [member],
    });
    const viewers = [];
    for (let i = 0; i < VIEWERS; i += 1) {
      const sub = core.accounts.watch();
      // eslint-disable-next-line no-await-in-loop
      await sub.next();
      viewers.push(sub);
    }
    let used = 0;
    let at = Date.now();
    const { samples } = await inWindow(async () => {
      used = (used + 1) % 100;
      at += 1;
      const waiting = viewers.map(sub => sub.next());
      const t0 = performance.now();
      core.observe(
        backend,
        member,
        /** @type {any} */ ({
          at,
          source: 'observed',
          limitReached: false,
          windows: [{ name: 'secondary', usedPercent: used }],
        }),
      );
      await Promise.all(waiting);
      return performance.now() - t0;
    });
    await stats('accounts.push', samples, {
      budget: { median: 5 },
      extra: {
        viewers: VIEWERS,
        deliveries: { count: 0, perOp: 0 },
        note: 'adapter-local channel: no vat is involved',
      },
    });
  } finally {
    await core.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

await runPerf('accounts', async ({ provision }) => {
  await measurePush();
  const dropKey = useKeyFile('perf-accounts');
  try {
    const { m4, server } = await startPerfM4(provision);
    const counter = await makeFrameCounter(m4);
    const members = [];
    for (const tag of ['r1', 'r2']) {
      // eslint-disable-next-line no-await-in-loop
      const { secret } = await makeValueSecret(
        m4,
        `perf ${tag}`,
        credentialText('claude', { accessToken: tokenOf(tag) }),
      );
      members.push({ label: `member ${tag}`, credential: secret });
    }
    const { backend } = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Perf accounts',
      members,
      baseUrl: server.url,
    });
    // The pool's spec reaches this incarnation with its first catalogue
    // read (a pool never used is not read: `subscriptions/index.js`).
    await E(backend).listModels();
    const accounts = await E(m4.subs).accounts();
    await E(accounts).refresh(backend);
    const reads = () =>
      server.requests().filter(r => r.path === '/api/oauth/usage').length;
    const readsBefore = reads();
    const before = await counter.frames();
    const { samples } = await inWindow(async () => {
      const t0 = performance.now();
      await E(accounts).refresh(backend);
      return performance.now() - t0;
    });
    const frames = (await counter.frames()) - before;
    await stats('accounts.refresh', samples, {
      budget: { median: FAKE_MS + 100 },
      extra: {
        usageReadsPerRefresh: +(
          (reads() - readsBefore) /
          samples.length
        ).toFixed(2),
        managerFramesPerRefresh: +(frames / samples.length).toFixed(3),
      },
    });
  } finally {
    await closeServers();
    dropKey();
  }
});
