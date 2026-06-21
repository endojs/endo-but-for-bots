// @ts-check
/* eslint-disable no-await-in-loop */

/**
 * `ClaudeClient` — a single Claude Code session running inside an
 * `@endo/sandbox` slice (rootless podman, by default).
 *
 * Turn model: each `send(prompt)` runs one
 * `claude -p <prompt> --output-format stream-json` process inside the
 * slice. Turns **queue** on an internal chain so two processes never
 * race the same workspace conversation; `--continue` on every turn
 * after the first resumes the conversation persisted in the workspace,
 * letting a sequence of `send()` calls build on each other (no
 * long-lived stdin plumbing).
 *
 * `send()` returns a **buffered reply reader** immediately (consume it
 * with `makeRefIterator`): it yields the parsed stream-json events, then
 * a terminal `{ type: 'end' }` on clean completion or
 * `{ type: 'abort', reason }` on a spawn/stream error. **Closing the
 * reader aborts the turn** — it kills the in-flight `claude` process (or
 * makes a still-queued turn bail). This mirrors the floot session's
 * reply channel; `interrupt()` is the same thing applied to the current
 * turn. See `DESIGN.md` § "Turn model".
 *
 * The slice and 9P mount are provisioned lazily (see the `provision`
 * thunk and `claude-client-module.js`), so the exo can be a pure-`env`
 * formula that reincarnates across daemon restarts. `terminate()`
 * disposes the slice, unmounts the workspace, and revokes the
 * credential grant.
 *
 * @module
 */

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

import { makeBufferedReader } from './buffered-channel.js';

/** @import { SandboxHandle, ProcessHandle } from '@endo/sandbox/types.js' */

const ClaudeClientInterface = M.interface('ClaudeClient', {
  send: M.call(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
  terminate: M.call().returns(M.promise()),
  status: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * Parse a stream of UTF-8 byte chunks as newline-delimited JSON,
 * yielding one parsed object per non-empty line. This is the
 * `claude -p --output-format stream-json` wire shape.
 *
 * Exported for unit testing — it is the pure core of `send()`'s
 * stdout handling, independent of the slice / CapTP plumbing.
 *
 * @param {AsyncIterable<Uint8Array>} bytesIterable
 * @returns {AsyncGenerator<any, void, void>}
 */
export async function* parseStreamJsonLines(bytesIterable) {
  const decoder = new TextDecoder();
  let buf = '';

  /** @param {string} line */
  const parseLine = line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw makeError(
        X`ClaudeClient: malformed stream-json line ${q(line.slice(0, 120))}: ${q(
          /** @type {Error} */ (e).message,
        )}`,
      );
    }
  };

  for await (const chunk of bytesIterable) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) {
        yield parseLine(line);
      }
      nl = buf.indexOf('\n');
    }
  }
  // Flush any trailing partial multi-byte sequence and final line
  // that didn't end in a newline.
  buf += decoder.decode();
  const last = buf.trim();
  if (last.length > 0) {
    yield parseLine(last);
  }
}
harden(parseStreamJsonLines);

/**
 * Default adapter from a slice `ProcessHandle` to an
 * `AsyncIterable<Uint8Array>` over its stdout, driving the
 * `@endo/exo-stream` base64 wire protocol.
 *
 * @param {ProcessHandle} proc
 * @returns {AsyncIterable<Uint8Array>}
 */
const defaultStdoutIterable = proc =>
  harden({
    async *[Symbol.asyncIterator]() {
      const stdoutRef = await E(proc).stdout();
      yield* iterateBytesReader(/** @type {any} */ (stdoutRef));
    },
  });

/**
 * @typedef {object} ClaudeClientArgs
 * @property {string} sessionId
 * @property {string} createdAt - ISO timestamp.
 * @property {SandboxHandle} [slice] - Live sandbox slice handle. `spawn`
 *   runs `claude` inside it; `dispose` tears it down on terminate.
 *   Provide this (with `mountHandle`) for an eagerly-provisioned client;
 *   omit both and pass `provision` for a lazily-provisioned one.
 * @property {{ unmount: () => Promise<void> }} [mountHandle] - Host-side
 *   9P mount handle for the workspace. Unmounted on `terminate()`.
 *   Omitted when the workspace was bound by some other means (tests).
 * @property {() => Promise<{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> }, revoke?: () => Promise<void> }>} [provision]
 *   - Lazy workspace provisioner. When present, `slice` / `mountHandle`
 *   are ignored and the slice + mount are created on first use (the
 *   first `send()` or `initialPrompt`), memoized thereafter. This is
 *   what lets the client be a pure-`env` formula: it constructs
 *   instantly and re-mounts / re-mints its container on demand, so
 *   daemon boot is never blocked on a container start. May also return a
 *   `revoke` thunk, called on `terminate()` to release the credential
 *   grant it issued.
 * @property {string} workspaceMountPoint - Host path the workspace 9P
 *   mount lives at (diagnostic; surfaced in `status()`).
 * @property {string} [workspacePath] - Slice-internal workspace path
 *   used as the spawn cwd. Defaults to `/workspace`.
 * @property {string} backend - Resolved sandbox backend name
 *   (diagnostic).
 * @property {string} [rootfsLabel] - Human-readable rootfs label
 *   (diagnostic).
 * @property {string} [model] - Default `--model` for every send.
 * @property {Record<string, string>} [env] - Extra per-spawn env
 *   merged on top of the slice's env. The slice's env already carries
 *   the credential, so this is normally empty.
 * @property {string} [initialPrompt] - Optional one-shot prompt fired
 *   (and drained) at construction.
 * @property {(proc: ProcessHandle) => AsyncIterable<Uint8Array>} [makeStdoutIterable]
 *   - Adapter from a `ProcessHandle` to its stdout byte stream.
 *   Injectable for tests; defaults to the `@endo/exo-stream` reader.
 */

