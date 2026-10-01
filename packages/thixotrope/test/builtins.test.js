// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';

import { serveThixotrope } from '../src/control/supervisor.js';
import { connectLocalControl } from '../src/control/local-control.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeLogPowers } from '../src/platform/logging.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

const powers = makeNodePowers();
/** The supervisor's diagnostics, for what a start says of its socket. */
/** @type {string[]} */
const diagnostics = [];
const observed = harden({
  ...powers,
  logging: makeLogPowers({
    log: (...args) => powers.logging.log(...args),
    info: () => {},
    error: (...args) => {
      diagnostics.push(args.map(String).join(' '));
      powers.logging.error(...args);
    },
  }),
});

/**
 * @param {import('ava').ExecutionContext} t
 * @param {string} path
 */
const start = async (t, path) => {
  const supervisor = await serveThixotrope(observed, path, {
    engine: harden({
      ...makePeerJournalReplayEngine(powers),
      acquireStore: async () => async () => {},
    }),
  });
  t.teardown(() => supervisor.close());
  const client = await connectLocalControl(powers, join(path, 'control.sock'));
  t.teardown(() => client.close());
  return {
    client,
    stop: async () => {
      client.close();
      await supervisor.close();
    },
  };
};

test.serial(
  'the workspace provides a clock and a mailbox as installations in their own vats',
  async t => {
    t.timeout(60_000);
    const path = await mkdtemp('/tmp/thix-builtins-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    let host = await start(t, path);
    t.teardown(() => host.stop());
    // The control socket this connection came through is the resource's,
    // not the host's own listener.
    t.false(
      diagnostics.some(line => line.includes('control socket served by')),
      diagnostics.join('\n'),
    );
    t.like(
      (await host.client.call('installations')).find(
        (/** @type {{name: string}} */ entry) => entry.name === 'control',
      ),
      { kind: 'native', digest: 'builtin:control', status: 'ready' },
    );
    await t.throwsAsync(() => host.client.call('remove', 'control'), {
      message: /cannot be removed/,
    });
    const listed = await host.client.call('installations');
    t.like(
      listed.find(entry => entry.name === 'clock'),
      { kind: 'native', digest: 'builtin:clock', status: 'ready' },
    );
    t.like(
      listed.find(entry => entry.name === 'mailbox'),
      { kind: 'application', digest: 'builtin:mailbox', status: 'ready' },
    );
    // A zero delay settles at once with the host time, through the clock's
    // own adapter process.
    t.regex(
      await host.client.call('evaluate', "E(inventory.get('clock')).after(0n)"),
      /^[0-9]+n$/,
    );
    t.is(
      await host.client.call(
        'evaluate',
        "E(inventory.get('mailbox')).inbox().then(messages => messages.length)",
      ),
      '0',
    );
    const vatOf = async name => {
      const status = await host.client.call('status');
      return status.workers.find(
        worker =>
          worker.debugLabel === `app:${name}` ||
          worker.debugLabel === `native:${name}`,
      )?.workerId;
    };
    const clockVat = await vatOf('clock');
    t.truthy(clockVat);
    t.not(clockVat, (await host.client.call('status')).workspace);
    // An alarm armed through the clock is a registration in the clock's
    // manager vat, counted by its status.
    await host.client.call(
      'evaluate',
      "globalThis.never = E(inventory.get('clock')).at(2n ** 50n); never.catch(() => {}); undefined",
    );
    // Arming is asynchronous to the evaluation that requested it.
    let armed = false;
    for (let attempt = 0; attempt < 100 && !armed; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const status = await host.client.call('alarmStatus');
      armed = status.pending === 1;
      // eslint-disable-next-line no-await-in-loop
      if (!armed) await setTimeout(25);
    }
    t.true(armed);
    // Removing the clock retires its vat, with its alarms and its adapter
    // process; the next start provides a fresh one.
    t.true(await host.client.call('remove', 'clock'));
    await t.throwsAsync(() => host.client.call('alarmStatus'), {
      message: /not installed/,
    });
    t.is(await host.client.call('evaluate', "inventory.has('clock')"), 'false');
    const mailboxVat = await vatOf('mailbox');
    t.truthy(mailboxVat);
    await host.stop();
    host = await start(t, path);
    t.is(await host.client.call('evaluate', "inventory.has('clock')"), 'true');
    const replacement = await vatOf('clock');
    t.truthy(replacement);
    t.not(replacement, clockVat);
    t.is(await vatOf('mailbox'), mailboxVat, 'the mailbox is kept');
  },
);
