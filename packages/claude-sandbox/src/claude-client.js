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
 * after the first resumes the conversation persisted in the session's
 * Claude config dir (a dedicated per-session mount that survives daemon
 * restarts — see `claude-client-module.js`), letting a sequence of
 * `send()` calls build on each other (no long-lived stdin plumbing).
 * A client reincarnated after a restart is constructed with
 * `resumePriorConversation: true` when that config dir already holds a
 * transcript, so its very first post-restart turn resumes instead of
 * forking a fresh, context-free conversation.
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
 *   handle backing the cap. The attach registrar owns it across slice
 *   recreates; `terminate()` still unmounts it, because terminate destroys
 *   the whole CLI environment rather than one bind.
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
 * @property {(extraMounts?: readonly ExtraMountSpec[]) => Promise<{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> }, configMountHandle?: { unmount: () => Promise<void> }, revoke?: () => Promise<void>, removeMount?: () => Promise<void> }>} [provision]
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
 * @property {string} [systemPrompt] - Default system prompt appended to
 *   every spawn via `--append-system-prompt`, so the CLI's own agent loop
 *   runs under the caller's persona/instructions in addition to Claude
 *   Code's built-in prompt. Overridable per turn via `send(prompt, {
 *   systemPrompt })`. Omitted argv when neither is set.
 * @property {boolean} [resumePriorConversation] - Seed
 *   `conversationStarted` so the very first `send()` passes `--continue`.
 *   Set by `claude-client-module.js` when a reincarnated session's
 *   persistent Claude config dir already holds a transcript, so a
 *   post-restart turn resumes the pre-restart conversation instead of
 *   starting a fresh, context-free one. Defaults to `false` (a brand-new
 *   session has nothing to resume).
 * @property {() => boolean} [detectPriorConversation] - Ground-truth
 *   check for a persisted transcript, consulted before *every* spawn
 *   (not once at construction). When provided it decides `--continue`
 *   directly, which closes two gaps the in-memory flag cannot: a first
 *   turn killed before Claude persisted anything must NOT make the next
 *   turn pass `--continue` (there is nothing to resume — the CLI would
 *   error or silently fork a fresh conversation), and a post-restart
 *   turn must resume whenever a transcript exists even if the one-shot
 *   construction-time detection raced or failed. A detector throw falls
 *   back to the in-memory flag. Also gates `initialPrompt`, so a
 *   reincarnated formula does not re-fire its initial prompt as a
 *   spurious extra turn on every daemon restart.
 * @property {() => string | undefined} [resolveResumeSessionId] - The id
 *   of the newest persisted conversation, read from the session's config
 *   dir before every spawn. When it yields an id the turn resumes that
 *   conversation by name (`--resume <id>`) rather than asking the CLI to
 *   infer "the most recent conversation" (`--continue`); a named resume
 *   that cannot be honoured fails loudly instead of silently forking a
 *   fresh, context-free conversation. Absent for sessions with no
 *   persistent config dir, which fall back to `--continue`.
 * @property {() => unknown} [describeTranscripts] - Opt-in resume
 *   diagnostic (see `ENDO_CLAUDE_DEBUG_RESUME` in
 *   `claude-client-module.js`). When set, every spawn reports the
 *   resume decision, Claude's own `system/init` event, and whether the
 *   turn's prompt chained onto earlier ones. Absent in production.
 * @property {string} [mcpConfigPath] - Slice-internal path to an MCP
 *   config file (see the floot package's mcp-socket-server). When set,
 *   every spawn passes `--mcp-config` (with this path) and
 *   `--strict-mcp-config`, wiring the CLI to the session's Endo tool
 *   bridge over a mounted Unix socket and ignoring any ambient
 *   project/user MCP config.
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
  systemPrompt,
  mcpConfigPath,
  env = {},
  initialPrompt,
  resumePriorConversation = false,
  detectPriorConversation,
  resolveResumeSessionId,
  describeTranscripts,
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
  // `--continue` resumes the most recent conversation persisted in the
  // session's Claude config dir. A brand-new session has nothing to
  // resume, so `--continue` is omitted until one prompt has been
  // dispatched. A session reincarnated after a daemon restart, whose
  // persistent config dir already holds a transcript, is constructed with
  // `resumePriorConversation: true` so its first post-restart turn
  // resumes the pre-restart conversation rather than forking a fresh one.
  let conversationStarted = resumePriorConversation;
  // Whether the *next* spawn should resume at all, and whether `initialPrompt`
  // has already been answered. The detector, when present, is the ground truth
  // (it reads the persisted transcript), so a turn killed before Claude
  // persisted anything does not poison the next turn with a resume that has
  // nothing to resume, and a post-restart turn resumes whenever a transcript
  // actually exists. Which conversation to resume is a separate question,
  // answered by `resolveResumeSessionId`. Without a detector (tests, ephemeral
  // tmpfs config dirs) the in-memory flag is all we have.
  const priorConversation = () => {
    if (detectPriorConversation) {
      try {
        return detectPriorConversation();
      } catch {
        // Unreadable backing dir (transient fs race): fall back to the flag.
      }
    }
    return conversationStarted;
  };
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
  // True while a recreate is tearing down the live slice, so the killed
  // in-flight turn's abort reason names the recreate instead of a bare
  // signal.
  let recreating = false;
  // A recreate's teardown must finish before a racing turn re-provisions:
  // both the old teardown and the new provision touch the same host
  // mountpoints (workspace/config 9P), so an overlap could unmount the fresh
  // mount. `ensureProvisioned` chains behind this gate.
  /** @type {Promise<void>} */
  let pendingTeardown = Promise.resolve();

  // Workspace provisioning. Direct `slice` / `mountHandle` are treated
  // as already provisioned (eager); a `provision` thunk is run once on
  // first use (lazy) and memoized. `provisioned` stays `undefined`
  // until a lazy provision starts, so `terminate()` before any use is
  // a no-op rather than spinning up a container just to tear it down.
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
  const ensureProvisioned = () => {
    if (provisioned === undefined) {
      // A terminated client must never re-provision: `terminate()` tears down
      // only what `provisioned` names at the moment it runs, so a provision
      // started after it (a queued turn racing terminate, or a recreate whose
      // teardown terminate raced past) would leak a container, its 9P
      // mounts, and a fresh credential grant with no owner left to release
      // them.
      guardLive();
      const pending = pendingTeardown.then(() =>
        /** @type {NonNullable<typeof provision>} */ (provision)(extraMounts),
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
   * While a recreate is disposing the live slice, the in-flight `claude`
   * process dies because WE killed it (attach/detach is disruptive by design —
   * see designs/runtime-container-fs-mount.md). The turn genuinely ends, so it
   * still aborts; but the reason should describe the restart, not the symptoms
   * of our own kill.
   *
   * The exit code and stderr of a process we SIGKILLed describe the kill, and
   * reporting them turns an expected restart into what reads as a crash on
   * session start — "claude exited with code 1" — which is exactly how this
   * gets misdiagnosed.
   *
   * @param {string} base
   */
  const abortReasonInContext = base => {
    if (!recreating) return base;
    const paths = extraMounts
      .map(spec => spec && spec.innerPath)
      .filter(Boolean)
      .join(', ');
    return `sandbox restarted to apply a container mount change${
      paths ? ` (${paths})` : ''
    } — the attach succeeded; send this turn again to continue`;
  };

  /**
   * Whether the current abort is our own doing, and so should not carry the
   * killed process's diagnostics.
   */
  const abortIsByDesign = () => recreating;

  /**
   * Spawn one `claude -p` process inside the slice and return its
   * `ProcessHandle`.
   *
   * @param {string} prompt
   * @param {{ model?: string, systemPrompt?: string }} [opts]
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
    if (mcpConfigPath) {
      // Wire the session's Endo tool bridge (mounted Unix socket) and ignore
      // any project/user .mcp.json so only these capability-bounded tools load.
      argv.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
    }
    const useModel = opts.model || model;
    if (useModel) {
      argv.push('--model', useModel);
    }
    // Append the caller's persona/instructions to Claude Code's built-in
    // system prompt so the CLI's own agent loop honors them (the CLI never
    // sees the conversation-tree system message the API path injects). Sent
    // on every spawn — each `claude -p` is a fresh process — so a resumed
    // (`--continue`) turn keeps the same persona as the first.
    const useSystemPrompt = opts.systemPrompt || systemPrompt;
    if (useSystemPrompt) {
      argv.push('--append-system-prompt', String(useSystemPrompt));
    }
    // Resume the conversation by its own id when we can read one off the
    // persisted transcript. `--continue` asks the CLI to pick "the most recent
    // conversation" by its own reckoning; naming the session removes that
    // inference and fails loudly ("No conversation found with session ID")
    // instead of silently starting a fresh, context-free one. Sessions with no
    // persistent config dir (older ones, on the ephemeral tmpfs) have no id to
    // read, so they keep the `--continue` behaviour.
    let resumeSessionId;
    if (resolveResumeSessionId) {
      try {
        resumeSessionId = resolveResumeSessionId();
      } catch {
        // Unreadable backing dir (transient fs race): fall back to --continue.
      }
    }
    const resuming = resumeSessionId !== undefined || priorConversation();
    if (resumeSessionId !== undefined) {
      argv.push('--resume', resumeSessionId);
    } else if (resuming) {
      argv.push('--continue');
    }
    if (describeTranscripts) {
      // The prompt is user content; report only its length so the journal
      // carries the resume decision without the conversation itself.
      console.error(
        '[claude-sandbox] spawn',
        JSON.stringify({
          sessionId,
          resuming,
          resumeSessionId,
          detector: Boolean(detectPriorConversation),
          conversationStarted,
          promptChars: String(prompt).length,
          argv: argv.filter(arg => arg !== String(prompt)),
          transcripts: describeTranscripts(),
        }),
      );
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
   * @param {{ model?: string, systemPrompt?: string }} [opts]
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
          ...(abortIsByDesign() ? { expected: true } : {}),
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
          if (
            describeTranscripts &&
            event?.type === 'system' &&
            event?.subtype === 'init'
          ) {
            // What the CLI itself believes it opened. A `session_id` other than
            // the one we asked to resume means the resume did not take.
            console.error(
              '[claude-sandbox] init',
              JSON.stringify({
                sessionId,
                claudeSessionId: event.session_id,
                cwd: event.cwd,
                model: event.model,
                version: event.claude_code_version,
                apiKeySource: event.apiKeySource,
              }),
            );
          }
          push(event);
        }
        if (describeTranscripts) {
          // Ground truth for the turn: whether the prompt Claude just persisted
          // chained onto the conversation, or started a fresh root.
          console.error(
            '[claude-sandbox] after-turn',
            JSON.stringify({ sessionId, transcripts: describeTranscripts() }),
          );
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
          const base = abortReasonInContext(`claude ${how}`);
          const stderrText = abortIsByDesign()
            ? ''
            : await readStderrBrief(proc);
          push({
            type: 'abort',
            reason: stderrText
              ? `${base}\n--- stderr ---\n${stderrText}`
              : base,
            ...(abortIsByDesign() ? { expected: true } : {}),
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
        // error. Skipped for a recreate: the diagnostics would be of our own
        // kill.
        await E(proc)
          .kill()
          .catch(() => {});
        const stderrText = abortIsByDesign() ? '' : await readStderrBrief(proc);
        push({
          type: 'abort',
          reason: stderrText ? `${base}\n--- stderr ---\n${stderrText}` : base,
          ...(abortIsByDesign() ? { expected: true } : {}),
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
  //
  // Only on a genuinely fresh session: the prompt rides in the formula env,
  // so a reincarnated formula would otherwise re-fire it as a spurious extra
  // turn on every daemon restart (and, when resume detection missed, that
  // re-fired turn would become the fresh conversation all later `--continue`
  // turns build on — total context loss).
  if (initialPrompt && !priorConversation()) {
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
      try {
        try {
          /** @type {Awaited<typeof prior> | undefined} */
          let resolved;
          try {
            resolved = await prior;
          } catch {
            // The prior provision failed and already cleaned up after
            // itself; the next provision binds the new set.
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
          // Unmount the workspace/config 9P mounts so the re-provision can
          // remount the same host mountpoints. The extras' own 9P bridges
          // are NOT touched: the attach registrar owns them across
          // recreates (they die only on detach or terminate).
          for (const handle of [
            resolved.mountHandle,
            resolved.configMountHandle,
          ]) {
            if (handle) {
              try {
                await E(handle).unmount();
              } catch {
                // best-effort
              }
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
        // missing cleanup, so simply stop here.
        if (terminated) {
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
     * @param {{ model?: string, systemPrompt?: string }} [opts] - Per-turn
     *   overrides: `model` for `--model`, `systemPrompt` for
     *   `--append-system-prompt` (each falls back to the constructor
     *   default when omitted).
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
      // Runtime-attached extras destroyed too: terminate destroys the
      // whole shared CLI environment, not one session's view of it, so
      // every 9P bridge handed in with the attach set is released (a mere
      // recreate never touches these). Done before the provisioned check —
      // an attach can precede the first provision.
      for (const extra of extraMounts) {
        if (extra.handle) {
          try {
            await E(extra.handle).unmount();
          } catch {
            // best-effort; the bridge caplet also unmounts on teardown
          }
        }
      }
      // Only tear down what was actually provisioned. If the workspace
      // was never provisioned (lazy client that never ran), there is
      // no container or mount to release.
      if (provisioned === undefined) {
        return;
      }
      /** @type {{ slice: SandboxHandle, mountHandle?: { unmount: () => Promise<void> }, configMountHandle?: { unmount: () => Promise<void> }, revoke?: () => Promise<void>, removeMount?: () => Promise<void> } | undefined} */
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
      // The persistent Claude config dir is a second host-side 9P mount; it
      // must be released too. Its backing directory survives (that is the
      // whole point — the transcript persists for the next revival); only the
      // live mount is torn down.
      if (resolved.configMountHandle) {
        try {
          await E(resolved.configMountHandle).unmount();
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
