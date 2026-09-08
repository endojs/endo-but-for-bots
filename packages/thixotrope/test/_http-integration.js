// @ts-check
import harden from '@endo/harden';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { bundleApplication } from '../src/bundle-application.js';
import { connectLocalControl } from '../src/local-control.js';
import { makePeerJournalReplayEngine } from '../src/peer-replay-engine.js';
import { serveThixotrope } from '../src/supervisor.js';
import { makeFsStore } from '../src/store-fs.js';

/** @import {TestFn} from 'ava' */
/** @param {TestFn} test @param {'replay'|'ironhorse'} kind */
export const registerHttpIntegration = (test, kind) => {
  test.serial(
    `installed HTTP application restores state and listener after restart (${kind})`,
    async t => {
      t.timeout(180_000);
      const path = await mkdtemp('/tmp/thix-http-app-');
      t.teardown(() => rm(path, { recursive: true, force: true }));
      const reservation = createServer();
      t.teardown(() => reservation.close());
      await new Promise(resolve =>
        reservation.listen(0, '127.0.0.1', () => resolve(undefined)),
      );
      const address = reservation.address();
      if (!address || typeof address === 'string')
        throw Error('Expected TCP port');
      const { port } = address;
      await new Promise(resolve => reservation.close(() => resolve(undefined)));
      const start = async () => {
        const supervisor = await serveThixotrope(
          path,
          kind === 'ironhorse'
            ? {}
            : {
                engine: harden({
                  ...makePeerJournalReplayEngine(),
                  acquireStore: async () => async () => {},
                }),
              },
        );
        t.teardown(() => supervisor.close());
        const client = await connectLocalControl(join(path, 'control.sock'));
        t.teardown(() => client.close());
        return { supervisor, client };
      };
      let host = await start();
      const granted = await host.client.call('httpGrant', 'web', port);
      t.is(granted.desired, 'allocated');
      const { bundle } = await bundleApplication(
        fileURLToPath(new URL('../examples/http-counter.js', import.meta.url)),
      );
      await host.client.call('install', 'site', bundle, [['http', 'web']]);
      for (let i = 0; i < 100; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if ((await host.client.call('httpServices'))[0].status === 'listening')
          break;
        // eslint-disable-next-line no-await-in-loop
        await setTimeout(30);
      }
      const request = async (method, route) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
          method,
          headers: { connection: 'close' },
        });
        t.is(response.status, 200);
        return response.text();
      };
      t.is(await request('POST', '/incr'), '1\n');
      host.client.close();
      await host.supervisor.close();
      host = await start();
      t.is(await request('GET', '/read'), '1\n');
      t.is(await request('POST', '/incr'), '2\n');
      t.is(
        await host.client.call('evaluate', "E(E(apps).get('site')).read()"),
        '2n',
      );
      const store = makeFsStore(path);
      t.false(
        Object.keys(store.getHubState().sessions).some(key =>
          key.startsWith('transient:'),
        ),
      );
      await host.client.call('evaluate', "E(E(apps).get('site')).close()");
      t.is((await host.client.call('httpServices'))[0].desired, 'closed');
      await t.throwsAsync(() => fetch(`http://127.0.0.1:${port}/read`));
      host.client.close();
      await host.supervisor.close();
      host = await start();
      t.is((await host.client.call('httpServices'))[0].desired, 'closed');
      await t.throwsAsync(() => fetch(`http://127.0.0.1:${port}/read`));
      t.is(
        await host.client.call('evaluate', "E(E(apps).get('site')).read()"),
        '2n',
      );
    },
  );
};
harden(registerHttpIntegration);
