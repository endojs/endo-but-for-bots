// In-slice bridge for @endo/opencode-sandbox.
//
// One long-lived Node process per session incarnation. It starts a local
// `opencode serve` child, subscribes to its SSE event stream, and speaks
// newline-delimited JSON with the host over stdin/stdout. The pure helpers at
// the top are exported for unit tests; `main()` only runs when this file is
// the process entry point.
//
// Bridge -> host events (see opencode-protocol.js):
//   ready | phase | text-delta | thinking-delta | tool-call | tool-result |
//   usage | end | abort
// Host -> bridge commands:
//   { op: "send", text } | { op: "interrupt" } | { op: "shutdown" }
//
// Only events for the bridge's own session are forwarded: the server event bus
// is per-instance, so Task/subagent sessions share it. Bridge output is
// untrusted UI text, not attestation.
//
// This file is baked into the image at /opt/opencode-bridge/bridge.mjs; it
// must not import workspace packages.

/* global fetch */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { clearTimeout, setImmediate, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

// ---- environment knobs -----------------------------------------------------

const LISTEN_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 5000;
const API_TIMEOUT_MS = 10_000;
const STDERR_TAIL_BYTES = 2048;
// The native producer bounds checkpoints to 16 MiB. JSON tool inputs are
// encoded again as canonical argument strings, so the output needs twice that
// space plus envelope headroom. These are transport, not model-token limits.
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 34 * 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 17 * 1024 * 1024;

const positiveEnvNumber = (raw, fallback) => {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Remove secret-shaped material before it can reach the host transcript.
 * @param text
 * @param secrets
 */
const redactSecrets = (text, secrets) => {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      out = out.replaceAll(secret, '[redacted]');
    }
  }
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
};

// Off unless the operator sets one: a long turn is the user's to interrupt,
// and the 30-minute default this used to carry ended real review turns —
// dozens of tool calls around long model time — rather than anything the
// host had to bound. The client passes ENDO_OPENCODE_BRIDGE_TURN_TIMEOUT_MS
// through when an operator wants an explicit budget.
const TURN_TIMEOUT_MS = positiveEnvNumber(
  process.env.OPENCODE_BRIDGE_TURN_TIMEOUT_MS,
  0,
);

// ---- pure helpers ----------------------------------------------------------

/**
 * Parse the child's `opencode server listening on http://host:port` line. Only
 * the loopback HTTP origin is accepted so the server password cannot be sent
 * to a redirected origin.
 * @param line
 */
export const parseListeningLine = line => {
  const match = /listening on (https?:\/\/[^\s]+)/.exec(line);
  if (!match) return undefined;
  try {
    const url = new URL(match[1]);
    if (url.protocol !== 'http:') return undefined;
    if (url.hostname !== '127.0.0.1' && url.hostname !== '::1')
      return undefined;
    const port = Number(url.port);
    if (!Number.isSafeInteger(port) || port <= 0) return undefined;
    return Object.freeze({ host: url.hostname, port });
  } catch {
    return undefined;
  }
};

/**
 * Message registry: tracks role and summary flags, part types, and which
 * deltas were seen so a completed part without deltas can still be emitted.
 * @param {object} [options]
 * @param {string} [options.mcpServerName]
 * @param {Map<string, number>} [options.contextWindows]
 */
