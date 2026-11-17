// @ts-check
/** @import { FilePowers } from '../platform/files.js' */
/** @import { HashPowers } from '../platform/hashes.js' */
/** @import { PathPowers } from '../platform/paths.js' */
/** @import { SpawnedProcess, ProcessPowers } from '../platform/processes.js' */
/** @import { TimerPowers } from '../platform/timers.js' */
import harden from '@endo/harden';
import { Fail } from '@endo/errors';
import { acquireIronhorseRuntime, hashFile } from './ironhorse-runtime.js';
import { makeIronhorseLimits } from './ironhorse-limits.js';

import { WorkerCrashError } from '../core/worker-crash-error.js';
import { WorkerHaltError } from '../core/worker-engine.js';
import { withExpiry } from '../platform/timers.js';

/** @import { WorkerEngine } from '../core/worker-engine.js' */
/** @import { GcPolicyName, LimitInput } from './ironhorse-limits.js' */

/** The largest budget the worker accepts (u64). */
const U64_MAX = 0xffff_ffff_ffff_ffffn;

/**
 * Ironhorse with immutable sleep images. Each incarnation uses a private
 * writable copy, which the worker commits when it closes, not per crank.
 * Recovery ALWAYS starts at the snapshot paired with the transport's journal
 * cut, never at an abandoned incarnation's copy. This keeps the existing
 * journal/sequence protocol valid without a distributed transaction between
 * heap and hub.
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
 * @param {LimitInput} [options.crankBudget]
 * @param {LimitInput} [options.bootstrapBudget]
 * @param {LimitInput} [options.slotCeiling]
 * @param {LimitInput} [options.chunkCeiling]
 * @param {GcPolicyName} [options.gcPolicy] when the worker collects garbage
 *   (see `makeIronhorseLimits`)
 * @param {LimitInput} [options.gcSlotAllowance]
 * @param {LimitInput} [options.gcChunkAllowance]
 * @param {LimitInput} [options.requestTimeoutMs] watchdog: a worker that has
 *   not answered a request in this long is killed, and has crashed
 * @returns {WorkerEngine}
 */
