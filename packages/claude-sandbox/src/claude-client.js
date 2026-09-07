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
import { mapReader } from '@endo/stream';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

/** @import { SandboxHandle, ProcessHandle } from '@endo/sandbox/types.js' */

const ClaudeClientInterface = M.interface('ClaudeClient', {
  send: M.call(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
  setExtraMounts: M.call(M.arrayOf(M.record())).returns(M.promise()),
  terminate: M.call().returns(M.promise()),
  status: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * Split a stream of UTF-8 byte chunks into trimmed, non-empty text lines.
 * This is the stateful **byte-framing** half of the stream-json wire — one
 * chunk may carry zero, one, or many lines, and a line may span chunks — so
 * it cannot be a 1-to-1 map; the parse half (below) is.
 *
 * @param {AsyncIterable<Uint8Array>} bytesIterable
 * @returns {AsyncGenerator<string, void, void>}
 */
async function* splitLines(bytesIterable) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of bytesIterable) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) {
        yield line;
      }
      nl = buf.indexOf('\n');
    }
  }
  // Flush any trailing partial multi-byte sequence and final line that
  // didn't end in a newline.
  buf += decoder.decode();
  const last = buf.trim();
  if (last.length > 0) {
    yield last;
  }
}

/**
 * Parse one stream-json line into an event, wrapping a JSON error with the
 * offending line for a usable diagnostic.
 *
 * @param {string} line
 * @returns {any}
 */
