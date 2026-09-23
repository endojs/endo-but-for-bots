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

for (const failMailbox of [false, true]) {
  test.serial(
    `collection drains sibling cleanup before reporting failures: mailbox=${failMailbox}`,
    async t => {
      t.timeout(15_000);
      const temporary = await mkdtemp(path.join(tmpdir(), 'endo-drain-'));
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
      let handleDeletionAttempts = 0;
      /** @type {FormulaNumber | undefined} */
      let handleNumber;
      /** @type {FormulaNumber | undefined} */
      let mailboxNumber;
      /** @type {FormulaNumber | undefined} */
      let mailHubNumber;
      /** @type {FormulaNumber[]} */
      const deleted = [];
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
                workerDaemonFacet: Far('UnusedWorker', { terminate: () => {} }),
                workerTerminated: workerCancelled.catch(() => {}),
              };
            },
          }),
          persistence: harden({
            ...powers.persistence,
            writeFormula: async (number, node, formula) => {
              if (armed && formula.type === 'mail-hub') {
                mailHubNumber = number;
                throw Error('Injected guest write failure');
              }
              await powers.persistence.writeFormula(number, node, formula);
              if (armed && formula.type === 'handle') handleNumber = number;
              if (armed && formula.type === 'mailbox-store')
                mailboxNumber = number;
            },
            deleteFormula: async number => {
              if (number === handleNumber) {
                handleDeletionAttempts += 1;
                if (armed) throw Error('Injected handle deletion failure');
              }
              if (armed && failMailbox && number === mailboxNumber)
                throw Error('Injected mailbox deletion failure');
              await powers.persistence.deleteFormula(number);
              deleted.push(number);
            },
          }),
        },
        'collection-cleanup-drain',
        cancelled.reject,
        /** @type {Promise<never>} */ (cancelled.promise),
        {},
        { gcEnabled: true },
      );
      t.teardown(() => daemon.cancelGracePeriod(Error('Test finished')));
      const host = await E(daemon.endoBootstrap).host();
      armed = true;
      const error = await t.throwsAsync(E(host).provideGuest('failed-guest'));
      if (!(error instanceof AggregateError))
        throw Error('Expected construction and cleanup errors');
      /**
       * @param {unknown} cause
       * @returns {string[]}
       */
      const messages = cause =>
        cause instanceof AggregateError
          ? cause.errors.flatMap(messages)
          : [cause instanceof Error ? cause.message : String(cause)];
      t.deepEqual(messages(error).sort(), [
        'Injected guest write failure',
        'Injected handle deletion failure',
        ...(failMailbox ? ['Injected mailbox deletion failure'] : []),
      ]);
      if (!handleNumber || !mailboxNumber || !mailHubNumber)
        throw Error('Missing acquired identities');
      // Observe persistence directly: another host operation could drain the
      // stranded callbacks and conceal premature completion of the first drain.
      t.true(deleted.includes(mailHubNumber));
      if (failMailbox) {
        t.is(
          (await powers.persistence.readFormula(mailboxNumber)).formula.type,
          'mailbox-store',
        );
      } else {
        t.true(deleted.includes(mailboxNumber));
        await t.throwsAsync(powers.persistence.readFormula(mailboxNumber), {
          message: /No formula exists for number/,
        });
      }
      t.is(
        (await powers.persistence.readFormula(handleNumber)).formula.type,
        'handle',
      );
      armed = false;
      t.is(await E(host).identify('failed-guest'), undefined);
      const sibling = await E(host).makeDirectory('after-failure');
      t.deepEqual(await E(sibling).list(), []);
      await E(host).remove('after-failure');
      t.is(handleDeletionAttempts, 1);
    },
  );
}
