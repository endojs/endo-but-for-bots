// @ts-check
/** @import {EndoDirectory, FormulaNumber} from '../src/types.js'; */
/** @import {Passable} from '@endo/pass-style'; */
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { assertPassable, Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as popen from 'node:child_process';
import process from 'node:process';
import * as url from 'node:url';

import {
  gunzip,
  makeCryptoPowers,
  makeDaemonicPowers,
  makeFilePowers,
} from '../src/manager-node-powers.js';
import { makeDaemon } from '../src/manager.js';
import { parseId } from '../src/formula-identifier.js';
import { makeEndoClient, restart, start, stop } from '../index.js';

for (const fail of [false, true, 'after-write']) {
  for (const existing of [false, true]) {
    const interleavings =
      fail === 'after-write' || existing ? [false] : [false, true];
    for (const interleaved of interleavings) {
      test.serial(
        `marshal persists before publication: fail=${fail}, existing=${existing}, interleaved=${interleaved}`,
        async t => {
          t.timeout(15_000);
          const temporary = await mkdtemp(path.join(tmpdir(), 'endo-marshal-'));
          t.teardown(() => rm(temporary, { recursive: true, force: true }));
          const cancelled = makePromiseKit();
          const entered = makePromiseKit();
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
                throw Error('Unexpected network');
              },
              gunzip,
              createHash: crypto.createHash,
            },
          });
          await powers.persistence.initializePersistence();
          let armed = false;
          /** @type {FormulaNumber | undefined} */
          let lastMarshalNumber;
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
                  if (formula.type === 'marshal') lastMarshalNumber = number;
                  if (armed && formula.type === 'marshal') {
                    armed = false;
                    entered.resolve(undefined);
                    await release.promise;
                    if (fail === 'after-write') {
                      await powers.persistence.writeFormula(
                        number,
                        node,
                        formula,
                      );
                    }
                    if (fail)
                      throw Error('Injected marshal persistence failure');
                  }
                  return powers.persistence.writeFormula(number, node, formula);
                },
              }),
            },
            'marshal-publication-test',
            cancelled.reject,
            /** @type {Promise<never>} */ (cancelled.promise),
            {},
            { gcEnabled: true },
          );
          t.teardown(() => daemon.cancelGracePeriod(Error('Test finished')));
          const host = await E(daemon.endoBootstrap).host();
          let capability;
          let capabilityId;
          if (interleaved) {
            capability = await E(host).makeDirectory('sole-root');
            capabilityId = await E(host).identify('sole-root');
            await E(capability).makeDirectory('child');
          }
          if (existing) await E(host).storeValue('old', 'target');
          const oldId = await E(host).identify('target');
          armed = true;
          const value = interleaved ? harden({ capability }) : 'new';
          assertPassable(value);
          const storing = E(host).storeValue(
            /** @type {Passable} */ (value),
            'target',
          );
          const outcome = fail
            ? t.throwsAsync(storing, {
                message: /Injected marshal persistence failure/,
              })
            : storing;
          await entered.promise;
          // A real persistent petstore, not a Map: the old binding must remain
          // intact throughout a pending or failed formula write.
          t.is(await E(host).identify('target'), oldId);
          if (existing) t.is(await E(host).lookup('target'), 'old');
          if (interleaved) {
            await E(host).remove('sole-root');
          }
          release.resolve(undefined);
          await outcome;
          if (fail) {
            t.is(await E(host).identify('target'), oldId);
            if (existing) t.is(await E(host).lookup('target'), 'old');
            if (interleaved) {
              if (capabilityId === undefined)
                throw Error('Missing capability ID');
              await E(host).storeValue('drain deferred collection', 'other');
              await t.throwsAsync(
                powers.persistence.readFormula(parseId(capabilityId).number),
              );
            }
            if (fail === 'after-write') {
              // Lost acknowledgement must not publish a dangling name. Error
              // cleanup must also reclaim the written but unpublished formula.
              if (lastMarshalNumber === undefined)
                throw Error('Missing marshal');
              await t.throwsAsync(
                powers.persistence.readFormula(lastMarshalNumber),
                { message: /No formula exists for number/ },
              );
            }
          } else {
            if (interleaved) {
              // The persisted value was constructed above with this exact shape.
              const published = /** @type {{ capability: EndoDirectory }} */ (
                await E(host).lookup('target')
              );
              t.deepEqual(await E(published.capability).list(), ['child']);
              if (capabilityId === undefined)
                throw Error('Missing capability ID');
              const diagnostics = await E(host).diagnostics();
              t.is(
                (await E(diagnostics).getFormula(parseId(capabilityId).id))
                  .type,
                'directory',
              );
              t.is(
                (
                  await powers.persistence.readFormula(
                    parseId(capabilityId).number,
                  )
                ).formula.type,
                'directory',
              );
            } else {
              t.is(await E(host).lookup('target'), 'new');
            }
            const id = await E(host).identify('target');
            t.not(id, oldId);
            if (id === undefined) throw Error('Missing published name');
            const { formula } = await powers.persistence.readFormula(
              parseId(id).number,
            );
            t.is(formula.type, 'marshal');
          }
          if (!fail && !existing && !interleaved) {
            // A failed publication returns no ID: its caller cannot release a
            // transferred pin. The otherwise unreferenced formula must collect.
            await t.throwsAsync(
              E(host).storeValue('unpublished', ['missing', 'target']),
            );
            const unpublished = lastMarshalNumber;
            if (unpublished === undefined)
              throw Error('Missing failed formula');
            await E(host).storeValue('drain deferred collection', 'other');
            await t.throwsAsync(powers.persistence.readFormula(unpublished));
            t.is(await E(host).lookup('target'), 'new');
          }
        },
      );
    }
  }
}

