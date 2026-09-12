// @ts-check
/** @import { FilePowers } from '../platform/files.js' */
/** @import { PathPowers } from '../platform/paths.js' */
/** @import { ProcessPowers } from '../platform/processes.js' */
/** @import { TimerPowers } from '../platform/timers.js' */
import harden from '@endo/harden';

import { Fail, q } from '@endo/errors';

/**
 * @import {WorkerEngine, WorkerIncarnation} from '../core/worker-engine.js'
 */

/**
 * Escape non-ASCII so every byte crossing the pipe is ASCII, where the
 * binary's C-string handling is exact.
 *
 * @param {unknown} value
 */
const asciiJson = value =>
  JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/**
 * A {@link WorkerEngine} backed by real XS heap snapshots: each
 * incarnation is a `thixotrope-xs-worker` process (rust/thixotrope-xs-worker)
 * running the worker peer inside an XS machine, speaking
 * newline-delimited JSON over fd 3/4. `snapshot()` streams the heap into
 * the content-addressed `casPath` and returns its sha256; `start` with a
 * snapshot ref restores the heap without re-evaluating anything.
 *
 * Build inputs: `cargo build --release -p thixotrope-xs-worker` (after
 * `yarn build:xs-bundles` in this package generates `dist-xs/`).
 *
 * @param {object} powers
 * @param {ProcessPowers} powers.processes
 * @param {FilePowers} powers.files
 * @param {PathPowers} powers.paths
 * @param {TimerPowers} powers.timers
 * @param {object} options
 * @param {string} options.workerBinary path to the thixotrope-xs-worker binary
 * @param {string} options.bootPath pre-bundle boot script (dist-xs/boot.js)
 * @param {string} options.bundlePath worker peer bundle (dist-xs/worker-peer.js)
 * @param {string} options.casPath directory for content-addressed snapshots
 * @returns {WorkerEngine}
 */
export const makeXsEngine = (
  { processes, files, paths, timers },
  { workerBinary, bootPath, bundlePath, casPath },
) => {
  const { spawn } = processes;
  const { join } = paths;
  const { setTimer, clearTimer, unrefTimer } = timers;
  return harden({
    canSnapshot: true,
    /** @type {WorkerEngine['start']} */
    start: async ({ debugName, snapshot, onOutbound }) => {
      await files.makeDirectory(casPath);
      const args = [
        '--boot',
        bootPath,
        '--bundle',
        bundlePath,
        '--cas',
        casPath,
      ];
      if (snapshot !== null && snapshot !== undefined) {
        typeof snapshot === 'string' ||
          Fail`XS engine snapshot ref must be a CAS hash string`;
        args.push('--restore', /** @type {string} */ (snapshot));
      }
      const child = spawn(workerBinary, args, {
        stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'],
      });
      const toChild = child.input(3);

      /** @type {Array<{ expect: string, resolve: (reply: any) => void, reject: (reason: Error) => void }>} */
      const pending = [];
      let exited = false;
      const failAll = reason => {
        while (pending.length > 0) {
          const waiter = pending.shift();
          waiter?.reject(reason);
        }
      };
      // A protocol violation must fail this incarnation's requests and
      // kill the child, never throw inside a stream event handler
      // (which would crash the whole host process).
      const failProtocol = reason => {
        failAll(reason);
        child.kill('SIGKILL');
      };
      void child.exited.then(code => {
        exited = true;
        failAll(
          Error(
            `thixotrope-xs-worker for ${debugName} exited (${code ?? 'signaled'})`,
          ),
        );
        return code;
      });
      void (async () => {
        await null;
        try {
          for await (const line of child.lines(4)) {
            if (line !== '') {
              /** @type {any} */
              let reply;
              try {
                reply = JSON.parse(line);
              } catch (_error) {
                failProtocol(Error(`garbled line from XS worker ${debugName}`));
                return;
              }
              if (reply.op === 'outbound') {
                onOutbound(reply.message);
              } else {
                const waiter = pending.shift();
                if (waiter === undefined) {
                  failProtocol(
                    Error(`unsolicited ${q(reply.op)} from XS worker`),
                  );
                  return;
                }
                if (reply.op === waiter.expect) {
                  waiter.resolve(reply);
                } else {
                  waiter.reject(
                    Error(
                      `XS worker replied ${reply.op}, expected ${waiter.expect}`,
                    ),
                  );
                }
              }
            }
          }
        } catch (error) {
          exited = true;
          failAll(
            Error(
              `thixotrope-xs-worker for ${debugName} failed to spawn: ${
                /** @type {Error} */ (error).message
              }`,
            ),
          );
        }
      })();

      /**
       * @param {Record<string, unknown> | undefined} payload
       * @param {string} expect
       * @returns {Promise<any>}
       */
      const request = (payload, expect) =>
        new Promise((resolve, reject) => {
          if (exited) {
            reject(Error(`thixotrope-xs-worker for ${debugName} has exited`));
            return;
          }
          pending.push({ expect, resolve, reject });
          if (payload !== undefined) {
            toChild?.write(`${asciiJson(payload)}\n`);
          }
        });

      await request(undefined, 'ready');

      /** @type {WorkerIncarnation} */
      const incarnation = {
        deliver: async message => {
          await request({ op: 'deliver', message }, 'ack');
        },
        snapshot: async () => {
          const reply = await request({ op: 'snapshot' }, 'snapshot-ok');
          return reply.ref;
        },
        terminate: async () => {
          if (exited) {
            return;
          }
          child.input(3)?.write('{"op":"exit"}\n');
          const killer = setTimer(() => child.kill('SIGKILL'), 2000);
          unrefTimer?.(killer);
          await child.exited;
          clearTimer(killer);
        },
      };
      return harden(incarnation);
    },
    releaseSnapshot: async ref => {
      typeof ref === 'string' || Fail`XS engine snapshot ref must be a string`;
      const hash = /** @type {string} */ (ref);
      /^[0-9a-f]{64}$/.test(hash) ||
        Fail`XS engine snapshot ref must be a sha256 hex digest`;
      await files.remove(join(casPath, hash), { force: true });
    },
  });
};
harden(makeXsEngine);
