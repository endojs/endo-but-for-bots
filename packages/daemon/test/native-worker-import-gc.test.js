// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as popen from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeCollector } from './fixtures/worker-import-gc-collect.js';
import {
  makeDaemonicControlPowers,
  makeFilePowers,
} from '../src/manager-node-powers.js';

/** @import { make as makeGcProbe } from './fixtures/worker-import-gc.js' */

test.serial(
  'native worker pipe collects discarded replies and caps in both directions',
  async t => {
    t.timeout(30_000);
    const temporary = await mkdtemp(
      path.join(tmpdir(), 'endo-worker-import-gc-'),
    );
    const cancelled = makePromiseKit();
    const forced = makePromiseKit();
    let workerTerminated = Promise.resolve();
    t.teardown(async () => {
      cancelled.reject(Error('GC probe finished'));
      forced.reject(Error('GC probe finished'));
      await workerTerminated;
      await rm(temporary, { recursive: true, force: true });
    });
    /** @type {WeakRef<object>[]} */
    const produced = [];
    const daemonFacet = Far('DaemonImportGcProbe', {
      read() {
        const result = harden({ payload: 'x'.repeat(8192) });
        produced.push(new WeakRef(result));
        return result;
      },
      fresh() {
        const result = Far('TemporaryDaemonCapability', {
          ping: () => 'daemon',
        });
        produced.push(new WeakRef(result));
        return result;
      },
      ping: () => 'still connected',
    });
    const powers = makeDaemonicControlPowers(
      {
        statePath: path.join(temporary, 'state'),
        ephemeralStatePath: path.join(temporary, 'ephemeral'),
        cachePath: path.join(temporary, 'cache'),
        sockPath: path.join(temporary, 'socket'),
      },
      fileURLToPath,
      makeFilePowers({ fs, path }),
      fs,
      popen,
    );
    const worker = await powers.makeWorker(
      'import-gc-probe',
      /** @type {any} */ (daemonFacet),
      /** @type {Promise<never>} */ (cancelled.promise),
      /** @type {Promise<never>} */ (forced.promise),
    );
    ({ workerTerminated } = worker);
    // The runtime facet's env argument is missing from the legacy declaration.
    // This known test module supplies the returned capability's interface.
    const probe = /** @type {Awaited<ReturnType<typeof makeGcProbe>>} */ (
      await E(/** @type {any} */ (worker.workerDaemonFacet)).makeUnconfined(
        new URL('./fixtures/worker-import-gc.js', import.meta.url).href,
        daemonFacet,
        undefined,
        harden({}),
      )
    );
    const collect = makeCollector();
    await E(probe).consume();
    await collect();
    await collect();
    t.is(produced.length, 64);
    t.true(produced.every(ref => ref.deref() === undefined));
    for (let i = 0; i < 32; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await E(probe).read();
      // eslint-disable-next-line no-await-in-loop
      await E(probe).fresh();
    }
    await collect();
    await collect();
    t.is(await E(probe).retained(), 0);
    t.is(
      await E(probe).ping(),
      'still connected',
      'held capabilities survive GC',
    );
  },
);
