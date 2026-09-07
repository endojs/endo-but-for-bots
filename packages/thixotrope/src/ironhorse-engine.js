// @ts-check
/* global setTimeout, clearTimeout */
import harden from '@endo/harden';
import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { acquireIronhorseRuntime, hashFile } from './ironhorse-runtime.js';

import { WorkerHaltError } from './worker-engine.js';

/** @import { WorkerEngine } from './worker-engine.js' */

/** @param {string} path */
const syncFile = async path => {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
};

/**
 * Ironhorse with incremental SQLite checkpoints and immutable sleep images.
 * Each incarnation uses a private writable copy. Recovery ALWAYS starts at
 * the snapshot paired with the transport's journal cut, never at an abandoned
 * incarnation's newer checkpoint. This keeps the existing journal/sequence
 * protocol valid without a distributed transaction between heap and hub.
 *
 * @param {object} options
 * @param {string} options.workerBinary
 * @param {Array<string>} options.bootPaths trusted bootstrap files
 * @param {string} options.storePath private directory for heap images
 * @param {number} [options.crankBudget]
 * @param {number} [options.requestTimeoutMs] watchdog for compiler/host faults
 * @returns {WorkerEngine}
 */
export const makeIronhorseEngine = ({
  workerBinary,
  bootPaths,
  storePath,
  crankBudget = 10_000_000,
  requestTimeoutMs = 60_000,
}) => {
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
          (await realpath(statePath)) !== (await realpath(dirname(storePath)))
        ) {
          throw Error(
            'Ironhorse heaps must belong to the daemon state directory',
          );
        }
        await mkdir(storePath, { recursive: true });
        if (
          (await realpath(storePath)) !==
          join(await realpath(statePath), 'heaps')
        ) {
          throw Error('Ironhorse heaps directory must not be a symlink');
        }
        runtime = await acquireIronhorseRuntime({
          statePath,
          workerBinary,
          bootPaths,
          crankBudget,
          onLost: () => {
            void stopWorkers().catch(() => {});
          },
        });
      } finally {
        acquiring = false;
      }
      return async () => {
        await stopWorkers();
        await runtime?.release();
        runtime = undefined;
      };
    },
    releaseSnapshot: async ref => rm(imagePath(ref), { force: true }),
    start: async ({ snapshot, onOutbound }) => {
      if (!runtime)
        throw Error(
          'Acquire the Ironhorse state directory before starting workers',
        );
      const owned = runtime;
      owned.assertOwned();
      const first = await mkdir(images, { recursive: true });
      if (first) {
        for (let path = images; ; path = dirname(path)) {
          // Persist every newly created directory entry up to its parent.
          // eslint-disable-next-line no-await-in-loop
          await syncFile(path);
          if (path === dirname(first)) break;
        }
      }
      await mkdir(work, { recursive: true });
      const directory = await mkdtemp(join(work, 'vat-'));
      const heap = join(directory, 'heap.sqlite');
      try {
        if (snapshot != null) {
          const source = imagePath(snapshot);
          if ((await hashFile(source)) !== snapshot) {
            throw Error('Ironhorse snapshot digest mismatch');
          }
          await copyFile(source, heap);
        }
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }

      let terminated = false;
      /** @type {ReturnType<typeof spawn> | undefined} */
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
          const timer = setTimeout(
            () => fail(Error('Ironhorse worker request timed out')),
            requestTimeoutMs,
          );
          pending = {
            resolve: value => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: error => {
              clearTimeout(timer);
              reject(error);
            },
          };
          if (message) child.stdin?.write(`${JSON.stringify(message)}\n`);
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
        const process = child;
        exited = new Promise(resolve => {
          process.once('exit', (code, signal) => {
            if (pending)
              fail(Error(`Ironhorse worker exited (${code ?? signal})`));
            resolve(code);
          });
          process.once('error', error => {
            fail(error);
            resolve(null);
          });
        });
        process.stdin?.on('error', fail);
        const lines = createInterface({
          input: /** @type {import('node:stream').Readable} */ (process.stdout),
        });
        lines.on('line', line => {
          try {
            const reply = JSON.parse(line);
            const waiter = pending;
            if (!waiter) throw Error('Unsolicited Ironhorse reply');
            if (reply.op === 'fatal') {
              fail(new WorkerHaltError(String(reply.message)));
              return;
            }
            if (!['ready', 'result'].includes(reply.op))
              throw Error('Invalid Ironhorse reply');
            pending = undefined;
            waiter.resolve(reply);
          } catch (error) {
            fail(/** @type {Error} */ (error));
          }
        });
        const ready = await request();
        owned.assertOwned();
        if (ready.op !== 'ready')
          throw Error('Ironhorse boot protocol mismatch');
      };

      const close = async () => {
        const timer = setTimeout(
          () => child?.kill('SIGKILL'),
          requestTimeoutMs,
        );
        child?.stdin?.end(`${JSON.stringify({ op: 'close' })}\n`);
        const code = await exited;
        clearTimeout(timer);
        child = undefined;
        if (code !== 0)
          throw Error('Ironhorse failed to close its SQLite heap');
      };

      const terminate = async () => {
        terminated = true;
        child?.kill('SIGKILL');
        await exited;
        await rm(directory, { recursive: true, force: true });
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
          const ref = await hashFile(heap);
          const temporary = join(directory, 'snapshot.sqlite');
          await copyFile(heap, temporary);
          await syncFile(temporary);
          await rename(temporary, imagePath(ref));
          await syncFile(images);
          await launch();
          return ref;
        },
        terminate,
      });
    },
  });
};
harden(makeIronhorseEngine);