export const makeMessageRegistry = ({
  mcpServerName = '',
  contextWindows = new Map(),
} = {}) => {
  const messages = new Map(); // messageID -> { role, summary, model }
  const parts = new Map(); // partID -> { messageID, type, sawDelta }
  const summaryIDs = new Set();
  // opencode names MCP tools `<server>_<tool>` (e.g. `endo_list`), while the
  // durable Endo execution evidence is recorded under the tool's own name
  // (`list`). Report the canonical name so the two records dedupe instead of
  // showing the same execution twice in the transcript.
  const mcpPrefix = mcpServerName ? `${mcpServerName}_` : '';
  // opencode re-emits `message.part.updated` with status 'running' as a tool
  // part's input streams, and may repeat the terminal update. Floot requires
  // each hosted tool call to have a unique id and each result a single
  // matching unsettled call, so track what was emitted per callID.
  const startedToolCalls = new Set();
  const finishedToolCalls = new Set();
  const checkpoints = new Map();
  const reportedUsage = new Set();

  const isCompactionSummary = info =>
    info?.role === 'assistant' && info.summary === true;

  return Object.freeze({
    acceptCheckpoint(checkpoint) {
      const encoded = JSON.stringify(checkpoint);
      if (Buffer.byteLength(encoded) > MAX_CHECKPOINT_BYTES) {
        throw new Error('Native compaction checkpoint exceeds transport limit');
      }
      const digest = createHash('sha256').update(encoded).digest('hex');
      const prior = checkpoints.get(checkpoint.summaryID);
      if (prior !== undefined) {
        if (prior !== digest)
          throw new Error('Native compaction checkpoint identity changed');
        return false;
      }
      if (checkpoints.size >= 65_536)
        throw new Error('Native compaction checkpoint identity limit exceeded');
      checkpoints.set(checkpoint.summaryID, digest);
      return true;
    },
    noteMessage(info) {
      if (!info || typeof info.id !== 'string') return;
      messages.set(info.id, {
        role: info.role,
        summary: info.summary === true,
        model:
          typeof info.providerID === 'string' &&
          typeof info.modelID === 'string'
            ? `${info.providerID}/${info.modelID}`
            : undefined,
      });
      if (isCompactionSummary(info)) summaryIDs.add(info.id);
    },
    notePart(part) {
      if (!part || typeof part.id !== 'string') return;
      parts.set(part.id, {
        messageID: part.messageID,
        type: part.type,
        sawDelta: parts.get(part.id)?.sawDelta === true,
      });
    },
    noteDelta(partID) {
      const part = parts.get(partID);
      if (part) part.sawDelta = true;
    },
    canonicalToolName(name) {
      return mcpPrefix && name.startsWith(mcpPrefix)
        ? name.slice(mcpPrefix.length)
        : name;
    },
    markToolCall(callID) {
      if (startedToolCalls.has(callID)) return false;
      startedToolCalls.add(callID);
      return true;
    },
    hasToolCall(callID) {
      return startedToolCalls.has(callID);
    },
    markToolResult(callID) {
      if (finishedToolCalls.has(callID)) return false;
      finishedToolCalls.add(callID);
      return true;
    },
    isSummaryMessage(messageID) {
      return summaryIDs.has(messageID);
    },
    markUsage(partID) {
      if (
        messages.get(parts.get(partID)?.messageID)?.role !== 'assistant' ||
        reportedUsage.has(partID)
      )
        return false;
      reportedUsage.add(partID);
      return true;
    },
    isVisibleAssistantPart(partID) {
      const part = parts.get(partID);
      if (!part) return false;
      const message = messages.get(part.messageID);
      if (message?.role !== 'assistant') return false;
      return !summaryIDs.has(part.messageID);
    },
    partType(partID) {
      return parts.get(partID)?.type;
    },
    /**
     * The context window of the model that produced a part; 0 if unknown.
     * @param partID
     */
    contextWindowOfPart(partID) {
      const model = messages.get(parts.get(partID)?.messageID)?.model;
      const window = model === undefined ? 0 : contextWindows.get(model);
      return typeof window === 'number' && window > 0 ? window : 0;
    },
    sawDelta(partID) {
      return parts.get(partID)?.sawDelta === true;
    },
  });
};

const count = value =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;

/**
 * The hosted `usage` event for one finished model step. opencode's `tokens`
 * are already disjoint: `input` excludes the cache reads and writes, and
 * `output` excludes `reasoning`. That is `getUsage` in
 * `packages/opencode/src/session/session.ts` of the fork the image is built
 * from (`adjustedInputTokens`, `outputTokens - reasoningTokens`), read at its
 * `build/v1.18.30-endo-session-import` branch. What the step put in the
 * window is its `total` when the provider gave one, otherwise the sum.
 *
 * @param {any} tokens
 * @param {number} windowTokens 0 when the model's limit is not known
 */
export const usageEventFromStep = (tokens, windowTokens) => {
  const counts = {
    inputTokens: count(tokens.input),
    outputTokens: count(tokens.output),
    cachedInputTokens: count(tokens.cache?.read),
    cacheWriteInputTokens: count(tokens.cache?.write),
    reasoningOutputTokens: count(tokens.reasoning),
  };
  const usedTokens =
    count(tokens.total) ||
    counts.inputTokens +
      counts.outputTokens +
      counts.cachedInputTokens +
      counts.cacheWriteInputTokens +
      counts.reasoningOutputTokens;
  return Object.freeze({
    type: 'usage',
    ...counts,
    ...(usedTokens === 0 && windowTokens === 0
      ? {}
      : { context: Object.freeze({ usedTokens, windowTokens }) }),
  });
};

/**
 * `provider/model` to context window, from `GET /config/providers`.
 *
 * @param {any} listing
 * @returns {Map<string, number>}
 */
