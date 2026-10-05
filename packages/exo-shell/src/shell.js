// @ts-check
/// <reference types="ses"/>
/* global setTimeout, clearTimeout */

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { ShellInterface } from './interfaces.js';

/**
 * @import { EndoShell, ShellPolicy, Spawner } from './types.js'
 */

/**
 * Default grace period, in milliseconds, between the timeout's polite
 * `SIGTERM` and the uncatchable `SIGKILL`.  A cooperative child gets this long
 * to flush and exit on its own; an uncooperative one (a child that traps or
 * ignores `SIGTERM`) is force-killed so `exec` cannot hang past its bound.
 */
const DEFAULT_KILL_GRACE_MS = 2000;

/**
 * Drain an async-iterable byte stream into a UTF-8 string, bounded to
 * `maxBytes`.  Once the cap is reached the remaining chunks are still read to
 * EOF (so the child never blocks on a full pipe) but discarded, and the result
 * is flagged `truncated`. Stream failure initiates termination and is reported
 * by exec, never converted into a successful partial result.
 *
 * @param {AsyncIterable<Uint8Array> | null | undefined} stream
 * @param {number} maxBytes
 * @param {(error: unknown) => void} onFailure
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
const drainBounded = async (stream, maxBytes, onFailure) => {
  if (stream === null || stream === undefined) {
    return { text: '', truncated: false };
  }
  /** @type {Uint8Array[]} */
  const kept = [];
  let total = 0;
  let truncated = false;
  await null;
  try {
    for await (const chunk of stream) {
      const bytes =
        chunk instanceof Uint8Array
          ? chunk
          : new TextEncoder().encode(String(chunk));
      if (truncated) {
        // Keep draining to EOF but discard — bounds memory, not the pipe.
        continue; // eslint-disable-line no-continue
      }
      if (total + bytes.length <= maxBytes) {
        kept.push(bytes);
        total += bytes.length;
      } else {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          kept.push(bytes.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
      }
    }
  } catch (error) {
    onFailure(error);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of kept) {
    buf.set(c, offset);
    offset += c.length;
  }
  return { text: new TextDecoder().decode(buf), truncated };
};

/**
 * Build the portable `Shell` exo over a working directory, a formula-owned
 * policy, and an injected `Spawner` engine (host or sandbox — chosen host-side
 * and invisible on this surface).  The exo enforces the guest-facing bounds:
 * allowlist-before-spawn, argv-only (no shell string), the policy's sanitized
 * env (carried by the spawner's defaults plus `policy.env`), a per-stream
 * output cap, and a default timeout that a holder can override per call. `cwd` and the env
 * passlist are host-private and never surface through `inspect()`.
 *
 * A read-only mount cannot bound a child process's OS-level write authority, so
 * a "read-only shell" would misrepresent the authority actually granted; the
 * maker refuses one outright (design § Shell capability: the shell's authority
 * is the working tree's write authority, which a read-only mount cannot back).
 *
 * @param {object} powers
 * @param {string} powers.cwd  Host working directory for spawned children.
 * @param {ShellPolicy & { env?: Record<string, string> }} powers.policy
 * @param {Spawner} powers.spawner
 * @param {boolean} [powers.readOnly]
 * @param {number} [powers.killGraceMs]  Host-private grace between the timeout's
 *   `SIGTERM` and the escalated `SIGKILL`; never revealed by `inspect()`.
 * @returns {EndoShell}
 */
