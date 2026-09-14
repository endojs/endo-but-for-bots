// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import fc from 'fast-check';

import {
  makeCredentialsPool,
  renderApiKeyHelperSettings,
} from '../src/credentials-pool.js';

// A minimal fake ClaudeCredentials caplet matching the live surface
// (issue/revoke + single-shot materialise). `failIssue` induces an issue failure.
const makeFakeCredentials = (id, { failIssue = false } = {}) => {
  const revoked = [];
  return {
    id,
    revoked,
    credentials: {
      async issue(sessionTag) {
        if (failIssue) throw new Error(`issue failed for ${id}`);
        let materialised = false;
        return {
          async materialise() {
            if (materialised) throw new Error('single-shot');
            materialised = true;
            return `key-${id}`;
          },
          sessionTag,
        };
      },
      async revoke(sessionTag) {
        revoked.push(sessionTag);
      },
    },
  };
};

const poolOf = n =>
  makeCredentialsPool({
    subscriptions: Array.from({ length: n }, (_, i) =>
      makeFakeCredentials(`sub-${i}`),
    ),
  });

test('acquire returns a slot; release frees it; stats track occupancy', async t => {
  const pool = poolOf(2);
  t.deepEqual(pool.stats(), { total: 2, free: 2, busy: 0, cooling: 0 });
  const a = await pool.acquire('tag-a');
  t.is(a.type, 'acquired');
  t.deepEqual(pool.stats(), { total: 2, free: 1, busy: 1, cooling: 0 });
  const b = await pool.acquire('tag-b');
  t.is(b.type, 'acquired');
  t.deepEqual(pool.stats(), { total: 2, free: 0, busy: 2, cooling: 0 });
  // Reject-with-a-tag: no free slot -> pool-exhausted, never a queue.
  const c = await pool.acquire('tag-c');
  t.is(c.type, 'pool-exhausted');
  // @ts-expect-error narrowing
  await a.release();
  t.deepEqual(pool.stats(), { total: 2, free: 1, busy: 1, cooling: 0 });
});

test('release is idempotent and always frees the slot (finally-safe)', async t => {
  const pool = poolOf(1);
  const a = await pool.acquire('tag-a');
  t.is(a.type, 'acquired');
  // @ts-expect-error narrowing
  await a.release();
  // @ts-expect-error narrowing
  await a.release(); // second release is a no-op, not a double-free
  t.deepEqual(pool.stats(), { total: 1, free: 1, busy: 0, cooling: 0 });
});

test('a failed issue frees the slot rather than stranding the subscription', async t => {
  const pool = makeCredentialsPool({
    subscriptions: [makeFakeCredentials('sub-0', { failIssue: true })],
  });
  await t.throwsAsync(() => pool.acquire('tag-a'), { message: /issue failed/ });
  // Slot returned to full occupancy despite the failure.
  t.deepEqual(pool.stats(), { total: 1, free: 1, busy: 0, cooling: 0 });
});

test('a cooling subscription is skipped and reported via retryAfterMs', async t => {
  let clock = 1000;
  const pool = makeCredentialsPool({
    subscriptions: [makeFakeCredentials('sub-0')],
    now: () => clock,
  });
  pool.markCooling('sub-0', 1000 + 5000);
  const r = await pool.acquire('tag-a');
  t.is(r.type, 'pool-exhausted');
  // @ts-expect-error narrowing
  t.is(r.retryAfterMs, 5000);
  t.deepEqual(pool.stats(), { total: 1, free: 0, busy: 0, cooling: 1 });
  clock = 1000 + 6000; // cooling elapsed
  const r2 = await pool.acquire('tag-b');
  t.is(r2.type, 'acquired');
});

test('renderApiKeyHelperSettings has exactly one key and refuses newlines', t => {
  t.deepEqual(renderApiKeyHelperSettings('/opt/helper'), {
    apiKeyHelper: '/opt/helper',
  });
  t.throws(() => renderApiKeyHelperSettings('/opt/helper\nrm -rf'), {
    message: /newline-free/,
  });
});

// --- property: acquire/return never strands a subscription ---------------

test('property: fc.commands lifecycle keeps free+busy == total and never strands', async t => {
  const N = 3;
  let tagSeq = 0;

  /** @typedef {{ held: number }} Model */
  /** @typedef {{ pool: ReturnType<typeof poolOf>, outstanding: Array<(opts?: { failed?: boolean }) => Promise<void>> }} Real */

  const acquireCmd = {
    check: () => true,
    /**
     * @param {Model} model
     * @param {Real} real
     */
    run: async (model, real) => {
      tagSeq += 1;
      const r = await real.pool.acquire(`tag-${tagSeq}`);
      const s = real.pool.stats();
      t.is(s.total, N);
      t.is(s.free + s.busy + s.cooling, N);
      if (model.held < N) {
        t.is(r.type, 'acquired');
        if (r.type === 'acquired') real.outstanding.push(r.release);
        model.held += 1;
      } else {
        t.is(r.type, 'pool-exhausted');
      }
      t.is(s.busy, model.held);
    },
    toString: () => 'acquire',
  };

  const releaseCmd = {
    /** @param {Model} model */
    check: model => model.held > 0,
    /**
     * @param {Model} model
     * @param {Real} real
     */
    run: async (model, real) => {
      await null;
      const release = real.outstanding.shift();
      if (release) await release();
      model.held -= 1;
      t.is(real.pool.stats().busy, model.held);
    },
    toString: () => 'release',
  };

  const commands = [fc.constant(acquireCmd), fc.constant(releaseCmd)];

  await fc.assert(
    fc.asyncProperty(fc.commands(commands, { maxCommands: 40 }), async cmds => {
      /** @type {Real} */
      const real = { pool: poolOf(N), outstanding: [] };
      /** @type {Model} */
      const model = { held: 0 };
      await fc.asyncModelRun(() => ({ model, real }), cmds);
      // Drain: after releasing everything, the pool returns to full occupancy.
      await Promise.all(real.outstanding.map(release => release()));
      t.deepEqual(real.pool.stats(), {
        total: N,
        free: N,
        busy: 0,
        cooling: 0,
      });
    }),
    { numRuns: 60 },
  );
});