export const contextWindowsFrom = listing => {
  const windows = new Map();
  const providers = Array.isArray(listing?.providers) ? listing.providers : [];
  for (const provider of providers) {
    const models =
      typeof provider?.id === 'string' &&
      provider.models !== null &&
      typeof provider.models === 'object'
        ? provider.models
        : {};
    for (const [modelID, model] of Object.entries(models)) {
      const window = count(/** @type {any} */ (model)?.limit?.context);
      if (window > 0) windows.set(`${provider.id}/${modelID}`, window);
    }
  }
  return windows;
};

/**
 * Is this the synthetic compaction continuation prompt?
 * @param part
 */
export const isCompactionContinuation = part =>
  part?.type === 'text' &&
  part.synthetic === true &&
  part.metadata?.compaction_continue === true;

/**
 * Project the pinned fork's authoritative snapshot, not an SSE history mirror.
 * This is the stack's text/tool context contract, not a byte-for-byte provider
 * prompt: reasoning and provider metadata are not represented by that contract.
 * The native compaction request becomes the canonical summary's
 * scaffold on import; its synthetic continuation remains ordinary context.
 * @param {any} checkpoint
 * @param {ReturnType<typeof makeMessageRegistry>} registry
 * @param {string} sessionID
 */
export const projectCompactionCheckpoint = (
  checkpoint,
  registry,
  sessionID,
) => {
  const refuse = () => {
    throw new Error('Unsupported or malformed native compaction checkpoint');
  };
  if (
    checkpoint?.version !== 1 ||
    typeof checkpoint.summaryID !== 'string' ||
    !Array.isArray(checkpoint.messages) ||
    checkpoint.messages.length < 2 ||
    checkpoint.messages.length > 65_536
  )
    refuse();
  const messages = checkpoint.messages;
  const messageIDs = new Set();
  const partIDs = new Set();
  for (const message of messages) {
    const info = message?.info;
    if (
      !info ||
      typeof info.id !== 'string' ||
      info.id === '' ||
      messageIDs.has(info.id) ||
      info.sessionID !== sessionID ||
      !['user', 'assistant'].includes(info.role) ||
      !Array.isArray(message.parts)
    )
      refuse();
    messageIDs.add(info.id);
    for (const part of message.parts) {
      if (
        !part ||
        typeof part.id !== 'string' ||
        part.id === '' ||
        partIDs.has(part.id) ||
        part.messageID !== info.id ||
        part.sessionID !== sessionID ||
        typeof part.type !== 'string'
      )
        refuse();
      partIDs.add(part.id);
    }
  }
  const [request, summary, ...tail] = messages;
  if (
    request.info.role !== 'user' ||
    request.parts.length !== 1 ||
    request.parts[0].type !== 'compaction' ||
    summary.info.role !== 'assistant' ||
    summary.info.summary !== true ||
    summary.info.id !== checkpoint.summaryID ||
    summary.info.parentID !== request.info.id ||
    typeof summary.info.finish !== 'string' ||
    summary.info.finish === '' ||
    summary.info.error
  )
    refuse();
  const retainedTail = [];
  const calls = new Set();
  const appendMessage = (role, content) => {
    if (typeof content !== 'string') refuse();
    if (content !== '') {
      if (role === 'user') calls.clear();
      retainedTail.push({ kind: 'message', role, content });
    }
  };
  // The native projector ignores these storage/accounting parts. Reasoning is
  // display-only in the existing canonical contract; do not turn it into prose.
  const ignored = new Set([
    'reasoning',
    'step-start',
    'step-finish',
    'snapshot',
    'patch',
    'agent',
    'retry',
  ]);
  const summaryText = [];
  for (const part of summary.parts) {
    if (part.type === 'text' && typeof part.text === 'string')
      summaryText.push(part.text);
    else if (!ignored.has(part.type)) refuse();
  }
  if (summaryText.join('') === '') refuse();
  for (const message of tail) {
    const { info, parts } = message;
    if (info.role === 'assistant' && info.summary === true) refuse();
    // Match native omission of failed assistant messages, except interrupted
    // messages containing ordinary content or a tool result.
    if (
      info.role === 'assistant' &&
      info.error &&
      !(
        info.error.name === 'MessageAbortedError' &&
        parts.some(part => !['step-start', 'reasoning'].includes(part.type))
      )
    )
      // eslint-disable-next-line no-continue
      continue;
    for (const part of parts) {
      if (part.type === 'text') {
        if (info.role !== 'user' || !part.ignored)
          appendMessage(info.role, part.text);
      } else if (part.type === 'tool' && info.role === 'assistant') {
        const { state } = part;
        if (
          typeof part.callID !== 'string' ||
          part.callID === '' ||
          calls.has(part.callID) ||
          typeof part.tool !== 'string' ||
          part.tool === '' ||
          !state ||
          !['completed', 'error'].includes(state.status) ||
          state.input === null ||
          typeof state.input !== 'object' ||
          Array.isArray(state.input) ||
          part.metadata?.providerExecuted === true
        )
          refuse();
        calls.add(part.callID);
        const pruned =
          state.status === 'completed' && Boolean(state.time?.compacted);
        if (
          !pruned &&
          state.attachments !== undefined &&
          (!Array.isArray(state.attachments) || state.attachments.length !== 0)
        )
          refuse();
        const interruptedOutput =
          state.status === 'error' &&
          state.metadata?.interrupted === true &&
          typeof state.metadata.output === 'string';
        const content = pruned
          ? '[Old tool result content cleared]'
          : state.status === 'completed'
            ? state.output
            : interruptedOutput
              ? state.metadata.output
              : state.error;
        if (typeof content !== 'string') refuse();
        retainedTail.push({
          kind: 'tool-call',
          id: part.callID,
          name: registry.canonicalToolName(part.tool),
          args: JSON.stringify(state.input),
        });
        retainedTail.push({
          kind: 'tool-result',
          id: part.callID,
          content,
          ...(state.status !== 'completed' && !interruptedOutput
            ? { failed: true }
            : {}),
        });
      } else if (
        part.type === 'file' &&
        info.role === 'user' &&
        ['text/plain', 'application/x-directory'].includes(part.mime)
      ) {
        // Native preprocessing has already expanded these into text parts.
      } else if (part.type === 'subtask' && info.role === 'user') {
        appendMessage('user', 'The following tool was executed by the user');
      } else if (!ignored.has(part.type)) {
        // Media, nested compactions, and unknown context-bearing parts are not
        // silently discarded. Supporting them needs a canonical format change.
        refuse();
      }
    }
  }
  return Object.freeze({
    type: 'compaction',
    summary: summaryText.join(''),
    retainedTail,
  });
};

