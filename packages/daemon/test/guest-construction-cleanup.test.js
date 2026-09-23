// @ts-check
/** @import {FormulaNumber} from '../src/types.js' */
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
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
import { parseId } from '../src/formula-identifier.js';

for (const automatic of [false, true]) {
  for (const stage of ['mail-hub', 'guest']) {
    for (const afterWrite of [false, true]) {
      test.serial(
        `guest construction releases acquired pins: automatic=${automatic}, stage=${stage}, afterWrite=${afterWrite}`,
        async t => {
          t.timeout(15_000);
          const temporary = await mkdtemp(
            path.join(tmpdir(), 'endo-guest-cleanup-'),
          );
          t.teardown(() => rm(temporary, { recursive: true, force: true }));
          const cancelled = makePromiseKit();
          t.teardown(() => cancelled.reject(Error('Test finished')));
          const powers = await makeDaemonicPowers({
            config: {
              statePath: path.join(temporary, 'state'),
              ephemeralStatePath: path.join(temporary, 'run'),
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
                throw Error('Unexpected network');
              },
              gunzip,
              createHash: crypto.createHash,
            },
          });
          await powers.persistence.initializePersistence();
          let armed = false;
          let injected = false;
          /** @type {FormulaNumber | undefined} */
          let failedNumber;
          /** @type {FormulaNumber[]} */
          const acquired = [];
          const daemon = await makeDaemon(
            {
              ...powers,
              control: /** @type {any} */ ({
                makeWorker: async (
                  _id,
                  _facet,
                  workerCancelled,
                  forceCancelled,
                ) => {
                  void forceCancelled.catch(() => {});
                  return {
                    workerDaemonFacet: Far('UnusedWorker', {
                      terminate: () => {},
                    }),
                    workerTerminated: workerCancelled.catch(() => {}),
                  };
                },
              }),
              persistence: harden({
                ...powers.persistence,
                writeFormula: async (number, node, formula) => {
                  const fail = armed && !injected && formula.type === stage;
                  if (fail) {
                    injected = true;
                    failedNumber = number;
                    if (afterWrite)
                      await powers.persistence.writeFormula(
                        number,
                        node,
                        formula,
                      );
                    throw Error('Injected guest construction failure');
                  }
                  await powers.persistence.writeFormula(number, node, formula);
                  if (armed && !injected) acquired.push(number);
                },
              }),
            },
            'guest-construction-cleanup',
            cancelled.reject,
            /** @type {Promise<never>} */ (cancelled.promise),
            {},
            { gcEnabled: true },
          );
          t.teardown(() => daemon.cancelGracePeriod(Error('Test finished')));
          const host = await E(daemon.endoBootstrap).host();
          await E(host).provideGuest('control');
          const controlId = await E(host).identify('control');
          if (!controlId) throw Error('Missing control');
          armed = true;
          const creating = automatic
            ? E(host).makeUnconfined('failed-worker', 'test:never-reached', {
                powersName: 'failed-powers',
                resultName: 'failed-client',
              })
            : E(host).provideGuest('failed-guest');
          await t.throwsAsync(creating, {
            message: /Injected guest construction failure/,
          });
          t.true(injected);
          if (!failedNumber) throw Error('Missing failed formula number');
          if (stage === 'guest' || !afterWrite) {
            await t.throwsAsync(powers.persistence.readFormula(failedNumber), {
              message: /No formula exists for number/,
            });
          } else {
            // This write rejected before returning an ID to the builder. Its
            // orphan is outside acquired-pin rollback, not proof of full cleanup.
            t.is(
              (await powers.persistence.readFormula(failedNumber)).formula.type,
              'mail-hub',
            );
          }
          t.true(acquired.length >= 2);
          // No public name may refer to a guest whose formula write failed,
          // including a write whose acknowledgement was lost.
          t.is(await E(host).identify('failed-guest'), undefined);
          t.is(await E(host).identify('failed-powers'), undefined);
          for (const number of acquired) {
            // eslint-disable-next-line no-await-in-loop
            await t.throwsAsync(powers.persistence.readFormula(number), {
              message: /No formula exists for number/,
            });
          }
          t.is(await E(host).identify('control'), controlId);
          await powers.persistence.readFormula(parseId(controlId).number);
          armed = false;
          const successful = await E(host).provideGuest('successful');
          t.true((await E(successful).list()).some(name => name === '@self'));
          // A partial publication is different: the successfully stored handle
          // must retain its complete guest graph despite a sibling name failure.
          await t.throwsAsync(
            E(host).provideGuest('partial', {
              agentName: ['missing-parent', 'agent'],
            }),
            { message: /missing-parent/ },
          );
          const partialId = await E(host).identify('partial');
          if (!partialId) throw Error('Missing partial publication');
          const { formula: handle } = await powers.persistence.readFormula(
            parseId(partialId).number,
          );
          if (handle.type !== 'handle') throw Error('Expected handle');
          const { formula: guest } = await powers.persistence.readFormula(
            parseId(handle.agent).number,
          );
          if (guest.type !== 'guest') throw Error('Expected guest');
          await powers.persistence.readFormula(parseId(guest.worker).number);
          await E(host).remove('partial');
          await t.throwsAsync(
            powers.persistence.readFormula(parseId(handle.agent).number),
          );
          await t.throwsAsync(
            powers.persistence.readFormula(parseId(guest.worker).number),
          );
        },
      );
    }
  }
}
