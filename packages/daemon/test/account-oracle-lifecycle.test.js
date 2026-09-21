// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { makeEndoClient, start, stop } from '../index.js';

for (const fails of [false, true]) {
  test.serial(
    `oracle formula drains journal and fences old source: lost acknowledgement=${fails}`,
    async t => {
      t.timeout(30_000);
      const root = await mkdtemp(
        path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-o-'),
      );
      const config = {
        statePath: path.join(root, 'state'),
        ephemeralStatePath: path.join(root, 'run'),
        cachePath: path.join(root, 'cache'),
        sockPath: path.join(root, 'endo.sock'),
        address: '127.0.0.1:0',
        pets: new Map(),
        values: new Map(),
        gcEnabled: true,
      };
      const cancelled = makePromiseKit();
      void cancelled.promise.catch(() => {});
      let control;
      t.teardown(async () => {
        if (control)
          await E(control)
            .release()
            .catch(() => {});
        try {
          await stop(config);
        } finally {
          cancelled.reject(Error('Test finished'));
          await rm(root, { recursive: true, force: true });
        }
      });
      await start(config);
      const client = await makeEndoClient(
        'oracle-lifecycle-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      const host = await E(client.getBootstrap()).host();
      control = await E(host).makeUnconfined(
        '@node',
        new URL('./_account-oracle-lifecycle-powers.js', import.meta.url).href,
        { powersName: '@agent', resultName: 'control' },
      );
      await E(host).provideWorker('oracle-worker');
      const oracle = await E(host).makeUnconfined(
        'oracle-worker',
        new URL(
          '../../hosted-agent/src/account-oracle-module.js',
          import.meta.url,
        ).href,
        {
          powersName: 'control',
          resultName: 'oracle',
          env: harden({ ACCOUNT_PROVIDER_ID: 'codex' }),
        },
      );
      const keeper = await E(host).evaluate(
        'oracle-worker',
        "makeExo('Keeper', M.interface('Keeper', {}, { defaultGuards: 'passable' }), { read: () => E(original).getRateLimits() })",
        ['original'],
        ['oracle'],
        'keeper',
      );
      await E(oracle).getPlan();
      await E(control).arm(fails);
      await E(control).pushOld(65);
      await E(control).writing();
      let disposed = false;
      const disposal = E(host)
        .cancel('oracle')
        .then(() => {
          disposed = true;
        });
      void disposal.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 50));
      t.false(disposed);
      await t.throwsAsync(E(host).lookup('oracle'), {
        message: /disposal.*pending/i,
      });
      await t.throwsAsync(E(keeper).read(), {
        message: /closed|dispos|cancel/i,
      });
      await E(control).release();
      if (fails) {
        await t.throwsAsync(disposal, { message: /Cancellation hooks failed/ });
        await t.throwsAsync(E(host).lookup('oracle'), {
          message: /disposal.*failed/i,
        });
      } else {
        await disposal;
        await E(control).swapSource();
        const replacement = await E(host).lookup('oracle');
        t.is((await E(replacement).getRateLimits()).windows[0].usedPercent, 65);
      }
      const writes = await E(control).writes();
      await E(control).pushOld(95);
      await new Promise(resolve => setTimeout(resolve, 25));
      t.is(
        await E(control).writes(),
        writes,
        'retained old source cannot journal after disposal',
      );
    },
  );
}
