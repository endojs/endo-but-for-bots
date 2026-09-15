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

import { assertFormulaNumber, parseId } from '../src/formula-identifier.js';
import {
  gunzip,
  makeCryptoPowers,
  makeDaemonicPowers,
  makeFilePowers,
} from '../src/manager-node-powers.js';
import { makeDaemon } from '../src/manager.js';

for (const [kind, gate] of [
  ['worker', 'load'],
  ['make-unconfined', 'load'],
  ['make-unconfined', 'worker'],
]) {
  test.serial(
    `cancelled ${kind} revival fences ${gate === 'load' ? 'delayed formula loading' : 'delayed worker acquisition'}`,
    async t => {
      t.timeout(10_000);
      const temporary = await mkdtemp(
        path.join(tmpdir(), 'endo-formula-cancel-'),
      );
      t.teardown(() => rm(temporary, { recursive: true, force: true }));
      const cancelled = makePromiseKit();
      const loaded = makePromiseKit();
      const release = makePromiseKit();
      const exited = makePromiseKit();
      t.teardown(() => {
        release.resolve(undefined);
        exited.resolve(undefined);
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
      const formulaNumber = 'a'.repeat(64);
      const workerNumber = 'b'.repeat(64);
      assertFormulaNumber(formulaNumber);
      assertFormulaNumber(workerNumber);
      let hold = false;
      const acquisitions = [];
      let constructions = 0;
      const daemon = await makeDaemon(
        {
          ...powers,
          persistence: /** @type {any} */ ({
            ...powers.persistence,
            readFormula: async number => {
              const result = await powers.persistence.readFormula(number);
              if (hold && gate === 'load' && number === formulaNumber) {
                loaded.resolve(undefined);
                await release.promise;
              }
              return result;
            },
          }),
          control: /** @type {any} */ ({
            makeWorker: async (id, _facet, workerCancelled, forceCancelled) => {
              void workerCancelled.catch(() => {});
              void forceCancelled.catch(() => {});
              acquisitions.push(id);
              if (hold && gate === 'worker' && id === workerNumber) {
                loaded.resolve(undefined);
                await release.promise;
              }
              return {
                workerDaemonFacet: Far('Worker', {
                  terminate: () => {},
                  makeUnconfined: async () => {
                    constructions += 1;
                    return Far('Controller', {});
                  },
                }),
                workerTerminated: exited.promise,
              };
            },
          }),
        },
        'formula-cancellation-test',
        cancelled.reject,
        /** @type {Promise<never>} */ (cancelled.promise),
      );
      t.teardown(() => daemon.cancelGracePeriod(Error('Test finished')));
      const host = await E(daemon.endoBootstrap).host();
      const hostId = await E(host).identify('@agent');
      if (hostId === undefined) throw Error('Missing host identity');
      const { node } = parseId(hostId);
      const identifier = `${formulaNumber}:${node}`;
      const workerId = `${workerNumber}:${node}`;
      await E(host).storeValue(null, 'inert-input');
      const powersId = await E(host).identify('inert-input');
      if (powersId === undefined) throw Error('Missing powers identity');
      await E(host).storeIdentifier('delayed-formula', identifier);
      const workerFormula = harden({ type: 'worker', kind: 'node' });
      await powers.persistence.writeFormula(
        workerNumber,
        node,
        /** @type {any} */ (workerFormula),
      );
      await powers.persistence.writeFormula(
        formulaNumber,
        node,
        /** @type {any} */ (
          kind === 'worker'
            ? workerFormula
            : {
                type: 'make-unconfined',
                worker: workerId,
                powers: powersId,
                specifier: 'test:inert-controller',
                env: {},
              }
        ),
      );
      const initialAcquisitions = acquisitions.length;
      hold = true;
      const lookup = E(host).lookupById(identifier);
      // Observe the result while the deliberately delayed load is still pending.
      const outcome = lookup.then(
        value => ({ value }),
        error => ({ error }),
      );
      await loaded.promise;
      await E(host).cancel('delayed-formula', Error('Cancelled during load'));
      release.resolve(undefined);
      await outcome;
      await nextTurn();
      t.is(
        acquisitions.length,
        initialAcquisitions + (gate === 'worker' ? 1 : 0),
      );
      t.is(constructions, 0, 'neither original nor successor client evaluates');
      t.like(await outcome, { error: { message: 'Cancelled during load' } });
      // An intentional later lookup can revive the same persisted formula.
      // This also establishes that the held formula was valid, not merely
      // rejected before it could reach the worker for an unrelated reason.
      await E(host).lookupById(identifier);
      t.is(acquisitions.length, initialAcquisitions + 1);
      t.is(constructions, kind === 'make-unconfined' ? 1 : 0);
    },
  );
}
