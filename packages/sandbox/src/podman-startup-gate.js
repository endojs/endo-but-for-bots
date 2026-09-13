// @ts-check

import { Fail, makeError, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';
import { clearTimeout, setTimeout } from 'node:timers';

/** @import { ChildProcess } from 'node:child_process' */

const readyText = 'endo-sandbox-ready-v1\n';
const releaseText = 'endo-sandbox-go-v1\n';
const readyBytes = new TextEncoder().encode(readyText);
const gateScript = `printf '%s\\n' endo-sandbox-ready-v1
IFS= read -r endo_release || exit 125
[ "$endo_release" = endo-sandbox-go-v1 ] || exit 125
exec /usr/bin/env -i -- "$@"`;

/**
 * Run the trusted image's shell with an empty startup environment. Guest
 * environment is applied only after release, so loader hooks cannot run ahead
 * of verification. The second shell preserves command/argument boundaries,
 * including a command containing '=' which env would otherwise parse as an
 * assignment. Both shell programs are fixed; data is passed positionally.
 * The driver must protect these trusted image paths from writable mounts.
 * @param {readonly string[]} argv
 * @param {Readonly<Record<string, string>>} env
 */
export const makePodmanStartupCommand = (argv, env) => {
  argv.length > 0 || Fail`A native operation requires a command`;
  !argv[0]?.startsWith('-') ||
    Fail`Use an explicit path for a command beginning with '-'`;
  const assignments = Object.entries(env).map(([key, value]) => {
    (key !== '' &&
      !key.includes('=') &&
      !key.includes('\0') &&
      !value.includes('\0')) ||
      Fail`Invalid guest environment entry`;
    return `${key}=${value}`;
  });
  return harden({
    createArgs: ['--unsetenv-all', '--entrypoint=/bin/sh'],
    argv: [
      '-c',
      gateScript,
      'endo-startup-gate',
      ...assignments,
      '/bin/sh',
      '-c',
      'exec "$@"',
      'endo-workload',
      ...argv,
    ],
  });
};
harden(makePodmanStartupCommand);

/**
 * Consume only the fixed startup marker, then pause stdout until its public
 * consumer attaches. The first application stdin bytes follow the release
 * line and are never read by this host helper. This owns protocol observation,
 * not the process: every failure still requires the driver's original cleanup.
 * Attach this immediately after spawn, before exposing stdin/stdout. Await ready,
 * verify the native boundary, then await release before sending application
 * stdin. The caller must attach/resume its stdout consumer after readiness.
 * Execution becomes possible when the release write is issued. A later
 * release rejection is not proof of nonexecution; the caller retains process
 * termination and complete stdio drainage until native close.
 * @param {ChildProcess} child
 * @param {{timeoutMs: number}} options Existing driver control-command deadline.
 */
export const makePodmanStartupGate = (child, { timeoutMs }) => {
  const { stdin, stdout } = child;
  if (!stdin || !stdout) throw Fail`Native startup requires attached stdio`;
  const ready = makePromiseKit();
  void ready.promise.catch(() => {});
  let offset = 0;
  let isReady = false;
  let released = false;
  let hasFailed = false;
  /** @type {unknown} */
  let failure;
  /** @type {ReturnType<typeof makePromiseKit<void>> | undefined} */
  let releaseKit;
  const stopProtocol = () => {
    stdout.off('end', closed);
    stdout.off('data', data);
    clearTimeout(timer);
  };
  /** @param {unknown} error */
  const failed = error => {
    if (released || hasFailed) return;
    hasFailed = true;
    failure = error;
    stopProtocol();
    // Cleanup must not wait for an unread pipe after a refused startup.
    stdout.resume();
    ready.reject(error);
    releaseKit?.reject(error);
  };
  const closed = () => failed(makeError(X`Native startup gate closed`));
  const childClosed = () => {
    closed();
    // Child close follows closure of its stdio. Until then, even a failed gate
    // must observe error events while its caller performs native cleanup.
    child.off('error', failed);
    stdin.off('error', failed);
    stdout.off('error', failed);
  };
  /** @param {Uint8Array} chunk */
  const data = chunk => {
    for (const byte of chunk) {
      if (offset === readyBytes.length || byte !== readyBytes[offset]) {
        failed(makeError(X`Unexpected native startup output`));
        return;
      }
      offset += 1;
    }
    if (offset === readyBytes.length) {
      stdout.pause();
      stdout.off('data', data);
      clearTimeout(timer);
      isReady = true;
      ready.resolve(undefined);
    }
  };
  const timer = setTimeout(
    () => failed(makeError(X`Native startup gate timed out`)),
    timeoutMs,
  );
  child.on('error', failed);
  child.once('close', childClosed);
  stdin.on('error', failed);
  stdout.on('error', failed);
  stdout.once('end', closed);
  stdout.on('data', data);
  const release = () => {
    if (releaseKit) return releaseKit.promise;
    const kit = makePromiseKit();
    releaseKit = kit;
    void kit.promise.catch(() => {});
    const write = () => {
      if (hasFailed) {
        kit.reject(failure);
        return;
      }
      try {
        stdin.write(releaseText, error => {
          if (error) {
            failed(error);
          } else if (!hasFailed) {
            released = true;
            stopProtocol();
            kit.resolve(undefined);
          }
        });
      } catch (error) {
        failed(error);
      }
    };
    // Once ready, issue the write in the caller's own synchronous stretch. A
    // driver checks its admission state and then releases; deferring the
    // write to a microtask would leave a gap in which cancellation could be
    // requested after the check yet before execution became possible.
    if (isReady) {
      write();
    } else {
      void ready.promise.then(write, kit.reject);
    }
    return kit.promise;
  };
  return harden({ ready: ready.promise, release, cancel: failed });
};
harden(makePodmanStartupGate);
