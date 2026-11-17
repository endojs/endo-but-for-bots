// @ts-check
/* eslint-disable import/no-relative-packages, no-await-in-loop -- Cross-package real daemon regression with serial resource ownership. */
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { makeEndoClient, start, stop } from '../index.js';

import { makeSessionAttachments } from '../../floot/src/session-attachments.js';

import {
  createPrivateTurnStorage,
  retirePrivateTurnStorage,
} from '../../floot/src/private-turn-storage.js';

test.serial(
  'Floot text references are real adoptable Endo packages without inventory or namespace leaks',
  async t => {
    t.timeout(45_000);
    const root = await mkdtemp(
      path.join(
        process.platform === 'darwin' ? '/tmp' : tmpdir(),
        'endo-attach-',
      ),
    );
    const config = {
      statePath: path.join(root, 'state'),
      ephemeralStatePath: path.join(root, 'run'),
      cachePath: path.join(root, 'cache'),
      sockPath: path.join(root, 'endo.sock'),
      address: '127.0.0.1:0',
      pets: new Map(),
      values: new Map(),
      gcEnabled: false,
    };
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => {});
    t.teardown(async () => {
      try {
        await stop(config);
      } finally {
        cancelled.reject(Error('Test finished'));
        await rm(root, { recursive: true, force: true });
      }
    });
    await start(config);
    const client = await makeEndoClient(
      'floot-attachment-test',
      config.sockPath,
      cancelled.promise,
    );
    void client.closed.catch(() => {});
    const host = await E(client.getBootstrap()).host();
    const guest = await E(host).provideGuest('guest', {
      agentName: 'guest-agent',
    });
    await createPrivateTurnStorage(host, 'one');
    const original = harden({ text: 'original document' });
    await E(host).storeValue(original, 'source');
    const value = await E(host).lookup('source');
    const identity = await E(host).identify('source');
    if (!identity) throw Error('No source identity');
    const references = harden([{ path: ['source'], identity, value }]);
    const message = harden({ strings: ['Read ', ''], names: ['document'] });
    const manager = makeSessionAttachments(host, guest, 'one');
    const before = await E(guest).list();
    const rootNames = await E(host).list();
    for (let i = 0; i < 3; i += 1) {
      const packet = await manager.open(message, references, `${i}`, () => {});

      const messages = await E(guest).listMessages();
      t.is(messages.length, 1);
      t.true(manager.owns(messages[0].messageId));
      if (i === 0) {
        t.deepEqual(
          await E(guest).list(),
          before,
          'delivery grants no automatic inventory binding',
        );

        await E(guest).adopt(messages[0].number, 'document', ['notes']);

        await E(host).remove('source');
      }

      await packet.close();

      t.deepEqual(await E(guest).listMessages(), []);

      t.deepEqual(await E(guest).lookup('notes'), original);

      t.deepEqual(await E(host).list('floot-private-sessions', 'one'), [
        'schema',
      ]);
    }
    t.deepEqual(
      await E(host).list(),
      rootNames.filter(name => name !== 'source'),
    );
    await retirePrivateTurnStorage(host, 'one');
    t.false(await E(host).has('floot-private-sessions', 'one'));
    t.deepEqual(
      await E(guest).lookup('notes'),
      original,
      'adopted value belongs to the agent',
    );
  },
);
