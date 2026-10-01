// @ts-check
import test from '@endo/ses-ava/test.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { connectLocalControl } from '../../src/control/local-control.js';

import { makeNodePowers } from '../../src/platform/node/powers.js';

const nodePowers = makeNodePowers();

/** @import {ExecutionContext} from 'ava' */

const supervisorModuleSpecifier = JSON.stringify(
  new URL('../../src/control/supervisor.js', import.meta.url).href,
);

const powersModuleSpecifier = JSON.stringify(
  new URL('../../src/platform/node/powers.js', import.meta.url).href,
);

// The clock keeps real time in its adapter process: the alarm is armed far
// enough out that even a slow CI worker cannot deliver it before the crash.
const supervisorScript = `
import '@endo/init';
import { serveThixotrope } from ${supervisorModuleSpecifier};
import { makeNodePowers } from ${powersModuleSpecifier};
const nodePowers = makeNodePowers();
const [path] = process.argv.slice(1);
const supervisor = await serveThixotrope(nodePowers, path);
console.log('Alarm supervisor ready');
await supervisor.stopped;
await supervisor.close();
`;

/**
 * @param {ExecutionContext} t
 * @param {string} path
 */
const start = async (t, path) => {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', supervisorScript, path],
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
  const client = await connectLocalControl(
    nodePowers,
    join(path, 'control.sock'),
  );
  t.teardown(() => client.close());
  return { child, exited, client };
};

/**
 * Bounded by time rather than attempts: after a restart the clock's adapter
 * is a fresh process, forked and restored behind the start notices.
 * @param {() => Promise<boolean>} predicate
 */
const waitUntil = async predicate => {
  await null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(50);
  }
  throw Error('Alarm condition did not become true');
};

test.serial(
  'SIGKILL preserves an admitted alarm and its original guest listener',
  async t => {
    t.timeout(180_000);
    const path = await mkdtemp('/tmp/thix-alarm-crash-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    const first = await start(t, path);
    const { bundle } = await nodePowers.bundler.bundle(
      fileURLToPath(new URL('../../examples/reminder.js', import.meta.url)),
    );
    await first.client.call('install', 'reminders', bundle, [
      ['clock', 'clock'],
    ]);
    const armedAt = BigInt(Date.now());
    t.is(
      await first.client.call(
        'evaluate',
        "E(inventory.get('reminders')).arm(8000n, 'survive SIGKILL')",
      ),
      'true',
    );
    // arm() itself acknowledges before the cross-vat after() runs. A pending
    // alarm in the clock's count proves its manager admitted it.
    await waitUntil(async () => {
      const status = await first.client.call('alarmStatus');
      return status.pending === 1;
    });
    t.is(
      await first.client.call(
        'evaluate',
        "E(inventory.get('reminders')).status().then(s => s.count === 0n && s.items.length === 1 && s.items[0].state === 'waiting')",
      ),
      'true',
    );
    first.child.kill('SIGKILL');
    t.deepEqual(await first.exited, [null, 'SIGKILL']);

    // The deadline passes while no host runs.
    const elapsed = BigInt(Date.now()) - armedAt;
    if (elapsed < 8200n) await setTimeout(Number(8200n - elapsed));
    const recovered = await start(t, path);
    const waitForDelivery = () =>
      waitUntil(async () => {
        const status = await recovered.client.call('alarmStatus');
        return status.pending === 0;
      });
    await waitForDelivery();
    t.is(
      await recovered.client.call(
        'evaluate',
        `E(inventory.get('reminders')).status().then(s => s.count === 1n && s.items.length === 1 && s.items[0].state === 'fired' && s.items[0].message === 'survive SIGKILL' && s.items[0].firedAt >= ${armedAt + 8000n}n)`,
      ),
      'true',
      'restart settles the original listener exactly once, at or after the deadline',
    );
    // The installed application still holds the original clock grant; neither
    // the application nor its clock is replaced or granted again on restart.
    t.is(
      await recovered.client.call(
        'evaluate',
        "E(inventory.get('reminders')).arm(100n, 'retained clock')",
      ),
      'true',
    );
    await waitUntil(async () => {
      const result = await recovered.client.call(
        'evaluate',
        "E(inventory.get('reminders')).status().then(s => s.count === 2n && s.items.length === 2 && s.items.every(item => item.state === 'fired'))",
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
