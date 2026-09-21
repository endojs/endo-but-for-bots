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

for (const mode of ['write', 'failed-write', 'late-native']) {
  const fails = mode === 'failed-write';
  test.serial(
    `production Floot factory disposal drains admitted work and fences retained facets: ${mode}`,
    async t => {
      t.timeout(30_000);
      const root = await mkdtemp(
        path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-f-'),
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
        'factory-lifecycle-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      const host = await E(client.getBootstrap()).host();
      control = await E(host).makeUnconfined(
        '@node',
        new URL('./_floot-factory-lifecycle-powers.js', import.meta.url).href,
        { powersName: '@agent', resultName: 'control' },
      );
      await E(host).provideWorker('factory-worker');
      const factory = await E(host).makeUnconfined(
        'factory-worker',
        new URL('../../floot/agent.js', import.meta.url).href,
        { powersName: 'control', resultName: 'factory' },
      );
      t.deepEqual(await E(factory).getVoicePreferences(), {});
      if (mode === 'late-native') {
        await E(control).enableNative();
        const creation = E(factory).createSession({
          backendId: 'test',
          modelId: 'm',
        });
        void creation.catch(() => {});
        await E(control).writing();
        let settled = false;
        const disposal = E(host)
          .cancel('factory')
          .finally(() => {
            settled = true;
          });
        void disposal.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 50));
        t.false(settled);
        t.is(await E(control).terminated(), 0);
        await t.throwsAsync(E(host).lookup('factory'), {
          message: /disposal.*pending/i,
        });
        await E(control).release();
        // The cancelled startup may fail its admitted turn, but must stop the
        // late admin and settle disposal without waiting on its own startup.
        await t.throwsAsync(creation, { message: /closed|unreachable/ });
        await t.throwsAsync(disposal, { message: /Cancellation hooks failed/ });
        t.true(Number(await E(control).terminated()) >= 1);
        await t.throwsAsync(E(host).lookup('factory'), {
          message: /disposal.*failed/i,
        });
        return;
      }
      const keeper = await E(host).evaluate(
        'factory-worker',
        "makeExo('Keeper', M.interface('Keeper', {}, { defaultGuards: 'passable' }), { read: () => E(original).getVoicePreferences(), write: () => E(original).setVoicePreferences({voice: 'old'}) })",
        ['original'],
        ['factory'],
        'keeper',
      );
      await E(control).arm(fails);
      const writing = E(factory).setVoicePreferences({ voice: 'preserved' });
      void writing.catch(() => {});
      await E(control).writing();
      let disposed = false;
      const disposal = E(host)
        .cancel('factory')
        .then(() => {
          disposed = true;
        });
      void disposal.catch(() => {});
      await Promise.race([
        disposal,
        new Promise(resolve => setTimeout(resolve, 50)),
      ]);
      t.false(
        disposed,
        'factory cannot acknowledge disposal while its write is pending',
      );
      await t.throwsAsync(E(host).lookup('factory'), {
        message: /disposal.*pending/i,
      });
      await t.throwsAsync(E(keeper).write(), {
        message: /closed|dispos|cancel/i,
      });
      await E(control).release();
      if (fails) {
        await t.throwsAsync(writing, { message: /lost write acknowledgement/ });
        await t.throwsAsync(disposal, { message: /Cancellation hooks failed/ });
        await t.throwsAsync(E(host).lookup('factory'), {
          message: /disposal.*failed/i,
        });
        t.deepEqual(await E(control).lookup('floot-voice-preferences'), {
          voice: 'preserved',
        });
        return;
      }
      await writing;
      await disposal;
      const replacement = await E(host).lookup('factory');
      t.deepEqual(await E(replacement).getVoicePreferences(), {
        voice: 'preserved',
      });
      await t.throwsAsync(E(keeper).read(), {
        message: /closed|dispos|cancel/i,
      });
      t.deepEqual(await E(replacement).listSessions(), []);
    },
  );
}
