// @ts-check

/**
 * `OpencodeClient` — one long-lived opencode session running inside an
 * `@endo/sandbox` slice (rootless podman, by default), carried by the
 * in-slice bridge (`/opt/opencode-bridge/bridge.mjs`).
 *
 * Turn model: the bridge starts `opencode serve`, subscribes to its event
 * stream, and speaks newline-delimited JSON over stdin/stdout.  A `send`
 * writes `{op:'send',text}` and returns a **buffered reply reader**
 * immediately (consume it with `makeRefIterator`): it yields the hosted
 * events the bridge emits for that turn (`phase`, `text-delta`,
 * `commentary-delta`, `tool-call`, `tool-result`, `usage`), then exactly
 * one terminal `{type:'end'}` or `{type:'abort',reason}`.  Turns **queue**
 * on an internal chain so the bridge never sees two `send` commands at
 * once; the next prompt is written only after the previous turn's terminal.
 *
 * `interrupt()` writes `{op:'interrupt'}` and awaits the active turn's
 * terminal, so when it resolves a later `send()` cannot race the
 * interrupted turn (the terminal barrier).  The bridge itself enforces a
 * grace timeout and emits `abort` even if the server does not acknowledge.
 *
 * The slice, mounts, and credential grant are provisioned lazily (see the
 * `provision` thunk and `opencode-client-module.js`), so the exo can be a
 * pure-`env` formula that reincarnates across daemon restarts.
 * `terminate()` disposes the slice, unmounts its 9P mounts, drops the
 * mount pet names, and revokes the credential grant, keeping durable
 * workspace + state for the next revival; `destroy()` additionally deletes
 * the session's durable state through the injected `removeState` thunk.
 *
 * Bridge stdout is untrusted UI text, not attestation: the client
 * validates event shapes with `assertBridgeEvent` but never bases a
 * recovery or authorization decision on their content.
 *
 * @module
 */

import { E } from '@endo/eventual-send';
import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';
import { makeExo } from '@endo/exo';
import {
  pairToolCalls,
  renderTranscriptDialogue,
} from '@endo/hosted-agent/transcript-records.js';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { makeCleanupScope } from '@endo/hosted-agent/cleanup-scope.js';

import { assertBridgeEvent, parseJsonLines } from './opencode-protocol.js';

/** @import { SandboxHandle, ProcessHandle } from '@endo/sandbox/types.js' */

/**
 * The baked bridge path inside the sandbox image.  Exposed as an option so
 * tests (and a deployment with a different image layout) can inject the
 * spawn argv.
 */
/** Host-side bound on interrupt(); the bridge grace timer is untrusted. */
const INTERRUPT_DEADLINE_MS = 15_000;
// Total normalized-event bytes one turn may buffer before the bridge is
// considered hostile and torn down.
const MAX_TURN_EVENT_BYTES = 8 * 1024 * 1024;

export const DEFAULT_BRIDGE_ARGV = harden([
  'node',
  '/opt/opencode-bridge/bridge.mjs',
]);