export const makeIronhorseEngine = (
  { processes, files, paths, timers, hashes },
  {
    workerBinary,
    bootPaths,
    storePath,
    crankBudget,
    bootstrapBudget,
    slotCeiling,
    chunkCeiling,
    gcPolicy,
    gcSlotAllowance,
    gcChunkAllowance,
    requestTimeoutMs,
  },
) => {
  const limits = makeIronhorseLimits({
    crankBudget,
    bootstrapBudget,
    slotCeiling,
    chunkCeiling,
    gcPolicy,
    gcSlotAllowance,
    gcChunkAllowance,
    requestTimeoutMs,
  });
  const timeoutMs = limits.requestTimeoutMs;
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

  const images = resolvePath(storePath, 'snapshots');
  const work = resolvePath(storePath, 'incarnations');
  /** @param {unknown} ref */
  const imagePath = ref => {
    if (typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref)) {
      throw Error('Invalid Ironhorse snapshot reference');
    }
    return join(images, `${ref}.sqlite`);
  };
  /**
   * A directory-safe form of a worker's debug name.
   * @param {string} name
   */
  const slugOf = name =>
    name
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

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
            limits,
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
    start: async ({ debugName, snapshot, onOutbound, onOutboundBatch }) => {
      if (!runtime)
        throw Error(
          'Acquire the Ironhorse state directory before starting workers',
        );
      const owned = runtime;
      owned.assertOwned();
      await makeDirectory(images);
      await makeDirectory(work);
      // Name the incarnation after its worker, so `ls` and the heap path in
      // `ps` tell an operator which vat is whose. Diagnostic only: nothing
      // looks an incarnation up by name.
      const directory = await makeTempDirectory(
        join(work, `vat-${slugOf(debugName)}-`),
      );
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
      /** @type {SpawnedProcess | undefined} */
      let child;
      /** @type {Promise<number | null> | undefined} */
      let exited;
      /** @type {{ resolve: (value: any) => void, reject: (error: Error) => void } | undefined} */
      let pending;
      /**
       * Why the current child can answer nothing more, once it has exited;
       * a request made after that fails at once instead of at its deadline.
       *
       * @type {Error | undefined}
       */
      let gone;
      /**
       * What went wrong with the child's pipes or replies before its exit
       * said how it ended.
       *
       * @type {Error | undefined}
       */
      let symptom;

      /** @param {Error} error */
      const fail = error => {
        pending?.reject(error);
        pending = undefined;
        child?.kill('SIGKILL');
      };

      /**
       * A broken pipe or a reply cut short is how a worker's death looks
       * when it is noticed ahead of the exit. Make sure of the exit, and
       * let it say what this was: see `ended`.
       *
       * @param {Error} error
       */
      const failAtExit = error => {
        symptom ??= error;
        child?.kill('SIGKILL');
      };

      /**
       * How the child ended. A worker killed by a signal has crashed: that
       * is its own death (an abort, a fault, the kernel reclaiming memory)
       * or one dealt it from outside, and either way says nothing against
       * the host. One that exits with a status has reported a failure on
       * its error stream and left in good order, which is how it refuses a
       * lease, a heap it cannot open or a disk it cannot write: the host's
       * trouble, not counted against the worker. So is an exit the host
       * asked for.
       *
       * @param {number | null} code
       */
      const ended = code => {
        const how = `Ironhorse worker exited (${code ?? 'signaled'})`;
        const message =
          symptom === undefined ? how : `${how} after ${symptom.message}`;
        return code === null && !terminated
          ? new WorkerCrashError(message)
          : Error(message);
      };

      /** @param {object} [message] */
      const request = message =>
        new Promise((resolve, reject) => {
          if (gone) {
            reject(gone);
            return;
          }
          if (!child || terminated || pending) {
            reject(Error('Ironhorse worker is unavailable or busy'));
            return;
          }
          const timer = setTimer(
            () =>
              fail(new WorkerCrashError('Ironhorse worker request timed out')),
            timeoutMs,
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

      let combinedDelivery = false;
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
            JSON.stringify(limits),
            ...owned.bootPaths,
          ],
          {
            stdio: ['pipe', 'pipe', 'inherit'],
          },
        );
        const workerProcess = child;
        gone = undefined;
        symptom = undefined;
        // A process that never started has no exit to wait for, and is the
        // host's failure to report as it is.
        const spawned = workerProcess.pid !== 0;
        // A snapshot closes one child and launches another: what a child's
        // pipes report late must not be taken out on its successor.
        const current = () => child === workerProcess;
        void workerProcess.failed.then(error => {
          if (current()) (spawned ? failAtExit : fail)(error);
        });
        exited = workerProcess.exited.then(code => {
          if (current()) {
            gone = spawned
              ? ended(code)
              : Error('Ironhorse worker did not start');
            if (pending) fail(gone);
          }
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
                } else if (reply.op === 'error') {
                  // A malformed request; the worker and its heap stay up.
                  pending = undefined;
                  waiter.reject(Error(String(reply.message)));
                } else {
                  if (!['ready', 'result'].includes(reply.op))
                    throw Error('Invalid Ironhorse reply');
                  pending = undefined;
                  waiter.resolve(reply);
                }
              } catch (error) {
                if (current()) failAtExit(/** @type {Error} */ (error));
              }
            }
          } catch (error) {
            if (current()) failAtExit(/** @type {Error} */ (error));
          }
        })();
        const ready = await request();
        owned.assertOwned();
        if (ready.op !== 'ready')
          throw Error('Ironhorse boot protocol mismatch');
        combinedDelivery =
          Array.isArray(ready.features) &&
          ready.features.includes('deliver-v1');
      };

      const close = async () => {
        // The escalation must be cleared even when the wait fails: a surviving
        // SIGKILL timer holds the host's event loop and fires at a child that
        // has already gone.
        const code = await withExpiry(
          timers,
          timeoutMs,
          () => child?.kill('SIGKILL'),
          () => {
            child?.input(0)?.end(`${JSON.stringify({ op: 'close' })}\n`);
            return exited;
          },
        );
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
      /**
       * One crank: dispatch `source` (calls of the bootstrap's dispatch),
       * drain its jobs, collect and finalize when the worker's collection
       * schedule (`limits.gcPolicy`) says so, take outbound.
       *
       * @param {string} source
       * @param {string} budget decimal computrons
       */
      const crank = async (source, budget) => {
        let reply;
        if (combinedDelivery) {
          // The native operation runs dispatch jobs and the complete
          // finalizer cascade before extracting outbound, with no extra GC
          // for the allocation-only bridge read.
          reply = await request({
            op: 'deliver',
            source,
            budget,
            drainBudget: limits.crankBudget,
          });
        } else {
          // A pinned older runtime must replay its original two evaluations.
          // Do not change its collection/finalization schedule on restart.
          await request({ op: 'eval', source, budget });
          reply = await request({
            op: 'eval',
            source: 'JSON.stringify(thixotropeTakeOutbound())',
            budget: limits.crankBudget,
          });
        }
        const frames = JSON.parse(reply.result);
        if (onOutboundBatch !== undefined) onOutboundBatch(frames);
        else for (const frame of frames) onOutbound(frame);
      };
      /** @param {Record<string, unknown>} message */
      const dispatchSource = message =>
        // The queue and dispatch function belong to the trusted worker
        // bootstrap; the guest evaluator receives neither one.
        `thixotropeDispatch(${JSON.stringify(JSON.stringify(message))});`;
      return harden({
        deliver: async message => {
          owned.assertOwned();
          await crank(
            dispatchSource(message),
            message.t === 'init' ? limits.bootstrapBudget : limits.crankBudget,
          );
        },
        /**
         * Several frames in one crank: the dispatches run in order in one
         * evaluation, then one drain, one collection and one outbound read.
         * The crank's budget is the sum of its frames' budgets, so the
         * frames a GC run waited for keep the whole budget they had alone.
         *
         * @param {Array<Record<string, unknown>>} messages
         */
        deliverBatch: async messages => {
          owned.assertOwned();
          messages.length > 0 || Fail`Ironhorse deliverBatch needs a message`;
          for (const message of messages) {
            message.t === 'f' || Fail`Ironhorse deliverBatch takes frames only`;
          }
          const budget = BigInt(limits.crankBudget) * BigInt(messages.length);
          await crank(
            messages.map(dispatchSource).join(''),
            String(budget < U64_MAX ? budget : U64_MAX),
          );
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