test.serial(
  'published marshal values survive a daemon process restart',
  async t => {
    t.timeout(30_000);
    // macOS's per-user tmpdir plus worker paths can exceed sockaddr_un limits.
    const root = await mkdtemp(
      path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-m-'),
    );
    const config = {
      statePath: path.join(root, 'state'),
      ephemeralStatePath: path.join(root, 'run'),
      cachePath: path.join(root, 'cache'),
      sockPath: path.join(root, 'endo.sock'),
      address: '127.0.0.1:0',
      pets: new Map(),
      values: new Map(),
      gcEnabled: true,
    };
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => {});
    t.teardown(async () => {
      try {
        await stop(config);
      } finally {
        cancelled.reject(Error('Test finished'));
        await rm(root, { recursive: true, force: true });
      }
    });
    const connect = async () => {
      const client = await makeEndoClient(
        'marshal-restart',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      return E(client.getBootstrap()).host();
    };
    await start(config);
    const before = await connect();
    await E(before).storeValue(
      harden({ sequence: 1n, content: 'preserved' }),
      'journal-event',
    );
    await E(before).storeValue('old', 'replace');
    await E(before).storeValue('new', 'replace');
    // Replace a directory's sole pet-name root with a marshal value referring
    // to that very directory. The marshal's slot edge must exist before the
    // old name edge is removed, or enabled collection can destroy the value
    // being published. No second name retains the directory.
    await E(before).makeDirectory('capability-root');
    const heldId = await E(before).identify('capability-root');
    if (heldId === undefined) throw Error('Missing capability root');
    const held = await E(before).lookup('capability-root');
    await E(held).makeDirectory('child');
    await E(before).storeValue(harden({ held }), 'capability-root');
    t.not(await E(before).identify('capability-root'), heldId);
    const published = await E(before).lookup('capability-root');
    t.deepEqual(await E(published.held).list(), ['child']);
    const diagnostics = await E(before).diagnostics();
    t.is((await E(diagnostics).getFormula(heldId)).type, 'directory');
    await restart(config);
    const after = await connect();
    t.deepEqual(await E(after).lookup('journal-event'), {
      sequence: 1n,
      content: 'preserved',
    });
    t.is(await E(after).lookup('replace'), 'new');
    const revived = await E(after).lookup('capability-root');
    t.deepEqual(await E(revived.held).list(), ['child']);
    const revivedDiagnostics = await E(after).diagnostics();
    t.is((await E(revivedDiagnostics).getFormula(heldId)).type, 'directory');
  },
);
