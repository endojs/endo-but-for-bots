// @ts-check
/** @import { FilePowers } from '../platform/files.js' */
/** @import { HashPowers } from '../platform/hashes.js' */
/** @import { PathPowers } from '../platform/paths.js' */
/** @import { ChildProcessPowers, ProcessPowers } from '../platform/processes.js' */
/** @import { TimerPowers } from '../platform/timers.js' */
import harden from '@endo/harden';
import { acquireIronhorseRuntime, hashFile } from './ironhorse-runtime.js';

import { WorkerHaltError } from '../core/worker-engine.js';

/** @import { WorkerEngine } from '../core/worker-engine.js' */

/**
 * Ironhorse with incremental SQLite checkpoints and immutable sleep images.
 * Each incarnation uses a private writable copy. Recovery ALWAYS starts at
 * the snapshot paired with the transport's journal cut, never at an abandoned
 * incarnation's newer checkpoint. This keeps the existing journal/sequence
 * protocol valid without a distributed transaction between heap and hub.
 *
 * @param {object} powers
 * @param {ProcessPowers} powers.processes
 * @param {FilePowers} powers.files
 * @param {PathPowers} powers.paths
 * @param {TimerPowers} powers.timers
 * @param {HashPowers} powers.hashes
 * @param {object} options
 * @param {string} options.workerBinary
 * @param {Array<string>} options.bootPaths trusted bootstrap files
 * @param {string} options.storePath private directory for heap images
 * @param {number} [options.crankBudget]
 * @param {number} [options.requestTimeoutMs] watchdog for compiler/host faults
 * @returns {WorkerEngine}
 */
