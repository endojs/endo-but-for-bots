// @ts-check
import { clearTimeout, setTimeout } from 'node:timers';

import { makeError, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { passStyleOf } from '@endo/pass-style';
import { M } from '@endo/patterns';
import { makeTurnLedger } from '@endo/hosted-agent/turn-ledger.js';

import { toolFromItem } from './codex-protocol.js';

const CodexClientInterface = M.interface('CodexClient', {
  send: M.call(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.promise()),
  models: M.call().returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
  acknowledge: M.call(M.string()).returns(M.promise()),
  terminate: M.call().returns(M.promise()),
  status: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

const TURN_SCOPED_NOTIFICATIONS = harden([
  'turn/started',
  'item/agentMessage/delta',
  'item/started',
  'item/completed',
  'thread/tokenUsage/updated',
  'error',
  'turn/completed',
]);

/** @param {unknown} value */
const byteLength = value =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * @param {unknown} value
 * @param {number} limit
 */
const brief = (value, limit) => {
  const text = /** @type {string} */ (
    typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  );
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
};

const auditProjection = (value, limit = 4 * 1024 * 1024) => {
  const text =
    typeof value === 'string'
      ? value
      : (JSON.stringify(value) ?? String(value));
  const size = new TextEncoder().encode(text).byteLength;
  if (size > limit) throw Error(`Audit payload exceeded ${limit} bytes`);
  return text;
};

/**
 * Project a successful tool fulfillment to JSON without silently collapsing
 * an Endo capability to `{}` or coercing another non-JSON passable.
 *
 * @param {unknown} root
 */
const projectToolResult = root => {
  const visit = value => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw Error('Successful Endo tool result contains a non-finite number');
      }
      return value;
    }
    let style;
    try {
      style = passStyleOf(value);
    } catch {
      throw Error('Successful Endo tool result is not passable JSON data');
    }
    if (style === 'copyArray') {
      return harden(value.map(visit));
    }
    if (style === 'copyRecord') {
      const keys = Reflect.ownKeys(value);
      if (!keys.every(key => typeof key === 'string')) {
        throw Error(
          'Successful Endo tool result contains a symbol-keyed field',
        );
      }
      return harden(
        Object.fromEntries(keys.map(key => [key, visit(value[key])])),
      );
    }
    throw Error(`Successful Endo tool result has non-JSON pass style ${style}`);
  };
  return visit(root);
};

const CODEX_SANDBOX_MODE = 'workspace-write';

/**
 * @typedef {object} AppServerTransport
 * @property {AsyncIterable<any>} messages
 * @property {(message: object) => Promise<void>} send
 * @property {() => Promise<void>} close
 */

/**
 * @typedef {object} ActiveTurn
 * @property {string} threadId
 * @property {string} [turnId]
 * @property {(event: any) => void} push
 * @property {boolean} interrupted
 * @property {string} [interruptReason]
 * @property {string} [errorReason]
 * @property {Promise<void>} terminal
 * @property {() => void} resolveTerminal
 * @property {ReturnType<typeof setTimeout>} [terminalTimer]
 * @property {ReturnType<typeof setTimeout>} [wallTimer]
 * @property {number} events
 * @property {number} bytes
 * @property {number} toolCalls
 * @property {Set<string>} serverRequestIds
 * @property {Set<string>} toolCallIds
 * @property {Set<string>} textItems
 * @property {Map<string, string | null>} messagePhases
 * @property {Map<string, any[]>} earlyByTurn
 * @property {number} earlyEvents
 * @property {number} earlyBytes
 */

/**
 * Build a remotable Codex session over an injected app-server transport.
 * Exactly one turn may be active. Consumer close maps to `turn/interrupt`, so
 * cancellation cannot replay a partially executed turn.
 *
 * @param {object} options
 * @param {() => Promise<AppServerTransport>} options.start
 * @param {string} options.sessionId
 * @param {(error: Error) => void | Promise<void>} [options.reportCleanupFailure]
 * @param {(kind: string, payload: Record<string, unknown>) => void | Promise<void>} [options.auditEvent]
 * @param {string} [options.threadId]
 * @param {(threadId: string) => Promise<void>} [options.saveThreadId]
 * @param {string} [options.cwd]
 * @param {string} [options.model]
 * @param {string} [options.reasoningEffort]
 * @param {string} [options.developerInstructions]
 * @param {string} [options.approvalPolicy]
 * @param {Array<{ type: 'function', name: string, description: string, inputSchema: unknown }>} [options.dynamicTools]
 * @param {(name: string, args: Record<string, unknown>) => Promise<unknown>} [options.callTool]
 * @param {string} [options.toolSetId]
 * @param {string} [options.savedToolSetId]
 * @param {{ baseTurnId: string | null, turnId?: string, status?: string }} [options.savedRecovery]
 * @param {(state: { threadId: string, toolSetId?: string, recovery?: { baseTurnId: string | null, turnId?: string, status?: string } }) => Promise<void>} [options.saveThreadState]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.maxTurnEvents]
 * @param {number} [options.maxTurnBytes]
 * @param {number} [options.maxToolResultChars]
 * @param {number} [options.maxPromptBytes]
 * @param {number} [options.maxRequestBytes]
 * @param {number} [options.maxToolCalls]
 * @param {number} [options.toolCallTimeoutMs]
 * @param {number} [options.turnWallTimeoutMs]
 */
