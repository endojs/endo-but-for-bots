// @ts-check
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { serveThixotrope } from '../../src/control/supervisor.js';
import { connectLocalControl } from '../../src/control/local-control.js';
import { makeNodePowers } from '../../src/platform/node/powers.js';

const powers = makeNodePowers();

test.serial(
  'native manager meter failure leaves workspace and sibling usable',
  async t => {
    t.timeout(120_000);
    const path = await mkdtemp('/tmp/thix-native-vat-');
    const directory = await mkdtemp('/tmp/thix-native-module-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    t.teardown(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      join(directory, 'package.json'),
      '{"name":"native-manager-fixture","type":"module"}',
    );
    await writeFile(
      join(directory, 'durable.js'),
      `export const make = ({Far}) => {
    let starts = 0;
    return harden({
      registration: Far('Registration', {
        starts: () => starts,
        exhaust: () => { let n = 0; while (n < 1000000000) n += 1; return n; },
      }),
      lifecycle: Far('Lifecycle', {started: () => { starts += 1; }}),
    });
  };`,
    );
    await writeFile(
      join(directory, 'ephemeral.js'),
      'export const make = () => undefined;',
    );
    const start = async () => {
      const supervisor = await serveThixotrope(powers, path);
      t.teardown(() => supervisor.close());
      const client = await connectLocalControl(
        powers,
        join(path, 'control.sock'),
      );
      t.teardown(() => client.close());
      return { supervisor, client };
    };
    let host = await start();
    await host.client.call('installNative', 'bad', directory);
    await host.client.call('installNative', 'good', directory);
    await t.throwsAsync(() =>
      host.client.call('evaluate', "E(inventory.get('bad')).exhaust()"),
    );
    t.is(await host.client.call('evaluate', '6 * 7'), '42');
    t.is(
      await host.client.call('evaluate', "E(inventory.get('good')).starts()"),
      '0',
    );
    const before = await host.client.call('status');
    t.truthy(
      before.workers.find(worker => worker.debugLabel === 'native:bad').failure,
    );
    t.falsy(
      before.workers.find(worker => worker.workerId === before.workspace)
        .failure,
    );
    host.client.close();
    await host.supervisor.close();
    host = await start();
    t.is(await host.client.call('evaluate', '6 * 7'), '42');
    t.is(
      await host.client.call('evaluate', "E(inventory.get('good')).starts()"),
      '1',
    );
    await host.client.call('installNative', 'bad', directory);
    const after = await host.client.call('status');
    t.is(
      after.workers.filter(worker => worker.debugLabel === 'native:bad').length,
      1,
    );
  },
);
