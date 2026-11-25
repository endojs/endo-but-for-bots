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
import { inventoryPage } from './inventory.js';
import { runtimeParts, makeRuntime } from './runtime-parts.js';
import { makeQueue as defaultMakeQueue } from './queue.js';
import { markerOf } from '../lib/pending-queue.js';
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
import { makeContextWindow } from './compaction.js';
import { subagentConfig, withoutSubagentModel } from '../lib/subagent-model.js';

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
  { config: given, services: givenServices, rowReporter },
  {
    makeQueue = defaultMakeQueue,
    isRestartSignal = defaultIsRestartSignal,
    maxToolRounds = limits.maxToolRounds,
    toolTable: table = toolTable,
    parts = runtimeParts,
    labelSeeds = defaultLabelSeeds,
  } = {},
) => {
  // D-M9-27: a subagent spawned through an older factory carries its
  // model choice as an endowment; the session runs on it from here on.
  // The choice is the session's config, not an object of its inventory.
  const config = subagentConfig(given, givenServices.endowments);
  const services = withoutSubagentModel(givenServices);
  let { title } = config;
  let inventoryRevision = 0;
  // Creation seeds precede the first possible reader and live publisher.
  let announceInventory = false;
  const inventoryChanged = () => {
    inventoryRevision += 1;
    if (announceInventory) runner.inventoryChanged(inventoryRevision);
  };
  // M5 (2.4.1): a seed whose label is taken fails `make`.
  const labels = makeLabels({
    seeds: seedsFor(services, config, labelSeeds),
    onChange: inventoryChanged,
    children: () => runtime.subagents,
  });
  // The runtime parts (S4), made once, in table order; they send nothing.
  const records = makeRecordLog();
  // M8 S-6 (m8-interfaces.md 4.7): the context window over the log; the
  // runner's clock is read at run time (`runner` is defined below).
  const window = makeContextWindow({
    records,
    seenAt: () => runner.lastKnownTime(),
  });
  const runtime = makeRuntime({
    labels,
    inventoryChanged,
    services,
    config,
    contextWindow: window,
    parts,
  });
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
    epoch: () => window.epoch(),
  });
  const contextSource = makeContextSource({
    records,
    archive,
    boundary: () => window.boundary(),
  });
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
    window,
  });
  // Receipts keep the turn id; the Turn is minted when one is handed out
  // while the session keeps the turn (J-9152, m2-interfaces.md 5.3).
  // `QueueEntry.sendNow` claims through the runner (crank A).
  const queue = makeQueue({
    onChange: runner.queueChanged,
    turnOf: runner.turnById,
    claim: () => runner.claimNext(),
    cancelCurrent: () => runner.cancelCurrent(),
    admit: () => runtime.hooks.admit(),
  });

  runner.attach({ queue });
  announceInventory = true;

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
    execution: runtime.environment,
    inbox: runtime.inbox,
  });
  const refuseIfDeleting = () => {
    if (fence.closed()) throw Error(texts.sessionDeleting);
  };
  // m6-interfaces.md R-3 (a), D-M6-20: a stopped or stopping session
  // refuses user-facing starts before anything is written.
  const refuseIfStopped = () => {
    const refusal = runtime.hooks.admit();
    if (refusal !== undefined) throw Error(refusal);
  };
  /**
   * The `execution` event (seam S-3), published after the crank's own
   * flush so its rev follows any in-turn batch of this crank.
   */
  const announce = () =>
    runner.publishOutside([
      { type: 'execution', ...runtime.environment.executionState() },
    ]);

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
   * @param {{ spoken?: boolean, dictated?: boolean }} [options] M11: the
   *   spoken-mode marker (m11-interfaces.md 9.1)
   */
  const enqueue = (submission, requestId, at, attachments, options) => {
    runner.see(at);
    const { receipt, added } = queue.enqueueOnce(
      submission,
      requestId,
      at,
      attachments,
      markerOf(options),
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
        inventoryRevision,
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
     * @param {{ spoken?: boolean, dictated?: boolean }} [options] M11
     *   (m11-interfaces.md 9.1)
     */
    enqueueOnce(submission, requestId, at, options) {
      refuseIfDeleting();
      refuseIfStopped();
      return inCrank(() =>
        enqueue(submission, requestId, at, undefined, options),
      );
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
      refuseIfStopped();
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
    /** @param {string} [cursor] */
    getInventoryPage(cursor) {
      return inventoryPage(labels, inventoryRevision, cursor);
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
     * @param {{ spoken?: boolean, dictated?: boolean }} [options] M11
     *   (m11-interfaces.md 9.1)
     */
    enqueueMessageOnce(submission, requestId, at, attachments, options) {
      refuseIfDeleting();
      refuseIfStopped();
      return inCrank(() => {
        checkAttachments(submission, attachments);
        return enqueue(submission, requestId, at, attachments, options);
      });
    },
    /** M5 (2.5): the session's granted tools (W5.6's `grants` part). */
    grants() {
      return runtime.grants.facet;
    },
    /**
     * Emergency stop (m6-interfaces.md 4.5, R4-8): crank E1 marks the
     * part `stopping`, holds the queue `stopped`, cancels the current turn
     * and sends the control's stop; the answer (E2) is `stopped`, or
     * `stopIncomplete` with the state left `stopping`.
     */
    emergencyStop() {
      const { environment } = runtime;
      const wasStopped = environment.executionState().state === 'stopped';
      const stopping = environment.beginStop();
      if (wasStopped) return stopping;
      inCrank(() => {
        queue.hold('stopped', texts.holdStopped);
        runner.cancelCurrent();
      });
      announce();
      return stopping.finally(() => {
        announce();
      });
    },
    /** 4.5: running again; the hold stays until a new message or send-now. */
    resume() {
      return runtime.environment.resume().then((/** @type {any} */ state) => {
        if (queue.holdReason() === 'stopped') runner.claimNext();
        announce();
        return state;
      });
    },
    getExecutionState() {
      return runtime.environment.executionState();
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
    // M9 (m9-interfaces.md 3.2, S5): a delivery is recorded by the `inbox`
    // part and, when new, claimed in this crank if the session is idle and
    // not held (a `restart` hold lets it through, turn.js `claimNext`). A
    // runtime without the part refuses, as before it was built.
    /** @param {any} envelope */
    deliverMail(envelope) {
      const { inbox } = runtime;
      if (fence.closed()) return harden({ refused: texts.sessionDeleting });
      return inCrank(() => {
        runner.see(envelope.at);
        const delivery = inbox.deliver(envelope);
        if (delivery.number !== undefined && delivery.duplicate === undefined)
          runner.claimNext();
        return delivery;
      });
    },
    /** @param {number} postmark */
    cancelMail(postmark) {
      inCrank(() => {
        if (runtime.inbox?.cancel(postmark) === 'cancel-turn')
          runner.cancelCurrent();
      });
    },
  });

  return harden({ session, internal });
};
harden(makeSession);
