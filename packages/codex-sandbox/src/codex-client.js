// @ts-check
import { clearTimeout, setTimeout } from 'node:timers';

import { makeError, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { M } from '@endo/patterns';

import { toolFromItem } from './codex-protocol.js';

const CodexClientInterface = M.interface('CodexClient', {
  send: M.call(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.promise()),
  models: M.call().returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
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
 * @property {number} events
 * @property {number} bytes
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
 * @param {string} [options.threadId]
 * @param {(threadId: string) => Promise<void>} [options.saveThreadId]
 * @param {string} [options.cwd]
 * @param {string} [options.model]
 * @param {string} [options.reasoningEffort]
 * @param {string} [options.developerInstructions]
 * @param {string} [options.approvalPolicy]
 * @param {string} [options.sandbox]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.maxTurnEvents]
 * @param {number} [options.maxTurnBytes]
 * @param {number} [options.maxToolResultChars]
 * @param {number} [options.maxPromptBytes]
 * @param {number} [options.maxRequestBytes]
 */
export const makeCodexClient = ({
  start,
  sessionId,
  reportCleanupFailure = () => undefined,
  threadId: savedThreadId,
  saveThreadId = async () => undefined,
  cwd = '/workspace',
  model,
  reasoningEffort,
  developerInstructions,
  approvalPolicy = 'never',
  sandbox = 'workspace-write',
  requestTimeoutMs = 30_000,
  maxTurnEvents = 10_000,
  maxTurnBytes = 16 * 1024 * 1024,
  maxToolResultChars = 64 * 1024,
  maxPromptBytes = 1024 * 1024,
  maxRequestBytes = 2 * 1024 * 1024,
}) => {
  /** @type {AppServerTransport | undefined} */
  let transport;
  /** @type {Promise<void> | undefined} */
  let ready;
  /** @type {Promise<void> | undefined} */
  let shutdown;
  let terminated = false;
  let initialized = false;
  /** @type {string[]} */
  const cleanupFailures = [];
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
    turn.push(event);
    active = undefined;
    turnReserved = false;
    turn.resolveTerminal();
  };

  const failSession = error => {
    const failure = error instanceof Error ? error : Error(`${error}`);
    terminated = true;
    signalTermination(failure);
    turnReserved = false;
    rejectPending(failure);
    if (active) endActive(harden({ type: 'abort', reason: failure.message }));
    if (!shutdown) {
      shutdown = (async () => {
        await null;
        if (transport) {
          await transport.close();
        } else if (ready) {
          // Do not let an unbounded transport factory delay terminate(). The
          // startup continuation observes `terminated` and closes any process
          // that arrives late; keep its rejection observed here.
          void ready.catch(() => undefined);
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
        await failSession(Error(`${reason} during startup`));
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

  const onNotification = message => {
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
        if (status === 'completed') {
          endActive({ type: 'end' });
        } else if (status === 'interrupted' || status === 'failed') {
          endActive({
            type: 'abort',
            reason: `${
              (status === 'interrupted' && active?.interruptReason) ||
              active?.errorReason ||
              params.turn?.error?.message ||
              `Codex turn ${status || 'failed'}`
            }`,
          });
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
          // No model-callable bridge is installed in this core. Reject every
          // server request so a newly introduced request cannot silently grant
          // authority.
          await sendMessage({
            id: message.id,
            error: {
              code: -32_601,
              message: `Unsupported server request: ${message.method}`,
            },
          });
        } else if ('method' in message) {
          onNotification(message);
        }
      }
      failSession(Error('Codex app-server stdout closed'));
    } catch (error) {
      failSession(error);
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
              experimentalApi: false,
              requestAttestation: false,
            },
          });
          if (
            typeof initializeResult?.codexHome !== 'string' ||
            typeof initializeResult?.platformFamily !== 'string' ||
            typeof initializeResult?.platformOs !== 'string' ||
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
      sandbox,
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
      const response = await request('thread/start', common);
      const created = response?.thread?.id;
      if (typeof created !== 'string' || created === '') {
        const failure = Error('Codex app-server did not return a thread id');
        failSession(failure);
        throw failure;
      }
      // Persistence is part of thread creation: never execute a turn whose
      // continuation identity was not durably accepted by the caller.
      try {
        await saveThreadId(created);
      } catch (error) {
        failSession(error);
        throw error;
      }
      threadId = created;
    }
    threadReady = true;
    return /** @type {string} */ (threadId);
  };

  return makeExo('CodexClient', CodexClientInterface, {
    async send(prompt, opts = {}) {
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
        textItems: new Set(),
        messagePhases: new Map(),
        earlyByTurn: new Map(),
        earlyEvents: 0,
        earlyBytes: 0,
      };
      active = turn;
      channel.setOnClose(() => {
        if (active === turn) void interruptActive('Codex turn interrupted');
      });
      try {
        const response = await request('turn/start', {
          threadId: currentThreadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
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
          const early = turn.earlyByTurn.get(turn.turnId) || [];
          turn.earlyByTurn.clear();
          for (const message of early) {
            if (active !== turn) break;
            onNotification(message);
          }
        }
      } catch (error) {
        if (active === turn) {
          endActive({
            type: 'abort',
            reason: error instanceof Error ? error.message : `${error}`,
          });
        }
      }
      return channel.reader;
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
      const done = failSession(Error('Codex session terminated'));
      await done;
    },
    async status() {
      return harden({
        sessionId,
        threadId: threadId || null,
        ready: initialized && !terminated,
        active: Boolean(active),
        terminated,
        cleanupFailures: harden([...cleanupFailures]),
      });
    },
    help(method = '') {
      const methods = harden({
        send: 'send(prompt, options?) -> streamed provider-neutral events',
        models: 'models() -> app-server model catalog',
        interrupt: 'interrupt() -> interrupt the active turn',
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