/**
 * Build a `ClaudeClient` exo.
 *
 * @param {ClaudeClientArgs} args
 */
export const makeClaudeClient = ({
  sessionId,
  createdAt,
  slice,
  mountHandle,
  provision,
  workspaceMountPoint,
  workspacePath = '/workspace',
  backend,
  rootfsLabel = '',
  model,
  env = {},
  initialPrompt,
  makeStdoutIterable = defaultStdoutIterable,
}) => {
  let terminated = false;
  // `--continue` resumes the most recent conversation; the first turn
  // has nothing to resume, so it is omitted until one prompt has been
  // dispatched.
  let conversationStarted = false;
  /** @type {ProcessHandle | null} */
  let inFlight = null;
  // The reply reader of the most recent turn. `interrupt()` closes it —
  // the floot model where closing the reader *is* the interrupt.
  /** @type {{ return: () => Promise<any> } | null} */
  let currentReader = null;
  // Serialize turns so two `claude -p` processes never race the same
  // workspace conversation: each `send()` queues behind the previous turn.
  /** @type {Promise<void>} */
  let turnChain = Promise.resolve();

  // Workspace provisioning. Direct `slice` / `mountHandle` are treated
  // as already provisioned (eager); a `provision` thunk is run once on
  // first use (lazy) and memoized. `provisioned` stays `undefined`
  // until a lazy provision starts, so `terminate()` before any use is
  // a no-op rather than spinning up a container just to tear it down.
  /** @type {Promise<{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> }, revoke?: () => Promise<void> }> | undefined} */
  let provisioned = provision
    ? undefined
    : Promise.resolve(
        harden(
          /** @type {{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> } }} */ ({
            slice,
            mountHandle,
          }),
        ),
      );
  const ensureProvisioned = () => {
    if (provisioned === undefined) {
      const pending = Promise.resolve(
        /** @type {NonNullable<typeof provision>} */ (provision)(),
      );
      provisioned = pending;
      // A transient provisioning failure (image pull, 9P mount EPERM,
      // slice mint) must not permanently brick the session: drop the
      // memoized rejection so a later turn can retry. `provision()`
      // re-issues the credential on retry, and its own catch already
      // unmounts/revokes the failed attempt.
      pending.catch(() => {
        if (provisioned === pending) {
          provisioned = undefined;
        }
      });
    }
    return provisioned;
  };

  const guardLive = () => {
    if (terminated) {
      throw makeError(X`ClaudeClient(${q(sessionId)}) is terminated.`);
    }
  };

  /**
   * Spawn one `claude -p` process inside the slice and return its
   * `ProcessHandle`.
   *
   * @param {string} prompt
   * @param {{ model?: string }} [opts]
   * @returns {Promise<ProcessHandle>}
   */
  const spawnClaude = async (prompt, opts = {}) => {
    const { slice: activeSlice } = await ensureProvisioned();
    const argv = [
      'claude',
      '-p',
      String(prompt),
      '--output-format',
      'stream-json',
      // `stream-json` print mode requires --verbose to emit the full
      // per-event stream rather than only the final result.
      '--verbose',
    ];
    const useModel = opts.model || model;
    if (useModel) {
      argv.push('--model', useModel);
    }
    if (conversationStarted) {
      argv.push('--continue');
    }
    const proc = await E(activeSlice).spawn(
      harden(argv),
      harden({
        cwd: workspacePath,
        env: { ...env },
        captureStdout: true,
        captureStderr: true,
      }),
    );
    conversationStarted = true;
    return proc;
  };

  /**
   * Run one turn: queue behind any in-flight turn (`turnChain`), spawn
   * `claude -p`, stream its parsed stream-json stdout into a buffered
   * reply reader, and return that reader immediately. The reader yields
   * the raw stream-json events, then a terminal `{ type: 'end' }` on
   * clean completion or `{ type: 'abort', reason }` on a spawn/stream
   * error.
   *
   * Closing the reader (consumer stop) kills the in-flight process — the
   * floot `onClose → abort`, here `onClose → kill`. A turn that is still
   * queued when closed bails before it spawns.
   *
   * @param {string} prompt
   * @param {{ model?: string }} [opts]
   * @returns {object} reply reader
   */
  const runTurn = (prompt, opts = {}) => {
    /** @type {ProcessHandle | null} */
    let proc = null;
    let closed = false;
    const { push, reader, setOnClose } =
      makeBufferedReader('ClaudeReplyReader');
    setOnClose(() => {
      closed = true;
      if (proc) {
        E(proc)
          .kill()
          .catch(() => {});
      }
    });
    currentReader = reader;

    const turn = turnChain.then(async () => {
      if (closed || terminated) return;
      try {
        proc = await spawnClaude(prompt, opts);
      } catch (error) {
        push({
          type: 'abort',
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (closed || terminated) {
        await E(proc)
          .kill()
          .catch(() => {});
        return;
      }
      inFlight = proc;
      try {
        for await (const event of parseStreamJsonLines(
          makeStdoutIterable(proc),
        )) {
          push(event);
        }
        push({ type: 'end' });
      } catch (error) {
        push({
          type: 'abort',
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (inFlight === proc) {
          inFlight = null;
        }
      }
    });
    // Keep the chain alive even if a turn rejects (errors are surfaced as
    // `abort` events, but be defensive).
    turnChain = turn.catch(() => {});
    return reader;
  };

  // Fire-and-forget the initial prompt: queue it as the first turn and
  // drain it in the background so the buffer does not grow unbounded if
  // the caller never pulls. Explicit `send()`s queue after it.
  if (initialPrompt) {
    const initReader = runTurn(initialPrompt);
    (async () => {
      for (;;) {
        const { done } = await initReader.next();
        if (done) break;
      }
    })().catch(() => {});
  }

  return makeExo('ClaudeClient', ClaudeClientInterface, {
    /**
     * Start a turn and return its reply reader immediately. The turn
     * queues behind any in-flight turn; the reader yields the parsed
     * stream-json events followed by a terminal `{ type: 'end' }` (or
     * `{ type: 'abort', reason }`). Closing the reader aborts the turn.
     *
     * @param {string} prompt
     * @param {object} [opts]
     */
    async send(prompt, opts = {}) {
      guardLive();
      return runTurn(prompt, opts);
    },

    /**
     * Interrupt the current turn by closing its reply reader: closing
     * kills the in-flight `claude` process (or makes a still-queued turn
     * bail before it spawns). The slice survives; the next `send()`
     * starts a fresh process.
     */
    async interrupt() {
      guardLive();
      if (!currentReader) {
        throw makeError(
          X`ClaudeClient(${q(sessionId)}): no in-flight prompt to interrupt.`,
        );
      }
      await currentReader.return();
    },

    /**
     * Tear down the session: abort the in-flight turn, dispose the slice
     * (which kills every process and releases the container), unmount the
     * host-side 9P workspace mount, and revoke the credential grant.
     */
    async terminate() {
      if (terminated) return;
      terminated = true;
      // Abort the in-flight turn's reader (kills the process if running).
      if (currentReader) {
        try {
          await currentReader.return();
        } catch {
          // best-effort
        }
      }
      if (inFlight) {
        const proc = inFlight;
        inFlight = null;
        try {
          await E(proc).kill();
        } catch {
          // best-effort
        }
      }
      // Only tear down what was actually provisioned. If the workspace
      // was never provisioned (lazy client that never ran), there is
      // no container or mount to release.
      if (provisioned === undefined) {
        return;
      }
      /** @type {{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> }, revoke?: () => Promise<void> } | undefined} */
      let resolved;
      try {
        resolved = await provisioned;
      } catch {
        // Provisioning failed; nothing was created to tear down.
        return;
      }
      try {
        await E(resolved.slice).dispose();
      } catch {
        // best-effort; dispose may already have run on cancellation
      }
      if (resolved.mountHandle) {
        try {
          await E(resolved.mountHandle).unmount();
        } catch {
          // best-effort; the mount caplet also unmounts on teardown
        }
      }
      if (resolved.revoke) {
        try {
          await resolved.revoke();
        } catch {
          // best-effort; the credential cap may already be gone
        }
      }
    },

    async status() {
      return harden({
        sessionId,
        createdAt,
        workspaceMountPoint,
        backend,
        rootfs: rootfsLabel,
        conversationStarted,
        terminated,
      });
    },

    /**
     * @param {string} [methodName]
     */
    help(methodName) {
      if (methodName === undefined) {
        return [
          'ClaudeClient: a single Claude Code session in a sandbox slice.',
          '  send(prompt, opts?) → reply reader of stream-json events,',
          '                        terminated by {type:"end"} or',
          '                        {type:"abort",reason} (consume with',
          '                        makeRefIterator). Turns queue.',
          '  interrupt()         → close the current reader (kills the',
          '                        in-flight prompt; slice survives)',
          '  terminate()         → dispose the slice + unmount + revoke creds',
          '  status()            → { sessionId, createdAt, workspaceMountPoint,',
          '                          backend, rootfs, conversationStarted,',
          '                          terminated }',
        ].join('\n');
      }
      return `No documentation for method "${q(methodName)}".`;
    },
  });
};
harden(makeClaudeClient);