const OpencodeClientInterface = M.interface('OpencodeClient', {
  send: M.call(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
  terminate: M.call().returns(M.promise()),
  destroy: M.call().returns(M.promise()),
  status: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * Encode one host→bridge command as the newline-delimited JSON frame the
 * bridge's stdin reader expects.  Exported for tests.
 *
 * @param {object} command
 * @returns {Uint8Array}
 */
export const encodeBridgeCommand = command => {
  const line = `${JSON.stringify(command)}\n`;
  return new TextEncoder().encode(line);
};
harden(encodeBridgeCommand);

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
 * Default adapter from a slice `ProcessHandle` to a bytes writer over its
 * stdin.
 *
 * @param {ProcessHandle} proc
 * @returns {Promise<any>}
 */
const defaultMakeStdinWriter = async proc =>
  iterateBytesWriter(/** @type {any} */ (await E(proc).stdin()), {
    buffer: 0,
  });

/**
 * @typedef {object} Turn
 * @property {string} text
 * @property {readonly any[] | undefined} transcript - The stack's record of
 *   this conversation, used only when this incarnation has none of its own.
 * @property {string | undefined} systemPrompt
 * @property {object} reader - Buffered reply reader handed to the caller.
 * @property {(event: any) => void} push
 * @property {boolean} closed
 * @property {Promise<void>} terminal - Resolves when the terminal event has
 *   been delivered (or the turn was failed); the interrupt barrier.
 * @property {() => void} settle
 */

/**
 * @typedef {object} OpencodeClientArgs
 * @property {string} sessionId
 * @property {string} createdAt - ISO timestamp.
 * @property {SandboxHandle} [slice] - Live sandbox slice handle; provide
 *   this (with `mountHandle`) for an eagerly-provisioned client, or omit and
 *   pass `provision` for the lazy formula path.
 * @property {{ unmount: () => Promise<void> }} [mountHandle] - Host-side 9P
 *   mount handle for the workspace, unmounted on `terminate()`.
 * @property {(extraMounts?: readonly any[]) => Promise<{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> }, configMountHandle?: { unmount: () => Promise<void> }, revoke?: () => Promise<void>, removeMount?: () => Promise<void> }>} [provision]
 *   - Lazy provisioner.  Runs once on first use and is memoized; a failed
 *   attempt is dropped so a later turn can retry.
 * @property {() => Promise<void>} [cleanupProvision] - Required with `provision`.
 *   Permanently fences provisioning and releases all successful and partial
 *   acquisitions, including after provision rejects. Failed cleanup stays
 *   owned and retryable. This callback, not the result promise, owns resources.
 * @property {string} workspaceMountPoint - Host path of the workspace 9P
 *   mount (diagnostic; surfaced in `status()`).
 * @property {string} [workspacePath] - Slice-internal workspace path used as
 *   the bridge's cwd. Defaults to `/workspace`.
 * @property {string} [statePath] - Slice-internal durable state path
 *   (`XDG_DATA_HOME`). Diagnostic only.
 * @property {string} [backend] - Resolved sandbox backend name (diagnostic).
 * @property {string} [rootfsLabel] - Human-readable rootfs label (diagnostic).
 * @property {string} [model] - Diagnostic: the OpenRouter model ref.
 * @property {string} [systemPrompt] - The session persona baked into the
 *   opencode agent. A `send` whose `options.systemPrompt` differs is refused:
 *   the agent prompt is fixed at config load.
 * @property {string} [opencodeSessionId] - The persisted opencode session id
 *   to resume when this client revives.  When omitted, the bridge creates a
 *   new opencode session.
 * @property {boolean} [resumePriorConversation] - Suppresses the one-shot
 *   `initialPrompt` on a reincarnated client (default false).
 * @property {string} [initialPrompt] - Optional one-shot prompt fired (and
 *   drained) at construction.
 * @property {readonly string[]} [bridgeArgv] - Spawn argv for the in-slice
 *   bridge. Defaults to `['node', '/opt/opencode-bridge/bridge.mjs']`.
 * @property {Record<string, string>} [env] - Extra per-spawn env merged on
 *   top of the slice's env (normally empty; the slice env already carries
 *   the credential and bridge configuration).
 * @property {() => Promise<void>} [removeState] - Destroy-side hook that
 *   deletes the session's durable state. Called only by `destroy()`.
 * @property {(proc: ProcessHandle) => AsyncIterable<Uint8Array>} [makeStdoutIterable]
 * @property {(proc: ProcessHandle) => AsyncIterable<Uint8Array>} [makeStderrIterable]
 * @property {(proc: ProcessHandle) => Promise<any>} [makeStdinWriter]
 * @property {number} [stderrReadLimit] - Maximum bytes of stderr retained for
 *   an abort reason. Defaults to 16384.
 * @property {number} [stderrTailLength] - Maximum byte length of the trailing
 *   stderr excerpt included in a failure reason. Defaults to 2000.
 */

/** How long the structured import may take before the prompt carries it. */
const IMPORT_TIMEOUT_MS = 30_000;

/**
 * Transcript records as the turns opencode's import route takes.
 *
 * A tool call and its result become one imported turn, because that is what
 * they are: the route records a tool message carrying both, and splitting them
 * would produce a call the store shows as never having returned.
 *
 * @param {readonly any[]} records
 */
const importedTurnsFor = records => {
  const { pairs } = pairToolCalls(records);
  const resultFor = new Map(pairs.map(pair => [pair.call, pair.result]));
  const turns = [];
  for (const record of records) {
    if (record.kind === 'message') {
      turns.push({ kind: record.role, text: record.content });
    } else if (record.kind === 'compaction') {
      turns.push({ kind: 'compaction', text: record.summary });
    } else if (record.kind === 'tool-call') {
      const result = resultFor.get(record);
      let input = {};
      try {
        const parsed = JSON.parse(record.args);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed;
        } else {
          input = { value: parsed };
        }
      } catch {
        input = { value: record.args };
      }
      turns.push({
        kind: 'tool',
        callID: record.id,
        name: record.name,
        input,
        output: result ? result.content : 'Tool call did not complete.',
        ...(result?.failed ? { failed: true } : {}),
      });
    }
    // A `tool-result` was folded into its call above.
  }
  return turns;
};

/**
 * Build an `OpencodeClient` exo.
 *
 * @param {OpencodeClientArgs} args
 */
export const makeOpencodeClient = ({
  sessionId,
  createdAt,
  slice,
  mountHandle,
  provision,
  cleanupProvision,
  workspaceMountPoint,
  workspacePath = '/workspace',
  statePath = '/opencode-state',
  backend = 'podman',
  rootfsLabel = '',
  model = '',
  systemPrompt,
  opencodeSessionId: initialOpencodeSessionId = '',
  resumePriorConversation = false,
  initialPrompt,
  bridgeArgv = DEFAULT_BRIDGE_ARGV,
  env = {},
  removeState,
  makeStdoutIterable = defaultStdoutIterable,
  makeStderrIterable = defaultStderrIterable,
  makeStdinWriter = defaultMakeStdinWriter,
  stderrReadLimit = 16_384,
  stderrTailLength = 2000,
}) => {
  let terminated = false;
  let cleanupComplete = false;
  let destroyed = false;
  // The captured opencode session id (`ready` event).  Kept in memory and
  // reported by `status()` so the backend factory can record it for resume.
  let opencodeSessionId = String(initialOpencodeSessionId || '');
  /** @type {ProcessHandle | null} */
  let proc = null;
  /** @type {any} */
  let stdin = null;
  /** @type {Promise<void> | undefined} */
  let startPromise;
  /** @type {Promise<void> | undefined} */
  let startupAcquisition;
  let bridgeExited = false;
  let bridgeExitReason = '';
  let stderrTail = '';
  /** @type {(() => void) | undefined} */
  let resolveReady;
  /** @type {((error: Error) => void) | undefined} */
  let rejectReady;

  /** @type {Turn | null} */
  let active = null;
  let activeBytes = 0;
  /** @type {Turn[]} */
  const pendingTurns = [];
  let dispatching = false;
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();

  // Workspace provisioning: direct `slice` / `mountHandle` are already
  // provisioned (eager); a `provision` thunk runs once on first use.
  /** @type {Promise<{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> }, configMountHandle?: { unmount: () => Promise<void> }, revoke?: () => Promise<void>, removeMount?: () => Promise<void> }> | undefined} */
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

  if (provision && !cleanupProvision) {
    throw makeError(X`Lazy OpenCode provisioning requires a cleanup owner`);
  }
  // Eager clients already own their slice. The lazy module supplies its own
  // acquisition owner, available even if its result promise rejects.
  const mountCleanup = makeCleanupScope();
  if (mountHandle) mountCleanup.add(() => E(mountHandle).unmount());
  let sliceStopped = false;
  const releaseResources =
    cleanupProvision ||
    (async () => {
      await null;
      if (!sliceStopped) {
        await E(/** @type {SandboxHandle} */ (slice)).dispose();
        sliceStopped = true;
      }
      // A failed disposal is not permission to unmount guest storage.
      await mountCleanup.run();
    });

  const guardLive = () => {
    if (terminated) {
      throw makeError(X`OpencodeClient(${q(sessionId)}) is terminated.`);
    }
  };

  const ensureProvisioned = () => {
    if (provisioned === undefined) {
      // A terminated client must never re-provision: terminate() tears down
      // only what `provisioned` names at the moment it runs, so a provision
      // started afterwards would leak a container, mounts, and a credential
      // grant with no owner left to release them.
      guardLive();
      const pending = /** @type {NonNullable<typeof provision>} */ (
        provision
      )().then(value => harden(value));
      provisioned = pending;
      // The provisioning owner retains partial acquisitions separately and
      // must finish predecessor cleanup before admitting a later attempt.
      pending.catch(() => {
        if (provisioned === pending) {
          provisioned = undefined;
        }
      });
    }
    return provisioned;
  };

  /**
   * Best-effort stderr excerpt for a failure reason.  The drain loop keeps
   * `stderrTail` bounded while the process runs.
   *
   * @returns {string}
   */
  const readStderrBrief = () => stderrTail.trim().slice(-stderrTailLength);

  /**
   * @param {ProcessHandle} activeProc
   */
  const drainStderr = activeProc => {
    (async () => {
      try {
        const decoder = new TextDecoder();
        for await (const chunk of makeStderrIterable(activeProc)) {
          stderrTail += decoder.decode(chunk, { stream: true });
          if (stderrTail.length > stderrReadLimit) {
            stderrTail = stderrTail.slice(-stderrReadLimit);
          }
        }
        stderrTail += decoder.decode();
      } catch {
        // Best-effort: the stream may be torn down by teardown first.
      }
    })().catch(() => {});
  };

  /**
   * Fail every live turn and mark the bridge unusable.  A client whose
   * bridge exited fails closed: it never silently starts a fresh opencode
   * history under the same incarnation (see DESIGN.md § Session handoff).
   *
   * @param {string} reason
   */
  const bridgeEnded = reason => {
    if (terminated || bridgeExited) return;
    bridgeExited = true;
    const stderrText = readStderrBrief();
    bridgeExitReason = stderrText
      ? `${reason}\n--- stderr ---\n${stderrText}`
      : reason;
    if (rejectReady) {
      rejectReady(
        makeError(X`OpencodeClient(${q(sessionId)}): ${bridgeExitReason}`),
      );
    }
    const turn = active;
    const queued = [...pendingTurns];
    active = null;
    pendingTurns.length = 0;
    for (const failed of [...(turn ? [turn] : []), ...queued]) {
      failed.push({ type: 'abort', reason: bridgeExitReason });
      failed.settle();
    }
    if (proc) {
      E(proc)
        .kill()
        .catch(() => {});
    }
  };

  /**
   * Deliver one validated bridge event.  `ready` is the session handshake;
   * every other event belongs to the active turn (a turn is the only thing
   * that provokes bridge traffic after startup).
   *
   * @param {any} event
   */
  // Restoration happens once per incarnation, before the first turn of a
  // session this process did not start. A later turn continues the
  // conversation the CLI is now holding, so repeating the history would
  // duplicate it.
  let restorationPending = !resumePriorConversation;

  const handleEvent = event => {
    if (event.type === 'imported') {
      if (resolveImported) resolveImported(event.ok === true);
      return;
    }
    if (event.type === 'ready') {
      // A resume that came back under a different id did not resume: the
      // store no longer held the session this plan recorded, and the bridge
      // started a fresh one. That case had no handling at all — the session
      // simply continued context-free, which is the silent version of losing
      // a conversation. Restoring instead is what the stack's record is for.
      if (
        resumePriorConversation &&
        initialOpencodeSessionId &&
        event.sessionId !== initialOpencodeSessionId
      ) {
        restorationPending = true;
      }
      opencodeSessionId = event.sessionId;
      if (resolveReady) resolveReady();
      return;
    }
    const turn = active;
    if (!turn) {
      // A trailing phase/idle (or any event after the terminal) has no
      // reader to carry it; dropping it keeps one terminal per send.
      return;
    }
    // Bound the producer side: a hostile bridge must not be able to grow the
    // buffered reader without limit and exhaust the shared daemon worker.
    activeBytes += Buffer.byteLength(JSON.stringify(event));
    if (activeBytes > MAX_TURN_EVENT_BYTES) {
      // Deliver the terminal before tearing the bridge down, or the reader
      // would hang with no outcome.
      turn.push({ type: 'abort', reason: 'turn event budget exceeded' });
      active = null;
      turn.settle();
      bridgeEnded('turn event budget exceeded');
      return;
    }
    turn.push(event);
    if (event.type === 'end' || event.type === 'abort') {
      active = null;
      turn.settle();
      void dispatchNext();
    }
  };

  /**
   * @param {ProcessHandle} activeProc
   */
  const consumeStdout = activeProc => {
    (async () => {
      try {
        for await (const raw of parseJsonLines(
          makeStdoutIterable(activeProc),
        )) {
          handleEvent(assertBridgeEvent(raw));
        }
        bridgeEnded('bridge stdout ended');
      } catch (error) {
        bridgeEnded(error instanceof Error ? error.message : String(error));
      }
    })().catch(() => {});
  };

  /**
   * Start the long-lived bridge process once, and resolve when its `ready`
   * handshake lands.  A bridge that exits during startup fails this step
   * and every later send.
   */
  const ensureStarted = () => {
    if (bridgeExited) {
      throw makeError(
        X`OpencodeClient(${q(sessionId)}): opencode bridge exited (${q(bridgeExitReason)})`,
      );
    }
    if (!startPromise) {
      const ready = new Promise((resolve, reject) => {
        resolveReady = () => resolve(undefined);
        rejectReady = reject;
      });
      // Cancellation may reject readiness before acquisition has settled.
      void ready.catch(() => {});
      const acquisition = (async () => {
        await null;
        guardLive();
        const { slice: activeSlice } = await ensureProvisioned();
        guardLive();
        const activeProc = /** @type {ProcessHandle} */ (
          await E(activeSlice).spawn(
            harden([...bridgeArgv]),
            harden({
              cwd: workspacePath,
              env: { ...env },
              captureStdout: true,
              captureStderr: true,
            }),
          )
        );
        // Retain an already-admitted spawn result before honoring the fence.
        proc = activeProc;
        guardLive();
        stdin = await makeStdinWriter(activeProc);
        guardLive();
        drainStderr(activeProc);
        consumeStdout(activeProc);
      })();
      startupAcquisition = acquisition;
      const start = acquisition.then(() => ready);
      startPromise = start;
      start.catch(() => {
        if (startPromise === start) {
          startPromise = undefined;
        }
      });
    }
    return startPromise;
  };

  /**
   * @param {object} command
   * @returns {Promise<void>}
   */
  const writeCommand = command => {
    writeChain = writeChain.then(async () => {
      guardLive();
      if (!stdin) {
        throw makeError(
          X`OpencodeClient(${q(sessionId)}): bridge stdin is not available`,
        );
      }
      const result = await stdin.next(encodeBridgeCommand(command));
      if (result.done) {
        throw makeError(
          X`OpencodeClient(${q(sessionId)}): bridge stdin closed before command write`,
        );
      }
    });
    return writeChain;
  };

  /**
   * Write the next queued send once the previous turn's terminal landed.
   * Serializing here is what makes one terminal per send observable: the
   * bridge never sees two `send` commands in flight.
   */
  const dispatchNext = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      await null;
      while (!terminated && active === null && pendingTurns.length > 0) {
        const turn = /** @type {Turn} */ (pendingTurns.shift());
        if (turn.closed) {
          turn.settle();
        } else {
          let startFailure;
          try {
            // eslint-disable-next-line no-await-in-loop
            await ensureStarted();
          } catch (error) {
            startFailure = error;
          }
          if (startFailure) {
            turn.push({
              type: 'abort',
              reason:
                startFailure instanceof Error
                  ? startFailure.message
                  : String(startFailure),
            });
            turn.settle();
          } else {
            active = turn;
            activeBytes = 0;
            try {
              // Composed here, not at `send`: the bridge starts lazily on
              // the first turn, so whether this incarnation has a
              // conversation to continue is only known once it says so. One
              // turn at a time is the point — a restoration completes before
              // the prompt it precedes.
              /* eslint-disable no-await-in-loop */
              const restored = await restoreOnce(turn);
              await writeCommand({
                op: 'send',
                text: `${restored}${turn.text}`,
              });
              /* eslint-enable no-await-in-loop */
            } catch (error) {
              if (active === turn) active = null;
              turn.push({
                type: 'abort',
                reason: error instanceof Error ? error.message : String(error),
              });
              turn.settle();
            }
          }
        }
      }
    } finally {
      dispatching = false;
    }
  };

  /**
   * @param {string} text
   * @param {{ systemPrompt?: string, transcript?: readonly any[] }} [opts]
   * @returns {Turn}
   */
  const enqueueTurn = (text, opts = {}) => {
    const { push, reader, setOnClose } = makeBufferedReader();
    let settle = () => {};
    const terminal = new Promise(resolve => {
      settle = () => resolve(undefined);
    });
    /** @type {Turn} */
    const turn = {
      text,
      transcript: opts.transcript,
      systemPrompt: opts.systemPrompt,
      reader,
      push,
      closed: false,
      terminal,
      settle,
    };
    setOnClose(() => {
      turn.closed = true;
      if (active === turn) {
        // Consumer stopped pulling: abort the executing turn.  The pushed
        // terminal (if it still arrives) lands in a finished reader, which
        // is a no-op; `settle` only matters for a still-parked reader.
        turn.settle();
        writeCommand({ op: 'interrupt' }).catch(() => {});
        return;
      }
      const index = pendingTurns.indexOf(turn);
      if (index >= 0) {
        pendingTurns.splice(index, 1);
        push({ type: 'abort', reason: 'turn cancelled before it ran' });
        settle();
      }
    });
    pendingTurns.push(turn);
    void dispatchNext();
    return turn;
  };

  /** @type {((ok: boolean) => void) | undefined} */
  let resolveImported;
  // What the imported messages are attributed to. The agent is opencode's
  // default persona name; the model is the session's own, split into the
  // provider-scoped ref the import route takes. A session with no recorded
  // model does not import — an attribution invented here would be a claim
  // about which model said what.
  const importAgent = 'build';
  const importModel = model
    ? harden({
        providerID: String(model).split('/')[0],
        modelID: String(model).split('/').slice(1).join('/'),
      })
    : undefined;

  /**
   * Hand this session the conversation the stack holds, once per incarnation.
   *
   * Structured first: the server records each turn as its own message, so a
   * tool call comes back a tool call. An image built before that route exists
   * says so, and the conversation is read into the next prompt instead —
   * lossy, but a conversation the model can see beats one it cannot.
   *
   * @param {any} turn
   * @returns {Promise<string>} text to prepend, empty when the import took it.
   */
  const restoreOnce = async turn => {
    if (!restorationPending) return '';
    restorationPending = false;
    const records = Array.isArray(turn.transcript) ? turn.transcript : [];
    if (records.length === 0) return '';
    const turns = importedTurnsFor(records);
    if (turns.length > 0 && importModel !== undefined) {
      const imported = new Promise(resolve => {
        resolveImported = resolve;
      });
      try {
        await writeCommand({
          op: 'import',
          agent: importAgent,
          model: importModel,
          turns,
        });
        const ok = await Promise.race([
          imported,
          new Promise(resolve => {
            setTimeout(() => resolve(false), IMPORT_TIMEOUT_MS);
          }),
        ]);
        if (ok) return '';
      } catch {
        // Fall through to reading the conversation into the prompt.
      } finally {
        resolveImported = undefined;
      }
    }
    return `${renderTranscriptDialogue(records)}\n\n`;
  };

  const createClient = () => {
    // Fire-and-forget the initial prompt: queue it as the first turn and
    // drain it in the background.  Skipped on a reincarnated client whose
    // opencode session is being resumed, so the env-borne prompt is not
    // re-fired as a spurious extra turn on every daemon restart.
    if (initialPrompt && !resumePriorConversation) {
      const initReader = enqueueTurn(String(initialPrompt), {});
      (async () => {
        for await (const event of iterateReader(
          /** @type {any} */ (initReader.reader),
          { buffer: 8 },
        )) {
          // discarded — nobody is watching this turn's transcript
          void event;
        }
      })().catch(() => {});
    }

    /** @type {Promise<void> | undefined} */
    let terminationFlight;
    /** @type {Promise<void> | undefined} */
    let destructionFlight;
    const terminate = () => {
      if (!terminated) {
        // Fence new turns immediately, independently of cleanup success.
        terminated = true;
        rejectReady?.(
          makeError(X`OpencodeClient(${q(sessionId)}) is terminated.`),
        );
        const turns = [active, ...pendingTurns].filter(Boolean);
        active = null;
        pendingTurns.length = 0;
        for (const turn of turns) {
          /** @type {Turn} */ (turn).push({
            type: 'abort',
            reason: 'session terminated',
          });
          /** @type {Turn} */ (turn).settle();
        }
      }
      if (!terminationFlight) {
        terminationFlight = (async () => {
          await null;
          // Slice disposal is the containment barrier. Never put guest stdin
          // shutdown or its ready handshake ahead of host-side disposal.
          await releaseResources();
          // Disposal fences admitted spawns; retain their returned handles
          // until acquisition settles, without waiting for guest readiness.
          await startupAcquisition?.catch(() => {});
          proc = null;
          stdin = null;
          resolveReady = undefined;
          rejectReady = undefined;
          cleanupComplete = true;
        })().catch(error => {
          terminationFlight = undefined;
          throw error;
        });
      }
      return terminationFlight;
    };

    return makeExo('OpencodeClient', OpencodeClientInterface, {
      /**
       * Start a turn and return its reply reader immediately.  The turn
       * queues behind any in-flight turn; the reader yields hosted events
       * followed by exactly one terminal (`end` or `abort`).
       *
       * @param {string} prompt
       * @param {{ systemPrompt?: string, transcript?: readonly any[] }} [opts]
       */
      async send(prompt, opts = {}) {
        guardLive();
        if (bridgeExited) {
          // The long-lived bridge is gone; a fresh process would silently
          // start a new opencode history.  Fail closed instead.
          throw makeError(
            X`OpencodeClient(${q(sessionId)}): opencode bridge exited (${q(bridgeExitReason)})`,
          );
        }
        const requestedPrompt = opts.systemPrompt;
        if (requestedPrompt !== undefined && requestedPrompt !== systemPrompt) {
          throw makeError(
            X`OpencodeClient(${q(sessionId)}): a turn cannot change the session persona; the opencode agent prompt is fixed at config load`,
          );
        }
        // A new incarnation with no opencode session of its own would
        // otherwise start context-free: the store is the guest's, and a
        // conversation it no longer holds is one the model cannot see. The
        // stack's record goes in front of the first turn instead.
        //
        // Not faithful, and not pretending to be: opencode's own store is the
        // only place a tool call can be a tool call, and reaching it needs an
        // import path that does not enter the prompt lifecycle
        // (`designs/hosted-agent-sandbox-unification.md`). Until that exists,
        // the conversation arrives as the conversation, read rather than
        // replayed — which is what Codex does for the same reason.
        return enqueueTurn(String(prompt), opts).reader;
      },

      /**
       * Abort the active turn and await its terminal.  When this resolves
       * the interrupted turn is over, so a later `send()` cannot race it.
       */
      async interrupt() {
        guardLive();
        const turn = active;
        if (!turn) {
          // A queued turn that has not started yet is cancelled here; the
          // first-send provisioning window can be seconds long.
          let cancelled = false;
          for (const queued of pendingTurns) {
            queued.closed = true;
            cancelled = true;
          }
          if (cancelled) {
            void dispatchNext();
            return;
          }
          throw makeError(
            X`OpencodeClient(${q(sessionId)}): no in-flight prompt to interrupt.`,
          );
        }
        await writeCommand({ op: 'interrupt' });
        // The bridge's own grace timer is untrusted; bound the host-side wait
        // so a hostile or wedged bridge cannot hang the caller forever.
        let deadlineTimer;
        const deadline = new Promise((_, reject) => {
          deadlineTimer = setTimeout(
            () =>
              reject(
                makeError(
                  X`OpencodeClient(${q(sessionId)}): interrupt timed out.`,
                ),
              ),
            INTERRUPT_DEADLINE_MS,
          );
          deadlineTimer.unref();
        });
        try {
          await Promise.race([turn.terminal, deadline]);
        } finally {
          clearTimeout(deadlineTimer);
        }
      },

      /**
       * Tear down the live incarnation: abort the in-flight turn, stop the
       * bridge and its server child, dispose the slice, unmount the 9P
       * mounts, drop the mount pet names, and revoke the credential grant.
       * Durable workspace and state survive for the next revival.
       */
      async terminate() {
        await terminate();
      },

      /**
       * Destroy the session's durable state in addition to terminating the
       * live incarnation.  The backend factory's destroy path calls this;
       * a plain terminate/cancel must not.
       */
      async destroy() {
        if (destroyed) return;
        if (!destructionFlight) {
          destructionFlight = (async () => {
            await null;
            await terminate();
            if (removeState) await removeState();
            destroyed = true;
          })().catch(error => {
            destructionFlight = undefined;
            throw error;
          });
        }
        await destructionFlight;
      },

      async status() {
        return harden({
          sessionId,
          createdAt,
          workspaceMountPoint,
          statePath,
          backend,
          rootfs: rootfsLabel,
          model,
          network: env.NETWORK || 'private',
          opencodeSessionId,
          terminated,
          stopped: cleanupComplete,
          bridgeRunning: Boolean(proc) && !bridgeExited,
          bridgeExited,
          pendingPrompts: pendingTurns.length,
          turnActive: active !== null,
        });
      },

      /**
       * @param {string} [methodName]
       */
      help(methodName) {
        if (methodName === undefined) {
          return [
            'OpencodeClient: one long-lived opencode session in a sandbox slice.',
            '  send(prompt, opts?) → reply reader of hosted events, terminated',
            '                        by exactly one {type:"end"} or',
            '                        {type:"abort",reason} (consume with',
            '                        makeRefIterator). Turns queue.',
            '  interrupt()         → abort the active turn and await its',
            '                        terminal (barrier).',
            '  terminate()         → stop bridge + slice + mounts; keeps state.',
            '  destroy()           → terminate() + delete durable state.',
            '  status()            → { sessionId, opencodeSessionId, terminated, stopped,',
            '                          bridgeRunning, pendingPrompts, ... }',
            '    terminated fences turns; stopped means resource cleanup completed.',
          ].join('\n');
        }
        return `No documentation for method "${q(methodName)}".`;
      },
    });
  };

  return createClient();
};
harden(makeOpencodeClient);
