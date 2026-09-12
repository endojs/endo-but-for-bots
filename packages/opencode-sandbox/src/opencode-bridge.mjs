// In-slice bridge for @endo/opencode-sandbox.
//
// One long-lived Node process per session incarnation. It starts a local
// `opencode serve` child, subscribes to its SSE event stream, and speaks
// newline-delimited JSON with the host over stdin/stdout. The pure helpers at
// the top are exported for unit tests; `main()` only runs when this file is
// the process entry point.
//
// Bridge -> host events (see opencode-protocol.js):
//   ready | phase | text-delta | commentary-delta | tool-call | tool-result |
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

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

// ---- environment knobs -----------------------------------------------------

const LISTEN_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 5_000;
const API_TIMEOUT_MS = 10_000;
const STDERR_TAIL_BYTES = 2048;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024;

const positiveEnvNumber = (raw, fallback) => {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const TURN_TIMEOUT_MS = positiveEnvNumber(
  process.env.OPENCODE_BRIDGE_TURN_TIMEOUT_MS,
  900_000,
);

// ---- pure helpers ----------------------------------------------------------

/**
 * Parse the child's `opencode server listening on http://host:port` line. Only
 * the loopback HTTP origin is accepted so the server password cannot be sent
 * to a redirected origin.
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
 */
export const makeMessageRegistry = () => {
  const messages = new Map(); // messageID -> { role, summary }
  const parts = new Map(); // partID -> { messageID, type, sawDelta }
  const summaryIDs = new Set();

  const isCompactionSummary = info =>
    info?.role === 'assistant' && info.summary === true;

  return Object.freeze({
    noteMessage(info) {
      if (!info || typeof info.id !== 'string') return;
      messages.set(info.id, {
        role: info.role,
        summary: info.summary === true,
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
    isSummaryMessage(messageID) {
      return summaryIDs.has(messageID);
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
    sawDelta(partID) {
      return parts.get(partID)?.sawDelta === true;
    },
  });
};

/** Is this the synthetic compaction continuation prompt? */
export const isCompactionContinuation = part =>
  part?.type === 'text' &&
  part.synthetic === true &&
  part.metadata?.compaction_continue === true;

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
      if (state.status === 'running') {
        return Object.freeze({
          type: 'tool-call',
          id: part.callID,
          name: part.tool,
          args: state.input,
        });
      }
      if (state.status === 'completed') {
        return Object.freeze({
          type: 'tool-result',
          id: part.callID,
          ok: true,
          result: state.output,
        });
      }
      if (state.status === 'error') {
        return Object.freeze({
          type: 'tool-result',
          id: part.callID,
          ok: false,
          error: `${state.error ?? 'tool failed'}`,
        });
      }
      return undefined;
    }
    if (
      part.type === 'step-finish' &&
      typeof part.tokens?.input === 'number' &&
      typeof part.tokens?.output === 'number' &&
      registry.isVisibleAssistantPart(part.id)
    ) {
      return Object.freeze({
        type: 'usage',
        inputTokens: part.tokens.input,
        outputTokens: part.tokens.output,
      });
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
        type: part.type === 'text' ? 'text-delta' : 'commentary-delta',
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
      return Object.freeze({ type: 'commentary-delta', text: delta });
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

/** Split a byte stream of SSE frames into parsed data payloads. */
export async function* iterateSseData(chunks) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    if (buffer.length > MAX_SSE_BUFFER_BYTES) {
      throw new Error('opencode event frame exceeded the bridge buffer');
    }
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (data !== '') {
        try {
          yield Object.freeze(JSON.parse(data));
        } catch {
          // Ignore malformed frames; the server retries.
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
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
  const requestedSession = process.env.OPENCODE_SESSION_ID;

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
    process.stdout.write(`${line}\n`);
  };

  const child = spawn(
    executable,
    ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
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
    const escalate = setTimeout(() => child.kill('SIGKILL'), 5_000);
    escalate.unref();
    await Promise.race([
      childExit,
      new Promise(resolve => {
        const timer = setTimeout(resolve, 6_000);
        timer.unref();
      }),
    ]);
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

  const api = async (path, init = {}) => {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${baseUrl}${path}${separator}directory=${encodeURIComponent(directory)}`;
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      const error = /** @type {Error & { status?: number }} */ (
        new Error(
          `opencode ${init.method ?? 'GET'} ${path} -> ${response.status}`,
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

  // Resolve or create the session. A requested session that cannot be read
  // fails closed: silently starting a new history would break continuity.
  let sessionID = requestedSession;
  if (sessionID) {
    try {
      await api(`/session/${encodeURIComponent(sessionID)}`);
    } catch (error) {
      const status = /** @type {{ status?: number }} */ (error)?.status;
      await shutdown(
        1,
        `requested session ${sessionID} is unavailable (${status ?? 'error'})`,
      );
      return;
    }
  } else {
    try {
      const session = await api('/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'endo-opencode-sandbox' }),
      });
      sessionID = session.id;
    } catch (error) {
      await shutdown(1, `could not create a session: ${error}`);
      return;
    }
  }
  const activeSessionId = String(sessionID);
  writeEvent({
    type: 'ready',
    sessionId: activeSessionId,
    port: Number(new URL(baseUrl).port),
  });

  const registry = makeMessageRegistry();
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
    inFlight = true;
    sawBusy = false;
    pendingError = undefined;
    interrupted = false;
    clearTurnTimers();
    turnTimer = setTimeout(() => {
      finishTurn(deriveTerminal({ pendingError, timedOut: true }));
      void api(`/session/${encodeURIComponent(activeSessionId)}/abort`, {
        method: 'POST',
      }).catch(() => {});
    }, TURN_TIMEOUT_MS);
    void api(`/session/${encodeURIComponent(activeSessionId)}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    }).catch(error => {
      pendingError = `${error}`;
      finishTurn(deriveTerminal({ pendingError }));
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
        if (mapped.type === 'phase' && mapped.phase === 'error') {
          if (inFlight && !sawBusy) {
            pendingError = mapped.error;
            finishTurn(deriveTerminal({ pendingError }));
          } else {
            pendingError = mapped.error;
          }
          continue;
        }
        if (mapped.type === 'phase' && mapped.phase === 'busy') {
          if (!inFlight) continue;
          sawBusy = true;
          writeEvent(mapped);
          continue;
        }
        if (mapped.type === 'phase' && mapped.phase === 'idle') {
          if (!inFlight) continue;
          // Ignore idles from before this turn started: a trailing idle from a
          // previous turn must not finish a freshly dispatched queued send.
          if (!sawBusy) continue;
          if (outstandingCalls.size > 0) {
            finishTurn({
              type: 'abort',
              reason: 'turn ended with unresolved tool calls',
            });
          } else {
            finishTurn(
              deriveTerminal({ pendingError, timedOut: false, interrupted }),
            );
          }
          continue;
        }
        if (!inFlight) continue;
        if (mapped.type === 'tool-call') outstandingCalls.add(mapped.id);
        if (mapped.type === 'tool-result') outstandingCalls.delete(mapped.id);
        try {
          writeEvent(mapped);
        } catch {
          finishTurn({ type: 'abort', reason: 'bridge event too large' });
          continue;
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
  })().catch(error => {
    if (inFlight) {
      finishTurn({ type: 'abort', reason: `${error}` });
    }
  });

  // Commands from the host.
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
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
    if (command.op === 'interrupt') {
      if (!inFlight) return;
      interrupted = true;
      void api(`/session/${encodeURIComponent(activeSessionId)}/abort`, {
        method: 'POST',
      }).catch(() => {});
      clearTimeout(interruptTimer);
      interruptTimer = setTimeout(() => {
        finishTurn(deriveTerminal({ pendingError, interrupted: true }));
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
  const detail = stderrTail.trim().slice(-200);
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
