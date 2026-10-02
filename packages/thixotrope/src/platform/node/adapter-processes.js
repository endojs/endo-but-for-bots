// @ts-check
/** @import { AdapterProcessPowers } from '../adapter-processes.js' */
/** @import { TimerPowers } from '../timers.js' */
import { decodeBase64, encodeBase64 } from '@endo/base64';
import harden from '@endo/harden';
import { fork } from 'node:child_process';

/**
 * Native resource processes forked from this Node host. A child shares
 * only this process's stderr; its stdout is discarded, so a native module
 * that wants to be heard writes diagnostics to stderr, and nothing it
 * prints can land in the daemon's own output.
 *
 * @param {object} host
 * @param {TimerPowers} host.timers
 * @param {number} [host.startupTimeoutMs] how long a child may take to
 *   report readiness before it is killed and `start` rejects
 * @returns {AdapterProcessPowers}
 */
export const makeAdapterProcessPowers = ({
  timers,
  startupTimeoutMs = 30_000,
}) =>
  harden({
    start: ({ id, bundlePath, bundleDigest, onFrame, onExit }) =>
      new Promise((resolve, reject) => {
        /** @type {ReturnType<typeof fork>} */
        let child;
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
          timers.clearTimer(timeout);
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
        // Armed before the fork: a delay the timer refuses must not leave a
        // child running that nothing will ever kill.
        const timeout = timers.setTimer(
          () => fail(Error('Native resource startup timed out')),
          startupTimeoutMs,
        );
        try {
          child = fork(
            new URL('./adapter-process-entry.js', import.meta.url),
            [id, bundlePath, bundleDigest],
            {
              stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
              execArgv: [],
            },
          );
        } catch (error) {
          timers.clearTimer(timeout);
          reject(error);
          return;
        }
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
            timers.clearTimer(timeout);
            resolve(
              harden({
                closed,
                terminate,
                send: bytes => {
                  if (!child.connected)
                    throw Error('Native resource process is closed');
                  child.send({ frame: encodeBase64(bytes) }, error => {
                    if (!error) return;
                    // A process that went away between the check above and
                    // the write cannot be written to: that is its exit,
                    // which 'exit' reports, not a failure of its own for
                    // `terminate` to rethrow. A drop sent by collection
                    // while the process ends meets exactly this.
                    const { code } = /** @type {NodeJS.ErrnoException} */ (
                      error
                    );
                    if (
                      code === 'EPIPE' ||
                      code === 'ECONNRESET' ||
                      code === 'ERR_IPC_CHANNEL_CLOSED'
                    ) {
                      if (!exited) child.kill('SIGKILL');
                      return;
                    }
                    fail(error);
                  });
                },
              }),
            );
          }
        });
      }),
  });
harden(makeAdapterProcessPowers);