/**
 * Map one opencode SSE event to zero or one hosted event. Terminal handling
 * and turn state stay in the caller. Events for another session are dropped:
 * the instance event bus also carries Task/subagent sessions.
 *
 * @param {any} event
 * @param {ReturnType<typeof makeMessageRegistry>} registry
 * @param {string} sessionID
 */
export const mapSseEvent = (event, registry, sessionID) => {
  const { type, properties = {} } = event ?? {};
  if (type === 'session.compacted') {
    if (properties.sessionID !== sessionID) return undefined;
    const projected = projectCompactionCheckpoint(
      properties.checkpoint,
      registry,
      sessionID,
    );
    return registry.acceptCheckpoint(properties.checkpoint)
      ? projected
      : undefined;
  }
  if (type === 'message.updated') {
    if (properties.sessionID !== sessionID) return undefined;
    registry.noteMessage(properties.info);
    return undefined;
  }
  if (type === 'message.part.updated') {
    const part = properties.part;
    if (!part || part.sessionID !== sessionID) return undefined;
    registry.notePart(part);
    if (isCompactionContinuation(part)) return undefined;
    if (part.type === 'tool') {
      const state = part.state ?? {};
      if (typeof part.callID !== 'string' || typeof part.tool !== 'string') {
        return undefined;
      }
      const toolName = registry.canonicalToolName(part.tool);
      if (state.status === 'running') {
        // Only the first running update announces the call; later input
        // updates repeat the same callID.
        if (!registry.markToolCall(part.callID)) return undefined;
        return Object.freeze({
          type: 'tool-call',
          id: part.callID,
          name: toolName,
          // Floot renders args as text; a raw object becomes '[object Object]'.
          args:
            typeof state.input === 'string'
              ? state.input
              : JSON.stringify(state.input ?? {}),
        });
      }
      if (state.status === 'completed') {
        if (!registry.markToolResult(part.callID)) return undefined;
        const rendered =
          typeof state.output === 'string'
            ? state.output
            : JSON.stringify(state.output ?? '');
        return Object.freeze({
          type: 'tool-result',
          id: part.callID,
          name: toolName,
          ok: true,
          result: rendered,
        });
      }
      if (state.status === 'error') {
        if (!registry.markToolResult(part.callID)) return undefined;
        const rendered = `${state.error ?? 'tool failed'}`;
        return Object.freeze({
          type: 'tool-result',
          id: part.callID,
          name: toolName,
          ok: false,
          // Floot reads `result` (and treats an absent one as an empty
          // success), so a failure must carry its message there too.
          result: rendered,
          error: rendered,
        });
      }
      return undefined;
    }
    if (
      part.type === 'step-finish' &&
      typeof part.tokens?.input === 'number' &&
      typeof part.tokens?.output === 'number' &&
      registry.markUsage(part.id)
    ) {
      return usageEventFromStep(
        part.tokens,
        registry.contextWindowOfPart(part.id),
      );
    }
    // Completed text/reasoning parts are only used when no deltas arrived.
    if (
      (part.type === 'text' || part.type === 'reasoning') &&
      part.time?.end &&
      !registry.sawDelta(part.id) &&
      registry.isVisibleAssistantPart(part.id)
    ) {
      if (part.text === '') return undefined;
      return Object.freeze({
        type: part.type === 'text' ? 'text-delta' : 'thinking-delta',
        text: part.text,
      });
    }
    return undefined;
  }
  if (type === 'message.part.delta') {
    const { partID, field, delta } = properties;
    if (properties.sessionID !== sessionID) return undefined;
    if (field !== 'text') return undefined;
    if (!registry.isVisibleAssistantPart(partID)) return undefined;
    registry.noteDelta(partID);
    const partType = registry.partType(partID);
    if (partType === 'text') {
      return Object.freeze({ type: 'text-delta', text: delta });
    }
    if (partType === 'reasoning') {
      return Object.freeze({ type: 'thinking-delta', text: delta });
    }
    return undefined;
  }
  if (type === 'session.status' || type === 'session.idle') {
    if (properties.sessionID !== sessionID) return undefined;
    if (type === 'session.idle') {
      return Object.freeze({ type: 'phase', phase: 'idle' });
    }
    const status = properties.status?.type;
    if (status === 'busy')
      return Object.freeze({ type: 'phase', phase: 'busy' });
    if (status === 'idle')
      return Object.freeze({ type: 'phase', phase: 'idle' });
    return undefined;
  }
  if (type === 'session.error') {
    if (properties.sessionID !== sessionID) return undefined;
    if (
      properties.error?.data?.message ===
      'Unable to publish compaction checkpoint'
    ) {
      throw new Error(
        'Native compaction checkpoint failed; session continuity lost',
      );
    }
    return Object.freeze({
      type: 'phase',
      phase: 'error',
      error: `${properties.error?.name ?? 'error'}`,
    });
  }
  return undefined;
};

