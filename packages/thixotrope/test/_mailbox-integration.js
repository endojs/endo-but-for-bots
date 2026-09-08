// @ts-check
import harden from '@endo/harden';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { connectLocalControl } from '../src/local-control.js';
import { makePeerJournalReplayEngine } from '../src/peer-replay-engine.js';
import { serveThixotrope } from '../src/supervisor.js';
import { makeFsStore } from '../src/store-fs.js';

/** @import { TestFn } from 'ava' */
/** @param {TestFn} test @param {'replay' | 'ironhorse'} kind */
export const registerMailboxIntegration = (test, kind) => {
  test.serial(
    `two supervisors exchange capabilities and recover offline mail (${kind})`,
    async t => {
      t.timeout(180_000);
      const root = await mkdtemp('/tmp/thix-mail-');
      t.teardown(() => rm(root, { recursive: true, force: true }));
      /** @param {string} who */
      const start = async who => {
        const path = join(root, who);
        const supervisor = await serveThixotrope(
          path,
          kind === 'ironhorse'
            ? {}
            : {
                engine: harden({
                  ...makePeerJournalReplayEngine(),
                  acquireStore: async () => async () => {},
                }),
                idleSleepMs: 0,
              },
        );
        t.teardown(() => supervisor.close());
        const client = await connectLocalControl(join(path, 'control.sock'));
        t.teardown(() => client.close());
        return { supervisor, client };
      };
      /** @param {() => Promise<boolean>} check */
      const until = async check => {
        for (let i = 0; i < 100; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          if (await check()) return;
          // eslint-disable-next-line no-await-in-loop
          await setTimeout(30);
        }
        t.fail('Expected mailbox state did not arrive');
      };
      let alice = await start('alice');
      let bob = await start('bob');
      const invitation = await alice.client.call('invite', 'bob');
      const bobStore = makeFsStore(join(root, 'bob'));
      const beforeSessions = bobStore.listSessionTokens();
      const invalid = {
        ...JSON.parse(invitation),
        location: {
          network: 'tcp-testing-only',
          designator: '/tmp/not-a-peer',
        },
      };
      await t.throwsAsync(
        () => bob.client.call('connect', 'bad', JSON.stringify(invalid)),
        { message: /Unix peer/ },
      );
      t.deepEqual(
        bobStore.listSessionTokens(),
        beforeSessions,
        'invalid invitations create no durable session obligations',
      );
      t.true(await bob.client.call('connect', 'alice', invitation));
      await until(
        async () => (await bob.client.call('contacts'))[0]?.status === 'ready',
      );
      t.deepEqual(
        (await alice.client.call('contacts')).map(({ name, status }) => ({
          name,
          status,
        })),
        [{ name: 'bob', status: 'ready' }],
      );
      await alice.client.call(
        'evaluate',
        "E(vats).createWorker('shared-counter').then(w => E(w).evaluate(\"(() => { let n = 0n; return Far('Counter', { incr: () => ++n, read: () => n }); })()\")).then(counter => { inventory.set('counter', counter); return true; })",
      );
      t.is(
        await alice.client.call('send', 'bob', 'Try this counter', 'counter'),
        '1',
      );
      await until(async () => (await bob.client.call('inbox')).length === 1);
      t.deepEqual(await bob.client.call('inbox'), [
        { id: '1', from: 'alice', text: 'Try this counter' },
      ]);
      const view = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../bin/thix.js', import.meta.url)),
          'mail',
          join(root, 'bob'),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const viewExited = once(view, 'exit');
      t.teardown(async () => {
        view.kill('SIGKILL');
        await viewExited;
      });
      let viewOutput = '';
      view.stdout.on('data', chunk => {
        viewOutput += String(chunk);
      });
      view.stderr.on('data', chunk => {
        viewOutput += String(chunk);
      });
      view.stdin.end('take 1 shared\nq\n');
      t.is((await viewExited)[0], 0, viewOutput);
      t.regex(viewOutput, /Try this counter/);
      t.is(
        await bob.client.call('evaluate', "E(inventory.get('shared')).incr()"),
        '1n',
      );
      t.is(
        await bob.client.call(
          'send',
          'alice',
          'Returning the same capability',
          'shared',
        ),
        '1',
      );
      await until(async () => (await alice.client.call('inbox')).length === 1);
      t.true(await alice.client.call('takeOffer', '1', 'returned'));
      t.is(
        await alice.client.call(
          'evaluate',
          "inventory.get('returned') === inventory.get('counter')",
        ),
        'true',
      );
      bob.client.close();
      await bob.supervisor.close();
      t.is(
        await alice.client.call('send', 'bob', 'While offline', 'counter'),
        '2',
      );
      alice.client.close();
      await alice.supervisor.close();
      // Both roles restart, with the sender returning first while Bob is absent.
      alice = await start('alice');
      bob = await start('bob');
      await until(async () => (await bob.client.call('inbox')).length === 2);
      await until(async () =>
        (await alice.client.call('outbox')).every(
          entry => entry.status === 'delivered',
        ),
      );
      t.is(
        await bob.client.call('evaluate', "E(inventory.get('shared')).incr()"),
        '2n',
      );
      t.deepEqual(
        (await bob.client.call('inbox')).map(entry => entry.text),
        ['Try this counter', 'While offline'],
      );
      t.true(await bob.client.call('discardOffer', '1'));
      t.is(
        await bob.client.call('evaluate', "E(inventory.get('shared')).read()"),
        '2n',
      );
      t.true(await alice.client.call('revokeInvitation', invitation));
      t.is(
        await bob.client.call(
          'send',
          'alice',
          'Contact remains usable',
          'shared',
        ),
        '2',
      );
      await until(async () => (await alice.client.call('inbox')).length === 2);
    },
  );
};
harden(registerMailboxIntegration);
