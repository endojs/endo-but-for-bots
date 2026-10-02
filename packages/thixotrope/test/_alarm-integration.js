// @ts-check
import harden from '@endo/harden';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { connectLocalControl } from '../src/control/local-control.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { serveThixotrope } from '../src/control/supervisor.js';

import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();

/** @import {TestFn} from 'ava' */
/**
 * The clock keeps real time in its adapter process, so the test works with
 * short real delays: an alarm armed for a little while out, a restart that
 * outlasts it, and the settlement that must follow.
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
      const start = async () => {
        const supervisor = await serveThixotrope(nodePowers, path, {
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
      /**
       * @param {{client: any}} host
       * @param {string} source an expression over the reminder's status
       */
      const reminder = (host, source) =>
        host.client.call(
          'evaluate',
          `E(inventory.get('reminders')).status().then(s => ${source})`,
        );
      /**
       * @param {{client: any}} host
       * @param {string} source
       */
      const waitFor = async (host, source) => {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop
          if ((await reminder(host, source)) === 'true') return;
          // eslint-disable-next-line no-await-in-loop
          await setTimeout(50);
        }
        throw Error(`Reminder never satisfied: ${source}`);
      };
      // Arming travels through two vats and a process launch, which under
      // Ironhorse takes seconds; the deadline must still be ahead when the
      // host goes down.
      const delay = kind === 'ironhorse' ? 10_000n : 4000n;
      let host = await start();
      t.is(
        await host.client.call(
          'evaluate',
          "E(inventory.get('clock')).__getMethodNames__().then(names => names.includes('now') || names.includes('fire'))",
        ),
        'false',
        'the clock neither tells the time nor exposes the sink',
      );
      const { bundle } = await nodePowers.bundler.bundle(
        fileURLToPath(new URL('../examples/reminder.js', import.meta.url)),
      );
      await host.client.call('install', 'reminders', bundle, [
        ['clock', 'clock'],
      ]);
      const armedAt = BigInt(Date.now());
      t.is(
        await host.client.call(
          'evaluate',
          `E(inventory.get('reminders')).arm(${delay}n, 'after restart')`,
        ),
        'true',
      );
      await waitFor(host, "s.count === 0n && s.items[0].state === 'waiting'");
      // The deadline is in the adapter's hands before the host goes down: an
      // alarm still being registered when the host ends is rejected, by
      // design, rather than retried.
      let armed = 0;
      for (let attempt = 0; attempt < 400 && armed !== 1; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        ({ armed } = await host.client.call('alarmStatus'));
        // eslint-disable-next-line no-await-in-loop
        if (armed !== 1) await setTimeout(50);
      }
      t.is(armed, 1, 'the clock armed the alarm');
      t.true(
        BigInt(Date.now()) - armedAt < delay,
        'the deadline is still ahead when the host goes down',
      );
      host.client.close();
      await host.supervisor.close();
      // The deadline passes while the host is absent. Its replacement must
      // rebuild the adapter, re-arm the overdue alarm, and settle the
      // original guest promise and listener.
      const elapsed = BigInt(Date.now()) - armedAt;
      if (elapsed < delay + 200n)
        await setTimeout(Number(delay + 200n - elapsed));
      host = await start();
      await waitFor(
        host,
        `s.count === 1n && s.items[0].state === 'fired' && s.items[0].message === 'after restart' && s.items[0].firedAt >= ${armedAt + delay}n`,
      );
      t.like(await host.client.call('alarmStatus'), { pending: 0 });
      // Restart again with no pending alarm: the completed listener must not
      // fire again. Reuse the exact retained clock grant for a new alarm.
      host.client.close();
      await host.supervisor.close();
      host = await start();
      t.is(await reminder(host, 's.count === 1n'), 'true');
      t.is(
        await host.client.call(
          'evaluate',
          "E(inventory.get('reminders')).arm(100n, 'reuse')",
        ),
        'true',
      );
      await waitFor(
        host,
        "s.count === 2n && s.items.length === 2 && s.items[1].state === 'fired' && s.items[1].message === 'reuse'",
      );
      t.like(await host.client.call('alarmStatus'), { pending: 0 });
    },
  );
};
harden(registerAlarmIntegration);
