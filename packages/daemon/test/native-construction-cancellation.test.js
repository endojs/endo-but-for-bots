// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as popen from 'node:child_process';
import { setImmediate as nextTurn } from 'node:timers/promises';
import * as url from 'node:url';

import { parseId } from '../src/formula-identifier.js';
import {
  gunzip,
  makeCryptoPowers,
  makeDaemonicPowers,
  makeFilePowers,
} from '../src/manager-node-powers.js';
import { makeDaemon } from '../src/manager.js';
import { assertPetName } from '../src/pet-name.js';

for (const failPersistence of [false, true]) {
  test.serial(
    `construction cancellation waits for ${failPersistence ? 'failed' : 'successful'} caplet persistence before closing original workers`,
    async t => {
      t.timeout(10_000);
      const temporary = await mkdtemp(
        path.join(tmpdir(), 'endo-construction-'),
      );
      t.teardown(() => rm(temporary, { recursive: true, force: true }));
      const cancelled = makePromiseKit();
      const persisting = makePromiseKit();
      const release = makePromiseKit();
      t.teardown(() => {
        release.resolve(undefined);
        cancelled.reject(Error('Test finished'));
      });
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
      const specifier = 'test:held-inert-controller';
      const acquisitions = [];
      const cancellations = [];
      let activations = 0;
      const daemon = await makeDaemon(
        {
          ...powers,
          persistence: /** @type {any} */ ({
            ...powers.persistence,
            writeFormula: async (number, node, formula) => {
              // Other formulas proceed while the published session's worker
              // exists but the client formulation has not returned its context.
              await null;
              if (
                formula.type === 'make-unconfined' &&
                formula.specifier === specifier
              ) {
                persisting.resolve(undefined);
                await release.promise;
                if (failPersistence) throw Error('Caplet persistence failed');
              }
              return powers.persistence.writeFormula(number, node, formula);
            },
          }),
          control: /** @type {any} */ ({
            makeWorker: async (id, _facet, workerCancelled, forceCancelled) => {
              acquisitions.push(id);
              void forceCancelled.catch(() => {});
              const workerTerminated = workerCancelled.catch(() => {
                cancellations.push(id);
              });
              return {
                workerDaemonFacet: Far('Worker', {
                  terminate: () => {},
                  makeUnconfined: async () =>
                    Far('InertController', {
                      activate: () => {
                        activations += 1;
                      },
                      terminate: () => {},
                    }),
                }),
                workerTerminated,
              };
            },
          }),
        },
        'construction-cancellation-test',
        cancelled.reject,
        /** @type {Promise<never>} */ (cancelled.promise),
      );
      t.teardown(() => daemon.cancelGracePeriod(Error('Test finished')));
      const host = await E(daemon.endoBootstrap).host();
      const recordsName = 'sessions';
      assertPetName(recordsName);
      const owner = await E(host).provideSessionOwner(recordsName, specifier);
      await E(owner).create('one', 'approved plan', {});
      const initialAcquisitions = acquisitions.length;
      const starting = t.throwsAsync(E(owner).start('one'), {
        message: /construction cancelled|Caplet persistence failed/,
      });
      await persisting.promise;
      const workerId = await E(host).identify(
        'sessions',
        'sessions',
        'one',
        'references',
        'worker',
      );
      if (workerId === undefined) throw Error('Worker was not published');
      const { number } = parseId(workerId);
      t.is(acquisitions.length, initialAcquisitions + 1);
      let stopped = false;
      const stopping = E(owner)
        .stop('one')
        .then(() => {
          stopped = true;
        });
      await nextTurn();
      t.false(stopped);
      t.false(
        cancellations.includes(number),
        'pending formulation still owns the worker',
      );
      t.is(activations, 0);
      // Unrelated daemon work can proceed during the retained uncertainty.
      t.truthy(await E(host).identify('@agent'));
      release.resolve(undefined);
      await starting;
      await stopping;
      t.deepEqual(cancellations, [number]);
      t.is(
        acquisitions.length,
        initialAcquisitions + 1,
        'no replacement worker acquired',
      );
      t.is(activations, 0);
      t.like(await E(owner).inspect('one'), {
        phase: 'stopped',
        references: {},
      });
    },
  );
}