/**
 * Choose the terminal for a finished turn.
 * @param {{ pendingError?: string, timedOut?: boolean, interrupted?: boolean }} [state]
 */
export const deriveTerminal = ({
  pendingError,
  timedOut,
  interrupted,
} = {}) => {
  if (timedOut) return Object.freeze({ type: 'abort', reason: 'turn timeout' });
  if (interrupted)
    return Object.freeze({ type: 'abort', reason: 'interrupted' });
  if (pendingError)
    return Object.freeze({ type: 'abort', reason: pendingError });
  return Object.freeze({ type: 'end' });
};

/**
 * Split a byte stream of SSE frames into parsed data payloads.
 * @param chunks
 */
export async function* iterateSseData(chunks) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  for await (const chunk of chunks) {
    // Bound each frame, not a coalesced network chunk containing many frames.
    // Slicing also bounds temporary decoder headroom above the current frame.
    for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
      buffer = (
        buffer +
        decoder.decode(chunk.subarray(offset, offset + 64 * 1024), {
          stream: true,
        })
      ).replaceAll('\r\n', '\n');
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (Buffer.byteLength(frame) > MAX_SSE_BUFFER_BYTES) {
          throw new Error('opencode event frame exceeded the bridge buffer');
        }
        const data = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (data !== '') {
          // This event stream has no resumable cursor. Skipping a corrupt
          // checkpoint would silently continue from context Endo never saw.
          const event = JSON.parse(data);
          if (!event || typeof event !== 'object' || Array.isArray(event)) {
            throw new Error('Invalid opencode event frame');
          }
          yield Object.freeze(event);
        }
        index = buffer.indexOf('\n\n');
      }
      if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
        throw new Error('opencode event frame exceeded the bridge buffer');
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== '') throw new Error('Truncated opencode event frame');
}

// ---- main ------------------------------------------------------------------

let activeChild;

