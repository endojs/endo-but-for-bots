// @ts-check
/**
 * The session (M1a W1a.4; architecture 3.2; `designs/m1a-interfaces.md`
 * sections 3.1, 8 and 11).
 *
 * `makeSession({ config, services, rowReporter })` builds one session: the
 * label map and the runtime parts (runtime-parts.js: every per-session job
 * besides the turn's own life), the record log (records.js), live
 * publishing (live.js), the delete fence, the archive (archive.js) and its
 * ContextSource, the turn runner (turn.js, which makes the session's
 * recovery), the queue (queue.js) and the export (export.js). It returns
 * the `Session` facet
 * (held by the factory, the Composer, the gateway) and `SessionInternal`
 * (held only by the factory).
 *
 * Every Session method runs in one crank and ends it with one publish of
 * that crank's events (turn.js `flush`); `enqueueOnce` claims the entry in
 * the same crank when the session is idle and the queue is not held. The
 * session asks for its adapter ports when it is made (`Backend.open`, once
 * per adapter incarnation; contract 6.1).
 *
 * M5 (W5.3; m5-interfaces.md 2.4.1, 2.8, H-4): the label map is seeded
 * from `services.endowments`, then `labelSeeds`; the `Session` exo takes
 * the M5 guard: `grants()` answers the `grants` part's facet;
 * `enqueueOnce` and `enqueueMessageOnce` share one enqueue, the latter
 * after `checkAttachments` (packages.js).
 */
import { interfaces, texts } from '../lib/guards/session.js';
import { limits } from '../lib/limits.js';
import { labelSeeds as defaultLabelSeeds, seedsFor } from './label-seeds.js';
import { makeLabels } from './labels.js';
import { runtimeParts, makeRuntime } from './runtime-parts.js';
import { makeQueue as defaultMakeQueue } from './queue.js';
import { isRestartSignal as defaultIsRestartSignal } from './recovery.js';
import { checkAttachments } from './packages.js';
import { makeSessionArchive } from './archive.js';
import { makeContextSource } from './context-source.js';
import { makeSessionExport } from './export.js';
import { makeLivePublishing } from './live.js';
import { makeRecordLog } from './records.js';
import { submissionField } from './staging.js';
import { toolTable } from './tool-table.js';
import { makeTurnRunner } from './turn.js';

// The exo methods are typed loosely; the interface guards check the values.
const { makeExo } = /** @type {any} */ (globalThis);

/**
 * @typedef {object} SessionOptions overrides for tests; the session program
 *   passes none
 * @property {typeof defaultMakeQueue} [makeQueue]
 * @property {(error: unknown) => boolean} [isRestartSignal]
 * @property {number} [maxToolRounds]
 * @property {readonly any[]} [toolTable]
 * @property {readonly any[]} [parts] the runtime parts (`runtime-parts.js`;
 *   a test adds a part with hooks or tools)
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
    isRestartSignal = defaultIsRestartSignal,
    maxToolRounds = limits.maxToolRounds,
    toolTable: table = toolTable,
    parts = runtimeParts,
    labelSeeds = defaultLabelSeeds,
  } = {},
) => {
  let { title } = config;
  // M5 (2.4.1): a seed whose label is taken fails `make`.
  const labels = makeLabels({
    seeds: seedsFor(services, config, labelSeeds),
  });
  // The runtime parts (S4), made once, in table order; they send nothing.
  const runtime = makeRuntime({ labels, services, config, parts });
  const records = makeRecordLog();
  const live = makeLivePublishing({
    host: services.host,
    // `runner` is defined below; a break is reported only in a later crank.
    onStale: publisher => runner.publisherBroke(publisher),
  });
  // The delete fence (7.1): closed once by `deleteSelf`; no claim, no
  // direct start, no seal and no new work afterwards.
  let deleted = false;
  const fence = harden({
    close: () => {
      deleted = true;
    },
    closed: () => deleted,
  });
  // M2 (D-M2-1; m2-interfaces.md 4): settled turns' records leave the vat in
  // segments; the archive's answers reach the runner in a later crank.
  const archive = makeSessionArchive({
    records,
    onSealed: dropped => runner.onSealed(dropped),
    onNotSealed: (error, ports) => runner.onNotSealed(error, ports),
    fence,
  });
  const contextSource = makeContextSource({ records, archive });
  const runner = makeTurnRunner({
    config,
    services,
    rowReporter,
    records,
    live,
    archive,
    contextSource,
    fence,
    runtime,
    isRestartSignal,
    table,
    maxToolRounds,
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

  runner.attach({ queue });

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
    archive,
    fence,
    config,
    info,
    rowReporter,
  });
  const refuseIfDeleting = () => {
    if (fence.closed()) throw Error(texts.sessionDeleting);
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

  /**
   * Crank A of section 6.1 (both enqueue methods): receipt, entry, and the
   * claim when idle.
   * @param {any} submission inline `{ text }` or a StagedText
   * @param {string} requestId
   * @param {number} at
   * @param {readonly { label: string, value: any }[]} [attachments]
   */
  const enqueue = (submission, requestId, at, attachments) => {
    runner.see(at);
    const { receipt, added } = queue.enqueueOnce(
      submission,
      requestId,
      at,
      attachments,
    );
    if (!added) return receipt;
    if (runner.claimNext() === undefined) return receipt;
    return queue.receiptFor(requestId) ?? receipt;
  };
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
      return inCrank(() => enqueue(submission, requestId, at));
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
     * M5 (2.6, A.4): `enqueueOnce` with attachments, refused (2.6) before
     * anything is written; the `packages` part's `onClaim` opens them.
     * @param {any} submission inline `{ text }` or a StagedText
     * @param {string} requestId
     * @param {number} at
     * @param {any[]} attachments
     */
    enqueueMessageOnce(submission, requestId, at, attachments) {
      refuseIfDeleting();
      return inCrank(() => {
        checkAttachments(submission, attachments);
        return enqueue(submission, requestId, at, attachments);
      });
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
