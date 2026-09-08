// @ts-check
import test from '@endo/ses-ava/test.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { bundleApplication } from '../../src/bundle-application.js';
import { connectLocalControl } from '../../src/local-control.js';

/** @import {ExecutionContext} from 'ava' */

// Hold wall time constant in each process so even a slow CI worker cannot
// deliver the first alarm before the crash. Only the host receives this power.
const supervisorScript = `
import '@endo/init';
import { serveThixotrope } from ${JSON.stringify(new URL('../../src/supervisor.js', import.meta.url).href)};
const [path, timestamp] = process.argv.slice(1);
if (!/^[0-9]+$/.test(timestamp)) throw Error('Invalid test timestamp');
const now = BigInt(timestamp);
if (now >= 2n ** 63n) throw Error('Invalid test timestamp');
const supervisor = await serveThixotrope(path, { alarmNow: () => now });
console.log('Alarm supervisor ready');
await supervisor.stopped;
await supervisor.close();
`;

/**
 * @param {ExecutionContext} t
 * @param {string} path
 * @param {bigint} now
 */
const start = async (t, path, now) => {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', supervisorScript, path, String(now)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
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
        if (output.includes('Alarm supervisor ready')) resolve(undefined);
      });
    }),
    exited.then(() => {
      throw Error(`Alarm supervisor exited: ${diagnostic}`);
    }),
  ]);
  const client = await connectLocalControl(join(path, 'control.sock'));
  t.teardown(() => client.close());
  return { child, exited, client };
};

/** @param {() => Promise<boolean>} predicate */
const waitUntil = async predicate => {
  await null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(25);
  }
  throw Error('Alarm condition did not become true');
};

test.serial(
  'SIGKILL preserves an admitted alarm and its original guest listener',
  async t => {
    t.timeout(180_000);
    const path = await mkdtemp('/tmp/thix-alarm-crash-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const first = await start(t, path, 1000n);
    await first.client.call('clockGrant', 'clock');
    const { bundle } = await bundleApplication(
      fileURLToPath(new URL('../../examples/reminder.js', import.meta.url)),
    );
    await first.client.call('install', 'reminders', bundle, [
      ['clock', 'clock'],
    ]);
    t.is(
      await first.client.call(
        'evaluate',
        "E(E(apps).get('reminders')).arm(2000n, 'survive SIGKILL')",
      ),
      'true',
    );
    // arm() itself acknowledges before the cross-vat when() runs. A host
    // registration proves the clock's authoritative guest map admitted it.
    await waitUntil(async () => {
      const status = await first.client.call('alarmStatus');
      return status.pending === 1;
    });
    t.is(
      await first.client.call(
        'evaluate',
        "E(E(apps).get('reminders')).status().then(s => s.count === 0n && s.items.length === 1 && s.items[0].state === 'waiting')",
      ),
      'true',
    );
    first.child.kill('SIGKILL');
    t.deepEqual(await first.exited, [null, 'SIGKILL']);

    const recovered = await start(t, path, 3000n);
    const waitForDelivery = () =>
      waitUntil(async () => {
        const status = await recovered.client.call('alarmStatus');
        return status.pending === 0 && status.observations === 0;
      });
    await waitForDelivery();
    t.is(
      await recovered.client.call(
        'evaluate',
        "E(E(apps).get('reminders')).status().then(s => s.count === 1n && s.items.length === 1 && s.items[0].state === 'fired' && s.items[0].message === 'survive SIGKILL' && s.items[0].firedAt === 3000n)",
      ),
      'true',
      'restart settles the original listener exactly once at the new host time',
    );
    // The installed application still holds the original clock grant; neither
    // the application nor its clock is replaced or granted again on restart.
    t.is(
      await recovered.client.call(
        'evaluate',
        "E(E(apps).get('reminders')).arm(3000n, 'retained clock')",
      ),
      'true',
    );
    await waitUntil(async () => {
      const result = await recovered.client.call(
        'evaluate',
        "E(E(apps).get('reminders')).status().then(s => s.count === 2n && s.items.length === 2 && s.items.every(item => item.state === 'fired' && item.firedAt === 3000n))",
      );
      return result === 'true';
    });
    await waitForDelivery();
    await recovered.client.call('stop');
    t.deepEqual(await recovered.exited, [0, null]);
    t.deepEqual(
      await readdir(join(path, 'heaps', 'incarnations')),
      [],
      'shutdown releases worker incarnations and the engine lease',
    );
  },
);
