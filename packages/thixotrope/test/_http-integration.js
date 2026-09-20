// @ts-check
import harden from '@endo/harden';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleApplication } from '../src/control/bundle-application.js';
import { connectLocalControl } from '../src/control/local-control.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { serveThixotrope } from '../src/control/supervisor.js';
import { makeFsStore } from '../src/store/store-fs.js';

import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();

/** @import {TestFn} from 'ava' */
/**
 * @param {TestFn} test @param {'replay'|'ironhorse'} kind
 * @param kind
 */
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
      const nativeChildren = [];
      const platform = harden({
        ...nodePowers,
        nativeWorkers: harden({
          start: async options => {
            const child = await nodePowers.nativeWorkers.start(options);
            nativeChildren.push(child);
            return child;
          },
        }),
      });
      const start = async () => {
        const supervisor = await serveThixotrope(
          platform,
          path,
          kind === 'ironhorse'
            ? {}
            : {
                engine: harden({
                  ...makePeerJournalReplayEngine(nodePowers),
                  acquireStore: async () => async () => {},
                }),
              },
        );
        t.teardown(() => supervisor.close());
        const client = await connectLocalControl(
          nodePowers,
          join(path, 'control.sock'),
        );
        t.teardown(() => client.close());
        return { supervisor, client };
      };
      let host = await start();
      await host.client.call(
        'installNative',
        'web',
        fileURLToPath(new URL('../resources/http/', import.meta.url)),
      );
      t.is(
        await host.client.call(
          'evaluate',
          "E(inventory.get('web')).__getMethodNames__().then(names => [...names].filter(name => name !== '__getMethodNames__').sort().join(','))",
        ),
        "'help,register'",
      );
      const { bundle } = await bundleApplication(
        nodePowers.bundler,
        fileURLToPath(new URL('../examples/http-counter.js', import.meta.url)),
      );
      await host.client.call('install', 'site', bundle, [['http', 'web']]);
      await host.client.call(
        'evaluate',
        `E(E(apps).get('site')).start(${port})`,
      );
      // Use a fresh Node HTTP request: Node 24's fetch client cleanup assigns
      // an error message inherited as read-only under SES lockdown.
      /**
       * @param {string} method @param {string} route
       * @param route
       */
      const request = (method, route) =>
        new Promise((resolve, reject) => {
          const outgoing = httpRequest(
            { host: '127.0.0.1', port, path: route, method, agent: false },
            response => {
              t.is(response.statusCode, 200);
              response.setEncoding('utf8');
              let body = '';
              response.on('data', chunk => {
                body += chunk;
              });
              response.once('error', reject);
              response.once('end', () => resolve(body));
            },
          );
          t.teardown(() => outgoing.destroy());
          outgoing.once('error', reject);
          outgoing.end();
        });
      t.is(await request('POST', '/incr'), '1\n');
      await nativeChildren.at(-1).terminate();
      await host.client.call(
        'evaluate',
        `E(E(apps).get('site')).start(${port})`,
      );
      t.is(await request('GET', '/read'), '1\n');
      host.client.close();
      await host.supervisor.close();
      host = await start();
      t.is(await request('GET', '/read'), '1\n');
      t.is(await request('POST', '/incr'), '2\n');
      t.is(
        await host.client.call('evaluate', "E(E(apps).get('site')).read()"),
        '2n',
      );
      const store = makeFsStore(nodePowers, path);
      t.false(
        Object.keys(store.getHubState().sessions).some(
          key =>
            key.startsWith('transient:') &&
            !key.startsWith('transient:native:'),
        ),
      );
      await host.client.call('evaluate', "E(E(apps).get('site')).close()");
      t.is(
        await host.client.call(
          'evaluate',
          "E(E(apps).get('site')).status().then(s => s.status)",
        ),
        "'closed'",
      );
      await t.throwsAsync(() => request('GET', '/read'), {
        code: 'ECONNREFUSED',
      });
      host.client.close();
      await host.supervisor.close();
      host = await start();
      t.is(
        await host.client.call(
          'evaluate',
          "E(E(apps).get('site')).status().then(s => s.status)",
        ),
        "'closed'",
      );
      await t.throwsAsync(() => request('GET', '/read'), {
        code: 'ECONNREFUSED',
      });
      t.is(
        await host.client.call('evaluate', "E(E(apps).get('site')).read()"),
        '2n',
      );
    },
  );
};
harden(registerHttpIntegration);
