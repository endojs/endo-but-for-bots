// @ts-check
import { E } from '@endo/far';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makeDurableNetLayer } from '../src/net/durable-netlayer.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeMemoryStore } from '../src/store/store-memory.js';
import { makeUnixNetLayer } from '../src/net/unix-netlayer.js';

import { makeNodePowers } from '../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

test.serial(
  'a large remote result and subsequent calls cross the durable Unix session',
  async t => {
    t.timeout(30_000);
    const path = await mkdtemp('/tmp/thix-large-delivery-');
    t.teardown(() => rm(path, { recursive: true, force: true }));
    /** @param {string} name */
    const start = async name => {
      /** @type {Awaited<ReturnType<typeof makeUnixNetLayer>> | undefined} */
      let base;
      const daemon = await makeThixotropeDaemon(nodePowers, {
        store: makeMemoryStore(),
        engine: makePeerJournalReplayEngine(nodePowers),
        codec: syrupCodec,
        makeNetlayer: ({ handlers, logger, resumption }) =>
          makeDurableNetLayer(nodePowers, {
            handlers,
            logger,
            resumption,
            makeBaseNetlayer: async powers => {
              base = await makeUnixNetLayer(nodePowers, {
                ...powers,
                socketPath: join(path, `${name}.sock`),
              });
              return base;
            },
          }),
      });
      t.teardown(async () => {
        await daemon.shutdown();
        await base?.closed;
      });
      return daemon;
    };
    const receiver = await start('receiver');
    const sender = await start('sender');
    const root = await sender.eval(
      "Far('LargeResult', { read: () => 'x'.repeat(2 * 1024 * 1024), ping: () => 'ready' })",
    );
    const secret = sender.publish(root);
    const remote = await receiver.importReference(sender.location, secret);
    const value = await E(remote).read();
    t.is(value.length, 2 * 1024 * 1024);
    t.is(value, 'x'.repeat(2 * 1024 * 1024));
    t.is(await E(remote).ping(), 'ready');
  },
);
