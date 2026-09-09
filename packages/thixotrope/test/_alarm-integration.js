// @ts-check
import harden from '@endo/harden';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { bundleApplication } from '../src/bundle-application.js';
import { connectLocalControl } from '../src/local-control.js';
import { makePeerJournalReplayEngine } from '../src/peer-replay-engine.js';
import { serveThixotrope } from '../src/supervisor.js';

import { makeNodePowers } from '../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

/** @import {TestFn} from 'ava' */
/**
 * @param {TestFn} test
 * @param {'replay'|'ironhorse'} kind
 */
export const registerAlarmIntegration = (test, kind) => {
  test.serial(
    `installed reminder retains its original listener across overdue restart (${kind})`,
    async t => {
      t.timeout(180_000);
      const path = await mkdtemp('/tmp/thix-alarm-app-');
      t.teardown(() => rm(path, { recursive: true, force: true }));
      let wallClock = 1000n;
      const start = async () => {
        const supervisor = await serveThixotrope(nodePowers, path, {
          alarmNow: () => wallClock,
          ...(kind === 'ironhorse'
            ? {}
            : {
                engine: harden({
                  ...makePeerJournalReplayEngine(nodePowers),
                  acquireStore: async () => async () => {},
                }),
              }),
        });
        t.teardown(() => supervisor.close());
        const client = await connectLocalControl(
          nodePowers,
          join(path, 'control.sock'),
        );
        t.teardown(() => client.close());
        return { supervisor, client };
      };
      let host = await start();
      await host.client.call('clockGrant', 'clock');
      t.is(
        await host.client.call('evaluate', "E(inventory.get('clock')).now()"),
        '1000n',
      );
      t.is(
        await host.client.call(
          'evaluate',
          "E(inventory.get('clock')).__getMethodNames__().then(names => names.includes('fire') || names.includes('pending'))",
        ),
        'false',
      );
      const { bundle } = await bundleApplication(
        nodePowers,
        fileURLToPath(new URL('../examples/reminder.js', import.meta.url)),
      );
      await host.client.call('install', 'reminders', bundle, [
        ['clock', 'clock'],
      ]);
      t.is(
        await host.client.call(
          'evaluate',
          "E(E(apps).get('reminders')).arm(2000n, 'after restart')",
        ),
        'true',
      );
      t.is(
        await host.client.call(
          'evaluate',
          "E(E(apps).get('reminders')).status().then(s => s.count === 0n && s.items[0].state === 'waiting')",
        ),
        'true',
      );
      host.client.close();
      await host.supervisor.close();
      // Advance only while the host is absent. Its replacement must rebuild
      // its timer index and settle the original guest promise and listener.
      wallClock = 3000n;
      host = await start();
      const waitForHostDelivery = async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          // Observe the host only; do not wake the reminder with status calls
          // while waiting for the overdue alarm dispatch acknowledgment.
          // eslint-disable-next-line no-await-in-loop
          const status = await host.client.call('alarmStatus');
          if (status.pending === 0 && status.observations === 0) return;
          // eslint-disable-next-line no-await-in-loop
          await setTimeout(30);
        }
        throw Error('Alarm scheduler did not finish delivery');
      };
      await waitForHostDelivery();
      t.is(
        await host.client.call(
          'evaluate',
          "E(E(apps).get('reminders')).status().then(s => s.count === 1n && s.items[0].state === 'fired' && s.items[0].message === 'after restart' && s.items[0].firedAt === 3000n)",
        ),
        'true',
      );
      // Restart again with no pending alarm: the completed listener must not
      // fire again. Reuse the exact retained clock grant for a new alarm.
      host.client.close();
      await host.supervisor.close();
      wallClock = 4000n;
      host = await start();
      t.is(
        await host.client.call(
          'evaluate',
          "E(E(apps).get('reminders')).status().then(s => s.count)",
        ),
        '1n',
      );
      t.is(
        await host.client.call(
          'evaluate',
          "E(E(apps).get('reminders')).arm(5000n, 'reuse')",
        ),
        'true',
      );
      wallClock = 6000n;
      // Registration travels through the guest clock; wait for its durable
      // pending record before examining host completion of the second alarm.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const result = await host.client.call(
          'evaluate',
          "E(E(apps).get('reminders')).status().then(s => s.count)",
        );
        if (result === '2n') break;
        // eslint-disable-next-line no-await-in-loop
        await setTimeout(30);
      }
      t.is(
        await host.client.call(
          'evaluate',
          "E(E(apps).get('reminders')).status().then(s => s.count === 2n && s.items.length === 2 && s.items[1].state === 'fired' && s.items[1].message === 'reuse' && s.items[1].firedAt === 6000n)",
        ),
        'true',
      );
      await waitForHostDelivery();
    },
  );
};
harden(registerAlarmIntegration);