export const makeCodexClient = ({
  start,
  sessionId,
  reportCleanupFailure = () => undefined,
  auditEvent = () => undefined,
  threadId: savedThreadId,
  saveThreadId = async () => undefined,
  saveThreadState,
  cwd = '/workspace',
  model,
  reasoningEffort,
  developerInstructions,
  approvalPolicy = 'never',
  dynamicTools = [],
  callTool,
  toolSetId,
  savedToolSetId,
  savedRecovery,
  requestTimeoutMs = 30_000,
  maxTurnEvents = 10_000,
  maxTurnBytes = 16 * 1024 * 1024,
  maxToolResultChars = 64 * 1024,
  maxPromptBytes = 1024 * 1024,
  maxRequestBytes = 2 * 1024 * 1024,
  maxToolCalls = 128,
  toolCallTimeoutMs = 120_000,
  turnWallTimeoutMs = 30 * 60_000,
}) => {
  /** @type {AppServerTransport | undefined} */
  let transport;
  /** @type {Promise<void> | undefined} */
  let ready;
  /** @type {Promise<void> | undefined} */
  let shutdown;
  /** @type {Promise<void> | undefined} */
  let sessionFailureAudit;
  let terminated = false;
  let closing = false;
  let closeDeferredAudited = false;
  let closeRequestedAudited = false;
  let initialized = false;
  /** @type {string[]} */
  const cleanupFailures = [];
  /** @type {Set<Promise<unknown>>} */
  const pendingToolOperations = new Set();
  /**
   * Server-request handlers the pump dispatched without awaiting, so that a
   * long-running Endo tool cannot stall the read loop. Shutdown observes them;
   * `pendingToolOperations` remains the admission barrier for the tool calls
   * themselves.
   * @type {Set<Promise<void>>}
   */
  const detachedRequests = new Set();
  const audit = async (kind, payload = {}) => {
    await auditEvent(kind, harden({ sessionId, ...payload }));
  };
  const recordCleanupFailure = error => {
    const failure = error instanceof Error ? error : Error(`${error}`);
    cleanupFailures.push(brief(failure.message, 4096));
    if (cleanupFailures.length > 16) cleanupFailures.shift();
    try {
      const reported = reportCleanupFailure(failure);
      Promise.resolve(reported).catch(reportError => {
        cleanupFailures.push(
          brief(
            `cleanup failure reporter rejected: ${
              reportError instanceof Error ? reportError.message : reportError
            }`,
            4096,
          ),
        );
        if (cleanupFailures.length > 16) cleanupFailures.shift();
      });
    } catch (reportError) {
      cleanupFailures.push(
        brief(
          `cleanup failure reporter threw: ${
            reportError instanceof Error ? reportError.message : reportError
          }`,
          4096,
        ),
      );
      if (cleanupFailures.length > 16) cleanupFailures.shift();
    }
    Promise.resolve(
      audit('cleanup-failed', { reason: brief(failure.message, 4096) }),
    ).catch(() => undefined);
  };
  /** @type {(failure: Error) => void} */
  let signalTermination = () => {};
  const terminationSignal = /** @type {Promise<Error>} */ (
    new Promise(resolve => {
      signalTermination = resolve;
    })
  );
  let nextRequestId = 1;
  let threadId = savedThreadId;
  let threadReady = false;
  // Codex app-server 0.152.0 refuses `thread/turns/list` on a thread that has
  // had no user message: a thread is not materialized until its first turn
  // starts. A freshly started thread therefore may not be asked, and its
  // write-ahead base checkpoint is `null` because there is nothing before its
  // first turn. A saved marker naming *some* turn — the base it built on, or
  // the turn itself — proves the saved thread was materialized; a marker with
  // neither was written between the write-ahead and `turn/start`, so that
  // thread still has no turns to list.
  let threadHasTurns = Boolean(
    savedThreadId &&
    savedRecovery &&
    (savedRecovery.turnId || savedRecovery.baseTurnId),
  );
  // The write-ahead / settle-once / reconcile protocol is @endo/hosted-agent's,
  // not this adapter's: it is the same for every hosted backend and it is where
  // durability bugs live. Only the two Codex-specific operations —
  // `thread/turns/list` and `thread/revert` — stay here. The persisted shape
  // keeps Codex's own field names, so existing durable state still loads.
  const ledger = makeTurnLedger({
    audit: (event, detail) => audit(event, detail),
    ...(savedRecovery
      ? {
          recovery: harden({
            baseCheckpoint: savedRecovery.baseTurnId ?? null,
            ...(savedRecovery.turnId
              ? { checkpoint: savedRecovery.turnId }
              : {}),
            status:
              savedRecovery.status === 'completed' ? 'completed' : 'started',
          }),
        }
      : {}),
    persist: async record => {
      if (!threadId || !saveThreadState) return;
      await saveThreadState(
        harden({
          threadId,
          ...(toolSetId ? { toolSetId } : {}),
          ...(record
            ? {
                recovery: harden({
                  baseTurnId: record.baseCheckpoint,
                  ...(record.checkpoint ? { turnId: record.checkpoint } : {}),
                  ...(record.status === 'completed'
                    ? { status: 'completed' }
                    : {}),
                }),
              }
            : {}),
        }),
      );
    },
  });
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  /** @type {ActiveTurn | undefined} */
  let active;
  let turnReserved = false;

  const rejectPending = error => {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  };

  const endActive = event => {
    if (!active) return;
    const turn = active;
    if (turn.terminalTimer !== undefined) clearTimeout(turn.terminalTimer);
    if (turn.wallTimer !== undefined) clearTimeout(turn.wallTimer);
    turn.push(event);
    active = undefined;
    turnReserved = false;
    turn.resolveTerminal();
  };

  /**
   * Settle the active turn through the ledger and deliver its terminal event
   * only if this outcome is the one that won.
   *
   * Every terminal path goes through here, so a notification the app-server had
   * already queued when the session failed cannot rewrite the durable marker or
   * hand the consumer a second terminal event: the ledger latches the first
   * outcome synchronously, and a loser never reaches `endActive`.
   *
   * @param {any} turn
   * @param {{ type: 'completed', checkpoint: string } | { type: 'aborted' | 'failed', reason: string }} outcome
   * @returns {Promise<boolean>}
   */
  const settleTurn = async (turn, outcome) => {
    if (!turn) return false;
    let accepted = true;
    if (turn.ledgerTurn) {
      ({ accepted } = await turn.ledgerTurn.settle(outcome));
    }
    if (!accepted || active !== turn) return false;
    endActive(
      outcome.type === 'completed'
        ? harden({ type: 'end', checkpoint: outcome.checkpoint })
        : harden({ type: 'abort', reason: outcome.reason }),
    );
    return true;
  };

  const failSession = (error, recordFailure = true) => {
    const failure = error instanceof Error ? error : Error(`${error}`);
    if (recordFailure && !sessionFailureAudit) {
      sessionFailureAudit = audit('session-failed', {
        reason: brief(failure.message, 4096),
      });
      // A caller may not await an automatic protocol failure; keep the
      // rejection observed while shutdown retains it for lifecycle reporting.
      sessionFailureAudit.catch(() => undefined);
    }
    terminated = true;
    signalTermination(failure);
    turnReserved = false;
    rejectPending(failure);
    if (active) {
      const failedTurn = active;
      const finish = () => {
        void settleTurn(failedTurn, {
          type: 'failed',
          reason: failure.message,
        });
      };
      if (sessionFailureAudit) {
        sessionFailureAudit.then(finish, finish);
      } else {
        finish();
      }
    }
    if (!shutdown) {
      shutdown = (async () => {
        await null;
        const failures = [];
        if (transport) {
          try {
            await transport.close();
          } catch (closeError) {
            failures.push(closeError);
          }
        } else if (ready) {
          // Do not let an unbounded transport factory delay terminate(). The
          // startup continuation observes `terminated` and closes any process
          // that arrives late; keep its rejection observed here.
          void ready.catch(() => undefined);
        }
        // A detached tool-call handler may still be writing its reply or its
        // audit entry. Its errors are already routed to `failSession`; waiting
        // keeps shutdown from resolving while one is mid-write.
        if (detachedRequests.size > 0) {
          await Promise.all([...detachedRequests]);
        }
        if (sessionFailureAudit) {
          try {
            await sessionFailureAudit;
          } catch (auditError) {
            failures.push(auditError);
          }
        }
        if (failures.length > 0) {
          if (failures.length === 1) throw failures[0];
          throw new AggregateError(failures, 'Codex session shutdown failed');
        }
      })();
      // Automatic protocol-failure paths have no caller awaiting shutdown.
      // Preserve the rejecting promise for explicit terminate(), while also
      // making teardown failure visible to the provisioner.
      shutdown.catch(recordCleanupFailure);
    }
    return shutdown;
  };

  const sendMessage = async message => {
    if (!transport) throw Error('Codex app-server is not initialized');
    const size = byteLength(message);
    if (size > maxRequestBytes) {
      throw makeError(
        X`Codex app-server request exceeded ${maxRequestBytes} bytes`,
      );
    }
    const timeoutFailure = Error('Codex app-server write timed out');
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutFailure), requestTimeoutMs);
    });
    await null;
    try {
      await Promise.race([transport.send(harden(message)), deadline]);
    } catch (error) {
      // A failed or timed-out write has an unknown outcome, including for
      // mutating requests. The session cannot safely send a successor.
      failSession(error);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const request = async (method, params) => {
    if (terminated) throw Error('Codex session terminated');
    const id = nextRequestId;
    nextRequestId += 1;
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    // The exchange may still be blocked in transport.send when failSession
    // rejects this response promise. Observe it immediately.
    response.catch(() => undefined);
    const timeoutFailure = Error(
      `Codex app-server request timed out: ${method}`,
    );
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutFailure), requestTimeoutMs);
    });
    // Attach handlers to both the write and response immediately. If stdin
    // blocks, the deadline still settles request() and the losing exchange
    // remains observed by Promise.race rather than becoming unhandled.
    const exchange = (async () => {
      await sendMessage({ id, method, params });
      return response;
    })();
    await null;
    try {
      return await Promise.race([exchange, deadline]);
    } catch (error) {
      if (error === timeoutFailure) {
        // A timed-out mutating request has an unknown outcome. Stop the whole
        // session rather than allowing an unaddressable turn to keep running.
        failSession(timeoutFailure);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      pending.delete(id);
    }
  };

  const interruptActive = async reason => {
    const turn = active;
    const reserved = turnReserved;
    await null;
    if (!turn) {
      if (reserved) {
        const failure = Error(`${reason} during startup`);
        await failSession(failure);
        return failure;
      }
      return undefined;
    }
    if (turn.interrupted) {
      return turn.terminal.then(() => undefined);
    }
    turn.interrupted = true;
    turn.interruptReason = reason;
    await null;
    if (!turn.turnId) {
      const failure = Error(
        'Codex turn could not be interrupted before its id was confirmed',
      );
      failSession(failure);
      return failure;
    }
    try {
      await audit('turn-interrupt-requested', {
        threadId: turn.threadId,
        turnId: turn.turnId,
        reason,
      });
      await request('turn/interrupt', {
        threadId: turn.threadId,
        turnId: turn.turnId,
      });
    } catch (error) {
      if (active !== turn) return undefined;
      const failure =
        error instanceof Error
          ? error
          : Error(`Codex interrupt failed: ${error}`);
      failSession(failure);
      return failure;
    }
    if (active === turn) {
      const timeoutFailure = Error(
        'Codex turn did not confirm interruption before the deadline',
      );
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutFailure), requestTimeoutMs);
      });
      try {
        await Promise.race([turn.terminal, deadline]);
      } catch (error) {
        const failure = error instanceof Error ? error : timeoutFailure;
        failSession(failure);
        return failure;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return undefined;
  };

  const pushTurn = event => {
    const turn = active;
    if (!turn) return;
    turn.events += 1;
    turn.bytes += byteLength(event);
    if (turn.events > maxTurnEvents || turn.bytes > maxTurnBytes) {
      void interruptActive('Codex turn exceeded configured output bounds');
      return;
    }
    turn.push(harden(event));
  };

  const sameTurn = params => {
    if (!active || params?.threadId !== active.threadId) return false;
    const eventTurnId = params?.turnId || params?.turn?.id;
    return Boolean(
      typeof eventTurnId === 'string' &&
      eventTurnId !== '' &&
      active.turnId &&
      eventTurnId === active.turnId,
    );
  };

  const correlateServerRequest = params => {
    if (
      !active ||
      params?.threadId !== active.threadId ||
      typeof params?.turnId !== 'string' ||
      params.turnId === '' ||
      !active.turnId
    ) {
      return false;
    }
    return params.turnId === active.turnId;
  };

  const runDynamicTool = async params => {
    if (closing || terminated) {
      throw Error(
        'Codex session is closing; no new Endo tool calls are admitted',
      );
    }
    if (!correlateServerRequest(params)) {
      throw Error('Dynamic tool call was not correlated to the active turn');
    }
    if (params.namespace !== null && params.namespace !== undefined) {
      throw Error('Namespaced dynamic tools are not exposed by Endo');
    }
    if (typeof callTool !== 'function') {
      throw Error('No Endo dynamic-tool executor is installed');
    }
    const descriptor = dynamicTools.find(tool => tool.name === params.tool);
    if (!descriptor) {
      throw Error(`Dynamic tool is not endowed: ${params.tool}`);
    }
    if (!params.arguments || typeof params.arguments !== 'object') {
      throw Error('Dynamic tool arguments must be a record');
    }
    if (typeof params.callId !== 'string' || params.callId === '') {
      throw Error('Dynamic tool call omitted its stable call id');
    }
    if (!active || active.toolCalls >= maxToolCalls) {
      throw Error(`Dynamic tool call limit exceeded (${maxToolCalls})`);
    }
    if (active.toolCallIds.has(params.callId)) {
      throw Error(`Dynamic tool call id was replayed: ${params.callId}`);
    }
    active.toolCallIds.add(params.callId);
    active.toolCalls += 1;
    await audit('tool-intent', {
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
      tool: params.tool,
      arguments: auditProjection(params.arguments),
    });
    const timeoutFailure = Error(
      `Dynamic tool timed out after ${toolCallTimeoutMs} ms`,
    );
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutFailure), toolCallTimeoutMs);
    });
    const operation = Promise.resolve().then(() =>
      callTool(params.tool, params.arguments),
    );
    pendingToolOperations.add(operation);
    operation.then(
      () => pendingToolOperations.delete(operation),
      () => pendingToolOperations.delete(operation),
    );
    let result;
    try {
      result = await Promise.race([operation, deadline]);
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      if (terminated) throw error;
      if (error === timeoutFailure) {
        await audit('tool-outcome-unknown', {
          threadId: params.threadId,
          turnId: params.turnId,
          callId: params.callId,
          tool: params.tool,
          reason: timeoutFailure.message,
        });
        // The Endo call cannot be assumed cancelled. Poison the session so no
        // successor can overlap it, and keep observing the late settlement for
        // the operator journal instead of reporting a false tool failure.
        operation
          .then(
            async lateResult => {
              try {
                const lateProjected = projectToolResult(lateResult);
                await audit('tool-late-settled', {
                  threadId: params.threadId,
                  turnId: params.turnId,
                  callId: params.callId,
                  tool: params.tool,
                  success: true,
                  result: auditProjection(lateProjected),
                });
              } catch (lateProjectionError) {
                await audit('tool-late-outcome-unknown', {
                  threadId: params.threadId,
                  turnId: params.turnId,
                  callId: params.callId,
                  tool: params.tool,
                  reason: brief(
                    lateProjectionError instanceof Error
                      ? lateProjectionError.message
                      : `${lateProjectionError}`,
                    maxToolResultChars,
                  ),
                });
              }
            },
            lateError =>
              audit('tool-late-settled', {
                threadId: params.threadId,
                turnId: params.turnId,
                callId: params.callId,
                tool: params.tool,
                success: false,
                reason: brief(
                  lateError instanceof Error ? lateError.message : lateError,
                  maxToolResultChars,
                ),
              }),
          )
          .catch(recordCleanupFailure);
        failSession(timeoutFailure);
        throw timeoutFailure;
      }
      const reason = brief(
        error instanceof Error ? error.message : `${error}`,
        maxToolResultChars,
      );
      await audit('tool-result', {
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: params.tool,
        success: false,
        reason,
      });
      return harden({
        success: false,
        contentItems: harden([{ type: 'inputText', text: `Error: ${reason}` }]),
      });
    }
    if (timer !== undefined) clearTimeout(timer);

    let projected;
    let text;
    try {
      projected = projectToolResult(result);
      text = brief(projected, maxToolResultChars);
    } catch (renderError) {
      const reason = brief(
        renderError instanceof Error
          ? renderError.message
          : 'Successful Endo tool result could not be represented',
        maxToolResultChars,
      );
      let failure =
        renderError instanceof Error ? renderError : Error(`${renderError}`);
      try {
        await audit('tool-outcome-unknown', {
          threadId: params.threadId,
          turnId: params.turnId,
          callId: params.callId,
          tool: params.tool,
          reason,
        });
      } catch (auditError) {
        failure = new AggregateError(
          [failure, auditError],
          'Successful Endo tool result could not be durably represented',
          { cause: auditError },
        );
      }
      failSession(failure);
      throw failure;
    }
    try {
      await audit('tool-result', {
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: params.tool,
        success: true,
        result: auditProjection(projected),
      });
    } catch (error) {
      // The Endo operation has already succeeded. Without its complete durable
      // result record, returning an ordinary tool error could invite the model
      // to repeat a side effect. Quarantine the session instead.
      failSession(error);
      throw error;
    }
    return harden({
      success: true,
      contentItems: harden([{ type: 'inputText', text }]),
    });
  };

  const handleServerRequest = async message => {
    await null;
    const { id, method, params = {} } = message;
    const validId =
      (typeof id === 'string' && id !== '') ||
      (typeof id === 'number' && Number.isFinite(id));
    if (!validId || !active) {
      throw Error('Codex server request omitted a valid active request id');
    }
    const requestKey = `${typeof id}:${id}`;
    if (active.serverRequestIds.has(requestKey)) {
      throw Error(`Codex server request id was replayed: ${id}`);
    }
    active.serverRequestIds.add(requestKey);
    if (method === 'item/tool/call') {
      const result = await runDynamicTool(params);
      await sendMessage({ id, result });
      return;
    }
    const approvalMethods = new Set([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ]);
    if (approvalMethods.has(method)) {
      if (!correlateServerRequest(params)) {
        throw Error(`${method} was not correlated to the active turn`);
      }
      const result = harden({ decision: 'accept' });
      await audit('approval-auto-granted', {
        method,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: `${params.itemId || ''}`,
        // Record the requested envelope, including commands and paths. The
        // journal is operator-sensitive storage, not a redacted UI log.
        request: auditProjection(params),
        response: result,
      });
      await sendMessage({ id, result });
      return;
    }
    await audit('server-request-denied', {
      method: `${method}`,
      ...(typeof params.threadId === 'string'
        ? { threadId: params.threadId }
        : {}),
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
    });
    await sendMessage({
      id,
      error: {
        code: -32_601,
        message: `Unsupported server request: ${method}`,
      },
    });
  };

  const onNotification = async message => {
    await null;
    const { method, params = {} } = message;
    if (!active || params?.threadId !== active.threadId) return;
    const eventTurnId = params?.turnId || params?.turn?.id;
    if (typeof eventTurnId !== 'string' || eventTurnId === '') {
      if (TURN_SCOPED_NOTIFICATIONS.includes(method)) {
        failSession(
          Error('Codex app-server emitted a turn notification without an id'),
        );
      }
      return;
    }
    if (eventTurnId && !active.turnId) {
      active.earlyEvents += 1;
      active.earlyBytes += byteLength(message);
      if (
        active.earlyEvents > maxTurnEvents ||
        active.earlyBytes > maxTurnBytes
      ) {
        failSession(Error('Codex early turn events exceeded output bounds'));
        return;
      }
      const queued = active.earlyByTurn.get(`${eventTurnId}`) || [];
      queued.push(message);
      active.earlyByTurn.set(`${eventTurnId}`, queued);
      return;
    }
    if (!sameTurn(params)) return;
    switch (method) {
      case 'turn/started':
        if (params.turn?.id && active) active.turnId = `${params.turn.id}`;
        pushTurn({ type: 'phase', phase: 'thinking' });
        break;
      case 'item/agentMessage/delta':
        if (active) {
          const itemId = `${params.itemId || ''}`;
          active.textItems.add(itemId);
          pushTurn({
            type:
              active.messagePhases.get(itemId) === 'commentary'
                ? 'commentary-delta'
                : 'text-delta',
            text: `${params.delta || ''}`,
          });
        }
        break;
      case 'item/started': {
        if (params.item?.type === 'agentMessage' && active) {
          active.messagePhases.set(
            `${params.item.id || ''}`,
            params.item.phase ?? null,
          );
        }
        const tool = toolFromItem(params.item);
        if (tool) {
          await audit('backend-tool-intent-observed', {
            threadId: params.threadId,
            turnId: eventTurnId,
            itemId: tool.id,
            tool: tool.name,
            arguments: auditProjection(tool.args),
          });
          pushTurn({
            type: 'tool-call',
            id: tool.id,
            name: tool.name,
            args: brief(tool.args, maxToolResultChars),
          });
        } else if (
          params.item?.type === 'reasoning' ||
          params.item?.type === 'plan'
        ) {
          pushTurn({ type: 'phase', phase: 'thinking' });
        }
        break;
      }
      case 'item/completed': {
        const { item } = params;
        if (item?.type === 'agentMessage' && active) {
          active.messagePhases.set(`${item.id || ''}`, item.phase ?? null);
        }
        const tool = toolFromItem(item);
        if (tool) {
          await audit('backend-tool-result-observed', {
            threadId: params.threadId,
            turnId: eventTurnId,
            itemId: tool.id,
            tool: tool.name,
            result: auditProjection(tool.result),
          });
          pushTurn({
            type: 'tool-result',
            id: tool.id,
            name: tool.name,
            result: brief(tool.result, maxToolResultChars),
          });
        } else if (
          item?.type === 'agentMessage' &&
          item.text &&
          active &&
          !active.textItems.has(`${item.id}`)
        ) {
          pushTurn({
            type:
              item.phase === 'commentary' ? 'commentary-delta' : 'text-delta',
            text: `${item.text}`,
          });
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const last = params.tokenUsage?.last;
        if (last) {
          pushTurn({
            type: 'usage',
            inputTokens: Number(last.inputTokens) || 0,
            outputTokens: Number(last.outputTokens) || 0,
          });
        }
        break;
      }
      case 'error':
        if (!params.willRetry) {
          const turn = active;
          if (!turn) break;
          turn.errorReason = `${
            params.error?.message ||
            (typeof params.error === 'string'
              ? params.error
              : JSON.stringify(params.error)) ||
            'Codex turn failed'
          }`;
          // App-server normally follows this notification with a terminal
          // turn/completed. Preserve the session and reservation until that
          // authoritative boundary, but do not hang forever if it is absent.
          if (turn.terminalTimer === undefined) {
            turn.terminalTimer = setTimeout(() => {
              if (active === turn) {
                failSession(
                  Error('Codex failed turn did not reach a terminal state'),
                );
              }
            }, requestTimeoutMs);
          }
        }
        break;
      case 'turn/completed': {
        const status = params.turn?.status;
        await audit('turn-terminal', {
          threadId: params.threadId,
          turnId: eventTurnId,
          status: `${status || 'missing'}`,
          ...((active?.errorReason || params.turn?.error?.message) && {
            reason: active?.errorReason || params.turn?.error?.message,
          }),
        });
        if (status === 'completed') {
          // Floot persists this checkpoint with its conversation node, then
          // acknowledges it. Until then the next send conservatively rolls the
          // backend turn out. The ledger records the commit only if this is the
          // outcome that won: a `completed` the app-server had already queued
          // when the session failed must not resurrect the turn.
          await settleTurn(active, {
            type: 'completed',
            checkpoint: `${eventTurnId}`,
          });
        } else if (status === 'interrupted' || status === 'failed') {
          const reason = `${
            (status === 'interrupted' && active?.interruptReason) ||
            active?.errorReason ||
            params.turn?.error?.message ||
            `Codex turn ${status || 'failed'}`
          }`;
          await settleTurn(active, { type: 'aborted', reason });
        } else {
          failSession(
            Error(
              `Codex app-server emitted nonterminal turn/completed status: ${
                status || 'missing'
              }`,
            ),
          );
        }
        break;
      }
      default:
    }
  };

  const pump = async () => {
    if (!transport) return;
    await null;
    try {
      for await (const message of transport.messages) {
        if ('id' in message && !('method' in message)) {
          const responseId = /** @type {number} */ (
            typeof message.id === 'number' ? message.id : Number.NaN
          );
          const validId = Number.isSafeInteger(responseId) && responseId > 0;
          const hasResult = Object.hasOwn(message, 'result');
          const hasError = Object.hasOwn(message, 'error');
          if (!validId || hasResult === hasError) {
            throw Error('Codex app-server emitted a malformed response');
          }
          const entry = pending.get(responseId);
          if (entry) {
            if ('error' in message) {
              const failure = Error(
                `Codex app-server request failed${
                  Number.isSafeInteger(message.error?.code)
                    ? ` (code ${message.error.code})`
                    : ''
                }: ${message.error?.message || JSON.stringify(message.error)}`,
              );
              entry.reject(failure);
            } else {
              entry.resolve(message.result);
            }
            pending.delete(responseId);
          }
        } else if ('id' in message && 'method' in message) {
          if (message.method === 'item/tool/call') {
            // An Endo tool call runs for as long as `toolCallTimeoutMs`
            // allows — four times the request timeout by default. Awaiting it
            // here stopped the pump from dequeuing responses, so every
            // concurrent request timed out on this side even though the
            // app-server had already answered; `request()` then read its own
            // timeout as an ambiguous mutating request and quarantined the
            // session. Since a user pressing stop during a tool call takes
            // exactly that path through `turn/interrupt`, cancelling a
            // long-running tool destroyed the session instead of interrupting
            // the turn. Dispatch it and keep reading.
            const handled = handleServerRequest(message).catch(error => {
              if (!terminated) failSession(error);
            });
            detachedRequests.add(handled);
            void handled.then(
              () => detachedRequests.delete(handled),
              () => detachedRequests.delete(handled),
            );
          } else {
            await handleServerRequest(message);
          }
        } else if ('method' in message) {
          await onNotification(message);
        }
      }
      if (!terminated) failSession(Error('Codex app-server stdout closed'));
    } catch (error) {
      if (!terminated) failSession(error);
    }
  };

  const ensureReady = async () => {
    if (terminated) throw Error('Codex session terminated');
    if (!ready) {
      ready = (async () => {
        await null;
        try {
          const startP = start();
          // If termination or the startup deadline wins, retain custody of a
          // transport that arrives late and close it immediately.
          let accepted = false;
          let abandoned = false;
          let unacceptedTransport;
          /** @type {Promise<void> | undefined} */
          let lateClose;
          const closeUnaccepted = () => {
            if (!accepted && unacceptedTransport && lateClose === undefined) {
              lateClose = unacceptedTransport.close().catch(error => {
                recordCleanupFailure(error);
              });
            }
          };
          void startP.then(
            started => {
              unacceptedTransport = started;
              if (terminated || abandoned) closeUnaccepted();
            },
            () => undefined,
          );
          const timeoutFailure = Error(
            'Codex app-server transport startup timed out',
          );
          /** @type {ReturnType<typeof setTimeout> | undefined} */
          let timer;
          const deadline = new Promise(resolve => {
            timer = setTimeout(
              () => resolve({ failure: timeoutFailure }),
              requestTimeoutMs,
            );
          });
          const outcome = /** @type {any} */ (
            await Promise.race([
              startP.then(started => ({ started })),
              terminationSignal.then(failure => ({ failure })),
              deadline,
            ]).finally(() => {
              if (timer !== undefined) clearTimeout(timer);
            })
          );
          if (outcome.failure) {
            abandoned = true;
            closeUnaccepted();
            throw outcome.failure;
          }
          const { started } = outcome;
          if (terminated) {
            try {
              await started.close();
            } catch (error) {
              recordCleanupFailure(error);
              throw error;
            }
            throw Error('Codex session terminated during startup');
          }
          accepted = true;
          transport = started;
          void pump();
          const initializeResult = await request('initialize', {
            clientInfo: {
              name: 'endo-codex-sandbox',
              title: 'Endo Codex Sandbox',
              version: '0.1.0',
            },
            capabilities: {
              experimentalApi: dynamicTools.length > 0,
              requestAttestation: false,
            },
          });
          if (
            initializeResult?.codexHome !== '/codex-home' ||
            initializeResult?.platformFamily !== 'unix' ||
            initializeResult?.platformOs !== 'linux' ||
            typeof initializeResult?.userAgent !== 'string'
          ) {
            const failure = Error(
              'Codex app-server returned a malformed initialize result',
            );
            failSession(failure);
            throw failure;
          }
          await sendMessage({ method: 'initialized' });
          initialized = true;
          // A signed-out app-server accepts `initialize` and `thread/start`
          // alike and fails only when the first turn opens its model
          // connection: an opaque 401 in the middle of a turn Floot has
          // already committed to. Ask first. `account/read` is answered
          // locally, needs no experimental capability, and reports
          // `requiresOpenaiAuth: false` only for a provider configured to
          // bring its own credentials.
          const accountResult = await request('account/read', {});
          const account = accountResult?.account ?? null;
          if (
            typeof accountResult?.requiresOpenaiAuth !== 'boolean' ||
            (account !== null &&
              (typeof account !== 'object' || typeof account.type !== 'string'))
          ) {
            const failure = Error(
              'Codex app-server returned a malformed account status',
            );
            failSession(failure);
            throw failure;
          }
          if (account === null && accountResult.requiresOpenaiAuth) {
            const failure = Error(
              'Codex is not authenticated: the hosted runtime holds neither a ChatGPT login nor an API key. Provision credentials in the sandbox before starting a Codex session.',
            );
            failSession(failure);
            throw failure;
          }
          await audit('session-open', {
            approvalPolicy,
            sandbox: CODEX_SANDBOX_MODE,
            toolNetworkAccess: false,
            toolSetId: toolSetId || '',
            // The kind of credential, never the credential: `apiKey`,
            // `chatgpt`, `amazonBedrock`, or `none` for a provider that needs
            // no OpenAI account.
            account: account === null ? 'none' : `${account.type}`,
          });
        } catch (error) {
          failSession(error);
          throw error;
        }
      })();
    }
    return ready;
  };

  const ensureThread = async (opts = {}) => {
    await ensureReady();
    if (threadReady && threadId) return threadId;
    const common = {
      cwd,
      approvalPolicy,
      sandbox: CODEX_SANDBOX_MODE,
      ...(opts.model || model ? { model: opts.model || model } : {}),
      ...(opts.systemPrompt ||
      opts.developerInstructions ||
      developerInstructions
        ? {
            developerInstructions:
              opts.systemPrompt ||
              opts.developerInstructions ||
              developerInstructions,
          }
        : {}),
    };
    let rotatedFrom;
    if (threadId && dynamicTools.length > 0 && savedToolSetId !== toolSetId) {
      // A schema/capability change gets a fresh conversation rather than
      // silently rebinding old model context to new authority. The old thread
      // remains intact for audit/recovery.
      rotatedFrom = threadId;
      threadId = undefined;
      threadHasTurns = false;
      // The marker names a turn in the thread being abandoned; the new thread
      // starts with nothing outstanding. The old thread is left intact for
      // audit and recovery.
      ledger.forget();
      await audit('thread-rotation-required', {
        oldThreadId: rotatedFrom,
        oldToolSetId: savedToolSetId || '',
        newToolSetId: toolSetId || '',
      });
    }
    if (threadId) {
      const response = await request('thread/resume', {
        threadId,
        ...common,
        excludeTurns: true,
      });
      if (response?.thread?.id !== threadId) {
        const failure = Error(
          'Codex app-server returned the wrong resumed thread',
        );
        failSession(failure);
        throw failure;
      }
    } else {
      const response = await request('thread/start', {
        ...common,
        ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      });
      const created = response?.thread?.id;
      if (typeof created !== 'string' || created === '') {
        const failure = Error('Codex app-server did not return a thread id');
        failSession(failure);
        throw failure;
      }
      // Persistence is part of thread creation: never execute a turn whose
      // continuation identity was not durably accepted by the caller.
      try {
        if (saveThreadState) {
          await saveThreadState(
            harden({
              threadId: created,
              ...(toolSetId ? { toolSetId } : {}),
            }),
          );
        } else {
          await saveThreadId(created);
        }
      } catch (error) {
        failSession(error);
        throw error;
      }
      threadId = created;
    }
    await audit('thread-bound', {
      threadId: /** @type {string} */ (threadId),
      resumed: Boolean(savedThreadId && !rotatedFrom),
      ...(rotatedFrom ? { rotatedFrom } : {}),
      toolSetId: toolSetId || '',
    });
    threadReady = true;
    return /** @type {string} */ (threadId);
  };

  const readLatestTurnId = async () => {
    const currentThreadId = await ensureThread();
    // Asking an unmaterialized thread is an error, not an empty answer, and
    // the honest answer for one is that it has no turns.
    if (!threadHasTurns) return null;
    const response = await request('thread/turns/list', {
      threadId: currentThreadId,
      cursor: null,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    });
    if (
      !Array.isArray(response?.data) ||
      /** @type {any[]} */ (response.data).length > 1
    ) {
      throw Error('Codex returned a malformed latest-turn checkpoint');
    }
    const latest = response.data[0]?.id;
    if (latest !== undefined && (typeof latest !== 'string' || latest === '')) {
      throw Error('Codex returned an invalid latest turn id');
    }
    return latest || null;
  };

  const reconcileThread = async () => {
    if (!ledger.status().needsReconciliation) return;
    const currentThreadId = await ensureThread();
    await ledger.reconcile({
      readLatestCheckpoint: readLatestTurnId,
      revertBefore: async beforeTurnId => {
        const response = await request('thread/revert', {
          threadId: currentThreadId,
          beforeTurnId,
        });
        if (response?.thread?.id !== currentThreadId) {
          const failure = Error(
            'Codex history reconciliation returned the wrong thread',
          );
          failSession(failure);
          throw failure;
        }
      },
    });
  };

  const acknowledgeCheckpoint = async checkpoint => {
    await ledger.acknowledge(checkpoint);
  };

  return makeExo('CodexClient', CodexClientInterface, {
    async send(prompt, opts = {}) {
      if (terminated) throw Error('Codex session terminated');
      if (closing) throw Error('Codex session closing');
      if (new TextEncoder().encode(prompt).byteLength > maxPromptBytes) {
        throw makeError(X`Codex prompt exceeded ${maxPromptBytes} bytes`);
      }
      if (turnReserved) {
        throw Error('Codex session already has an active turn');
      }
      turnReserved = true;
      let currentThreadId;
      await null;
      try {
        currentThreadId = await ensureThread(opts);
        if (opts.acknowledgedCheckpoint) {
          await acknowledgeCheckpoint(String(opts.acknowledgedCheckpoint));
        }
        await reconcileThread();
      } catch (error) {
        turnReserved = false;
        throw error;
      }
      if (terminated) {
        turnReserved = false;
        throw Error('Codex session terminated');
      }
      const channel = makeBufferedReader();
      let resolveTerminal = () => {};
      const terminal = /** @type {Promise<void>} */ (
        new Promise(resolve => {
          resolveTerminal = () => resolve(undefined);
        })
      );
      const turn = {
        threadId: currentThreadId,
        push: channel.push,
        interrupted: false,
        terminal,
        resolveTerminal,
        events: 0,
        bytes: 0,
        toolCalls: 0,
        serverRequestIds: new Set(),
        toolCallIds: new Set(),
        textItems: new Set(),
        messagePhases: new Map(),
        earlyByTurn: new Map(),
        earlyEvents: 0,
        earlyBytes: 0,
      };
      active = turn;
      turn.wallTimer = setTimeout(() => {
        if (active === turn) {
          void interruptActive(
            `Codex turn exceeded ${turnWallTimeoutMs} ms wall time`,
          );
        }
      }, turnWallTimeoutMs);
      channel.setOnClose(() => {
        if (active === turn) void interruptActive('Codex turn interrupted');
      });
      try {
        await audit('turn-requested', {
          threadId: currentThreadId,
          promptBytes: new TextEncoder().encode(prompt).byteLength,
          model: String(opts.model || model || ''),
          reasoningEffort: String(
            opts.reasoningEffort || reasoningEffort || '',
          ),
        });
        // Floot commits only after a successful terminal event, so the turn
        // about to be dispatched is written ahead first: the marker names the
        // checkpoint the thread must be rolled back to if nothing acknowledges
        // it.
        turn.ledgerTurn = await ledger.begin({
          baseCheckpoint: await readLatestTurnId(),
        });
        const response = await request('turn/start', {
          threadId: currentThreadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
          approvalPolicy,
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: ['/workspace', '/tmp', '/run', '/scratch'],
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          },
          ...(opts.model || model ? { model: opts.model || model } : {}),
          ...(opts.reasoningEffort || reasoningEffort
            ? { effort: opts.reasoningEffort || reasoningEffort }
            : {}),
        });
        if (
          typeof response?.turn?.id !== 'string' ||
          response.turn.id === '' ||
          response.turn.status !== 'inProgress'
        ) {
          const failure = Error(
            'Codex app-server did not return an in-progress turn id',
          );
          failSession(failure);
          throw failure;
        }
        if (active === turn) {
          turn.turnId = `${response.turn.id}`;
          // The thread is materialized from here on: a later turn can ask
          // Codex for the latest turn id without erroring.
          threadHasTurns = true;
          await turn.ledgerTurn.observe(turn.turnId);
          const early = turn.earlyByTurn.get(turn.turnId) || [];
          turn.earlyByTurn.clear();
          for (const message of early) {
            if (active !== turn) break;
            // Preserve the app-server event order, including durable audit
            // appends, before returning control to the stream consumer.
            // eslint-disable-next-line no-await-in-loop
            await onNotification(message);
          }
        }
      } catch (error) {
        await settleTurn(turn, {
          type: 'failed',
          reason: error instanceof Error ? error.message : `${error}`,
        });
      }
      return channel.reader;
    },
    async acknowledge(checkpoint) {
      await ensureThread();
      await acknowledgeCheckpoint(checkpoint);
    },
    async models() {
      await ensureReady();
      const models = [];
      let cursor = null;
      for (let page = 0; page < 10; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const response = await request('model/list', {
          cursor,
          limit: 100,
          includeHidden: false,
        });
        if (
          !Array.isArray(response?.data) ||
          !(
            response.nextCursor === null ||
            response.nextCursor === undefined ||
            typeof response.nextCursor === 'string'
          )
        ) {
          const failure = Error(
            'Codex app-server returned a malformed model catalog',
          );
          failSession(failure);
          throw failure;
        }
        models.push(...response.data);
        cursor = response?.nextCursor;
        if (!cursor) break;
        if (page === 9) {
          throw Error('Codex model catalog exceeded 10 pages');
        }
      }
      return harden(models);
    },
    async interrupt() {
      const failure = await interruptActive('Codex turn interrupted');
      if (failure) throw failure;
    },
    async terminate() {
      // Reserve shutdown synchronously before the first await. The message pump
      // and any concurrent terminate caller observe this admission barrier.
      closing = true;
      await null;
      if (pendingToolOperations.size > 0) {
        if (!closeDeferredAudited) {
          await audit('session-close-deferred', {
            pendingToolCalls: pendingToolOperations.size,
          });
          closeDeferredAudited = true;
        }
        throw Error(
          `Codex session has ${pendingToolOperations.size} unsettled Endo tool call(s)`,
        );
      }
      if (!terminated && !closeRequestedAudited) {
        await audit('session-close-requested', {
          threadId: threadId || '',
          needsRollback: ledger.status().needsReconciliation,
        });
        closeRequestedAudited = true;
      }
      const done = failSession(Error('Codex session terminated'), false);
      await done;
    },
    async status() {
      return harden({
        sessionId,
        threadId: threadId || null,
        ready: initialized && !terminated,
        active: Boolean(active),
        ...(ledger.status().needsReconciliation
          ? { needsReconciliation: true }
          : {}),
        pendingToolCalls: pendingToolOperations.size,
        ...(toolSetId ? { toolSetId } : {}),
        closing,
        terminated,
        cleanupFailures: harden([...cleanupFailures]),
      });
    },
    help(method = '') {
      const methods = harden({
        send: 'send(prompt, options?) -> streamed provider-neutral events',
        models: 'models() -> app-server model catalog',
        interrupt: 'interrupt() -> interrupt the active turn',
        acknowledge:
          'acknowledge(checkpoint) -> confirm the durable Floot commit',
        terminate: 'terminate() -> stop the app-server process',
        status: 'status() -> session lifecycle state',
      });
      return method
        ? methods[method] || `Unknown method ${method}`
        : Object.values(methods).join('\n');
    },
  });
};
harden(makeCodexClient);