export const makeShell = ({
  cwd,
  policy,
  spawner,
  readOnly = false,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
}) => {
  if (readOnly) {
    throw makeError(
      X`Shell cannot be constructed over a read-only mount: a child process holds OS-level write authority a read-only mount cannot bound`,
    );
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw makeError(X`makeShell: cwd must be a non-empty host path string`);
  }
  const {
    allowedCommands,
    timeoutMs: defaultTimeoutMs,
    maxOutputBytes,
    env = {},
  } = policy;
  if (
    !Array.isArray(allowedCommands) ||
    allowedCommands.length === 0 ||
    !allowedCommands.every(c => typeof c === 'string' && c.length > 0)
  ) {
    throw makeError(
      X`makeShell: policy.allowedCommands must be a non-empty array of command-name strings`,
    );
  }
  if (
    !Number.isInteger(defaultTimeoutMs) ||
    defaultTimeoutMs <= 0 ||
    defaultTimeoutMs > 0x7fff_ffff
  ) {
    throw makeError(X`makeShell: policy.timeoutMs must be a positive integer`);
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw makeError(
      X`makeShell: policy.maxOutputBytes must be a positive integer`,
    );
  }
  if (
    !Number.isInteger(killGraceMs) ||
    killGraceMs <= 0 ||
    killGraceMs > 0x7fff_ffff
  ) {
    throw makeError(X`makeShell: killGraceMs must be a positive integer`);
  }

  const allowed = new Set(allowedCommands);
  // Frozen copies, so a later mutation of the caller's arrays cannot widen
  // the allowlist or alter the child env after construction.
  const allowedList = harden([...allowedCommands]);
  const childEnv = harden({ ...env });

  const exo = makeExo('Shell', ShellInterface, {
    /**
     * Reveal only the policy the design's `ShellPolicy` names — never `cwd`,
     * `env`, or the baked `searchPath`, all of which carry host paths.
     */
    async inspect() {
      return harden({
        allowedCommands: allowedList,
        timeoutMs: defaultTimeoutMs,
        maxOutputBytes,
      });
    },

    /**
     * @param {string} command
     * @param {readonly string[]} args
     * @param {{ timeoutMs?: number }} [options]
     */
    async exec(command, args, options = {}) {
      if (!allowed.has(command)) {
        throw makeError(
          X`Shell.exec: command ${q(command)} is not in the allowlist`,
        );
      }
      // The policy supplies the default, not a ceiling on a holder's request.
      const requested = options.timeoutMs;
      if (
        requested !== undefined &&
        (!Number.isInteger(requested) ||
          requested <= 0 ||
          requested > 0x7fff_ffff)
      ) {
        throw makeError(
          X`Shell.exec: timeoutMs must be a positive timer-range integer`,
        );
      }
      const effectiveTimeoutMs = requested ?? defaultTimeoutMs;

      // Argv only — the program name is argv[0], never a shell string, and
      // `shell: false` forbids the spawner from wrapping it in `/bin/sh -c`.
      const argv = harden([command, ...args]);
      // Start the budget before admission. A late process stays observed and
      // receives any queued termination even after the caller has timed out.
      const procPromise = Promise.resolve().then(() =>
        spawner(argv, {
          cwd,
          env: childEnv,
          shell: false,
          timeoutMs: effectiveTimeoutMs,
        }),
      );
      /** @type {Error | undefined} */
      let failure;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let killTimer;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let abandonTimer;
      /** @type {(reason: unknown) => void} */
      let abandon = () => {};
      /** @type {Promise<never>} */
      const abandoned = new Promise((_, reject) => {
        abandon = reject;
      });
      void abandoned.catch(() => {});
      /** @type {Promise<void>[]} */
      const signals = [];
      /** @param {string} signal */
      const terminate = signal => {
        signals.push(
          procPromise.then(
            proc =>
              Promise.resolve()
                .then(() => proc.kill(signal))
                .catch(error => {
                  failure = makeError(
                    X`Shell cleanup failed: ${q(error)}`,
                    undefined,
                    { cause: failure },
                  );
                }),
            () => {},
          ),
        );
      };
      /** @param {unknown} error */
      const stop = error => {
        if (killTimer !== undefined) return;
        failure = error instanceof Error ? error : makeError(X`${q(error)}`);
        terminate('SIGTERM');
        killTimer = setTimeout(() => {
          terminate('SIGKILL');
          abandonTimer = setTimeout(() => {
            abandon(
              failure ?? makeError(X`Shell process failed without an error`),
            );
          }, killGraceMs);
        }, killGraceMs);
      };
      const timer = setTimeout(() => {
        stop(
          makeError(X`Shell command timed out after ${effectiveTimeoutMs}ms`),
        );
      }, effectiveTimeoutMs);
      try {
        const proc = await Promise.race([procPromise, abandoned]);
        const [outRes, errRes, status] = await Promise.race([
          Promise.all([
            drainBounded(proc.stdout, maxOutputBytes, stop),
            drainBounded(proc.stderr, maxOutputBytes, stop),
            proc.wait().catch(error => {
              stop(error);
              return undefined;
            }),
          ]),
          abandoned,
        ]);
        if (killTimer !== undefined) {
          // A rejected wait does not prove exit, even if both readers closed.
          if (status === undefined) terminate('SIGKILL');
          await Promise.race([Promise.all(signals), abandoned]);
          throw failure ?? makeError(X`Shell process failed without an error`);
        }
        if (status === undefined)
          throw makeError(X`Shell process outcome is unknown`);
        return harden({
          stdout: outRes.text,
          stderr: errRes.text,
          exitCode: status.code,
          signal: status.signal,
          truncated: outRes.truncated || errRes.truncated,
        });
      } finally {
        clearTimeout(timer);
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        if (abandonTimer !== undefined) clearTimeout(abandonTimer);
      }
    },
  });

  return /** @type {EndoShell} */ (exo);
};
harden(makeShell);