const parseStreamJsonLine = line => {
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

/**
 * Parse a stream of UTF-8 byte chunks as newline-delimited JSON, yielding one
 * parsed object per non-empty line — the `claude -p --output-format
 * stream-json` wire shape. Byte-framing (`splitLines`) is the 1-to-many half;
 * the JSON parse is a 1-to-1 `@endo/stream` `mapReader` layered over it.
 *
 * Exported for unit testing — it is the pure core of `send()`'s stdout
 * handling, independent of the slice / CapTP plumbing.
 *
 * @param {AsyncIterable<Uint8Array>} bytesIterable
 * @returns {AsyncIterable<any>}
 */
export const parseStreamJsonLines = bytesIterable =>
  mapReader(splitLines(bytesIterable), parseStreamJsonLine);
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
 * Default adapter from a slice `ProcessHandle` to its stderr byte stream.
 *
 * @param {ProcessHandle} proc
 * @returns {AsyncIterable<Uint8Array>}
 */
const defaultStderrIterable = proc =>
  harden({
    async *[Symbol.asyncIterator]() {
      const stderrRef = await E(proc).stderr();
      yield* iterateBytesReader(/** @type {any} */ (stderrRef));
    },
  });

/**
 * A runtime-attached extra container bind
 * (designs/runtime-container-fs-mount.md). The host-side attach registrar
 * bridges a cap the session guest holds over 9P, registers the mountpoint as
 * a daemon `Mount` cap, and hands the result here; the slice binds it at
 * `innerPath` (under `/mnt/`) on the next provision.
 *
 * @typedef {object} ExtraMountSpec
 * @property {object} cap - Daemon `Mount` cap for the bridged host mountpoint.
 * @property {string} innerPath - Slice-internal path, under `/mnt/`.
 * @property {'ro' | 'rw'} mode
 * @property {{ unmount: () => Promise<void> }} [handle] - Host-side 9P mount
 *   handle backing the cap, carried for diagnostics. The attach registrar
 *   owns it — across recreates AND across `terminate()` — because releasing
 *   a bridge also means dropping its daemon Mount pet name and the
 *   provider's cache entry. The client never unmounts it.
 */

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
 * @property {(extraMounts?: readonly ExtraMountSpec[]) => Promise<{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> }, revoke?: () => Promise<void>, removeMount?: () => Promise<void> }>} [provision]
 *   - Lazy workspace provisioner. When present, `slice` / `mountHandle`
 *   are ignored and the slice + mount are created on first use (the
 *   first `send()` or `initialPrompt`), memoized thereafter. This is
 *   what lets the client be a pure-`env` formula: it constructs
 *   instantly and re-mounts / re-mints its container on demand, so
 *   daemon boot is never blocked on a container start. Receives the
 *   current runtime-attached extra binds so a recreate expands the
 *   slice's mount list. May also return a
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
 * @property {(proc: ProcessHandle) => AsyncIterable<Uint8Array>} [makeStderrIterable]
 *   - Adapter from a `ProcessHandle` to its stderr byte stream, read
 *   best-effort to enrich an `abort` reason. Injectable for tests;
 *   defaults to the `@endo/exo-stream` reader.
 * @property {number} [stderrReadLimit] - Maximum bytes to read from the
 *   captured stderr stream before stopping. Defaults to 16384.
 * @property {number} [stderrTailLength] - Maximum byte length of the
 *   trailing stderr excerpt included in the `abort` reason. Defaults
 *   to 2000.
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
  makeStderrIterable = defaultStderrIterable,
  stderrReadLimit = 16_384,
  stderrTailLength = 2000,
}) => {
  /**
   * Best-effort read of a process's captured stderr, bounded so a chatty
   * or never-closing stream can't stall teardown. The caller kills the
   * process first so the captured stream EOFs. Returns the trailing slice
   * (where the actual error usually is), or '' on any failure (for example,
   * a proc with no stderr surface).
   *
   * @param {ProcessHandle} proc
   * @returns {Promise<string>}
   */
  const readStderrBrief = async proc => {
    try {
      const decoder = new TextDecoder();
      let text = '';
      for await (const chunk of makeStderrIterable(proc)) {
        text += decoder.decode(chunk, { stream: true });
        if (text.length >= stderrReadLimit) break;
      }
      text += decoder.decode();
      return text.trim().slice(-stderrTailLength);
    } catch {
      return '';
    }
  };
  let terminated = false;
  // `--continue` resumes the most recent conversation; the first turn
  // has nothing to resume, so it is omitted until one prompt has been
  // dispatched.
  let conversationStarted = false;
  /** @type {ProcessHandle | null} */
  let inFlight = null;
  // Closes the reply channel of the most recent turn (queued or running).
  // Closing is the producer-side half of a consumer close: it discards
  // undelivered events and fires the channel's onClose, which kills the turn.
  /** @type {(() => void) | null} */
  let currentClose = null;
  // Closes the reply channel of the turn that is *actually executing*
  // (spawned, streaming). `interrupt()` prefers this over `currentClose` so
  // that,
  // with a turn already in flight and another queued behind it, interrupt
  // kills the running `claude` process rather than bailing the queued turn.
  /** @type {(() => void) | null} */
  let inFlightClose = null;
  // Serialize turns so two `claude -p` processes never race the same
  // workspace conversation: each `send()` queues behind the previous turn.
  /** @type {Promise<void>} */
  let turnChain = Promise.resolve();

  // Runtime-attached extra container binds
  // (designs/runtime-container-fs-mount.md). Replacing the set while a slice
  // is live disposes and immediately re-mints it with the expanded mount
  // list; when nothing is provisioned yet, the set simply binds on the next
  // (lazy) provision.
  /** @type {readonly ExtraMountSpec[]} */
  let extraMounts = harden([]);
  // The exact `extraMounts` array the live (or in-flight) provision went in
  // with. Identity, not contents: `extraMounts` is replaced wholesale, so a
  // match means the provision read this very set.
  /** @type {readonly ExtraMountSpec[]} */
  let provisionedExtras = harden([]);
  // True while a recreate is tearing down the live slice, so the killed
  // in-flight turn's abort reason names the recreate instead of a bare
  // signal.
  let recreating = false;
  // A recreate's teardown must finish before a racing turn re-provisions:
  // both the old teardown and the new provision touch the same host
  // mountpoints (the workspace 9P mount), so an overlap could unmount the
  // fresh mount. `ensureProvisioned` chains behind this gate.
  /** @type {Promise<void>} */
  let pendingTeardown = Promise.resolve();

  // Workspace provisioning. Direct `slice` / `mountHandle` are treated
  // as already provisioned (eager); a `provision` thunk is run once on
  // first use (lazy) and memoized. `provisioned` stays `undefined`
  // until a lazy provision starts, so `terminate()` before any use is
  // a no-op rather than spinning up a container just to tear it down.
  /** @type {Promise<{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> }, revoke?: () => Promise<void>, removeMount?: () => Promise<void> }> | undefined} */
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
      // A terminated client must never re-provision: `terminate()` tears down
      // only what `provisioned` names at the moment it runs, so a provision
      // started after it (a queued turn racing terminate, or a recreate whose
      // teardown terminate raced past) would leak a container, its 9P
      // mounts, and a fresh credential grant with no owner left to release
      // them.
      guardLive();
      const pending = pendingTeardown.then(() => {
        // Read the bind set at the moment the provision actually starts, not
        // when it was scheduled, and record WHICH set it went in with. A
        // `setExtraMounts` racing a first `send()` can land in between, and
        // without this the recreate branch could not tell that the provision
        // it is about to tear down already carries the new binds.
        provisionedExtras = extraMounts;
        return /** @type {NonNullable<typeof provision>} */ (provision)(
          extraMounts,
        );
      });
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
   * While a recreate is disposing the live slice, the in-flight `claude`
   * process dies by signal; name the actual cause in that turn's abort
   * reason (attach/detach is disruptive by design — see
   * designs/runtime-container-fs-mount.md).
   *
   * @param {string} base
   */
  const abortReasonInContext = base =>
    recreating
      ? `container mount set changed; sandbox slice recreated — ${base}`
      : base;

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
      // Emit Anthropic content-block deltas as `stream_event` records instead
      // of waiting for each complete assistant message.
      '--include-partial-messages',
      // `stream-json` print mode requires --verbose to emit the full
      // per-event stream rather than only the final result.
      '--verbose',
      // This client always runs inside an Endo-confined rootless Podman slice.
      // There is no interactive permission channel in print mode, so let the
      // CLI execute its agentic tool loop within that OS-level boundary.
      '--dangerously-skip-permissions',
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
    const { push, reader, close, setOnClose } = makeBufferedReader();
    setOnClose(() => {
      closed = true;
      if (proc) {
        E(proc)
          .kill()
          .catch(() => {});
      }
    });
    currentClose = close;

    const turn = turnChain.then(async () => {
      if (closed || terminated) {
        // The consumer closed the reader, or the session was terminated,
        // before this queued turn ran. Finalize the reader with a terminal
        // event so a consumer parked in `next()` is not left hanging. `push`
        // is a no-op once the reader is already closed, so a plain consumer
        // `return()` (interrupt) is unaffected; this only rescues the
        // terminate-with-queued-turns case.
        push({ type: 'abort', reason: 'session terminated before turn ran' });
        return;
      }
      try {
        proc = await spawnClaude(prompt, opts);
      } catch (error) {
        // A recreate disposes the slice a queued spawn may be about to use;
        // label that failure the same way an in-flight kill is labelled.
        push({
          type: 'abort',
          reason: abortReasonInContext(
            error instanceof Error ? error.message : String(error),
          ),
        });
        return;
      }
      if (closed || terminated) {
        await E(proc)
          .kill()
          .catch(() => {});
        push({ type: 'abort', reason: 'session terminated' });
        return;
      }
      inFlight = proc;
      inFlightClose = close;
      try {
        for await (const event of parseStreamJsonLines(
          makeStdoutIterable(proc),
        )) {
          push(event);
        }
        // Stdout EOF alone does not mean the turn succeeded: `claude` exits
        // non-zero on auth failure, an internal error, or an external kill,
        // having already streamed a partial transcript. Consult the exit
        // status so a failed turn terminates as `abort` (with whatever it
        // wrote to stderr) instead of a clean `end` the consumer would
        // persist as a successful answer.
        const status = await E(proc)
          .wait()
          .catch(() => null);
        if (status && (status.code === null ? status.signal : status.code)) {
          const how =
            status.code === null
              ? `killed by ${status.signal}`
              : `exited with code ${status.code}`;
          const stderrText = await readStderrBrief(proc);
          const base = abortReasonInContext(`claude ${how}`);
          push({
            type: 'abort',
            reason: stderrText
              ? `${base}\n--- stderr ---\n${stderrText}`
              : base,
          });
        } else {
          push({ type: 'end' });
        }
      } catch (error) {
        const base = abortReasonInContext(
          error instanceof Error ? error.message : String(error),
        );
        // Kill first so the captured stderr stream EOFs, then fold any
        // diagnostic claude wrote to stderr into the abort reason — without
        // it, a claude-side failure surfaces only as an opaque stream/parse
        // error.
        await E(proc)
          .kill()
          .catch(() => {});
        const stderrText = await readStderrBrief(proc);
        push({
          type: 'abort',
          reason: stderrText ? `${base}\n--- stderr ---\n${stderrText}` : base,
        });
      } finally {
        if (inFlight === proc) {
          inFlight = null;
          inFlightClose = null;
        }
        // Drop the finished turn's closer so a later `interrupt()` reports
        // "nothing in flight" instead of silently no-op'ing against a closed
        // channel.
        if (currentClose === close) {
          currentClose = null;
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
      // Drain without closing: closing would fire onClose and kill the very
      // turn we are running.
      for await (const event of iterateReader(/** @type {any} */ (initReader), {
        buffer: 8,
      })) {
        // discarded — nobody is watching this turn's transcript
        void event;
      }
    })().catch(() => {});
  }

  // Serialize attach-set changes so two overlapping `setExtraMounts` calls
  // never interleave their teardown/re-provision sequences.
  /** @type {Promise<void>} */
  let extraMountsChain = Promise.resolve();
  /**
   * @param {readonly ExtraMountSpec[]} extras
   */
  const applyExtraMounts = extras => {
    const run = extraMountsChain.then(async () => {
      await null;
      guardLive();
      // Refuse BEFORE recording anything: an eagerly-provisioned client (no
      // provision thunk) has no way to recreate its slice, and a rejected
      // call must not leave the refused set visible in `status()` or
      // unmountable by `terminate()`.
      if (!provision) {
        throw makeError(
          X`ClaudeClient(${q(sessionId)}): extra mounts require a lazily-provisioned client (no provision thunk to recreate the slice with)`,
        );
      }
      // Validate at the boundary, where the values genuinely arrive untyped:
      // the interface guard admits any copyRecord, and a `mode` that is
      // neither "ro" nor "rw" must fail CLOSED. Coercing an unrecognized
      // value to read-write would widen a bind the caller may well have
      // meant to be read-only.
      for (const extra of extras) {
        if (extra.mode !== 'ro' && extra.mode !== 'rw') {
          throw makeError(
            X`ClaudeClient(${q(sessionId)}): extra mount ${q(extra.innerPath)} has mode ${q(extra.mode)}; expected "ro" or "rw"`,
          );
        }
        if (typeof extra.innerPath !== 'string' || extra.innerPath === '') {
          throw makeError(
            X`ClaudeClient(${q(sessionId)}): every extra mount needs a non-empty innerPath`,
          );
        }
        if (!extra.cap) {
          throw makeError(
            X`ClaudeClient(${q(sessionId)}): extra mount ${q(extra.innerPath)} has no capability to bind`,
          );
        }
      }
      extraMounts = harden([...extras]);
      if (provisioned === undefined) {
        // Nothing live: the new set binds on the next (lazy) provision.
        return;
      }
      const prior = provisioned;
      provisioned = undefined;
      /** @type {() => void} */
      let releaseTeardown = () => {};
      pendingTeardown = new Promise(resolve => {
        releaseTeardown = resolve;
      });
      recreating = true;
      /** @type {Awaited<typeof prior> | undefined} */
      let resolved;
      try {
        try {
          try {
            resolved = await prior;
          } catch {
            // The prior provision failed and already cleaned up after
            // itself; the next provision binds the new set.
            return;
          }
          if (provisionedExtras === extraMounts) {
            // A provision that was already in flight when this call landed
            // read the new set on its way in, so the live slice ALREADY
            // carries these binds. Tearing it down to mint an identical one
            // would kill the very first turn for nothing. Put the provision
            // back and stop.
            provisioned = prior;
            return;
          }
          // Dispose the slice first: it kills the in-flight `claude` (that
          // turn aborts with a recreate-labelled reason) and releases the
          // container's binds so the 9P mounts below can unmount.
          try {
            await E(resolved.slice).dispose();
          } catch {
            // best-effort
          }
          // Unmount the workspace 9P mount so the re-provision can remount
          // the same host mountpoint. The extras' own 9P bridges are NOT
          // touched: the attach registrar owns them across recreates (they
          // die only on detach or terminate).
          if (resolved.mountHandle) {
            try {
              await E(resolved.mountHandle).unmount();
            } catch {
              // best-effort
            }
          }
          // Release the credential grant; the re-provision issues a fresh
          // one.
          if (resolved.revoke) {
            try {
              await resolved.revoke();
            } catch {
              // best-effort
            }
          }
        } finally {
          // Must release before re-provisioning: ensureProvisioned chains
          // behind this gate.
          releaseTeardown();
        }
        // A terminate() that landed during the teardown above saw
        // `provisioned === undefined` and returned with nothing more to
        // release — re-provisioning now would mint a container, 9P mounts,
        // and a credential grant that nothing will ever tear down. The
        // teardown this recreate just performed doubles as the terminate's
        // missing cleanup, so stop here.
        if (terminated) {
          // With one exception: a recreate leaves the workspace Mount pet
          // name registered on purpose, because the re-provision registers
          // the same name again. Nothing is going to re-provision now, so
          // reclaim it here — otherwise the terminated session leaves a live
          // host-rooted Mount formula behind, which is exactly what
          // `terminate()`'s own `removeMount` exists to prevent.
          if (resolved?.removeMount) {
            try {
              await resolved.removeMount();
            } catch {
              // best-effort; the name may already be gone
            }
          }
          return;
        }
        // Immediate recreate (design decision: apply on attach, not on the
        // next turn) so a provisioning failure surfaces to the attach
        // caller rather than poisoning the next send.
        await ensureProvisioned();
      } finally {
        recreating = false;
      }
    });
    extraMountsChain = run.catch(() => {});
    return run;
  };

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
      // Prefer the executing turn (kills its `claude` process); fall back
      // to the most-recent queued turn (which bails before it spawns).
      const target = inFlightClose || currentClose;
      if (!target) {
        throw makeError(
          X`ClaudeClient(${q(sessionId)}): no in-flight prompt to interrupt.`,
        );
      }
      target();
    },

    /**
     * Replace the runtime-attached extra container binds
     * (designs/runtime-container-fs-mount.md). When a slice is live it is
     * disposed and IMMEDIATELY re-minted with the expanded mount list —
     * attach is disruptive by design, so an in-flight turn is killed with
     * an abort reason naming the recreate. When nothing is provisioned
     * yet, the set simply binds on the next (lazy) provision.
     *
     * Called by the host-side attach registrar, which owns each extra's 9P
     * bridge across recreates. Not reachable from a session: floot hands
     * sessions a send-only attenuation of this client.
     *
     * @param {ReadonlyArray<Record<string, any>>} extras - wire-shaped
     *   records (the interface guard admits any copyRecord); treated as
     *   {@link ExtraMountSpec}s.
     */
    async setExtraMounts(extras) {
      guardLive();
      return applyExtraMounts(
        /** @type {readonly ExtraMountSpec[]} */ (extras),
      );
    },

    /**
     * Tear down the session: abort the in-flight turn, dispose the slice
     * (which kills every process and releases the container), unmount the
     * host-side 9P workspace mount, and revoke the credential grant.
     */
    async terminate() {
      if (terminated) return;
      terminated = true;
      // Abort the executing turn's reader AND the most recent queued one:
      // with a turn in flight and another queued, they are different readers,
      // and closing only the newest would leave the running turn's consumer to
      // observe a clean `end` when its process is killed below — a truncated
      // reply that reads as a complete one.
      for (const close of new Set(
        [inFlightClose, currentClose].filter(Boolean),
      )) {
        try {
          /** @type {() => void} */ (close)();
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
      // Runtime-attached extras are NOT unmounted here, and that is the
      // point of `handle` being on the spec at all: only the attach
      // registrar can release a bridge, because releasing one also means
      // dropping the daemon Mount pet name and the provider's own cache
      // entry for it. Unmounting the handle directly from here would tear
      // down the kernel mount while both of those still pointed at it, and
      // the provider — whose cache is keyed by a DETERMINISTIC key, so a
      // replay asks for the same one — would then hand the next caller a
      // Mount cap over an empty directory. The container would bind it
      // without error and `git` would run against nothing.
      //
      // So the client only ever binds; the registrar mints and releases,
      // on detach and when the last session reference goes away.
      // Only tear down what was actually provisioned. If the workspace
      // was never provisioned (lazy client that never ran), there is
      // no container or mount to release.
      if (provisioned === undefined) {
        return;
      }
      /** @type {{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> }, revoke?: () => Promise<void>, removeMount?: () => Promise<void> } | undefined} */
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
      // Reclaim the workspace Mount pet name so it does not linger as a live
      // host-rooted formula after the session is gone (the per-session powers
      // scopes this to exactly this session's mount name).
      if (resolved.removeMount) {
        try {
          await resolved.removeMount();
        } catch {
          // best-effort; the name may already be gone
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
        extraMounts: extraMounts.map(({ innerPath, mode }) => ({
          innerPath,
          mode,
        })),
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
          '  setExtraMounts(a)   → replace the runtime-attached container',
          '                        binds; recreates a live slice immediately',
          '                        (the in-flight turn aborts)',
          '  terminate()         → dispose the slice + unmount + revoke creds',
          '  status()            → { sessionId, createdAt, workspaceMountPoint,',
          '                          backend, rootfs, conversationStarted,',
          '                          terminated, extraMounts }',
        ].join('\n');
      }
      return `No documentation for method "${q(methodName)}".`;
    },
  });
};
harden(makeClaudeClient);
