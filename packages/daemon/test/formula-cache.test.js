// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { assertPassable, Far } from '@endo/pass-style';
import { assert } from '@endo/errors';
import { encodeHex } from '@endo/hex';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as popen from 'node:child_process';
import * as url from 'node:url';

import {
  gunzip,
  makeCryptoPowers,
  makeDaemonicPowers,
  makeFilePowers,
} from '../src/manager-node-powers.js';
import { makeDaemon } from '../src/manager.js';
import {
  assertFormulaNumber,
  assertNodeNumber,
} from '../src/formula-identifier.js';
import { makeCollector } from './fixtures/worker-import-gc-collect.js';

/** @import { Passable } from '@endo/pass-style' */

test.serial(
  'marshal bodies and pure data are reloadable without deleting formulas',
  async t => {
    t.timeout(30_000);
    const temporary = await mkdtemp(path.join(tmpdir(), 'endo-formula-cache-'));
    t.teardown(() => rm(temporary, { recursive: true, force: true }));
    const cancelled = makePromiseKit();
    const exited = makePromiseKit();
    const powers = await makeDaemonicPowers({
      config: {
        statePath: path.join(temporary, 'state'),
        ephemeralStatePath: path.join(temporary, 'ephemeral'),
        cachePath: path.join(temporary, 'cache'),
        sockPath: path.join(temporary, 'socket'),
      },
      cancelled: /** @type {Promise<never>} */ (cancelled.promise),
      fs,
      popen,
      url,
      filePowers: makeFilePowers({ fs, path }),
      cryptoPowers: makeCryptoPowers(crypto),
      registryPowers: {
        fetch: async () => {
          throw Error('Unexpected network access');
        },
        gunzip,
        createHash: crypto.createHash,
      },
    });
    await powers.persistence.initializePersistence();
    const seededNumber = 'a'.repeat(64);
    const { keypair } = await powers.persistence.provideRootKeypair();
    const seededNode = encodeHex(keypair.publicKey);
    assertFormulaNumber(seededNumber);
    assertNodeNumber(seededNode);
    await powers.persistence.writeFormula(
      seededNumber,
      seededNode,
      harden({ type: 'marshal', body: '#{"seeded":true}', slots: [] }),
    );
    /** @type {WeakRef<object>[]} */
    const formulas = [];
    const daemon = await makeDaemon(
      {
        ...powers,
        control: {
          ...powers.control,
          makeWorker: async (_id, _facet, workerCancelled, forceCancelled) => {
            void workerCancelled.catch(() => {});
            void forceCancelled.catch(() => {});
            return {
              workerDaemonFacet: Far('Worker', {
                terminate: async () => exited.resolve(undefined),
                evaluate: async () => {
                  throw Error('Unexpected evaluation');
                },
                makeArchive: async () => {
                  throw Error('Unexpected archive');
                },
                makeUnconfined: async () => {
                  throw Error('Unexpected module');
                },
              }),
              workerTerminated: exited.promise,
            };
          },
        },
        persistence: {
          ...powers.persistence,
          readFormula: async number => {
            const result = await powers.persistence.readFormula(number);
            if (result.formula.type === 'marshal')
              formulas.push(new WeakRef(result.formula));
            return result;
          },
        },
      },
      'formula-cache-test',
      cancelled.reject,
      /** @type {Promise<never>} */ (cancelled.promise),
      {},
      { gcEnabled: false, defaultWorkerKind: 'node' },
    );
    t.teardown(() => {
      exited.resolve(undefined);
      cancelled.reject(Error('Test finished'));
      daemon.cancelGracePeriod(Error('Test finished'));
    });
    const host = await E(daemon.endoBootstrap).host();
    const populate = async () => {
      for (let i = 0; i < 12; i += 1) {
        // Populate sequentially to match the production snapshot writer.
        // eslint-disable-next-line no-await-in-loop
        await E(host).storeValue(
          harden({ index: i, text: 'x'.repeat(100_000) }),
          `snapshot-${i}`,
        );
      }
      const value = await E(host).lookup('snapshot-0');
      return new WeakRef(/** @type {object} */ (value));
    };
    const valueRef = await populate();
    const identifiers = await Promise.all(
      Array.from({ length: 12 }, (_, i) => E(host).identify(`snapshot-${i}`)),
    );
    await E(host).remove('snapshot-0');
    const collect = makeCollector();
    await collect();
    t.true(formulas.length > 0);
    t.true(
      formulas.every(ref => ref.deref() === undefined),
      'serialized bodies are not retained in the graph cache',
    );
    t.is(
      valueRef.deref(),
      undefined,
      'daemon caches release resolved pure copy data',
    );
    const id = identifiers[0];
    if (id === undefined) throw Error('Missing snapshot identifier');
    t.deepEqual(
      await E(host).lookupById(id),
      harden({ index: 0, text: 'x'.repeat(100_000) }),
    );
    t.deepEqual(
      await E(host).lookupById(`${seededNumber}:${seededNode}`),
      harden({ seeded: true }),
    );
    // A marshal carrying a capability continues to preserve its incarnation.
    const directory = await E(host).makeDirectory('retained-directory');
    const capData = harden({ directory });
    assertPassable(capData);
    // EndoDirectory's public interface omits the remotable brand; validate
    // the actual capability before crossing the copy-data type boundary.
    await E(host).storeValue(
      /** @type {Passable} */ (/** @type {unknown} */ (capData)),
      'cap-bearing-value',
    );
    t.is(
      await E(host).lookup('cap-bearing-value'),
      await E(host).lookup('cap-bearing-value'),
    );
    const capValue = await E(host).lookup('cap-bearing-value');
    assert(
      capValue !== null &&
        typeof capValue === 'object' &&
        'directory' in capValue,
    );
    t.is(capValue.directory, directory);
  },
);
