// @ts-check
/// <reference types="ses"/>
/* global setTimeout, clearTimeout */

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { ShellInterface } from './interfaces.js';
import {
  formatShellCommandUsage,
  matchShellCommand,
  normalizeShellCommandGrammars,
} from './command-grammar.js';

/**
 * @import { EndoShell, ShellCommandGrammar, ShellPolicy, Spawner } from './types.js'
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
 * is flagged `truncated`.  A stream that throws mid-read — the usual shape when
 * the process is killed — resolves with whatever was accumulated.
 *
 * @param {AsyncIterable<Uint8Array> | null | undefined} stream
 * @param {number} maxBytes
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
const drainBounded = async (stream, maxBytes) => {
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
  } catch {
    // The process was likely killed mid-stream; return the partial capture.
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
 * Build one `Shell` facet: the root facet runs matched argvs through the
 * spawner; an attenuated facet (from `attenuate`) runs them through its
 * parent's `exec`, so every ancestor's grammar check is enforced in turn —
 * a derived shell can only narrow (design § Command grammars, Attenuation).
 *
 * @param {object} state
 * @param {readonly ShellCommandGrammar[]} state.commands
 * @param {number} state.timeoutMs
 * @param {number} state.maxOutputBytes
 * @param {(command: string, args: readonly string[], timeoutMs: number) =>
 *   Promise<import('./types.js').ShellResult>} state.run
 * @returns {EndoShell}
 */
const makeShellFacet = ({ commands, timeoutMs, maxOutputBytes, run }) => {
  const usage = harden(commands.map(formatShellCommandUsage));

  const exo = makeExo('Shell', ShellInterface, {
    /**
     * Reveal only the grant surface the design's inspect shape names — the
     * command grammars with their rendered usage lines, the timeout, and the
     * output cap; never `cwd`, `env`, or the baked `searchPath`.
     */
    async inspect() {
      return harden({ commands, usage, timeoutMs, maxOutputBytes });
    },

    /**
     * @param {string} command
     * @param {readonly string[]} args
     * @param {{ timeoutMs?: number }} [options]
     */
    async exec(command, args, options = {}) {
      if (
        !commands.some(grammar => matchShellCommand(grammar, command, args))
      ) {
        throw makeError(
          X`Shell.exec: argv ${q([command, ...args])} matches no granted command grammar; usage: ${q(usage)}`,
        );
      }
      // A per-call timeout may only narrow this facet's value, never widen it.
      const requested = options.timeoutMs;
      const effectiveTimeoutMs =
        requested !== undefined && requested > 0
          ? Math.min(timeoutMs, requested)
          : timeoutMs;
      return run(command, args, effectiveTimeoutMs);
    },

    /**
     * Derive a narrower `Shell`: the derived facet accepts only argvs its own
     * grammars match, then delegates to this facet's `exec`, which re-checks
     * against this facet's grammars (and so on up the chain).  Intersection
     * by conjunction — no grammar-inclusion proof is needed, and a grammar
     * outside every ancestor's language yields a shell that accepts nothing.
     * Self-attenuation is narrowing by construction, so exposing this to a
     * guest is safe.
     *
     * The guard admits the grammar pattern; `normalizeShellCommandGrammars`
     * re-validates in depth, so the declared parameter stays `unknown` rather
     * than fighting the guard's structurally inferred copy-record types.
     *
     * @param {unknown} newCommands
     * @param {{ timeoutMs?: number }} [options]
     */
    async attenuate(newCommands, options = {}) {
      const normalized = normalizeShellCommandGrammars(newCommands);
      const requested = options.timeoutMs;
      let narrowedTimeoutMs = timeoutMs;
      if (requested !== undefined) {
        if (!Number.isInteger(requested) || requested <= 0) {
          throw makeError(
            X`Shell.attenuate: timeoutMs must be a positive integer`,
          );
        }
        narrowedTimeoutMs = Math.min(timeoutMs, requested);
      }
      return makeShellFacet({
        commands: normalized,
        timeoutMs: narrowedTimeoutMs,
        maxOutputBytes,
        run: (command, args, effectiveTimeoutMs) =>
          exo.exec(command, args, { timeoutMs: effectiveTimeoutMs }),
      });
    },
  });

  return /** @type {EndoShell} */ (exo);
};

