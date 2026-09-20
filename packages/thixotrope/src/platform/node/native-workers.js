// @ts-check
import { decodeBase64, encodeBase64 } from '@endo/base64';
import harden from '@endo/harden';
import { fork } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';

/**
 * @typedef {object} NativeWorker
 * @property {(bytes: Uint8Array) => void} send
 * @property {() => Promise<void>} terminate
 * @property {Promise<void>} closed
 *
 * @typedef {object} NativeWorkerPowers
 * @property {(options: {id: string, moduleUrl: string, onFrame: (bytes: Uint8Array) => void, onExit: () => void}) => Promise<NativeWorker>} start
 */

/** @returns {NativeWorkerPowers} */
export const makeNativeWorkerPowers = () =>
  harden({
    start: ({ id, moduleUrl, onFrame, onExit }) =>
      new Promise((resolve, reject) => {
        const child = fork(
          new URL('./native-worker-entry.js', import.meta.url),
          [id, moduleUrl],
          {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            execArgv: [],
          },
        );
        let exited = false;
        /** @type {unknown} */
        let failure;
        /** @type {() => void} */
        let resolveClosed;
        const closed = new Promise(resolveDone => {
          resolveClosed = () => resolveDone(undefined);
        });
        const finish = () => {
          if (exited) return;
          exited = true;
          clearTimeout(timeout);
          try {
            onExit();
          } catch (error) {
            failure ??= error;
          }
          resolveClosed();
          reject(
            failure ?? Error('Native resource process exited before readiness'),
          );
        };
        /** @param {unknown} error */
        const fail = error => {
          failure ??= error;
          child.kill('SIGKILL');
        };
        const timeout = setTimeout(
          () => fail(Error('Native resource startup timed out')),
          30_000,
        );
        child.once('exit', finish);
        child.once('error', error => {
          fail(error);
          // Failed spawn has no process whose exit we could await.
          if (child.pid === undefined) finish();
        });
        const terminate = async () => {
          if (!exited) child.kill('SIGKILL');
          await closed;
          if (failure !== undefined) throw failure;
        };
        child.once('disconnect', () => {
          if (!exited) child.kill('SIGKILL');
        });
        child.on('message', message => {
          if (exited || failure !== undefined) return;
          const data = /** @type {{ready?: boolean, frame?: string}} */ (
            message
          );
          try {
            if (data.frame !== undefined) onFrame(decodeBase64(data.frame));
          } catch (error) {
            fail(error);
            return;
          }
          if (data.ready) {
            clearTimeout(timeout);
            resolve(
              harden({
                closed,
                terminate,
                send: bytes => {
                  if (!child.connected)
                    throw Error('Native resource process is closed');
                  child.send({ frame: encodeBase64(bytes) }, error => {
                    if (error) fail(error);
                  });
                },
              }),
            );
          }
        });
      }),
  });
harden(makeNativeWorkerPowers);
