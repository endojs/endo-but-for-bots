// @ts-check

import '@endo/init/debug.js';
import test from 'ava';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { makeEndoClient, start, stop } from '@endo/daemon';
import {
  makeConversationTree,
  makeEndoPetstoreBackend,
} from '@endo/conversation-tree';

import { restoreInboxConversation } from '../src/inbox-conversation.js';

test.serial(
  'inbox selection and opaque context survive a cold daemon restart',
  async t => {
    t.timeout(45_000);
    const root = await mkdtemp('/tmp/endo-inbox-');
    const config = {
      statePath: join(root, 'state'),
      ephemeralStatePath: join(root, 'run'),
      cachePath: join(root, 'cache'),
      sockPath: join(root, 'endo.sock'),
      address: '127.0.0.1:0',
      gcEnabled: true,
    };
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => undefined);
    t.teardown(async () => {
      await null;
      try {
        await stop(config);
      } finally {
        cancelled.reject(Error('test cleanup'));
        await rm(root, { recursive: true, force: true });
      }
    });
    const connect = async () => {
      const client = await makeEndoClient(
        'inbox-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => undefined);
      return E(client.getBootstrap()).host();
    };
    await start(config);
    const host = await connect();
    let guest = await E(host).provideGuest('inbox-agent', {
      agentName: 'inbox-powers',
    });
    const restore = powers =>
      restoreInboxConversation({
        powers,
        tree: makeConversationTree(makeEndoPetstoreBackend(powers)),
        prompt: 'durable prompt',
      });
    const first = await restore(guest);
    await first.beginTurn();
    const user = await first.append(
      first.getLeafId(),
      [{ role: 'user', content: 'remember' }],
      { inboundNumber: 123n },
    );
    const message = harden({
      role: 'assistant',
      content: 'remembered',
      responsesOutput: {
        model: 'test-luna',
        items: [
          {
            type: 'reasoning',
            id: 'opaque-id',
            encrypted_content: 'retained-opaque',
          },
        ],
      },
    });
    const final = await first.append(user.id, [message]);
    await first.finishTurn();
    await stop(config);
    await start(config);
    guest = await E(await connect()).lookup('inbox-powers');
    const restored = await restore(guest);
    t.is(restored.getLeafId(), final.id);
    t.true(restored.hasAdmission(123n));
    t.deepEqual(await restored.getContext(final.id), [
      { role: 'system', content: 'durable prompt' },
      { role: 'user', content: 'remember' },
      message,
    ]);
    // This proves real formula publication/restoration, not live inference or
    // native process-loss recovery. The latter remains explicitly fail-closed.
  },
);
