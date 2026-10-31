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

for (const mode of ['pending', 'failed', 'mutual', 'dependency']) {
  const fails = mode === 'failed' || mode === 'dependency';
  test.serial(
    `formula reconstruction fences ${mode} remote disposal`,
    async t => {
      t.timeout(30_000);
      const root = await mkdtemp(
        path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-d-'),
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
      t.teardown(async () => {
        try {
          await stop(config);
        } finally {
          cancelled.reject(Error('Test finished'));
          await rm(root, { recursive: true, force: true });
        }
      });
      await start(config);
      const client = await makeEndoClient(
        'disposal-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      const host = await E(client.getBootstrap()).host();
      const control = await E(host).makeUnconfined(
        '@node',
        new URL('./_disposal-barrier-control.js', import.meta.url).href,
        {
          powersName: '@agent',
          resultName: 'control',
        },
      );
      await E(host).provideWorker('service-worker');
      const original = await E(host).makeUnconfined(
        'service-worker',
        new URL('./_disposal-barrier-service.js', import.meta.url).href,
        {
          powersName: 'control',
          resultName: 'service',
          env: {
            FAIL_DISPOSAL: fails ? '1' : '0',
            SKIP_DRAIN: mode === 'dependency' ? '1' : '0',
            ...(mode === 'mutual' ? { PROBE_NAME: 'other' } : {}),
          },
        },
      );
      t.is(await E(original).read(), 1);
      if (mode === 'dependency') {
        // An unconfined formula depends on its powers formula. Cancelling
        // those powers must fence its dependent, not just direct cancellees.
        await E(host).cancel('control');
        await t.throwsAsync(E(host).lookup('service'), {
          message: /disposal.*(pending|failed)/i,
        });
        return;
      }
      if (mode === 'mutual') {
        await E(host).provideWorker('other-worker');
        await E(host).makeUnconfined(
          'other-worker',
          new URL('./_disposal-barrier-service.js', import.meta.url).href,
          {
            powersName: 'control',
            resultName: 'other',
            env: { PROBE_NAME: 'service' },
          },
        );
        const cancelledBoth = ['service', 'other'].map(name =>
          E(host)
            .cancel(name)
            .then(
              () => undefined,
              error => error,
            ),
        );
        // eslint-disable-next-line no-await-in-loop
        while ((await E(control).draining()) !== 2) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await E(control).release();
        const errors = await Promise.all(cancelledBoth);
        t.true(
          errors.every(error =>
            /Cancellation hooks failed/.test(error?.message),
          ),
        );
        t.is(
          await E(control).count(),
          2,
          'mutual disposal never constructs replacements',
        );
        return;
      }
      const keeper = await E(host).evaluate(
        'service-worker',
        "makeExo('Keeper', M.interface('Keeper', {}, { defaultGuards: 'passable' }), { read: () => E(original).read(), registerLate: () => E(original).registerLate(), cancelAgain: () => E(original).cancelAgain() })",
        ['original'],
        ['service'],
        'keeper',
      );
      const cancellation = E(host)
        .cancel('service')
        .then(
          () => undefined,
          error => error,
        );
      await Promise.race([
        E(control).closing(),
        cancellation.then(error => {
          throw error || Error('Disposal returned before hook ran');
        }),
      ]);
      await t.throwsAsync(E(host).lookup('service'), {
        message: /disposal.*pending/i,
      });
      t.is(await E(control).count(), 1);
      await t.throwsAsync(E(keeper).read(), {
        message: /closed|cancel|revok/i,
      });
      await t.throwsAsync(E(keeper).registerLate(), { message: /cancel/i });
      await E(control).release();
      const error = await cancellation;
      if (fails) {
        t.truthy(error);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop
          await t.throwsAsync(E(host).lookup('service'), {
            message: /disposal.*failed/i,
          });
        }
        t.is(await E(control).count(), 1);
      } else {
        t.is(error, undefined);
        const replacement = await E(host).lookup('service');
        t.is(await E(replacement).read(), 2);
        await E(keeper).cancelAgain();
        t.is(
          await E(replacement).read(),
          2,
          'old cancellation cannot fence successor',
        );
        await t.throwsAsync(E(keeper).read(), {
          message: /closed|cancel|revok/i,
        });
      }
    },
  );
}
