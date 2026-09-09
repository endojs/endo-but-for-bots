// @ts-check
import test from '@endo/ses-ava/test.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { connectLocalControl } from '../../src/local-control.js';
import { makeFsStore } from '../../src/store-fs.js';

import { makeNodePowers } from '../../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

/** @import {ExecutionContext} from 'ava' */
const cli = fileURLToPath(new URL('../../bin/thix.js', import.meta.url));

/**
 * @param {ExecutionContext} t
 * @param {string} path
 */
const start = async (t, path) => {
  const child = spawn(process.execPath, [cli, 'serve', path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.teardown(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await exited;
  });
  let diagnostic = '';
  child.stderr.on('data', bytes => {
    diagnostic = `${diagnostic}${String(bytes)}`.slice(-8192);
  });
  let output = '';
  await Promise.race([
    new Promise(resolve => {
      child.stdout.on('data', bytes => {
        output = `${output}${String(bytes)}`.slice(-8192);
        if (output.includes('Thixotrope listening')) resolve(undefined);
      });
    }),
    exited.then(() => {
      throw Error(`serve exited: ${diagnostic}`);
    }),
  ]);
  const client = await connectLocalControl(
    nodePowers,
    join(path, 'control.sock'),
  );
  t.teardown(() => client.close());
  return { child, exited, client };
};

/** @param {ExecutionContext} t */
const freePort = async t => {
  const server = createServer();
  t.teardown(() => server.close());
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected TCP port');
  await new Promise(resolve => server.close(() => resolve(undefined)));
  return address.port;
};

const application = `({ make: ({ http }) => {
  let count = 0n;
  let waiting = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = Far('PendingHttpHandler', {
    handle: () => { count += 1n; return new Promise(() => {}); },
  });
  E(http).listen(handler).catch(() => {});
  return Far('Application', {
    read: () => count,
    waiting: () => waiting,
    wait: () => { waiting = true; return gate; },
    release: () => { release('done'); return true; },
  });
} })`;

const listener = `(() => {
  let state = 'pending';
  E(app).wait().then(value => { state = value; });
  return Far('DurableWaiter', { status: () => state });
})()`;

test.serial(
  'SIGKILL drops orphaned HTTP clients while preserving accepted effects and durable listeners',
  async t => {
    t.timeout(180_000);
    const path = await mkdtemp('/tmp/thix-http-crash-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const port = await freePort(t);
    const first = await start(t, path);
    await first.client.call('httpGrant', 'web', port);
    await first.client.call('install', 'site', application, [['http', 'web']]);
    t.is(
      await first.client.call(
        'evaluate',
        `(async () => {
    globalThis.waiterVat = await E(vats).createWorker('independent-listener');
    globalThis.waiter = await E(waiterVat).evaluate(${JSON.stringify(listener)}, { app: await E(apps).get('site') });
    return E(waiter).status();
  })()`,
      ),
      "'pending'",
    );
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // Explicitly wait for both unrelated guest listener registration and HTTP bind.
      // eslint-disable-next-line no-await-in-loop
      const waiting = await first.client.call(
        'evaluate',
        "E(E(apps).get('site')).waiting()",
      );
      // eslint-disable-next-line no-await-in-loop
      const services = await first.client.call('httpServices');
      if (waiting === 'true' && services[0].status === 'listening') {
        ready = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await setTimeout(20);
    }
    t.true(ready, 'the independent guest listener and HTTP socket are ready');

    const outgoing = request({
      host: '127.0.0.1',
      port,
      path: '/',
      method: 'POST',
      agent: false,
    });
    t.teardown(() => outgoing.destroy());
    const rejected = new Promise(resolve => {
      outgoing.once('error', error => resolve({ error }));
      outgoing.once('response', response => {
        response.resume();
        resolve({ status: response.statusCode });
      });
    });
    outgoing.end();
    let accepted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        // eslint-disable-next-line no-await-in-loop
        (await first.client.call(
          'evaluate',
          "E(E(apps).get('site')).read()",
        )) === '1n'
      ) {
        accepted = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await setTimeout(20);
    }
    t.true(accepted, 'guest handler committed its effect before the crash');
    const store = makeFsStore(nodePowers, path);
    t.true(
      Object.keys(store.getHubState().sessions).some(key =>
        key.startsWith('transient:'),
      ),
      'the pending HTTP request has a persisted transient hub session',
    );
    first.child.kill('SIGKILL');
    t.deepEqual(await first.exited, [null, 'SIGKILL']);
    t.truthy(
      (await rejected).error,
      'the caller loses its response when the supervisor is killed',
    );

    const recovered = await start(t, path);
    t.false(
      Object.keys(store.getHubState().sessions).some(key =>
        key.startsWith('transient:'),
      ),
      'orphaned HTTP sessions must be forgotten before startup returns',
    );
    t.is(
      await recovered.client.call('evaluate', "E(E(apps).get('site')).read()"),
      '1n',
      'the host must not issue the interrupted HTTP invocation again',
    );
    t.is(
      await recovered.client.call('evaluate', 'E(waiter).status()'),
      "'pending'",
    );
    await recovered.client.call('evaluate', "E(E(apps).get('site')).release()");
    let settled = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        // eslint-disable-next-line no-await-in-loop
        (await recovered.client.call('evaluate', 'E(waiter).status()')) ===
        "'done'"
      ) {
        settled = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await setTimeout(20);
    }
    t.true(
      settled,
      'discarding HTTP clients leaves unrelated durable promise listeners intact',
    );
    await recovered.client.call('stop');
    t.deepEqual(await recovered.exited, [0, null]);
    t.deepEqual(
      await readdir(join(path, 'heaps', 'incarnations')),
      [],
      'shutdown releases worker incarnations and the engine lease',
    );
  },
);
