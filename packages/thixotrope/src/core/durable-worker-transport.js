// @ts-check
/** @import { Logger } from '../platform/logging.js' */
/** @import { TimerHandle, TimerPowers } from '../platform/timers.js' */
/** @import { PromiseKit } from '@endo/promise-kit' */
import harden from '@endo/harden';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { Fail, makeError, q, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';

import { makeSerialQueue } from '../serial-queue.js';
import { WorkerCrashError } from './worker-crash-error.js';
import { WorkerHaltError } from './worker-engine.js';

/**
 * @import {WorkerEngine, WorkerIncarnation} from './worker-engine.js'
 * @import {WorkerCrashRecord, WorkerStore} from '../store/store.js'
 */

/**
 * The first wait before retrying a crashed worker; each further retry
 * doubles it, up to {@link MAX_CRASH_RETRY_DELAY_MS}.
 */
const DEFAULT_CRASH_RETRY_DELAY_MS = 1000;
const MAX_CRASH_RETRY_DELAY_MS = 60_000;

/**
 * The most GC frames one crank carries. A run of journaled GC frames is
 * delivered with the next ordinary frame, or on its own once it is this
 * long. Part of the replay contract: a journal written under one limit must
 * be replayed under the same one, since it decides where cranks begin.
 */
export const GC_FRAMES_PER_CRANK = 64;

/**
 * A cadence snapshot that falls due waits until the transport has had no
 * operation queued or running for this long, so it lands between turns
 * rather than between one turn's deliveries.
 */
export const CADENCE_IDLE_MS = 50;

/**
 * A worker that is never idle that long snapshots anyway once this many
 * cadences of deliveries have accrued: the bound on the journal a restart
 * replays.
 */
export const CADENCE_FORCE_FACTOR = 4;

/**
 * @typedef {{ b64: string, hubSequence?: string, gc?: true }} JournalEntry
 */

/**
 * Split journal entries into the cranks they are delivered in: a run of GC
 * entries goes with the ordinary entry that follows it, or alone once it
 * holds {@link GC_FRAMES_PER_CRANK}. GC entries after the last such boundary
 * are held: not yet any crank's.
 *
 * Pure in the entries, so a replay finds the cranks the live deliveries
 * made, as long as it starts where a crank began (a snapshot cut always
 * does: a cut is where delivery stopped, and delivery stops only between
 * cranks).
 *
 * @param {Array<JournalEntry>} entries
 * @param {number} base the absolute journal index of `entries[0]`
 * @returns {{ cranks: Array<{ start: number, entries: Array<JournalEntry> }>, heldStart: number, held: Array<JournalEntry> }}
 */
export const journalCranks = (entries, base) => {
  /** @type {Array<{ start: number, entries: Array<JournalEntry> }>} */
  const cranks = [];
  let start = base;
  /** @type {Array<JournalEntry>} */
  let run = [];
  entries.forEach((entry, offset) => {
    run.push(entry);
    if (entry.gc !== true || run.length === GC_FRAMES_PER_CRANK) {
      cranks.push({ start, entries: run });
      start = base + offset + 1;
      run = [];
    }
  });
  return { cranks, heldStart: start, held: run };
};
harden(journalCranks);

/**
 * The durability envelope of one worker's hub session: the "wire" is
 * the worker engine's duct, the durability is snapshot-keyed frame
 * retention, and the OCapN hub owns all routing. Worker→host frames
 * flow to the `onFrame` callback; host→worker frames enter through
 * `write`.
 *
 * Durability discipline (the same envelope the captp host proved):
 *
 * - Host→worker frames are journaled *before* they reach the duct.
 *   The journal is truncated when a snapshot commits — frames are
 *   retained until subsumed by a snapshot, not until acknowledged.
 * - Wake = start an incarnation from the last snapshot and replay the
 *   journal suffix. The worker deterministically regenerates the
 *   outbound frames that suffix produced. Every outbound frame —
 *   live or regenerated — carries a session-lifetime sequence number
 *   (`outboundBase`, persisted with each snapshot, plus the frame's
 *   index in this incarnation); determinism gives a regenerated frame
 *   the same number, and the hub's inbound watermark (which commits
 *   atomically with the frame's effects) drops duplicates. Exactly
 *   once, with no per-frame metadata write.
 * - A crash without sleep restarts from the snapshot plus the full
 *   journal suffix and re-emits the suffix's frames under their
 *   original numbers, which the hub skips.
 *
 * - OCapN GC frames (`op:gc-exports`, `op:gc-answers`, as `isGcFrame`
 *   tells them) are journaled like any frame but not delivered on their
 *   own: a run of them waits in the journal for the next ordinary frame
 *   and goes into the worker in the same crank, before it and in order, or
 *   goes alone once {@link GC_FRAMES_PER_CRANK} have gathered. A GC frame
 *   therefore never wakes a sleeping worker and never costs a crank (with
 *   the full collection that ends every crank) of its own; a burst of a
 *   hundred costs two. The journal marks each GC entry, so where cranks
 *   begin is a function of the journal alone (`journalCranks`) and a
 *   replay delivers the same cranks. Delaying a release is always safe: a
 *   reference is released later, never earlier, and no frame crosses
 *   another.
 *
 * Sleep ends the incarnation: snapshot, record `{ ref, cut }` (the
 * journal index the snapshot subsumes), advance the outbound base,
 * truncate, terminate. The OCapN session — and every remote reference through
 * it — stays live; the next inbound frame wakes the worker.
 *
 * Every incarnation-touching operation — frame delivery, wake, sleep,
 * crash, retirement — is serialized on one operation chain, so a sleep
 * naturally drains the deliveries queued before it, and deliveries
 * queued after it reopen the worker from the snapshot it just took.
 *
 * Three kinds of failure end an incarnation, and they are told apart by
 * what retrying would do:
 *
 * - A halt (`WorkerHaltError`) is deterministic. Its message is recorded as
 *   the worker's `failure` and the logical session is retired at once.
 * - A crash (`WorkerCrashError`: the process was killed, or missed its
 *   deadline) may or may not repeat. With `maxDeliveryAttempts`, a crash
 *   that leaves journal frames undelivered is counted, and the transport
 *   owes the worker a retry: it waits, then replays the journal by itself,
 *   and keeps doing so until the replay completes or the count of crashes
 *   without progress reaches the bound, when it records a `failure` as a
 *   halt does. The count is kept in the worker's metadata, so a restart
 *   continues it. A crash during a snapshot is not counted.
 * - Anything else is the host's own trouble (a full disk, a lost lease, a
 *   sink that refused a frame). It is never counted against the worker: the
 *   frame stays in the journal and the next operation tries again, or the
 *   owed retry does if there is one.
 *
 * @param {object} powers
 * @param {TimerPowers} powers.timers
 * @param {Logger} powers.logging
 * @param {object} options
 * @param {string} options.workerId
 * @param {WorkerStore} options.store
 * @param {WorkerEngine} options.engine
 * @param {(bytes: Uint8Array, sequenceNumber: number) => void} options.onFrame
 *   worker→host frames, each with its session-lifetime sequence
 *   number for the hub's inbound watermark
 * @param {(frames: Array<{bytes: Uint8Array, sequenceNumber: number}>) => void} [options.onFrames]
 *   one completed crank, retaining each frame's replay identity
 * @param {number} [options.idleSleepMs] put the worker to sleep after this
 *   long with no operations. The worker binary drains the engine's
 *   promise-job queue to quiescence after every delivery and workers
 *   have no timer queue, so "no inbound frames for a while" is an
 *   exact dormancy signal, not a heuristic — a worker awaiting a
 *   remote promise sleeps as heap state and the settlement frame wakes
 *   it. If a future engine surfaces its own dormancy signal, it can
 *   feed this same seam.
 * @param {string} [options.debugLabel]
 * @param {boolean} [options.resident] never put this worker to sleep on the host's own
 *   initiative. An explicit `sleep` is still honoured: residency is the host
 *   declining to take that decision, not a refusal to obey one
 * @param {number} [options.snapshotEveryDeliveries] snapshot an awake worker
 *   once this many deliveries have accrued since its last snapshot and the
 *   transport has then been idle for {@link CADENCE_IDLE_MS}, or at once when
 *   {@link CADENCE_FORCE_FACTOR} times as many have, so a worker that never
 *   idles still bounds its journal, and the replay a restart needs; omitted
 *   means an awake worker snapshots only at sleep
 * @param {number} [options.maxDeliveryAttempts] record a failure, as a halt
 *   does, once this many attempts in a row have crashed without progress;
 *   omitted means crashes are not counted, and a worker that crashes on
 *   every attempt is woken again by every later frame
 * @param {number} [options.crashRetryDelayMs] with `maxDeliveryAttempts`,
 *   how long to wait before the first retry of a crashed worker; each
 *   further retry waits twice as long, up to a minute
 * @param {() => void} [options.onFatal] retire the failed logical session
 * @param {(bytes: Uint8Array) => boolean} [options.isGcFrame] whether a
 *   host→worker frame is an OCapN GC frame, which waits for the next
 *   ordinary frame (see above); omitted means every frame is delivered at
 *   once, in its own crank
 */
export const makeDurableWorkerTransport = (
  { timers, logging },
  {
    workerId,
    store,
    engine,
    onFrame,
    onFrames = undefined,
    idleSleepMs = undefined,
    snapshotEveryDeliveries = undefined,
    maxDeliveryAttempts = undefined,
    crashRetryDelayMs = DEFAULT_CRASH_RETRY_DELAY_MS,
    debugLabel = undefined,
    resident = false,
    onFatal = () => {},
    isGcFrame = undefined,
  },
) => {
  typeof onFrame === 'function' ||
    Fail`durable worker transport requires an onFrame callback`;
  const debugName = `${debugLabel ?? 'worker'}(${workerId.slice(0, 8)})`;

  let destroyed = false;
  /** @type {WorkerIncarnation | undefined} */
  let incarnation;
  /** Outbound frames seen from the current incarnation, replay included. */
  let seenOutbound = 0;
  /** Outbound frames subsumed by the current snapshot (from meta). */
  let outboundBase = 0;
  /** Absolute journal index of the next host→worker frame to deliver. */
  let deliveredUpTo = 0;
  /** Absolute journal index the recorded snapshot subsumes (from meta). */
  let snapshotCut = store.getMeta().snapshot?.cut ?? 0;
  let checkpointQueued = false;
  /**
   * Where the last cadence snapshot failed, so the next is attempted a whole
   * cadence later rather than after every delivery.
   */
  let snapshotFailedAt = 0;
  /**
   * Crashes since the worker last made progress, as recorded in its
   * metadata: a restart resumes the count instead of forgetting it.
   *
   * @type {WorkerCrashRecord | undefined}
   */
  let stalled = store.getMeta().crash;
  /**
   * The retry a counted crash is owed: its timer, and the outcome of the
   * attempt it will make, for a wake that arrives meanwhile to wait on.
   * While it is armed nothing else attempts a wake: frames queue in the
   * journal for the retry to replay.
   *
   * @type {{ timer: TimerHandle, outcome: PromiseKit<void> } | undefined}
   */
  let retry;
  /** Retries armed since the worker last woke: each doubles the wait. */
  let retriesArmed = 0;
  /** Whether a `failure` is on record: the worker has been given up on. */
  let givenUp = store.getMeta().failure !== undefined;
  /**
   * Whether the host has said it is going down. From then on a crash proves
   * nothing, since stopping a supervisor's process group kills its workers
   * too, so none is counted and no retry is owed.
   */
  let standingDown = false;
  let deliveredHubSequence = String(store.getMeta().hubDelivery ?? '0');
  let receivedHubSequence = BigInt(deliveredHubSequence);
  for (const { hubSequence } of store.readJournal()) {
    if (hubSequence !== undefined) {
      const n = BigInt(hubSequence);
      if (n > receivedHubSequence) receivedHubSequence = n;
    }
  }
  /**
   * The GC frames at the end of the journal that no crank has taken yet
   * (`journalCranks`), and the journal index of the first. Every entry
   * before `heldStart` belongs to a crank that has been, or is queued to
   * be, delivered.
   */
  let { heldStart, held } = journalCranks(
    store.readJournal(snapshotCut),
    snapshotCut,
  );
  /** Incarnations started and cranks delivered by this transport object. */
  let wakes = 0;
  let cranks = 0;
  /**
   * The operation queue: deliveries, wakes, sleeps, crashes, and
   * retirement all serialize here.
   */
  const serial = makeSerialQueue();

  // --- idle-sleep policy ---

  /** @type {TimerHandle | undefined} */
  let idleTimer;
  /**
   * The wait for quiet before a due cadence snapshot. Whether one is due is
   * not kept apart: it follows from the journal indices (`cadenceBacklog`),
   * so a snapshot that falls due during a delivery is found when the queue
   * next empties.
   *
   * @type {TimerHandle | undefined}
   */
  let cadenceTimer;
  let opGeneration = 0;

  const noteActivity = () => {
    opGeneration += 1;
    if (idleTimer !== undefined) {
      timers.clearTimer(idleTimer);
      idleTimer = undefined;
    }
    if (cadenceTimer !== undefined) {
      timers.clearTimer(cadenceTimer);
      cadenceTimer = undefined;
    }
  };

  const armIdleTimer = () => {
    if (
      idleSleepMs === undefined ||
      destroyed ||
      incarnation === undefined ||
      resident
    ) {
      return;
    }
    if (idleTimer !== undefined) {
      timers.clearTimer(idleTimer);
    }
    const generation = opGeneration;
    const timer = timers.setTimer(() => {
      idleTimer = undefined;
      if (
        destroyed ||
        opGeneration !== generation ||
        incarnation === undefined
      ) {
        return;
      }

      sleepInternal().catch(error =>
        logging.error(
          `thixotrope worker transport ${debugName}: idle sleep failed`,
          error,
        ),
      );
    }, idleSleepMs);
    timers.unrefTimer?.(timer);
    idleTimer = timer;
  };

  /**
   * Enqueue an incarnation-touching operation. The returned promise
   * settles with the operation; the queue itself swallows rejections
   * (each operation's failure is its caller's to observe or log,
   * never the next operation's).
   *
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const enqueue = operation => {
    noteActivity();
    const generation = opGeneration;
    const result = serial(operation);
    const settled = () => {
      armIdleTimer();
      // The last operation queued has settled: the queue is empty.
      if (generation === opGeneration) armCadenceTimer();
    };
    result.then(settled, settled);
    return result;
  };

  // --- cadence snapshots ---

  /**
   * Deliveries since the last snapshot, or since the last failed attempt at
   * one; 0 where cadence snapshots are not taken.
   */
  const cadenceBacklog = () =>
    snapshotEveryDeliveries === undefined || resident || !engine.canSnapshot
      ? 0
      : deliveredUpTo - Math.max(snapshotCut, snapshotFailedAt);

  /**
   * Queue a cadence snapshot behind the operations already queued, as a
   * sleep would be; the worker stays awake through it.
   */
  const queueCadenceSnapshot = () => {
    checkpointQueued = true;
    enqueue(async () => {
      checkpointQueued = false;
      await checkpointInternal();
    }).catch(error => {
      logging.error(
        `thixotrope worker transport ${debugName}: cadence snapshot failed`,
        error,
      );
    });
  };

  /**
   * With the queue empty and a cadence snapshot due, take it once nothing
   * has been queued for {@link CADENCE_IDLE_MS}. Any operation queued
   * meanwhile clears the wait (`noteActivity`), and the queue emptying again
   * starts it afresh.
   */
  const armCadenceTimer = () => {
    if (
      snapshotEveryDeliveries === undefined ||
      destroyed ||
      incarnation === undefined ||
      checkpointQueued ||
      cadenceBacklog() < snapshotEveryDeliveries
    ) {
      return;
    }
    const generation = opGeneration;
    const timer = timers.setTimer(() => {
      cadenceTimer = undefined;
      if (
        destroyed ||
        opGeneration !== generation ||
        incarnation === undefined ||
        checkpointQueued
      ) {
        return;
      }
      queueCadenceSnapshot();
    }, CADENCE_IDLE_MS);
    timers.unrefTimer?.(timer);
    cadenceTimer = timer;
  };

  /**
   * The one way an incarnation leaves: detached first, so no operation
   * reaches it meanwhile, then terminated; settles once it has ended.
   */
  const terminateIncarnation = async () => {
    const dying = incarnation;
    incarnation = undefined;
    if (dying === undefined) return;
    await dying.terminate();
  };

  /** @param {string} why */
  const cancelRetry = why => {
    if (retry === undefined) return;
    const { timer, outcome } = retry;
    retry = undefined;
    timers.clearTimer(timer);
    outcome.reject(Error(`worker ${debugName}: retry after a crash ${why}`));
  };

  /** The worker's metadata without its crash record. */
  const metaWithoutCrash = () => {
    const meta = { ...store.getMeta() };
    delete meta.crash;
    return meta;
  };

  /**
   * Keep the crash count in the worker's metadata. The count in memory is
   * the one this process acts on, so a write that fails loses only what a
   * restart would have remembered, and must not mask the crash it follows.
   */
  const persistStall = () => {
    try {
      const meta = metaWithoutCrash();
      store.setMeta(stalled === undefined ? meta : { ...meta, crash: stalled });
    } catch (error) {
      logging.error(
        `thixotrope worker transport ${debugName}: crash count not recorded`,
        error,
      );
    }
  };

  /**
   * Owe the worker a retry: after a wait that doubles each time, replay the
   * journal. The wait makes a burst of frames one attempt rather than one
   * each, and lets a fault that lasts a moment be outlived rather than
   * counted to the bound. The retry stays owed until a replay completes or
   * the worker is given up on, because frames that arrive meanwhile leave
   * their delivery to it.
   */
  const armRetry = () => {
    cancelRetry('was superseded');
    // The exponent is bounded so that the product stays a number however
    // long a failure of the host's keeps the retry owed.
    const delayMs = Math.min(
      crashRetryDelayMs * 2 ** Math.min(retriesArmed, 30),
      MAX_CRASH_RETRY_DELAY_MS,
    );
    retriesArmed += 1;
    /** @type {PromiseKit<void>} */
    const outcome = makePromiseKit();
    // Awaited only by a wake that happens to arrive while this is owed.
    outcome.promise.catch(() => {});
    const timer = timers.setTimer(() => {
      retry = undefined;
      enqueue(retryWake).then(
        () => outcome.resolve(),
        error => {
          // Giving the worker up for its crashes is reported where it is
          // decided; everything else is reported here.
          if (!(error.cause instanceof WorkerCrashError)) {
            logging.error(
              `thixotrope worker transport ${debugName}: retry after a crash failed`,
              error,
            );
          }
          // A crash armed the next retry as it was counted. A failure of
          // the host's did not, and nothing else will deliver the frames
          // that deferred to this one. A halt ends the matter.
          if (
            !(error instanceof WorkerHaltError) &&
            !destroyed &&
            !standingDown &&
            !givenUp &&
            retry === undefined &&
            incarnation === undefined
          ) {
            armRetry();
          }
          outcome.reject(error);
        },
      );
    }, delayMs);
    // Not unreferenced, as the idle timer is: a wake may be waiting on this
    // retry, and a host with nothing else to do must not exit under it.
    retry = harden({ timer, outcome });
  };

  /**
   * Count a crash that left journal frames undelivered. A crash at or
   * before the frame the last one reached is another attempt without
   * progress; one past it starts the count afresh. Below the bound the
   * worker is owed a retry. At the bound it is given up on.
   *
   * @param {WorkerCrashError} error
   * @param {{ index: number, phase: string }} during
   * @param {number} bound
   * @returns {WorkerHaltError | undefined} the failure to throw in the
   *   crash's place, once the bound is reached
   */
  const noteCrash = (error, { index, phase }, bound) => {
    const repeated = stalled !== undefined && index <= stalled.index;
    const attempts =
      stalled !== undefined && repeated ? stalled.attempts + 1 : 1;
    stalled = harden({
      index: stalled !== undefined && repeated ? stalled.index : index,
      attempts,
      reason: error.message,
    });
    if (attempts < bound) {
      if (!destroyed) armRetry();
      persistStall();
      return undefined;
    }
    const failure = `crashed ${attempts} times without progress, last while ${phase}: ${error.message}`;
    try {
      store.setMeta({ ...metaWithoutCrash(), failure });
    } catch (storeError) {
      // Only a failure on record may retire the session. If this one is
      // not, the worker is still owed its retry, and the next crash tries
      // to record the failure again. If the write landed before it threw,
      // the retry finds the failure on record and retires the session then.
      if (!destroyed) armRetry();
      throw storeError;
    }
    logging.error(
      `thixotrope worker transport ${debugName}: quarantined; ${failure}`,
    );
    givenUp = true;
    stalled = undefined;
    retriesArmed = 0;
    onFatal();
    return new WorkerHaltError(failure, { cause: error });
  };

  /**
   * The incarnation's engine process died (a start, delivery or snapshot
   * failed): drop it so the next operation restarts from the snapshot
   * plus the journal suffix instead of wedging on a dead process.
   *
   * That replay is the right answer to a one-off crash. A worker that
   * crashes on every attempt (its process is killed, or misses its request
   * deadline, each time it reaches one frame) would instead make every
   * later frame replay up to that frame and crash again, so crashes are
   * counted: see `noteCrash`. A failure that is neither a halt nor a crash
   * is the host's, and is not held against the worker. Nor is a crash with
   * nothing left in the journal to deliver: no frame is waiting on the
   * worker, so there is no retry to owe and nothing to give it up for. Nor
   * is a crash once the host is standing down.
   *
   * @param {unknown} error
   * @param {{ index: number, phase: string }} [during] the journal frame
   *   being delivered, or the next to deliver, and what the incarnation was
   *   doing; omitted where a crash is not counted (a snapshot)
   * @returns {never}
   */
  const abandonIncarnation = (error, during = undefined) => {
    void terminateIncarnation().catch(() => {});
    if (error instanceof WorkerHaltError) {
      // Preserve the last snapshot for inspection, but do not endlessly
      // replay an input known to exhaust its budget or hit an engine gap.
      stalled = undefined;
      retriesArmed = 0;
      store.setMeta({ ...metaWithoutCrash(), failure: error.message });
      givenUp = true;
      onFatal();
    } else if (
      error instanceof WorkerCrashError &&
      during !== undefined &&
      maxDeliveryAttempts !== undefined &&
      !standingDown &&
      heldStart > snapshotCut
    ) {
      const failure = noteCrash(error, during, maxDeliveryAttempts);
      if (failure !== undefined) throw failure;
    }
    throw error;
  };

  /** @param {any} envelope */
  const processOutboundEnvelope = envelope => {
    if (destroyed) {
      return;
    }
    envelope.t === 'f' ||
      Fail`worker ${q(debugName)}: unexpected duct envelope ${q(envelope.t)}`;
    // Every frame — live or replay-regenerated — is delivered with
    // its session-lifetime sequence number. Determinism gives a
    // regenerated frame the same number it had, and the hub's
    // watermark (atomic with the frame's effects) drops duplicates:
    // exactly once, with no per-frame metadata write here.
    seenOutbound += 1;
    onFrame(decodeBase64(envelope.b64), outboundBase + seenOutbound);
  };

  /**
   * Deliver one crank's journal entries: one frame as before; several (GC
   * frames, and the ordinary frame they waited for) in one engine delivery
   * where the engine can, else one after another.
   *
   * @param {WorkerIncarnation} running
   * @param {Array<JournalEntry>} entries
   */
  const deliverCrank = async (running, entries) => {
    cranks += 1;
    if (entries.length === 1) {
      await running.deliver(harden({ t: 'f', b64: entries[0].b64 }));
    } else if (running.deliverBatch !== undefined) {
      await running.deliverBatch(
        harden(entries.map(({ b64 }) => ({ t: 'f', b64 }))),
      );
    } else {
      for (const { b64 } of entries) {
        // eslint-disable-next-line no-await-in-loop
        await running.deliver(harden({ t: 'f', b64 }));
      }
    }
  };

  /**
   * @param {Array<JournalEntry>} entries
   * @returns {string | undefined} the last hub sequence among them
   */
  const lastHubSequence = entries => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const { hubSequence } = entries[i];
      if (hubSequence !== undefined) return hubSequence;
    }
    return undefined;
  };

  /** Chain-context only: start an incarnation if none is running. */
  const ensureAwake = async () => {
    !destroyed || Fail`worker ${q(debugName)} transport is closed`;
    if (incarnation !== undefined) {
      return incarnation;
    }
    seenOutbound = 0;
    const meta = store.getMeta();
    if (meta.failure !== undefined) {
      if (!givenUp) {
        // On record without this transport knowing: a write that landed
        // and then threw. The session it should have retired is retired
        // now, and nothing more is owed.
        givenUp = true;
        onFatal();
      }
      throw new WorkerHaltError(meta.failure);
    }
    // Every caller leaves the attempt to an owed retry.
    retry === undefined ||
      Fail`worker ${q(debugName)}: a wake was attempted while a retry is owed`;
    outboundBase = meta.outboundBase ?? 0;
    const snapshotRef = meta.snapshot?.ref ?? null;
    const cut = meta.snapshot?.cut ?? 0;
    snapshotCut = cut;
    // What the incarnation is doing, and the journal frame it has reached,
    // when a failure interrupts the wake: a crash before the first frame
    // counts against that frame.
    let during = { index: cut, phase: 'starting' };
    const start = async () =>
      engine.start({
        debugName,
        snapshot: snapshotRef,
        onOutbound: processOutboundEnvelope,
        onOutboundBatch:
          onFrames === undefined
            ? undefined
            : envelopes => {
                if (destroyed) return;
                const frames = envelopes.map(envelope => {
                  if (envelope.t !== 'f' || typeof envelope.b64 !== 'string') {
                    throw makeError(
                      X`worker ${q(debugName)}: invalid duct frame`,
                    );
                  }
                  seenOutbound += 1;
                  return {
                    bytes: decodeBase64(envelope.b64),
                    sequenceNumber: outboundBase + seenOutbound,
                  };
                });
                if (frames.length > 0) onFrames(frames);
              },
      });
    wakes += 1;
    const started = await start().catch(error => {
      // Only a crash has anything to count or clean up here: there is no
      // incarnation yet, and any other failure to start is passed on as it
      // always was.
      if (error instanceof WorkerCrashError) abandonIncarnation(error, during);
      throw error;
    });
    // Awake from the moment the process runs: replies to replayed
    // frames can reach userland before the replay loop returns, and an
    // observer reacting to one must see the worker awake.
    incarnation = started;
    try {
      if (snapshotRef === null) {
        // The peer boots from the init message on first incarnation (or
        // on every incarnation for replay engines without snapshots);
        // restored heaps already contain the booted peer.
        during = { index: cut, phase: 'initializing' };
        await started.deliver(harden({ t: 'init', workerId, debugLabel }));
      }
      const replay = journalCranks(store.readJournal(cut), cut);
      replay.heldStart === heldStart ||
        Fail`worker ${q(debugName)}: journal cranks disagree with the frames written (${q(replay.heldStart)} != ${q(heldStart)})`;
      deliveredUpTo = cut;
      deliveredHubSequence = String(meta.hubDelivery ?? '0');
      for (const crank of replay.cranks) {
        during = {
          index: deliveredUpTo,
          phase: `replaying journal frame ${deliveredUpTo}`,
        };
        // eslint-disable-next-line no-await-in-loop
        await deliverCrank(started, crank.entries);
        deliveredHubSequence =
          lastHubSequence(crank.entries) ?? deliveredHubSequence;
        deliveredUpTo = crank.start + crank.entries.length;
      }
    } catch (error) {
      abandonIncarnation(error, during);
    }
    // A wake that completes is progress past whatever crashed before it.
    retriesArmed = 0;
    if (stalled !== undefined) {
      stalled = undefined;
      persistStall();
    }
    return started;
  };

  /** The attempt an owed retry makes when its wait is over. */
  const retryWake = async () => {
    !destroyed || Fail`worker ${q(debugName)} transport is closed`;
    // An operation queued ahead of this one may have settled the matter:
    // woken the worker, or crashed and been owed the next retry.
    if (retry === undefined) await ensureAwake();
  };

  /**
   * Wake the worker, or fail as the attempt to does. A crashed worker's owed
   * retry is that attempt: a wake waits for it rather than making another,
   * so that a wake never adds to the count.
   */
  const wake = async () => {
    for (;;) {
      while (retry !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        await retry.outcome.promise;
      }
      // eslint-disable-next-line no-await-in-loop
      const attempted = await enqueue(async () => {
        if (retry !== undefined) return false;
        await ensureAwake();
        return true;
      });
      if (attempted) return;
    }
  };

  /**
   * Stop counting and stop retrying, because the host is going down. A
   * signal sent to a supervisor's process group to stop it kills its workers
   * too, so a crash from here on is not counted, and the crash whose retry
   * this cancels is forgiven: with the retry unmade, nothing says it would
   * repeat. A worker that does crash every time is counted again at the
   * next start. Never throws: a host that is going down must get there.
   */
  const standDown = () => {
    standingDown = true;
    if (retry === undefined) return;
    cancelRetry('was cancelled: the host is standing down');
    retriesArmed = 0;
    if (stalled !== undefined) {
      stalled =
        stalled.attempts > 1
          ? harden({ ...stalled, attempts: stalled.attempts - 1 })
          : undefined;
      persistStall();
    }
  };

  /**
   * A frame toward the worker, decoded for the journal: its entry, and
   * whether it is a GC frame (held for the next crank).
   *
   * @param {Uint8Array} bytes
   * @param {string} [hubSequence]
   */
  const journalEntryOf = (bytes, hubSequence) => {
    const gc = isGcFrame !== undefined && isGcFrame(bytes);
    /** @type {JournalEntry} */
    const entry = harden({
      b64: encodeBase64(bytes),
      ...(hubSequence === undefined ? {} : { hubSequence }),
      ...(gc ? { gc: true } : {}),
    });
    return entry;
  };

  /**
   * After a durable append of `entry` at journal `index`: it either joins
   * the held GC run or ends it, with itself as the run's last frame, and a
   * crank that ends is queued for delivery.
   *
   * @param {JournalEntry} entry
   * @param {number} index
   */
  const afterAppend = (entry, index) => {
    const gc = entry.gc === true;
    if (entry.hubSequence !== undefined)
      receivedHubSequence = BigInt(entry.hubSequence);
    // Where cranks begin follows from the journal alone (`journalCranks`):
    // this frame either joins the held GC run or ends it, with itself as
    // the run's last frame.
    held = [...held, entry];
    if (gc && held.length < GC_FRAMES_PER_CRANK) return;
    const crankStart = heldStart;
    const crankEntries = held;
    heldStart = index + 1;
    held = [];
    const crankEnd = index + 1;
    enqueue(async () => {
      if (destroyed) {
        return;
      }
      if (retry !== undefined) {
        // A crashed worker is owed a retry, and the retry replays this
        // frame from the journal: attempting here as well would make
        // every frame of a burst a counted attempt.
        return;
      }
      const running = await ensureAwake();
      if (crankEnd <= deliveredUpTo) {
        // The wake replay already delivered this crank from the
        // journal.
        return;
      }
      crankStart === deliveredUpTo ||
        Fail`worker ${q(debugName)}: journal delivery out of order`;
      try {
        await deliverCrank(running, crankEntries);
      } catch (error) {
        // The frames stay in the journal; the wake this failure
        // provokes replays them against a fresh incarnation.
        abandonIncarnation(error, {
          index: crankStart,
          phase: `delivering journal frame ${crankStart}`,
        });
      }
      deliveredUpTo = crankEnd;
      deliveredHubSequence =
        lastHubSequence(crankEntries) ?? deliveredHubSequence;
      // A due snapshot waits for the queue to go quiet (`armCadenceTimer`),
      // unless the worker has gone so long without that the journal has
      // reached its bound.
      if (
        snapshotEveryDeliveries !== undefined &&
        !checkpointQueued &&
        cadenceBacklog() >= CADENCE_FORCE_FACTOR * snapshotEveryDeliveries
      ) {
        queueCadenceSnapshot();
      }
    }).catch(error => {
      logging.error(
        `thixotrope worker transport ${debugName}: delivery failed`,
        error,
      );
    });
  };

  const connection = harden({
    /**
     * @param {Uint8Array} bytes one OCapN frame toward the worker
     * @param {string} [hubSequence] durable outbox sequence, decimal bigint
     */
    write: (bytes, hubSequence) => {
      if (destroyed || store.getMeta().failure !== undefined) {
        return false;
      }
      if (
        hubSequence !== undefined &&
        BigInt(hubSequence) <= receivedHubSequence
      )
        return true;
      const entry = journalEntryOf(bytes, hubSequence);
      const index = store.journalLength();
      index === heldStart + held.length ||
        Fail`worker ${q(debugName)}: journal grew behind the transport`;
      // Journal before the duct: a frame the OCapN layer believes it
      // sent must survive any crash from here on.
      store.appendJournal(entry);
      afterAppend(entry, index);
      return true;
    },
    /**
     * Several frames toward the worker in order, journaled with one durable
     * append (one fsync where the store has `appendJournalEntries`) before
     * any of them is delivered. The journal holds exactly what `write` would
     * have appended frame by frame, so cranks and replay are unchanged.
     *
     * @param {Array<{ bytes: Uint8Array, sequence?: string }>} frames
     * @returns {number} how many leading frames the worker now owns: all of
     *   them, or 0 when it refuses frames (destroyed or quarantined)
     */
    writeBatch: frames => {
      if (destroyed || store.getMeta().failure !== undefined) {
        return 0;
      }
      /** @type {Array<JournalEntry>} */
      const entries = [];
      let seen = receivedHubSequence;
      for (const { bytes, sequence } of frames) {
        // A duplicate of what the journal holds is already owned.
        const fresh = sequence === undefined || BigInt(sequence) > seen;
        if (fresh) {
          if (sequence !== undefined) seen = BigInt(sequence);
          entries.push(journalEntryOf(bytes, sequence));
        }
      }
      if (entries.length === 0) return frames.length;
      const index = store.journalLength();
      index === heldStart + held.length ||
        Fail`worker ${q(debugName)}: journal grew behind the transport`;
      if (store.appendJournalEntries === undefined) {
        entries.forEach((entry, offset) => {
          store.appendJournal(entry);
          afterAppend(entry, index + offset);
        });
      } else {
        // Journal before the duct, as `write`: every frame of the batch is
        // durable before any of them can reach the worker. A failed append
        // throws before any is delivered (a torn tail is repaired on read).
        store.appendJournalEntries(entries);
        entries.forEach((entry, offset) => afterAppend(entry, index + offset));
      }
      return frames.length;
    },
    end: () => {
      destroyed = true;
      standDown();
    },
  });

  /**
   * Chain-context only: snapshot the running incarnation, record the
   * snapshot ref and journal cut, reset the outbound watermark, and
   * truncate the subsumed journal prefix. The incarnation keeps running:
   * a sleep terminates it afterwards, a cadence snapshot does not.
   */
  const checkpointInternal = async () => {
    if (incarnation === undefined || !engine.canSnapshot) {
      return;
    }
    const cut = deliveredUpTo;
    /** @type {unknown} */
    let ref;
    try {
      ref = await incarnation.snapshot();
    } catch (error) {
      // The next frame replays the whole journal. Were the cadence left
      // where it is, that frame would also snapshot again, and a snapshot
      // that fails every time would cost a full replay per frame.
      snapshotFailedAt = cut;
      abandonIncarnation(error);
    }
    const previous = store.getMeta().snapshot?.ref;
    // Record the snapshot before truncating: a crash between the
    // two leaves subsumed entries in the journal, which the next
    // wake skips via the recorded cut. The outbound base advances
    // to the total frames ever emitted: the snapshot subsumes
    // them, so the next incarnation numbers from here.
    outboundBase += seenOutbound;
    seenOutbound = 0;
    store.setMeta({
      ...store.getMeta(),
      snapshot: { ref, cut },
      outboundBase,
      hubDelivery: deliveredHubSequence,
    });
    store.truncateJournal(cut);
    snapshotCut = cut;
    if (previous !== undefined && previous !== ref && engine.releaseSnapshot) {
      await engine.releaseSnapshot(previous);
    }
  };

  /**
   * Put the worker to sleep: after the deliveries already queued drain,
   * checkpoint and terminate the incarnation. The OCapN session stays
   * live; the next frame wakes the worker.
   */
  const sleepInternal = () =>
    enqueue(async () => {
      if (incarnation === undefined) {
        return;
      }
      await checkpointInternal();
      await terminateIncarnation();
    });

  return harden({
    workerId,
    debugLabel,
    /** One host→worker OCapN frame: journal, then deliver in order. */
    write: connection.write,
    /** Several host→worker frames journaled with one fsync, then delivered. */
    writeBatch: connection.writeBatch,
    /** Stop accepting frames; deliveries in flight drain. */
    end: () => connection.end(),
    isAwake: () => incarnation !== undefined,
    /**
     * Whether the journal holds frames past the snapshot that a crank is
     * owed (held GC frames are not owed one): what a restart must replay.
     */
    owesDelivery: () => heldStart > snapshotCut,
    /**
     * Counts for diagnostics: GC frames journaled and held for the next
     * crank, and incarnations started and cranks delivered by this
     * transport object (process-local).
     */
    stats: () => harden({ heldFrames: held.length, wakes, cranks }),
    wake,
    standDown,
    /** See {@link sleepInternal}, which the idle timer shares. */
    sleep: async () => {
      await sleepInternal();
    },
    /**
     * Simulate worker-process death: terminate the incarnation with no
     * snapshot. The next delivery wakes the worker by replaying the
     * journal suffix — the crash-recovery path.
     */
    crash: async () => {
      await enqueue(terminateIncarnation);
    },
    /**
     * Permanently destroy the worker: terminate, release its snapshot,
     * and abort the OCapN session so every import from it breaks.
     */
    retire: async () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      cancelRetry('was cancelled: the worker is retired');
      await enqueue(async () => {
        await terminateIncarnation();
        const ref = store.getMeta().snapshot?.ref;
        if (ref !== undefined && engine.releaseSnapshot) {
          await engine.releaseSnapshot(ref);
        }
      });
    },
  });
};
harden(makeDurableWorkerTransport);
