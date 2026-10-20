// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { connectLocalControl } from '../../src/control/local-control.js';
import { serveThixotrope } from '../../src/control/supervisor.js';
import { makeNodePowers } from '../../src/platform/node/powers.js';

const powers = makeNodePowers();

test.serial(
  'daemon limits can increase across restart without losing its workspace',
  async t => {
    t.timeout(180_000);
    const path = await mkdtemp('/tmp/thix-limits-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const start = async env => {
      const supervisor = await serveThixotrope(
        harden({
          ...powers,
          environment: harden({
            get: name => env[name] ?? powers.environment.get(name),
          }),
        }),
        path,
      );
      t.teardown(() => supervisor.close());
      const client = await connectLocalControl(
        powers,
        join(path, 'control.sock'),
      );
      t.teardown(() => client.close());
      return { supervisor, client };
    };
    const firstEnv = {
      THIXOTROPE_CRANK_BUDGET: '20000000',
      THIXOTROPE_BOOTSTRAP_BUDGET: '1100000000',
      THIXOTROPE_SLOT_CEILING: '1200000',
      THIXOTROPE_CHUNK_CEILING: '300000000',
      THIXOTROPE_REQUEST_TIMEOUT_MS: '90000',
    };
    let host = await start(firstEnv);
    const status = await host.client.call('status');
    t.deepEqual(status.ironhorse, {
      crankBudget: '20000000',
      bootstrapBudget: '1100000000',
      slotCeiling: 1_200_000,
      chunkCeiling: 300_000_000,
      requestTimeoutMs: 90_000,
    });
    await host.client.call(
      'evaluate',
      '(globalThis.savedForLimits = 41, true)',
    );
    host.client.close();
    await host.supervisor.close();
    const before = JSON.parse(
      await readFile(join(path, 'runtime.json'), 'utf8'),
    );
    const raisedEnv = {
      THIXOTROPE_CRANK_BUDGET: '30000000',
      THIXOTROPE_BOOTSTRAP_BUDGET: '1200000000',
      THIXOTROPE_SLOT_CEILING: '1500000',
      THIXOTROPE_CHUNK_CEILING: '400000000',
      THIXOTROPE_REQUEST_TIMEOUT_MS: '60000',
    };
    host = await start(raisedEnv);
    t.is(await host.client.call('evaluate', '++savedForLimits'), '42');
    t.is((await host.client.call('status')).ironhorse.requestTimeoutMs, 60_000);
    host.client.close();
    await host.supervisor.close();
    const manifest = await readFile(join(path, 'runtime.json'), 'utf8');
    const { limits: previous, ...oldIdentity } = before;
    const { limits: raised, ...newIdentity } = JSON.parse(manifest);
    t.deepEqual(newIdentity, oldIdentity);
    t.notDeepEqual(raised, previous);
    // Each heap ceiling is independently monotonic, including when an
    // operator forgets an environment setting and thereby selects its default:
    // a restored heap may already exceed the lower ceiling.
    for (const name of [
      'THIXOTROPE_SLOT_CEILING',
      'THIXOTROPE_CHUNK_CEILING',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(
        () => start({ ...raisedEnv, [name]: firstEnv[name] }),
        {
          message: /cannot decrease below persisted value/,
        },
      );
      // eslint-disable-next-line no-await-in-loop
      t.is(await readFile(join(path, 'runtime.json'), 'utf8'), manifest);
    }
    // Budgets are per-crank allowances and cannot invalidate a heap image, so
    // an experimentally raised budget can be tuned back down in place.
    const loweredEnv = {
      ...raisedEnv,
      THIXOTROPE_CRANK_BUDGET: firstEnv.THIXOTROPE_CRANK_BUDGET,
      THIXOTROPE_BOOTSTRAP_BUDGET: firstEnv.THIXOTROPE_BOOTSTRAP_BUDGET,
    };
    host = await start(loweredEnv);
    t.is(await host.client.call('evaluate', 'savedForLimits'), '42');
    t.like((await host.client.call('status')).ironhorse, {
      crankBudget: '20000000',
      bootstrapBudget: '1100000000',
    });
    host.client.close();
    await host.supervisor.close();
    const { limits: lowered } = JSON.parse(
      await readFile(join(path, 'runtime.json'), 'utf8'),
    );
    t.deepEqual(lowered, {
      crankBudget: '20000000',
      bootstrapBudget: '1100000000',
      slotCeiling: 1_500_000,
      chunkCeiling: 400_000_000,
    });
    host = await start(raisedEnv);
    t.is(await host.client.call('evaluate', 'savedForLimits'), '42');
  },
);