export const makeIronhorseEngine = (
  { processes, files, paths, timers, hashes },
  {
    workerBinary,
    bootPaths,
    storePath,
    crankBudget = 10_000_000,
    requestTimeoutMs = 60_000,
  },
) => {
  const { spawn } = processes;
  const {
    copyFile,
    makeDirectory,
    makeTempDirectory,
    realPath,
    rename,
    remove,
    syncPath,
  } = files;
  const { dirname, join, resolve: resolvePath } = paths;
  const { setTimer, clearTimer } = timers;

  if (
    !Number.isSafeInteger(crankBudget) ||
    crankBudget <= 0 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0
  ) {
    throw Error(
      'Ironhorse budgets and timeouts must be positive safe integers',
    );
  }
  const images = resolvePath(storePath, 'snapshots');
  const work = resolvePath(storePath, 'incarnations');
  /** @param {unknown} ref */
  const imagePath = ref => {
    if (typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref)) {
      throw Error('Invalid Ironhorse snapshot reference');
    }
    return join(images, `${ref}.sqlite`);
  };

  /** @type {Awaited<ReturnType<typeof acquireIronhorseRuntime>> | undefined} */
  let runtime;
  let acquiring = false;
  /** @type {Set<() => Promise<void>>} */
  const incarnations = new Set();
  const stopWorkers = async () => {
    await Promise.all([...incarnations].map(stop => stop()));
  };
  return harden({
    canSnapshot: true,
    assertStoreOwnership: () => {
      if (!runtime) throw Error('Ironhorse state directory is not owned');
      runtime.assertOwned();
    },
    acquireStore: async statePath => {
      if (runtime || acquiring)
        throw Error('Ironhorse engine already owns a store');
      if (!statePath) throw Error('Ironhorse requires a filesystem store');
      acquiring = true;
      try {
        if (
          resolvePath(storePath) !== resolvePath(statePath, 'heaps') ||
          (await realPath(statePath)) !== (await realPath(dirname(storePath)))
        ) {
          throw Error(
            'Ironhorse heaps must belong to the daemon state directory',
          );
        }
        await makeDirectory(storePath);
        if (
          (await realPath(storePath)) !==
          join(await realPath(statePath), 'heaps')
        ) {
          throw Error('Ironhorse heaps directory must not be a symlink');
        }
        runtime = await acquireIronhorseRuntime(
          { processes, files, paths, hashes },
          {
            statePath,
            workerBinary,
            bootPaths,
            crankBudget,
            onLost: () => {
              void stopWorkers().catch(() => {});
            },
          },
        );
      } finally {
        acquiring = false;
      }
      return async () => {
        await stopWorkers();
        await runtime?.release();
        runtime = undefined;
      };
    },
    releaseSnapshot: async ref => remove(imagePath(ref), { force: true }),
    start: async ({ snapshot, onOutbound }) => {
      if (!runtime)
        throw Error(
          'Acquire the Ironhorse state directory before starting workers',
        );
      const owned = runtime;
      owned.assertOwned();
      await makeDirectory(images);
      await makeDirectory(work);
      const directory = await makeTempDirectory(join(work, 'vat-'));
      const heap = join(directory, 'heap.sqlite');
      try {
        if (snapshot != null) {
          const source = imagePath(snapshot);
          if ((await hashFile(hashes, source)) !== snapshot) {
            throw Error('Ironhorse snapshot digest mismatch');
          }
          await copyFile(source, heap);
        }
      } catch (error) {
        await remove(directory, { recursive: true, force: true });
        throw error;
      }

      let terminated = false;
      /** @type {ChildProcessPowers | undefined} */
      let child;
      /** @type {Promise<number | null> | undefined} */
      let exited;
      /** @type {{ resolve: (value: any) => void, reject: (error: Error) => void } | undefined} */
      let pending;

      /** @param {Error} error */
      const fail = error => {
        pending?.reject(error);
        pending = undefined;
        child?.kill('SIGKILL');
      };

      /** @param {object} [message] */
      const request = message =>
        new Promise((resolve, reject) => {
          if (!child || terminated || pending) {
            reject(Error('Ironhorse worker is unavailable or busy'));
            return;
          }
          const timer = setTimer(
            () => fail(Error('Ironhorse worker request timed out')),
            requestTimeoutMs,
          );
          pending = {
            resolve: value => {
              clearTimer(timer);
              resolve(value);
            },
            reject: error => {
              clearTimer(timer);
              reject(error);
            },
          };
          if (message) child.input(0)?.write(`${JSON.stringify(message)}\n`);
        });

      const launch = async () => {
        if (terminated)
          throw Error('Ironhorse worker was terminated during startup');
        owned.assertOwned();
        child = spawn(
          owned.workerBinary,
          [
            heap,
            owned.profile,
            join(storePath, 'active.lock'),
            ...owned.bootPaths,
          ],
          {
            stdio: ['pipe', 'pipe', 'inherit'],
          },
        );
        const workerProcess = child;
        exited = workerProcess.exited.then(code => {
          if (pending)
            fail(Error(`Ironhorse worker exited (${code ?? 'signaled'})`));
          return code;
        });
        void (async () => {
          await null;
          try {
            for await (const line of workerProcess.lines(1)) {
              try {
                const reply = JSON.parse(line);
                const waiter = pending;
                if (!waiter) throw Error('Unsolicited Ironhorse reply');
                if (reply.op === 'fatal') {
                  fail(new WorkerHaltError(String(reply.message)));
                } else {
                  if (!['ready', 'result'].includes(reply.op))
                    throw Error('Invalid Ironhorse reply');
                  pending = undefined;
                  waiter.resolve(reply);
                }
              } catch (error) {
                fail(/** @type {Error} */ (error));
              }
            }
          } catch (error) {
            fail(/** @type {Error} */ (error));
          }
        })();
        const ready = await request();
        owned.assertOwned();
        if (ready.op !== 'ready')
          throw Error('Ironhorse boot protocol mismatch');
      };

      const close = async () => {
        const timer = setTimer(() => child?.kill('SIGKILL'), requestTimeoutMs);
        child?.input(0)?.end(`${JSON.stringify({ op: 'close' })}\n`);
        const code = await exited;
        clearTimer(timer);
        child = undefined;
        if (code !== 0)
          throw Error('Ironhorse failed to close its SQLite heap');
      };

      const terminate = async () => {
        terminated = true;
        child?.kill('SIGKILL');
        await exited;
        await remove(directory, { recursive: true, force: true });
        incarnations.delete(terminate);
      };
      incarnations.add(terminate);
      try {
        await launch();
      } catch (error) {
        await terminate();
        throw error;
      }
      return harden({
        deliver: async message => {
          owned.assertOwned();
          // The queue and dispatch function belong to the trusted worker
          // bootstrap; the guest evaluator receives neither one.
          const source = `thixotropeDispatch(${JSON.stringify(JSON.stringify(message))});`;
          await request({
            op: 'eval',
            source,
            budget: message.t === 'init' ? 1_000_000_000 : crankBudget,
          });
          // run() drains promise jobs before returning. A separate read crank
          // sees every frame generated by that drain, commits its removal,
          // and only THEN allows frames onto the host duct.
          const reply = await request({
            op: 'eval',
            source: 'JSON.stringify(thixotropeTakeOutbound())',
            budget: crankBudget,
          });
          for (const frame of JSON.parse(reply.result)) onOutbound(frame);
        },
        snapshot: async () => {
          await close(); // SQLite folds the WAL before the file is copied.
          const ref = await hashFile(hashes, heap);
          const temporary = join(directory, 'snapshot.sqlite');
          await copyFile(heap, temporary);
          await syncPath(temporary);
          await rename(temporary, imagePath(ref));
          await syncPath(images);
          await launch();
          return ref;
        },
        terminate,
      });
    },
  });
};
harden(makeIronhorseEngine);