/**
 * Build the portable `Shell` exo over a working directory, a formula-owned
 * policy, and an injected `Spawner` engine (host or sandbox — chosen host-side
 * and invisible on this surface).  The exo enforces the guest-facing bounds:
 * grammar-match-before-spawn (the policy's passable command grammars are the
 * accepted argument language — design § Command grammars), argv-only (no
 * shell string), the policy's sanitized env (carried by the spawner's
 * defaults plus `policy.env`), a per-stream output cap, and a timeout that
 * narrows-only per call.  `cwd` and the env passlist are host-private and
 * never surface through `inspect()`.
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
  const { timeoutMs: policyTimeoutMs, maxOutputBytes, env = {} } = policy;
  // Validated, frozen deep copies, so a later mutation of the caller's
  // structures cannot widen the accepted language or alter the child env
  // after construction.
  const commands = normalizeShellCommandGrammars(
    policy.commands,
    'policy.commands',
  );
  if (!Number.isInteger(policyTimeoutMs) || policyTimeoutMs <= 0) {
    throw makeError(X`makeShell: policy.timeoutMs must be a positive integer`);
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw makeError(
      X`makeShell: policy.maxOutputBytes must be a positive integer`,
    );
  }
  if (!Number.isInteger(killGraceMs) || killGraceMs <= 0) {
    throw makeError(X`makeShell: killGraceMs must be a positive integer`);
  }
  const childEnv = harden({ ...env });

  /**
   * @param {string} command
   * @param {readonly string[]} args
   * @param {number} effectiveTimeoutMs
   */
  const run = async (command, args, effectiveTimeoutMs) => {
    // Argv only — the program name is argv[0], never a shell string, and
    // `shell: false` forbids the spawner from wrapping it in `/bin/sh -c`.
    const argv = harden([command, ...args]);
    const proc = await spawner(argv, {
      cwd,
      env: childEnv,
      shell: false,
    });

    let timedOut = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let killTimer;
    // On expiry, ask the child to terminate with `SIGTERM`; a child can trap
    // or ignore it (and a forked descendant can hold the stdio pipes open),
    // which would leave `proc.wait()` and the output drains pending forever —
    // the timeout would not be a bound at all.  So after a grace window we
    // escalate to the uncatchable `SIGKILL`.  The daemon spawner kills the
    // whole process group, so a stubborn child and its descendants are reaped,
    // their pipes reach EOF, and `exec` settles: the timeout is enforceable,
    // not merely advisory.
    const timer = setTimeout(() => {
      timedOut = true;
      void proc.kill('SIGTERM');
      killTimer = setTimeout(() => {
        void proc.kill('SIGKILL');
      }, killGraceMs);
    }, effectiveTimeoutMs);

    /** @type {{ text: string, truncated: boolean }} */
    let outRes;
    /** @type {{ text: string, truncated: boolean }} */
    let errRes;
    /** @type {{ code: number | null, signal: string | null }} */
    let status;
    try {
      [outRes, errRes, status] = await Promise.all([
        drainBounded(proc.stdout, maxOutputBytes),
        drainBounded(proc.stderr, maxOutputBytes),
        proc.wait(),
      ]);
    } finally {
      clearTimeout(timer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
    }

    const { code } = status;
    let { signal } = status;
    // A timeout kill may race the natural exit; surface the kill signal when
    // the runtime reported neither a code nor a signal.
    if (timedOut && code === null && signal === null) {
      signal = 'SIGTERM';
    }

    return harden({
      stdout: outRes.text,
      stderr: errRes.text,
      exitCode: code,
      signal,
      truncated: outRes.truncated || errRes.truncated,
    });
  };

  return makeShellFacet({
    commands,
    timeoutMs: policyTimeoutMs,
    maxOutputBytes,
    run,
  });
};
harden(makeShell);
