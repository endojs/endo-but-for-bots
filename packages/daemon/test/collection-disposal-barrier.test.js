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
import * as url from 'node:url';
import {
  gunzip,
  makeCryptoPowers,
  makeDaemonicPowers,
  makeFilePowers,
} from '../src/manager-node-powers.js';
import { makeDaemon } from '../src/manager.js';
import { formatId, parseId } from '../src/formula-identifier.js';

for (const mode of [
  'success',
  'delete-failure',
  'store-failure',
  'combined-failure',
  'held-read',
  'reclaim-failure',
]) {
  const failDeletion = mode === 'delete-failure' || mode === 'combined-failure';
  const failStore = mode === 'store-failure' || mode === 'combined-failure';
  test(`collection fences reconstruction before asynchronous formula deletion: ${mode}`, async t => {
    t.timeout(15_000);
    const temporary = await mkdtemp(path.join(tmpdir(), 'endo-collection-'));
    t.teardown(() => rm(temporary, { recursive: true, force: true }));
    const cancelled = makePromiseKit();
    const entered = makePromiseKit();
    const release = makePromiseKit();
    const readEntered = makePromiseKit();
    const releaseRead = makePromiseKit();
    t.teardown(() => {
      release.resolve(undefined);
      releaseRead.resolve(undefined);
      cancelled.reject(Error('Test finished'));
    });
    /** @type {string | undefined} */
    let heldNumber;
    /** @type {any} */
    let retainedMount;
    let reclaimAttempted = false;
    let injectFailure = true;
    let deletionAttempts = 0;
    let reclamationAttempts = 0;
    let storeFailureObserved = false;
    const files = makeFilePowers({ fs, path });
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
      filePowers: harden({
        ...files,
        removeDirectory: async directory => {
          if (
            mode === 'reclaim-failure' &&
            directory ===
              path.join(temporary, 'state', 'mounts', heldNumber || '')
          ) {
            reclamationAttempts += 1;
            reclaimAttempted = true;
            await t.throwsAsync(E(retainedMount).readText('proof.txt'), {
              message: /revok|cancel/i,
            });
            if (injectFailure) throw Error('Injected reclamation failure');
          }
          return files.removeDirectory(directory);
        },
      }),
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
    let holdRead = false;
    const daemon = await makeDaemon(
      {
        ...powers,
        petStore: harden({
          ...powers.petStore,
          deletePetStore: async (number, type) => {
            if (heldNumber && failStore && injectFailure) {
              storeFailureObserved = true;
              throw Error('Injected pet-store deletion failure');
            }
            return powers.petStore.deletePetStore(number, type);
          },
        }),
        control: /** @type {any} */ ({
          makeWorker: async (_id, _facet, workerCancelled, forceCancelled) => {
            void forceCancelled.catch(() => {});
            return {
              workerDaemonFacet: Far('UnusedWorker', { terminate: () => {} }),
              workerTerminated: workerCancelled.catch(() => {}),
            };
          },
        }),
        persistence: harden({
          ...powers.persistence,
          readFormula: async number => {
            const result = await powers.persistence.readFormula(number);
            if (holdRead && number === heldNumber) {
              holdRead = false;
              readEntered.resolve(undefined);
              await releaseRead.promise;
            }
            return result;
          },
          deleteFormula: async number => {
            if (number === heldNumber) {
              deletionAttempts += 1;
              entered.resolve(undefined);
              await release.promise;
              if (failDeletion && injectFailure)
                throw Error('Injected formula deletion failure');
            }
            return powers.persistence.deleteFormula(number);
          },
        }),
      },
      'collection-disposal-test',
      cancelled.reject,
      /** @type {Promise<never>} */ (cancelled.promise),
      {},
      { gcEnabled: true },
    );
    t.teardown(() => daemon.cancelGracePeriod(Error('Test finished')));
    const host = await E(daemon.endoBootstrap).host();
    if (mode === 'reclaim-failure') {
      retainedMount = await E(host).provideScratchMount('victim');
      await E(retainedMount).writeText('proof.txt', 'live mount');
    } else {
      await E(host).makeDirectory('victim');
    }
    const identified = await E(host).identify('victim');
    if (identified === undefined) throw Error('Missing directory formula');
    let id = formatId(parseId(identified));
    if (mode === 'held-read') {
      // Seed an otherwise uncached persisted formula. Its in-flight disk
      // read predates collection, unlike a lookup that starts afterward.
      const original = parseId(id);
      const { formula } = await powers.persistence.readFormula(original.number);
      const number = /** @type {import('../src/types.js').FormulaNumber} */ (
        crypto.randomBytes(32).toString('hex')
      );
      await powers.persistence.writeFormula(number, original.node, formula);
      id = formatId({ number, node: original.node });
      await E(host).storeIdentifier('victim', id);
    }
    heldNumber = parseId(id).number;
    let reading;
    if (mode === 'held-read') {
      holdRead = true;
      const diagnostics = await E(host).diagnostics();
      reading = t.throwsAsync(E(diagnostics).getFormula(id), {
        message: /unknown identifier|collect/i,
      });
      await readEntered.promise;
    }
    const removal = E(host).remove('victim');
    const removalOutcome =
      mode === 'reclaim-failure' || failDeletion || failStore
        ? t.throwsAsync(removal, {
            message:
              mode === 'combined-failure' || mode === 'reclaim-failure'
                ? 'Collected storage cleanup failed'
                : failDeletion
                  ? 'Injected formula deletion failure'
                  : 'Injected pet-store deletion failure',
          })
        : removal;
    await entered.promise;
    // The old controller is withdrawn, but its persistent formula and queued
    // cancellation still exist. No competing incarnation may start in this gap.
    await t.throwsAsync(E(host).lookupById(id), {
      message: /disposal|collect/i,
    });
    release.resolve(undefined);
    const removalError = await removalOutcome;
    if (mode === 'combined-failure') {
      t.true(removalError instanceof AggregateError);
      if (!(removalError instanceof AggregateError))
        throw Error('Expected both storage failures');
      t.deepEqual(removalError.errors.map(error => error.message).sort(), [
        'Injected formula deletion failure',
        'Injected pet-store deletion failure',
      ]);
    }
    if (failStore) t.true(storeFailureObserved);
    if (mode === 'held-read') {
      // Complete the read only after collection/deletion finishes. A stale
      // successful read must not reinsert the removed formula in the graph.
      releaseRead.resolve(undefined);
      await reading;
      await t.throwsAsync(E(host).lookupById(id));
    }
    if (failDeletion || failStore || mode === 'reclaim-failure') {
      // Failed durable deletion must not make the still-present formula usable
      // after its old controller and cleanup owner have been withdrawn.
      await t.throwsAsync(E(host).lookupById(id), {
        message: /disposal|collect/i,
      });
    }
    if (mode === 'reclaim-failure') {
      t.true(reclaimAttempted);
      t.is(
        await fs.promises.readFile(
          path.join(temporary, 'state', 'mounts', heldNumber, 'proof.txt'),
          'utf8',
        ),
        'live mount',
      );
    }
    if (failDeletion || mode === 'reclaim-failure') {
      // Characterize the open retry-ownership defect, not desired behavior:
      // clearing the external failure and draining subsequent graph changes
      // does not retry the cleanup removed from pendingCollectionCleanup.
      // Replace these assertions with reclamation checks when retry ownership
      // is implemented; retaining a reconstruction fence is not cleanup.
      injectFailure = false;
      const attempts = { deletionAttempts, reclamationAttempts };
      const sibling = await E(host).makeDirectory('after-failure');
      t.deepEqual(await E(sibling).list(), []);
      await E(host).remove('after-failure');
      t.deepEqual({ deletionAttempts, reclamationAttempts }, attempts);
      await t.throwsAsync(E(host).lookupById(id), {
        message: /disposal|collect/i,
      });
      if (failDeletion) {
        const stored = await powers.persistence.readFormula(parseId(id).number);
        t.is(stored.formula.type, 'directory');
      } else {
        t.is(
          await fs.promises.readFile(
            path.join(temporary, 'state', 'mounts', heldNumber, 'proof.txt'),
            'utf8',
          ),
          'live mount',
        );
      }
    }
  });
}
