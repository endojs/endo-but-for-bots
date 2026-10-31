// @ts-check
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
import { formatId } from '../src/formula-identifier.js';

for (const mode of [
  'before-key-write',
  'after-key-write',
  'delete-key-failure',
  'storage-delete-failure',
  'instantiated-guest',
  'cancellation-failure',
  'persisted-survivor',
  'retention-row',
  'publication-failure',
]) {
  test.serial(`abandoned guest key retirement: ${mode}`, async t => {
    t.timeout(15_000);
    const temporary = await mkdtemp(path.join(tmpdir(), 'endo-guest-key-'));
    t.teardown(() => rm(temporary, { recursive: true, force: true }));
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => {});
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
    let refuseKeyDeletion = true;
    let refuseStorageDeletion = true;
    let storageDeletionAttempts = 0;
    /** @type {import('../src/types.js').FormulaNumber | undefined} */
    let failedGuestNumber;
    let deletionAttempts = 0;
    let cancellationRejected = false;
    /** @type {any} */
    let guestNode;
    /** @type {any} */
    let host;
    /** @type {any} */
    let retainedGuest;
    const daemon = await makeDaemon(
      {
        ...powers,
        control: /** @type {any} */ ({
          makeWorker: async (_id, _facet, workerCancelled, forceCancelled) => {
            void forceCancelled.catch(() => {});
            const failedGuestWorker = armed;
            return {
              workerDaemonFacet: Far('UnusedWorker', { terminate: () => {} }),
              workerTerminated: workerCancelled.catch(() => {
                if (failedGuestWorker && mode === 'cancellation-failure') {
                  cancellationRejected = true;
                  throw Error('Injected cancellation failure');
                }
              }),
            };
          },
        }),
        persistence: harden({
          ...powers.persistence,
          writeAgentKey: (publicKey, privateKey, agentId) => {
            if (armed) guestNode = publicKey;
            if (armed && mode === 'before-key-write') {
              injected = true;
              throw Error('Injected key write failure');
            }
            powers.persistence.writeAgentKey(publicKey, privateKey, agentId);
            if (armed && mode === 'after-key-write') {
              injected = true;
              throw Error('Injected key write failure');
            }
          },
          deleteAgentKey: node => {
            if (node === guestNode) {
              deletionAttempts += 1;
              if (mode === 'delete-key-failure' && refuseKeyDeletion)
                throw Error('Injected key deletion failure');
            }
            return powers.persistence.deleteAgentKey(node);
          },
          deleteFormula: async number => {
            if (
              mode === 'storage-delete-failure' &&
              number === failedGuestNumber
            ) {
              storageDeletionAttempts += 1;
              if (refuseStorageDeletion)
                throw Error('Injected storage deletion failure');
            }
            return powers.persistence.deleteFormula(number);
          },
          writeFormula: async (number, node, formula) => {
            await powers.persistence.writeFormula(number, node, formula);
            if (
              armed &&
              !injected &&
              formula.type === 'guest' &&
              mode !== 'publication-failure'
            ) {
              injected = true;
              failedGuestNumber = number;
              if (mode === 'instantiated-guest') {
                retainedGuest = await E(host).lookupById(
                  formatId({
                    number,
                    node: /** @type {import('../src/types.js').NodeNumber} */ (
                      node
                    ),
                  }),
                );
                await E(retainedGuest).list();
              }
              if (mode === 'persisted-survivor') {
                // A disk-only formula is still evidence of node ownership.
                const survivor = /** @type {typeof number} */ (
                  crypto.randomBytes(32).toString('hex')
                );
                await powers.persistence.writeFormula(survivor, node, formula);
              }
              if (mode === 'retention-row') {
                powers.persistence.writeRetention(node, number);
              }
              throw Error('Injected guest write acknowledgement failure');
            }
          },
        }),
      },
      'guest-key-retirement-test',
      cancelled.reject,
      /** @type {Promise<never>} */ (cancelled.promise),
      {},
      { gcEnabled: true },
    );
    t.teardown(() => daemon.cancelGracePeriod(Error('Test finished')));
    host = await E(daemon.endoBootstrap).host();
    const control = await E(host).provideGuest('control');
    const priorIds = powers.persistence.listAgentKeys().map(key => key.agentId);
    armed = true;
    await t.throwsAsync(
      E(host).provideGuest(
        'failed',
        mode === 'publication-failure'
          ? { agentName: ['missing-parent', 'agent'] }
          : undefined,
      ),
      {
        message: /Injected .* failure|cleanup|cancellation|missing-parent/i,
      },
    );
    armed = false;
    if (mode !== 'publication-failure') t.true(injected);
    t.truthy(guestNode);
    const retained = [
      'delete-key-failure',
      'storage-delete-failure',
      'instantiated-guest',
      'cancellation-failure',
      'persisted-survivor',
      'retention-row',
      'publication-failure',
    ].includes(mode);
    t.is(powers.persistence.hasAgentKey(guestNode), retained);
    if (mode === 'cancellation-failure') t.true(cancellationRejected);
    if (mode === 'instantiated-guest') {
      t.truthy(retainedGuest);
      t.deepEqual(powers.persistence.listFormulaNumbersByNode(guestNode), []);
      // Listing the escaped guest's static special names remains possible;
      // the absence of disk formulas is not proof its key was never used.
      t.true((await E(retainedGuest).list()).includes('@self'));
    }
    if (mode === 'storage-delete-failure') {
      t.true(storageDeletionAttempts > 0);
      t.true(powers.persistence.listFormulaNumbersByNode(guestNode).length > 0);
      t.is(deletionAttempts, 0, 'failed storage still owns the key');
    }
    if (mode === 'delete-key-failure') t.true(deletionAttempts > 0);
    const attemptsBeforeRetry = deletionAttempts;
    refuseKeyDeletion = false;
    refuseStorageDeletion = false;
    await E(host).makeDirectory('drain');
    await E(host).remove('drain');
    if (mode === 'delete-key-failure' || mode === 'storage-delete-failure') {
      t.is(deletionAttempts, attemptsBeforeRetry + 1);
      t.false(powers.persistence.hasAgentKey(guestNode));
      t.deepEqual(powers.persistence.listFormulaNumbersByNode(guestNode), []);
    } else {
      t.is(deletionAttempts, attemptsBeforeRetry);
      t.is(powers.persistence.hasAgentKey(guestNode), retained);
    }
    const remainingIds = powers.persistence
      .listAgentKeys()
      .map(key => key.agentId);
    for (const id of priorIds) t.true(remainingIds.includes(id));
    t.true((await E(control).list()).includes('@self'));
  });
}
