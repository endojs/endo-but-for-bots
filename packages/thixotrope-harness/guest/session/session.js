// @ts-check
/**
 * The session (M1a W1a.4; architecture 3.2; `designs/m1a-interfaces.md`
 * sections 3.1, 8 and 11).
 *
 * `makeSession({ config, services, rowReporter })` builds one session: the
 * record log (records.js), live publishing (live.js), the turn runner
 * (turn.js), the queue (W1a.5 queue.js), and the `SessionCore` that
 * recovery (W1a.5 recovery.js) works on. It returns the `Session` facet
 * (held by the factory, the Composer, the gateway) and `SessionInternal`
 * (held only by the factory).
 *
 * Every Session method runs in one crank and ends it with one publish of
 * that crank's events (turn.js `flush`); `enqueueOnce` claims the entry in
 * the same crank when the session is idle and the queue is not held.
 */
import { interfaces } from '../lib/interfaces.js';
import { limits } from '../lib/limits.js';
import { makeQueue as defaultMakeQueue } from './queue.js';
import {
  isRestartSignal as defaultIsRestartSignal,
  recoverAfterRestart as defaultRecoverAfterRestart,
} from './recovery.js';
import { makeLivePublishing } from './live.js';
import { makeRecordLog } from './records.js';
import { toolTable } from './tool-table.js';
import { turnHooks } from './turn-hooks.js';
import { makeTurnRunner } from './turn.js';

// The exo methods are typed loosely; the interface guards check the values.
const { makeExo } = /** @type {any} */ (globalThis);

/**
 * @typedef {object} SessionOptions overrides for tests; the session program
 *   passes none
 * @property {typeof defaultMakeQueue} [makeQueue]
 * @property {(core: any, active: any) => boolean} [recoverAfterRestart]
 * @property {(error: unknown) => boolean} [isRestartSignal]
 * @property {number} [maxToolRounds]
 * @property {readonly any[]} [toolTable]
 * @property {typeof turnHooks} [hooks]
 */

/**
 * @param {{ config: any, services: { backend: any, host: any }, rowReporter: any }} makeArgs
 * @param {SessionOptions} [options]
 */
export const makeSession = (
  { config, services, rowReporter },
  {
    makeQueue = defaultMakeQueue,
    recoverAfterRestart = defaultRecoverAfterRestart,
    isRestartSignal = defaultIsRestartSignal,
    maxToolRounds = limits.maxToolRounds,
    toolTable: table = toolTable,
    hooks = turnHooks,
  } = {},
) => {
  let { title } = config;
  const records = makeRecordLog();
  const live = makeLivePublishing({ host: services.host });
  const runner = makeTurnRunner({
    config,
    services,
    rowReporter,
    records,
    live,
    recoverAfterRestart,
    isRestartSignal,
    hooks,
    table,
    maxToolRounds,
  });
  const queue = makeQueue({ onChange: runner.queueChanged });

  /** Section 11: what recovery.js (W1a.5) works on. */
  const core = harden({
    records,
    queue,
    current: runner.current,
    settle: runner.settle,
    report: runner.report,
    publishOutside: runner.publishOutside,
    lastKnownTime: runner.lastKnownTime,
    claimNext: runner.claimNext,
  });
  runner.attach({ queue, core });

  const info = () => {
    /** @type {Record<string, any>} */
    const result = {
      key: config.key,
      title,
      backendTitle: config.backendTitle,
      modelId: config.modelId,
      presetLabel: config.preset.label,
      createdAt: config.createdAt,
    };
    if (config.reasoningEffort !== undefined) {
      result.reasoningEffort = config.reasoningEffort;
    }
    return harden(result);
  };

  /**
   * Run one Session method's crank work and publish its events at the end.
   * @template T
   * @param {() => T} work
   * @returns {T}
   */
  const inCrank = work => {
    try {
      return work();
    } finally {
      runner.flush();
    }
  };

  const session = makeExo('Session', interfaces.Session, {
    getInfo() {
      return info();
    },
    /** @param {string} newTitle */
    rename(newTitle) {
      inCrank(() => {
        title = newTitle;
        runner.report({ title });
      });
    },
    watch() {
      /** @type {Record<string, any>} */
      const snapshot = {
        rev: live.rev(),
        info: info(),
        pending: queue.view(),
        usage: runner.usage(),
      };
      const status = runner.currentStatus();
      if (status !== undefined) snapshot.current = status;
      return harden(snapshot);
    },
    /**
     * Crank A of section 6.1: receipt, entry, and the claim when idle.
     * @param {{ text: string }} submission
     * @param {string} requestId
     * @param {number} at
     */
    enqueueOnce(submission, requestId, at) {
      return inCrank(() => {
        runner.see(at);
        const { receipt, added } = queue.enqueueOnce(submission, requestId, at);
        if (!added) return receipt;
        if (runner.claimNext() === undefined) return receipt;
        return queue.receiptFor(requestId) ?? receipt;
      });
    },
    /** @param {string} requestId */
    getSubmissionReceipt(requestId) {
      return queue.receiptFor(requestId);
    },
    listPending() {
      return queue.view();
    },
    /**
     * Direct start (A.4): refused with R4-10 while a turn is current, whatever
     * the queue holds.
     * @param {{ text: string }} submission
     * @param {number} [at]
     */
    startTurn(submission, at) {
      runner.see(at);
      return runner.startTurn(submission.text, at ?? runner.lastKnownTime());
    },
    getCurrentTurn() {
      return runner.currentTurn();
    },
    /** @param {string} [cursor] */
    getHistoryPage(cursor) {
      return runner.historyPage(cursor);
    },
    getUsage() {
      return runner.usage();
    },
  });

  const internal = makeExo('SessionInternal', interfaces.SessionInternal, {
    rowSnapshot() {
      return harden({
        title,
        activity: runner.activity(),
        messageCount: records.messageCount(),
        queuedCount: queue.size(),
      });
    },
  });

  return harden({ session, internal });
};
harden(makeSession);
