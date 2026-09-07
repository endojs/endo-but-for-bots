// @ts-check
/* global setTimeout, clearTimeout */
import harden from '@endo/harden';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { WorkerHaltError } from './worker-engine.js';

/** @import { WorkerEngine } from './worker-engine.js' */

/** @param {string} path */
const digest = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

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

  return harden({
    canSnapshot: true,
    releaseSnapshot: async ref => rm(imagePath(ref), { force: true }),
    start: async ({ snapshot, onOutbound }) => {
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
          if ((await digest(source)) !== snapshot) {
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
        child = spawn(workerBinary, [heap, ...bootPaths], {
          stdio: ['pipe', 'pipe', 'inherit'],
        });
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

      try {
        await launch();
      } catch (error) {
        child?.kill('SIGKILL');
        await exited;
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return harden({
        deliver: async message => {
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
          const ref = await digest(heap);
          const temporary = join(directory, 'snapshot.sqlite');
          await copyFile(heap, temporary);
          await syncFile(temporary);
          await rename(temporary, imagePath(ref));
          await syncFile(images);
          await launch();
          return ref;
        },
        terminate: async () => {
          terminated = true;
          child?.kill('SIGKILL');
          await exited;
          await rm(directory, { recursive: true, force: true });
        },
      });
    },
  });
};
harden(makeIronhorseEngine);
