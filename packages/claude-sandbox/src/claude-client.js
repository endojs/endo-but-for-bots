// @ts-check
/* eslint-disable no-await-in-loop */

/**
 * `ClaudeClient` — a single Claude Code session running inside an
 * `@endo/sandbox` slice (rootless podman, by default).
 *
 * Turn model (v1): each `send(prompt)` spawns a fresh
 * `claude -p <prompt> --output-format stream-json` process inside the
 * slice. Conversation continuity across turns is preserved by passing
 * `--continue` on every send after the first, which resumes the most
 * recent conversation persisted in the workspace. This keeps the
 * lifecycle simple (no long-lived stdin plumbing) while still letting
 * a sequence of `send()` calls build on each other.
 *
 * The process's stdout carries newline-delimited JSON — the
 * `claude -p --output-format stream-json` contract Anthropic ships.
 * `send()` resolves to a Far iterator of the parsed events; callers
 * consume it with `makeRefIterator` from `@endo/daemon/ref-reader.js`,
 * the same pattern used elsewhere for message followers.
 *
 * The slice handle and the host-side 9P mount handle are *live*
 * references held in the factory worker; this exo is therefore not a
 * pure-env formula and does not reincarnate across daemon restarts
 * (see `README.md` § "Lifecycle"). `terminate()` disposes the slice
 * and unmounts the workspace.
 *
 * @module
 */

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

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
 * @property {() => Promise<{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> } }>} [provision]
 *   - Lazy workspace provisioner. When present, `slice` / `mountHandle`
 *   are ignored and the slice + mount are created on first use (the
 *   first `send()` or `initialPrompt`), memoized thereafter. This is
 *   what lets the client be a pure-`env` formula: it constructs
 *   instantly and re-mounts / re-mints its container on demand, so
 *   daemon boot is never blocked on a container start.
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
  // `--continue` resumes the most recent conversation; the first send
  // has nothing to resume, so it is omitted until one prompt has been
  // dispatched.
  let conversationStarted = false;
  /** @type {ProcessHandle | null} */
  let inFlight = null;

  // Workspace provisioning. Direct `slice` / `mountHandle` are treated
  // as already provisioned (eager); a `provision` thunk is run once on
  // first use (lazy) and memoized. `provisioned` stays `undefined`
  // until a lazy provision starts, so `terminate()` before any use is
  // a no-op rather than spinning up a container just to tear it down.
  /** @type {Promise<{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> } }> | undefined} */
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
      provisioned = Promise.resolve(
        /** @type {NonNullable<typeof provision>} */ (provision)(),
      );
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
   * Wrap a `ProcessHandle`'s stdout as a Far iterator of parsed
   * stream-json events. Clears `inFlight` when the stream ends so a
   * later `interrupt()` does not target a finished process.
   *
   * @param {ProcessHandle} proc
   */
  const makeEventReader = proc => {
    const gen = parseStreamJsonLines(makeStdoutIterable(proc));
    const onDone = () => {
      if (inFlight === proc) {
        inFlight = null;
      }
    };
    // A lightweight one-off remotable iterator, consumed by
    // `makeRefIterator`. `Far` (rather than `makeExo`) is the
    // idiomatic shape here — see `@endo/daemon/ref-reader.js`.
    return Far('ClaudeEventReader', {
      async next() {
        const result = await gen.next();
        if (result.done) {
          onDone();
        }
        return harden({ done: result.done, value: result.value });
      },
      /** @param {any} [value] */
      async return(value) {
        onDone();
        if (gen.return) {
          const r = await gen.return(value);
          return harden({ done: true, value: r.value });
        }
        return harden({ done: true, value });
      },
      /** @param {any} err */
      async throw(err) {
        onDone();
        if (gen.throw) {
          return gen.throw(err);
        }
        throw err;
      },
    });
  };

  // Fire-and-forget the initial prompt: drain it in the background so
  // the stdout fd does not leak when the caller never calls send().
  // Ordering with the first explicit send() is preserved by awaiting
  // `sentInitial` there.
  const sentInitial = initialPrompt
    ? (async () => {
        const proc = await spawnClaude(initialPrompt);
        inFlight = proc;
        const reader = makeEventReader(proc);
        // eslint-disable-next-line no-constant-condition
        for (;;) {
          const { done } = await reader.next();
          if (done) break;
        }
      })()
    : null;
  if (sentInitial) {
    sentInitial.catch(() => {});
  }

  return makeExo('ClaudeClient', ClaudeClientInterface, {
    /**
     * @param {string} prompt
     * @param {object} [opts]
     */
    async send(prompt, opts = {}) {
      guardLive();
      if (sentInitial) {
        await sentInitial;
      }
      const proc = await spawnClaude(prompt, opts);
      inFlight = proc;
      return makeEventReader(proc);
    },

    /**
     * Kill the in-flight `claude` process (if any) without tearing
     * down the slice. The next `send()` starts a fresh process.
     */
    async interrupt() {
      guardLive();
      if (!inFlight) {
        throw makeError(
          X`ClaudeClient(${q(sessionId)}): no in-flight prompt to interrupt.`,
        );
      }
      const proc = inFlight;
      inFlight = null;
      await E(proc).kill();
    },

    /**
     * Tear down the session: kill any in-flight process, dispose the
     * slice (which kills every process and releases the container),
     * then unmount the host-side 9P workspace mount.
     */
    async terminate() {
      if (terminated) return;
      terminated = true;
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
      /** @type {{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> } } | undefined} */
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
          '  send(prompt, opts?) → reader of stream-json events',
          '                        (consume with makeRefIterator)',
          '  interrupt()         → kill the in-flight prompt (slice survives)',
          '  terminate()         → dispose the slice + unmount the workspace',
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
