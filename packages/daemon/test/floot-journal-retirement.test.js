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

for (const [kind, after] of [
  ['value', false],
  ['value', true],
  ['schema', true],
  ['gc', false],
]) {
  test.serial(
    `Floot journal retirement survives daemon restart: ${kind}, applied=${after}`,
    async t => {
      t.timeout(45_000);
      const root = await mkdtemp(
        path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-j-'),
      );
      const config = {
        statePath: path.join(root, 'state'),
        ephemeralStatePath: path.join(root, 'run'),
        cachePath: path.join(root, 'cache'),
        sockPath: path.join(root, 'endo.sock'),
        address: '127.0.0.1:0',
        pets: new Map(),
        values: new Map(),
        // Isolate removal acknowledgement faults from the separate real-GC
        // case: collecting a guest terminates workers retaining its presence.
        gcEnabled: kind === 'gc',
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
      const connect = async () => {
        const client = await makeEndoClient(
          'journal-retirement-test',
          config.sockPath,
          cancelled.promise,
        );
        void client.closed.catch(() => {});
        return E(client.getBootstrap()).host();
      };
      await start(config);
      const host = await connect();
      const readRegistry = async currentHost => {
        const names = (await E(currentHost).list())
          .filter(name => /^floot-sessions-v1-\d{20}$/.test(name))
          .sort();
        const name = names.at(-1);
        if (!name) throw Error('Missing durable registry');
        return E(currentHost).lookup(name);
      };
      const powers = await E(host).makeUnconfined(
        '@node',
        new URL('./_floot-journal-retirement-powers.js', import.meta.url).href,
        { powersName: '@agent', resultName: 'retirement-control' },
      );
      await E(host).provideWorker('journal-factory-worker');
      const factory = await E(host).makeUnconfined(
        'journal-factory-worker',
        new URL('../../floot/agent.js', import.meta.url).href,
        { powersName: 'retirement-control', resultName: 'journal-factory' },
      );
      await E(host).storeValue(
        harden({ preserved: true }),
        'unrelated-retirement-data',
      );
      const session = await E(factory).createSession({
        backendId: 'test',
        modelId: 'm',
      });
      const { id } = await E(session).getInfo();
      const turn = await E(session).startTurn('write journal evidence');
      await E(turn).whenFinished();
      t.is((await E(turn).getStatus()).error, null);
      let survivor;
      let survivorId;
      let survivorHistory;
      if (kind === 'gc') {
        survivor = await E(factory).createSession({
          backendId: 'test',
          modelId: 'm',
        });
        survivorId = (await E(survivor).getInfo()).id;
        const seed = await E(survivor).startTurn('preserve this other session');
        await E(seed).whenFinished();
        t.is((await E(seed).getStatus()).error, null);
        survivorHistory = await E(survivor).getHistory();
        t.deepEqual(survivorHistory, [
          { role: 'user', content: 'preserve this other session' },
          { role: 'assistant', content: 'journal evidence' },
        ]);
      }
      const expectedIds = survivorId ? [survivorId] : [];
      const prefix = `floot-private-turn-${id.length}-${id}-`;
      /** @type {string[]} */
      const before = (await E(host).list()).filter(name =>
        name.startsWith(prefix),
      );
      t.true(before.length > 1);
      if (kind !== 'gc') await E(powers).armRemoval(prefix, kind, after);
      await t.throwsAsync(E(factory).deleteSession(id), {
        message:
          kind === 'gc'
            ? /became unreachable by any pet name path and was collected/
            : /Injected journal removal/,
      });
      if (survivor) {
        // Characterize the collateral loss of an unrelated held session facet.
        // A fix must keep this facet usable, not merely recover on restart.
        await t.throwsAsync(E(survivor).getInfo(), {
          message: /became unreachable by any pet name path and was collected/,
        });
      }
      const failedRegistry = await readRegistry(host);
      t.is(failedRegistry.sessions[0].id, id);
      t.true(
        (kind === 'gc' ? ['deleting', 'error'] : ['error']).includes(
          failedRegistry.sessions[0].lifecycle,
        ),
      );
      const remaining = (await E(host).list()).filter(name =>
        name.startsWith(prefix),
      );
      if (kind === 'schema') t.deepEqual(remaining, []);
      else t.true(remaining.includes(`${prefix}schema`));

      // A new daemon and worker reconstruct the persisted terminal intent; no
      // old factory objects or injected fault state are reused.
      await stop(config);
      await start(config);
      const revivedHost = await connect();
      const revivedFactory = await E(revivedHost).lookup('journal-factory');
      const recoveryDeadline = Date.now() + 10_000;
      while (Date.now() < recoveryDeadline) {
        // eslint-disable-next-line no-await-in-loop
        const current = await readRegistry(revivedHost);
        if (!current.sessions.some(entry => entry.id === id)) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      t.deepEqual(
        (await E(revivedFactory).listSessions()).map(entry => entry.id),
        expectedIds,
      );
      t.deepEqual(
        (await readRegistry(revivedHost)).sessions.map(entry => entry.id),
        expectedIds,
      );
      if (survivorId) {
        const recovered = await E(revivedFactory).getSession(survivorId);
        t.deepEqual(await E(recovered).getHistory(), survivorHistory);
        const nextTurn = await E(recovered).startTurn('continue after restart');
        await E(nextTurn).whenFinished();
        t.is((await E(nextTurn).getStatus()).error, null);
      }
      t.deepEqual(
        (await E(revivedHost).list()).filter(name => name.startsWith(prefix)),
        [],
      );
      t.deepEqual(await E(revivedHost).lookup('unrelated-retirement-data'), {
        preserved: true,
      });
      // A second cold start must not resurrect an in-memory-only completion.
      await stop(config);
      await start(config);
      const finalHost = await connect();
      const finalFactory = await E(finalHost).lookup('journal-factory');
      t.deepEqual(
        (await E(finalFactory).listSessions()).map(entry => entry.id),
        expectedIds,
      );
      t.deepEqual(
        (await readRegistry(finalHost)).sessions.map(entry => entry.id),
        expectedIds,
      );
      t.deepEqual(
        (await E(finalHost).list()).filter(name => name.startsWith(prefix)),
        [],
      );
    },
  );
}
