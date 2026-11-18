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
 * the same crank when the session is idle and the queue is not held. The
 * session asks for its adapter ports when it is made (`Backend.open`, once
 * per adapter incarnation; contract 6.1).
 *
 * M5 (W5.3; m5-interfaces.md 2.4.1, 2.8, H-4): `make` builds the session's
 * label map (seeded from `services.endowments`, then `labelSeeds`) and its
 * runtime (`m5-parts.js`), and the `Session` exo takes the M5 guard:
 * `grants()` and `enqueueMessageOnce` forward to the runtime's `grants` and
 * `packages` parts, which every runtime has.
 */
import { interfaces, texts } from '../lib/guards/session.js';
import { limits } from '../lib/limits.js';
import { labelSeeds as defaultLabelSeeds, seedsFor } from './label-seeds.js';
import { makeLabels } from './labels.js';
import { m5Parts, makeRuntime } from './m5-parts.js';
import { makeQueue as defaultMakeQueue } from './queue.js';
import {
  isRestartSignal as defaultIsRestartSignal,
  recoverAfterRestart as defaultRecoverAfterRestart,
} from './recovery.js';
import { makeSessionExport } from './export.js';
import { makeLivePublishing } from './live.js';
import { makeRecordLog } from './records.js';
import { submissionField } from './staging.js';
import { toolSources, toolTable } from './tool-table.js';
import { turnHooks } from './turn-hooks.js';
import { makeTurnRunner } from './turn.js';

/** @import { Runtime } from './m5-parts.js' */

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
 * @property {readonly any[]} [toolSources] M5 S1
 * @property {readonly any[]} [parts] M5 runtime parts (`m5-parts.js`)
 * @property {readonly any[]} [labelSeeds] M5 (`label-seeds.js`)
 */

/**
 * @param {{ config: any, services: { backend: any, host: any, endowments?: any[] }, rowReporter: any }} makeArgs
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
    toolSources: sources = toolSources,
    parts = m5Parts,
    labelSeeds = defaultLabelSeeds,
  } = {},
) => {
  let { title } = config;
  // M5 (2.4.1): a seed whose label is taken fails `make`.
  const labels = makeLabels({
    seeds: seedsFor(services, config, labelSeeds),
  });
  /** @type {Runtime | undefined} */
  let runtime;
  const records = makeRecordLog();
  const live = makeLivePublishing({
    host: services.host,
    // `runner` is defined below; a break is reported only in a later crank.
    onStale: publisher => runner.publisherBroke(publisher),
  });
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
    // M2 (m2-interfaces.md 2.4 item 6): the runner builds the session's
    // ContextSource itself, over the archive.
    sources,
    getRuntime: () => runtime,
  });
  // Receipts keep the turn id; the Turn is minted when one is handed out
  // while the session keeps the turn (J-9152, m2-interfaces.md 5.3).
  // `QueueEntry.sendNow` claims through the runner (crank A).
  const queue = makeQueue({
    onChange: runner.queueChanged,
    turnOf: runner.turnById,
    claim: () => runner.claimNext(),
    cancelCurrent: () => runner.cancelCurrent(),
  });

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

  // M2 W2.7 (7.1, 7.3): the delete fence, blob pages, export, importing.
  const lifecycle = makeSessionExport({
    records,
    queue,
    runner,
    config,
    info,
    rowReporter,
  });
  const refuseIfDeleting = () => {
    if (lifecycle.isDeleting()) throw Error(texts.sessionDeleting);
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

  // M5 (S4): the runtime parts, made once the internals they use exist.
  runtime = makeRuntime({
    labels,
    services,
    config,
    session: harden({ core, queue, runner, inCrank, refuseIfDeleting }),
    parts,
  });
  // Contract 6.1: the ports are opened once, here, and held across turns.
  runner.openPorts();

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
     * @param {any} submission inline `{ text }` or a StagedText
     * @param {string} requestId
     * @param {number} at
     */
    enqueueOnce(submission, requestId, at) {
      refuseIfDeleting();
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
     * @param {any} submission inline `{ text }` or a StagedText
     * @param {number} [at]
     */
    startTurn(submission, at) {
      refuseIfDeleting();
      runner.see(at);
      return runner.startTurn(
        submissionField(submission),
        at ?? runner.lastKnownTime(),
      );
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
    /** @param {string} turnId W2.5 (m2-interfaces.md 4.9) */
    findTurn(turnId) {
      return runner.findTurn(turnId);
    },
    /**
     * M5 (2.6, A.4): `enqueueOnce` with attachments; the `packages` part
     * (W5.7) does the work in this crank.
     * @param {any} submission inline `{ text }` or a StagedText
     * @param {string} requestId
     * @param {number} at
     * @param {any[]} attachments
     */
    enqueueMessageOnce(submission, requestId, at, attachments) {
      const { packages } = runtime;
      refuseIfDeleting();
      return inCrank(() =>
        packages.enqueueMessageOnce(submission, requestId, at, attachments),
      );
    },
    /** M5 (2.5): the session's granted tools (W5.6's `grants` part). */
    grants() {
      return runtime.grants.facet;
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
    /** @param {string} [cursor] */
    blobPage(cursor) {
      return lifecycle.blobPage(cursor);
    },
    deleteSelf() {
      return inCrank(() => lifecycle.deleteSelf());
    },
    /** @param {string} [cursor] */
    exportState(cursor) {
      return lifecycle.exportState(cursor);
    },
    /** @param {any} chunk */
    importState(chunk) {
      return inCrank(() => lifecycle.importState(chunk));
    },
  });

  return harden({ session, internal });
};
harden(makeSession);