const main = async () => {
  // Always authenticate the local server, even if the caller did not supply a
  // password; nothing outside the bridge should be able to drive it.
  const password =
    process.env.OPENCODE_SERVER_PASSWORD || randomBytes(24).toString('hex');
  const username = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
  const executable = process.env.OPENCODE_BIN ?? 'opencode';
  const directory = process.env.OPENCODE_BRIDGE_DIRECTORY ?? process.cwd();

  const headers = {
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };

  const writeEvent = event => {
    const line = JSON.stringify(event);
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      const error = /** @type {Error & { oversize?: boolean }} */ (
        new Error('bridge event too large')
      );
      error.oversize = true;
      throw error;
    }
    if (process.stdout.writableLength > MAX_LINE_BYTES) {
      throw new Error('Bridge output queue exceeded transport limit');
    }
    process.stdout.write(`${line}\n`);
  };

  const child = spawn(
    executable,
    ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        // Background pruning has no durable context-revision event. Keep it
        // off even if another native configuration source requests it; normal
        // summary compaction uses the authoritative checkpoint protocol.
        OPENCODE_DISABLE_PRUNE: '1',
      },
    },
  );
  activeChild = child;

  let stderrTail = '';
  child.stderr.on('data', chunk => {
    stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_BYTES);
  });

  let baseUrl = '';
  let shuttingDown = false;
  const childExit = new Promise(resolve => child.once('exit', resolve));
  child.on('error', () => {
    try {
      writeEvent({
        type: 'abort',
        reason: 'opencode executable failed to start',
      });
    } catch {
      // stdout may already be gone; nothing else to do
    }
    process.exit(1);
  });

  const shutdown = async (code, reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reason !== undefined) {
      try {
        writeEvent({ type: 'abort', reason });
      } catch {
        // best effort
      }
    }
    child.kill('SIGTERM');
    const escalate = setTimeout(() => child.kill('SIGKILL'), 5000);
    escalate.unref();
    await Promise.race([
      childExit,
      new Promise(resolve => {
        const timer = setTimeout(resolve, 6000);
        timer.unref();
      }),
    ]);
    // process.exit does not flush pipes. Preserve complete checkpoints and the
    // terminal when the host is reading, without hanging forever if it is gone.
    let flushTimer;
    await Promise.race([
      new Promise(resolve => process.stdout.write('', resolve)),
      new Promise(resolve => {
        flushTimer = setTimeout(resolve, 2000);
      }),
    ]);
    clearTimeout(flushTimer);
    process.exit(code);
  };

  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('opencode serve did not report a port')),
      LISTEN_TIMEOUT_MS,
    );
    timer.unref();
    const onExit = code =>
      reject(new Error(`opencode serve exited during startup (${code})`));
    child.once('exit', onExit);
    createInterface({ input: child.stdout }).on('line', line => {
      const parsed = parseListeningLine(line);
      if (parsed) {
        clearTimeout(timer);
        child.off('exit', onExit);
        baseUrl = `http://${parsed.host}:${parsed.port}`;
        resolve(parsed);
      }
    });
  });

  const api = async (route, init = {}) => {
    const separator = route.includes('?') ? '&' : '?';
    const url = `${baseUrl}${route}${separator}directory=${encodeURIComponent(directory)}`;
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      const error = /** @type {Error & { status?: number }} */ (
        new Error(
          `opencode ${init.method ?? 'GET'} ${route} -> ${response.status}`,
        )
      );
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return undefined;
    return response.json();
  };

  try {
    await listening;
  } catch (error) {
    await shutdown(1, `${error}`);
    return;
  }

  // Every incarnation starts a fresh native conversation. The host imports
  // its canonical transcript before sending the first prompt; a stale local
  // ID must never bypass that restoration boundary.
  let sessionID;
  try {
    const session = await api('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'endo-opencode-sandbox' }),
    });
    sessionID = session.id;
    if (typeof sessionID !== 'string' || sessionID.length === 0)
      throw Error('server returned no session ID');
  } catch (error) {
    await shutdown(1, `could not create a session: ${error}`);
    return;
  }
  const activeSessionId = String(sessionID);
  writeEvent({
    type: 'ready',
    sessionId: activeSessionId,
    port: Number(new URL(baseUrl).port),
    // What this bridge understands. The image carries the bridge, so a slice
    // running an older one silently ignores a command it does not know and
    // answers nothing — which the client can only discover by waiting out a
    // timeout on every incarnation. Saying so here costs nothing and lets it
    // take the fallback immediately.
    features: ['import', 'fresh-session'],
  });

  // Context limits are only for display, so they load beside the first turn
  // and never delay it. A server that cannot list them still runs turns;
  // usage then reports a window of 0.
  const contextWindows = new Map();
  void api('/config/providers').then(
    listing => {
      for (const [model, window] of contextWindowsFrom(listing)) {
        contextWindows.set(model, window);
      }
    },
    error => {
      process.stderr.write(`opencode-bridge: no context limits: ${error}\n`);
    },
  );
  const registry = makeMessageRegistry({
    mcpServerName: process.env.OPENCODE_MCP_SERVER_NAME || '',
    contextWindows,
  });
  const pendingPrompts = [];
  let inFlight = false;
  let sawBusy = false;
  let pendingError;
  let interrupted = false;
  let turnTimer;
  let interruptTimer;
  const outstandingCalls = new Set();

  const clearTurnTimers = () => {
    clearTimeout(turnTimer);
    clearTimeout(interruptTimer);
  };

  const finishTurn = terminal => {
    if (!inFlight) return;
    if (shuttingDown) return;
    clearTurnTimers();
    inFlight = false;
    sawBusy = false;
    pendingError = undefined;
    interrupted = false;
    outstandingCalls.clear();
    try {
      writeEvent(terminal);
    } catch {
      // The terminal is small; an oversize error here means stdout is gone.
    }
    if (pendingPrompts.length > 0) {
      const next = pendingPrompts.shift();
      setImmediate(() => dispatchSend(next));
    }
  };

  const dispatchSend = text => {
    if (shuttingDown) return;
    inFlight = true;
    sawBusy = false;
    pendingError = undefined;
    interrupted = false;
    clearTurnTimers();
    if (TURN_TIMEOUT_MS > 0) {
      turnTimer = setTimeout(() => {
        void shutdown(1, 'turn timeout; native stop unconfirmed');
      }, TURN_TIMEOUT_MS);
    }
    void api(`/session/${encodeURIComponent(activeSessionId)}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    }).catch(() => {
      void shutdown(
        1,
        'Native prompt admission failed; session continuity unknown',
      );
    });
  };

  // SSE subscription.
  const eventUrl = `${baseUrl}/event?directory=${encodeURIComponent(directory)}`;
  let events;
  try {
    events = await fetch(eventUrl, { headers });
  } catch (error) {
    await shutdown(1, `event stream failed: ${error}`);
    return;
  }
  if (!events.ok || !events.body) {
    await shutdown(1, `event stream ${events.status}`);
    return;
  }

  const consumeEvents = (async () => {
    for await (const event of iterateSseData(events.body)) {
      if (shuttingDown) return;
      // A recovered error marker is cleared only by a new model step, not by
      // tool or usage traffic from the failed step.
      if (
        event.type === 'message.part.updated' &&
        event.properties?.part?.sessionID === activeSessionId &&
        event.properties.part.type === 'step-start'
      ) {
        pendingError = undefined;
      }
      const mapped = mapSseEvent(event, registry, activeSessionId);
      if (mapped) {
        if (
          mapped.type === 'compaction' &&
          (!inFlight || outstandingCalls.size > 0)
        ) {
          throw new Error('Native compaction crossed an invalid turn frontier');
        }
        // A terminal tool update can arrive without an observed running
        // update; Floot only accepts a result with a matching unsettled call,
        // so announce a bare call first.
        if (mapped.type === 'tool-result' && !registry.hasToolCall(mapped.id)) {
          registry.markToolCall(mapped.id);
          writeEvent({
            type: 'tool-call',
            id: mapped.id,
            name: mapped.name,
            args: '',
          });
        }
        if (mapped.type === 'phase' && mapped.phase === 'error') {
          if (inFlight && !sawBusy) {
            await shutdown(1, 'Native turn failed before its busy boundary');
            return;
          } else {
            pendingError = mapped.error;
          }
          // eslint-disable-next-line no-continue
          continue;
        }
        if (mapped.type === 'phase' && mapped.phase === 'busy') {
          // eslint-disable-next-line no-continue
          if (!inFlight) continue;
          sawBusy = true;
          writeEvent(mapped);
          // eslint-disable-next-line no-continue
          continue;
        }
        if (mapped.type === 'phase' && mapped.phase === 'idle') {
          // eslint-disable-next-line no-continue
          if (!inFlight) continue;
          // Ignore idles from before this turn started: a trailing idle from a
          // previous turn must not finish a freshly dispatched queued send.
          // eslint-disable-next-line no-continue
          if (!sawBusy) continue;
          if (outstandingCalls.size > 0) {
            throw new Error('Turn ended with unresolved tool calls');
          } else {
            finishTurn(
              deriveTerminal({ pendingError, timedOut: false, interrupted }),
            );
          }
          // eslint-disable-next-line no-continue
          continue;
        }
        // eslint-disable-next-line no-continue
        if (!inFlight) continue;
        if (mapped.type === 'tool-call') outstandingCalls.add(mapped.id);
        if (mapped.type === 'tool-result') outstandingCalls.delete(mapped.id);
        try {
          writeEvent(mapped);
          if (process.stdout.writableNeedDrain)
            await once(process.stdout, 'drain');
        } catch {
          throw new Error(
            'Bridge event delivery failed; session continuity lost',
          );
        }
      }
      if (
        event.type === 'permission.asked' &&
        event.properties?.sessionID === activeSessionId &&
        typeof event.properties.id === 'string'
      ) {
        void api(
          `/session/${encodeURIComponent(activeSessionId)}/permissions/${encodeURIComponent(event.properties.id)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ response: 'once' }),
          },
        ).catch(() => {});
      }
      if (
        event.type === 'question.asked' &&
        event.properties?.sessionID === activeSessionId &&
        typeof event.properties.id === 'string'
      ) {
        void api(
          `/question/${encodeURIComponent(event.properties.id)}/reject`,
          { method: 'POST' },
        ).catch(() => {});
      }
    }
    throw new Error('Opencode event stream ended; session continuity lost');
  })().catch(() =>
    shutdown(
      1,
      'OpenCode event continuity lost; restart from the recorded transcript',
    ),
  );

  // Commands from the host.
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    if (shuttingDown) return;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      void shutdown(1, 'bad bridge command');
      return;
    }
    if (command.op === 'send' && typeof command.text === 'string') {
      if (inFlight) {
        if (pendingPrompts.length >= 4) {
          void shutdown(1, 'bridge prompt queue overflow');
          return;
        }
        pendingPrompts.push(command.text);
      } else {
        dispatchSend(command.text);
      }
      return;
    }
    if (command.op === 'import' && Array.isArray(command.turns)) {
      // Restore a conversation the stack holds into a session that has none.
      // The server records a user turn as a `synthetic` message rather than a
      // prompt, so nothing here provokes a turn — the route lives on the fork
      // ref this image is built from.
      //
      // The answer is reported either way and matters either way: there is no
      // second path any more, so a refusal is how the client learns this
      // conversation cannot be handed over, and it fails the turn rather than
      // answering out of an empty context.
      void api(
        `/session/${encodeURIComponent(activeSessionId)}/message/import`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent: String(command.agent || 'build'),
            model: command.model,
            turns: command.turns,
          }),
        },
      ).then(
        () => writeEvent({ type: 'imported', ok: true }),
        error =>
          writeEvent({ type: 'imported', ok: false, reason: `${error}` }),
      );
      return;
    }
    if (command.op === 'interrupt') {
      if (!inFlight) return;
      interrupted = true;
      void api(`/session/${encodeURIComponent(activeSessionId)}/abort`, {
        method: 'POST',
      }).catch(() => {});
      clearTimeout(interruptTimer);
      interruptTimer = setTimeout(() => {
        void shutdown(1, 'interrupted; native stop unconfirmed');
      }, INTERRUPT_GRACE_MS);
      return;
    }
    if (command.op === 'shutdown') {
      void shutdown(0);
    }
  });
  lines.on('close', () => {
    void shutdown(0, 'host disconnected');
  });

  process.on('SIGTERM', () => {
    void shutdown(0, 'bridge terminated');
  });
  process.on('SIGINT', () => {
    void shutdown(0, 'bridge interrupted');
  });

  await consumeEvents;
  // A clean event-stream end means the server instance is gone; do not stay
  // alive with the key in memory and a dead event feed.
  const detail = redactSecrets(stderrTail, [password]).trim().slice(-200);
  await shutdown(1, `event stream ended${detail === '' ? '' : `: ${detail}`}`);
};

const entry = process.argv[1];
const isMain =
  entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isMain) {
  const reapActiveChild = () => {
    if (activeChild && activeChild.exitCode === null) {
      activeChild.kill('SIGKILL');
    }
  };
  main().catch(error => {
    reapActiveChild();
    process.stderr.write(`opencode bridge failed: ${error}\n`);
    process.exit(1);
  });
  process.on('uncaughtException', error => {
    reapActiveChild();
    process.stderr.write(`opencode bridge crashed: ${error}\n`);
    process.exit(1);
  });
  process.stdout.on('error', () => {
    reapActiveChild();
    process.exit(0);
  });
}
