// @ts-check

/**
 * The workflow engine: durable runs over the interpreter core.
 *
 * The engine owns everything the pure core cannot: the definition and
 * fragment registries, run directories and journals, effect execution
 * through an injected delivery seam, per-run alias tables (capability
 * references never enter the journal), factories with non-escalating
 * derivation and cascading revocation, timers, restart recovery, and
 * the observer/controller/admin run kit.
 *
 * All host authority arrives through the `powers` argument — a store
 * directory, a delivery seam, a clock, an id source, an optional timer
 * maker — so the engine itself stays daemon-agnostic: the daemon plugin
 * (`plugin.js`) and the tests supply different powers over the same
 * engine.
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { makeChangeTopic } from '@endo/pubsub/change-topic.js';
import { makeLatestTopic } from '@endo/pubsub/latest-topic.js';

import { renderDiagnostics, validateDefinition } from './definition.js';
import { inlineFragments } from './fragment.js';
import { makeInterpreter } from './interpret.js';
import { applyEvent, foldRecords } from './fold.js';
import { provideRunJournal, canonicalJson, hashRecord } from './journal.js';
import {
  WorkflowRunObserverInterface,
  WorkflowRunControllerInterface,
  WorkflowRunAdminInterface,
  WorkflowFactoryInterface,
  WorkflowFactoryAdminInterface,
  WorkflowServiceInterface,
} from './interfaces.js';

/** @import { JournalEventInput, JournalRecord, RunState, WorkflowDefinition, WorkflowFinal } from './types.js' */

const DEFINITIONS_DIRECTORY = 'definitions';
const FRAGMENTS_DIRECTORY = 'fragments';
const RUNS_DIRECTORY = 'runs';
const NAMES_FILE = 'names.json';

/**
 * Values that may be journaled directly are plain JSON data, checked
 * deeply; anything else — a remotable anywhere in the graph, a promise,
 * a function, an exotic prototype — is aliased into the run's
 * engine-private reference table and journaled as `ref:n`. The deep walk
 * matters: a plain record *containing* a capability must alias, or the
 * capability would be silently flattened into the journal.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
const isJournalableData = value => {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJournalableData);
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return false;
    }
    // Symbol-keyed properties can carry capabilities, and both this
    // check (`Object.values`) and `canonicalJson` (`Object.entries`)
    // ignore them — so a value bearing any symbol key cannot be
    // faithfully journaled and must be aliased, or a capability would
    // ride a symbol key into the run untraced.
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return false;
    }
    return Object.values(value).every(isJournalableData);
  }
  return false;
};

/**
 * @param {object} powers
 * @param {import('@endo/eventual-send').ERef<any>} powers.storeRoot
 *   writable virtual-file-system directory backing the engine store
 * @param {object} powers.deliver the effect delivery seam
 * @param {(target: unknown, payload: { description?: string, attachments?: Record<string, unknown>, idempotencyKey: string }) => Promise<unknown>} powers.deliver.request
 * @param {(target: unknown, payload: { description?: string, fields?: unknown[], idempotencyKey: string }) => Promise<Record<string, unknown>>} powers.deliver.form
 * @param {(target: unknown, method: string, args: unknown[], options: { idempotencyKey: string, idempotent?: boolean }) => Promise<unknown>} powers.deliver.call
 * @param {(target: unknown, method: string) => Promise<unknown>} [powers.deliver.attenuate]
 * @param {() => number} powers.now
 * @param {() => string} powers.makeId unique-id source (hex)
 * @param {(ms: number, fire: () => void) => () => void} [powers.makeTimer]
 *   returns a cancel function; when absent, `after` timeouts never fire
 * @param {(runId: string, meta: Record<string, unknown>) => Promise<Record<string, unknown>>} [powers.rebindParticipants]
 *   recovery hook: re-supply a recovered run's participant capabilities
 *   (the daemon plugin resolves them from its guest namespace)
 * @param {(message: string) => void} [powers.warn]
 */
export const makeWorkflowEngine = async powers => {
  const {
    storeRoot,
    deliver,
    now,
    makeId,
    makeTimer,
    warn = message => console.warn(`[workflow] ${message}`),
  } = powers;

  await null;
  const definitionsDirectory = await E(storeRoot).makeDirectory(
    DEFINITIONS_DIRECTORY,
    {},
  );
  const fragmentsDirectory = await E(storeRoot).makeDirectory(
    FRAGMENTS_DIRECTORY,
    {},
  );
  const runsDirectory = await E(storeRoot).makeDirectory(RUNS_DIRECTORY, {});

  /**
   * @param {import('@endo/eventual-send').ERef<any>} directory
   * @param {string} name
   * @param {unknown} value
   */
  const atomicWrite = async (directory, name, value) => {
    const temporaryName = `.tmp.${name}`;
    await E(directory).write(temporaryName, `${canonicalJson(value)}\n`);
    await E(directory).move(temporaryName, name);
  };

  /**
   * @param {import('@endo/eventual-send').ERef<any>} directory
   * @param {string} name
   */
  const readJson = async (directory, name) => {
    await null;
    let file;
    try {
      file = await E(directory).lookup(name);
    } catch (_error) {
      return undefined;
    }
    const blob = await E(file).snapshot();
    return E(blob).json();
  };

  // #region Definition and fragment registries

  /** @type {Map<string, WorkflowDefinition>} definition hash -> inlined definition */
  const definitionsByHash = new Map();
  /** @type {Map<string, string[]>} name -> ordered hashes (latest last) */
  const definitionNames = new Map();
  /** @type {Map<string, unknown>} fragment name -> fragment */
  const fragments = new Map();

  const persistNames = async () => {
    await atomicWrite(
      definitionsDirectory,
      NAMES_FILE,
      Object.fromEntries(definitionNames),
    );
  };

  /**
   * @param {string} name
   * @param {unknown} allegedDefinition
   * @returns {Promise<string>} the content hash
   */
  const define = async (name, allegedDefinition) => {
    await null;
    const kind = /** @type {{ kind?: string }} */ (allegedDefinition)?.kind;
    if (kind === 'fragment') {
      fragments.set(name, harden(allegedDefinition));
      await atomicWrite(fragmentsDirectory, `${name}.json`, allegedDefinition);
      return hashRecord(allegedDefinition);
    }
    const inlined = inlineFragments(
      /** @type {WorkflowDefinition} */ (allegedDefinition),
      Object.fromEntries(fragments),
    );
    const { ok, diagnostics } = validateDefinition(inlined);
    if (!ok) {
      throw makeError(
        X`Invalid workflow definition ${q(name)}:\n${q(
          renderDiagnostics(diagnostics),
        )}`,
      );
    }
    const hash = hashRecord(inlined);
    definitionsByHash.set(hash, harden(inlined));
    const versions = definitionNames.get(name) ?? [];
    if (!versions.includes(hash)) {
      definitionNames.set(name, [...versions, hash]);
    }
    await atomicWrite(definitionsDirectory, `${hash}.json`, inlined);
    await persistNames();
    return hash;
  };

  /** @param {string} nameOrHash */
  const resolveDefinition = nameOrHash => {
    const byHash = definitionsByHash.get(nameOrHash);
    if (byHash !== undefined) {
      return { hash: nameOrHash, definition: byHash };
    }
    const versions = definitionNames.get(nameOrHash);
    if (versions === undefined || versions.length === 0) {
      throw makeError(X`Unknown workflow definition ${q(nameOrHash)}`);
    }
    const hash = versions[versions.length - 1];
    const definition = definitionsByHash.get(hash);
    if (definition === undefined) {
      throw makeError(X`Missing definition body for ${q(nameOrHash)}`);
    }
    return { hash, definition };
  };

  // #endregion

  // #region Runs

  /**
   * @typedef {object} LiveRun
   * @property {string} runId
   * @property {string} definitionHash
   * @property {ReturnType<typeof makeInterpreter>} interpreter
   * @property {Awaited<ReturnType<typeof provideRunJournal>>} journal
   * @property {RunState} runState
   * @property {Record<string, unknown>} participants slot -> cap or array
   * @property {Map<string, unknown>} refs alias -> value (engine-private)
   * @property {{ parentRunId: string, as: string } | undefined} parent
   * @property {Set<string>} children live child run ids
   * @property {Map<string, { total: number, results: unknown[], arrived: number, joined: boolean, join: unknown }>} fanouts
   * @property {(() => void) | undefined} cancelTimer
   * @property {Promise<unknown>} tail per-run serial queue
   * @property {JournalEventInput[]} deferred events held while paused
   * @property {ReturnType<typeof makeChangeTopic<JournalRecord>>} eventsTopic
   * @property {ReturnType<typeof makeLatestTopic<unknown>>} statusTopic
   * @property {{ observer: unknown, controller: unknown, admin: unknown }} facets
   */

  /** @type {Map<string, LiveRun>} */
  const runs = new Map();

  const runsTopic = makeChangeTopic();

  /** @param {LiveRun} run */
  const summarize = run =>
    harden({
      runId: run.runId,
      definition: run.runState.definition,
      state: run.runState.state,
      ...(run.runState.final === undefined
        ? {}
        : { final: run.runState.final }),
      throughSeq: run.runState.throughSeq,
      updatedAt: now(),
      ...(run.parent === undefined ? {} : { parent: run.parent.parentRunId }),
    });

  /** @param {LiveRun} run */
  const publishSummary = run => {
    runsTopic.publisher.next(summarize(run));
  };

  /** @param {LiveRun} run */
  const statusOf = run =>
    harden({
      runId: run.runId,
      definition: run.runState.definition,
      state: run.runState.state,
      context: run.runState.context,
      pending: run.runState.pending,
      paused: run.runState.paused,
      ...(run.runState.final === undefined
        ? {}
        : { final: run.runState.final }),
      throughSeq: run.runState.throughSeq,
      updatedAt: now(),
    });

  /**
   * Alias a value into the run's engine-private reference table unless
   * it is journalable data.
   *
   * @param {LiveRun} run
   * @param {unknown} value
   * @returns {{ ref: string } | { value: unknown }}
   */
  const aliasValue = (run, value) => {
    if (isJournalableData(value)) {
      return { value };
    }
    const alias = `ref:${run.refs.size + 1}`;
    run.refs.set(alias, value);
    return { ref: alias };
  };

  /**
   * Journalable form/signal payload that preserves the reducer contract
   * (`event.values.field`) in the common case: a data record passes
   * through unchanged, but a payload carrying a capability is replaced
   * by its opaque alias string (the reducer then reads `undefined` for
   * its fields and a guard fails closed — a form reply must never smuggle
   * a live capability into the journal or an observer's `status()`).
   *
   * @param {LiveRun} run
   * @param {unknown} value
   * @returns {unknown}
   */
  const journalablePayload = (run, value) => {
    const aliased = aliasValue(run, value);
    return 'value' in aliased ? aliased.value : aliased.ref;
  };

  /**
   * Resolve a participant reference (`slot` or `slot:attenuator`)
   * against a run's bound participants.
   *
   * @param {LiveRun} run
   * @param {string} reference
   * @returns {Promise<unknown>}
   */
  const resolveParticipant = async (run, reference) => {
    const [slot, attenuator] = reference.split(':');
    const bound = run.participants[slot];
    if (bound === undefined) {
      throw makeError(X`Run ${q(run.runId)} has no participant ${q(slot)}`);
    }
    if (attenuator === undefined) {
      return bound;
    }
    if (deliver.attenuate === undefined) {
      throw makeError(X`No attenuate power for ${q(reference)}`);
    }
    return deliver.attenuate(bound, attenuator);
  };

  /**
   * @param {LiveRun} run
   * @param {() => Promise<unknown>} job
   */
  const enqueue = (run, job) => {
    const next = run.tail.then(job, job);
    run.tail = next.catch(error => {
      warn(`run ${run.runId}: ${/** @type {Error} */ (error).message}`);
    });
    return next;
  };

  // Forward references for mutually recursive helpers.
  /** @type {(run: LiveRun, record: JournalRecord, isRecovery?: boolean) => void} */
  let executeEffect;
  /** @type {(run: LiveRun, final: WorkflowFinal) => void} */
  let onFinished;
  /** @type {(run: LiveRun) => void} */
  let armTimer;

  /**
   * Append events, fold them, publish them, and execute what they
   * demand. The single write path for every run mutation.
   *
   * @param {LiveRun} run
   * @param {JournalEventInput[]} events
   */
  const commit = async (run, events) => {
    const appended = await run.journal.append(events);
    for (const record of appended) {
      run.runState = applyEvent(run.runState, record);
      run.eventsTopic.publisher.next(record);
    }
    run.statusTopic.publisher.next(statusOf(run));
    for (const record of appended) {
      if (record.type === 'effect.issued') {
        executeEffect(run, record);
      } else if (record.type === 'transition.fired') {
        armTimer(run);
      } else if (record.type === 'run.finished') {
        onFinished(run, /** @type {WorkflowFinal} */ (record.final));
      }
    }
    publishSummary(run);
  };

  /**
   * Route one external event through the interpreter (or defer it while
   * paused), on the run's serial queue.
   *
   * @param {LiveRun} run
   * @param {JournalEventInput} event
   */
  const dispatch = (run, event) =>
    enqueue(run, async () => {
      if (run.runState.paused) {
        run.deferred.push(event);
        return;
      }
      await commit(run, run.interpreter.handle(run.runState, event));
    });

  /**
   * Arm (or clear) the current state's `after` timer.
   *
   * @param {LiveRun} run
   */
  armTimer = run => {
    if (run.cancelTimer !== undefined) {
      run.cancelTimer();
      run.cancelTimer = undefined;
    }
    if (run.runState.final !== undefined || makeTimer === undefined) {
      return;
    }
    const state = run.interpreter.definition.states[run.runState.state];
    if (state?.after === undefined) {
      return;
    }
    // Recovery re-arms from the journaled entry time, so a restart does
    // not extend a deadline.
    const records = run.journal.records();
    let enteredAt = records[0]?.at ?? now();
    for (const record of records) {
      if (record.type === 'transition.fired' || record.type === 'run.started') {
        enteredAt = record.at;
      }
    }
    const remaining = Math.max(0, state.after.ms - (now() - enteredAt));
    run.cancelTimer = makeTimer(remaining, () => {
      run.cancelTimer = undefined;
      dispatch(run, harden({ type: 'timeout' }));
    });
  };

  /**
   * @param {LiveRun} run
   * @param {string} as
   * @param {number} member
   * @param {unknown} result
   */
  const onFanoutResult = (run, as, member, result) =>
    enqueue(run, async () => {
      const fanout = run.fanouts.get(as);
      if (fanout === undefined || run.runState.final !== undefined) {
        return;
      }
      if (fanout.results[member] !== undefined) {
        return; // duplicate member settlement: first wins
      }
      fanout.results[member] = result;
      fanout.arrived += 1;
      const journaled = aliasValue(run, result);
      await commit(run, [
        harden({ type: 'fanout.result', as, member, ...journaled }),
      ]);
      if (fanout.joined) {
        return; // late arrival after the join: journaled inert
      }
      const { join, total, arrived } = fanout;
      const satisfied =
        join === 'any'
          ? arrived >= 1
          : typeof join === 'object' && join !== null
            ? arrived >= /** @type {{ quorum: number }} */ (join).quorum
            : arrived >= total; // 'all' and default
      if (satisfied) {
        fanout.joined = true;
        const results = fanout.results.filter(value => value !== undefined);
        const joined = harden({
          type: 'fanout.joined',
          as,
          results: harden(results),
        });
        // Respect pause: partial results journal (audit-only), but the
        // join transition defers like any other external event.
        if (run.runState.paused) {
          run.deferred.push(joined);
        } else {
          await commit(run, run.interpreter.handle(run.runState, joined));
        }
      }
    });

  /**
   * @param {LiveRun} run
   * @param {JournalRecord} record an `effect.issued` record
   * @param {boolean} [isRecovery]
   */
  executeEffect = (run, record, isRecovery = false) => {
    const as = /** @type {string} */ (record.as);
    const kind = /** @type {string} */ (record.effect);
    const idempotencyKey = /** @type {string} */ (record.idempotencyKey);

    /** @param {unknown} value */
    const settled = value =>
      dispatch(
        run,
        harden({ type: 'effect.settled', as, ...aliasValue(run, value) }),
      );
    /** @param {unknown} error */
    const rejected = error =>
      dispatch(
        run,
        harden({
          type: 'effect.rejected',
          as,
          reason: String(
            (error && /** @type {Error} */ (error).message) || error,
          ),
        }),
      );

    const resolveAttachments = async () => {
      await null;
      /** @type {Record<string, unknown>} */
      const attachments = {};
      for (const reference of /** @type {string[]} */ (record.attach ?? [])) {
        // eslint-disable-next-line no-await-in-loop
        attachments[reference] = await resolveParticipant(run, reference);
      }
      return attachments;
    };

    if (kind === 'request') {
      (async () => {
        const target = await resolveParticipant(
          run,
          /** @type {string} */ (record.to),
        );
        const attachments = await resolveAttachments();
        return deliver.request(target, {
          description: /** @type {string | undefined} */ (record.description),
          attachments,
          idempotencyKey,
        });
      })().then(settled, rejected);
    } else if (kind === 'form') {
      (async () => {
        const target = await resolveParticipant(
          run,
          /** @type {string} */ (record.to),
        );
        return deliver.form(target, {
          description: /** @type {string | undefined} */ (record.description),
          fields: /** @type {unknown[] | undefined} */ (record.fields),
          idempotencyKey,
        });
      })().then(
        values =>
          dispatch(
            run,
            harden({
              type: 'form.value',
              as,
              values: journalablePayload(run, values),
            }),
          ),
        rejected,
      );
    } else if (kind === 'call') {
      const retry = /** @type {{ max?: number } | undefined} */ (record.retry);
      const idempotent = record.idempotent === true;
      if (isRecovery && !idempotent) {
        // The call may or may not have happened before the restart;
        // re-firing a non-idempotent call is worse than failing loudly.
        dispatch(
          run,
          harden({
            type: 'effect.rejected',
            as,
            reason: 'indeterminate: interrupted by restart before settlement',
          }),
        );
        return;
      }
      let attemptsLeft = 1 + (retry?.max ?? 0);
      /** @returns {Promise<void>} */
      const attempt = async () => {
        attemptsLeft -= 1;
        await null;
        try {
          const target = await resolveParticipant(
            run,
            /** @type {string} */ (record.to),
          );
          const value = await deliver.call(
            target,
            /** @type {string} */ (record.method),
            /** @type {unknown[]} */ (record.args ?? []),
            { idempotencyKey, idempotent },
          );
          await settled(value);
        } catch (error) {
          if (attemptsLeft > 0) {
            await attempt();
          } else {
            await rejected(error);
          }
        }
      };
      attempt();
    } else if (kind === 'fanout') {
      (async () => {
        const members = /** @type {unknown[]} */ (
          await resolveParticipant(run, /** @type {string} */ (record.to))
        );
        if (!Array.isArray(members)) {
          throw makeError(X`fanout target ${q(record.to)} is not an array`);
        }
        const existing = run.fanouts.get(as);
        const fanout = existing ?? {
          total: members.length,
          results: /** @type {unknown[]} */ (new Array(members.length)),
          arrived: 0,
          joined: false,
          join: record.join ?? 'all',
        };
        // A recovery-restored fanout learns its real member count here.
        fanout.total = members.length;
        run.fanouts.set(as, fanout);
        const attachments = await resolveAttachments();
        members.forEach((member, i) => {
          if (fanout.results[i] !== undefined) {
            return; // already settled before a restart
          }
          deliver
            .request(member, {
              description: /** @type {string | undefined} */ (
                record.description
              ),
              attachments,
              idempotencyKey: `${idempotencyKey}:${i}`,
            })
            .then(
              result => onFanoutResult(run, as, i, result),
              error =>
                onFanoutResult(run, as, i, {
                  error: String(
                    (error && /** @type {Error} */ (error).message) || error,
                  ),
                }),
            );
        });
      })().catch(rejected);
    } else if (kind === 'spawn') {
      (async () => {
        await null;
        const { definition } = resolveDefinition(
          /** @type {string} */ (record.workflow),
        );
        /** @type {Record<string, unknown>} */
        const childParticipants = {};
        for (const [childSlot, parentReference] of Object.entries(
          /** @type {Record<string, string>} */ (record.participants ?? {}),
        )) {
          // eslint-disable-next-line no-await-in-loop
          childParticipants[childSlot] = await resolveParticipant(
            run,
            parentReference,
          );
        }
        await startRun(definition, {
          input: /** @type {Record<string, unknown>} */ (
            record.childInput ?? {}
          ),
          participants: childParticipants,
          parent: { parentRunId: run.runId, as },
        });
      })().catch(rejected);
    } else {
      warn(`run ${run.runId}: unknown effect kind ${kind}`);
    }
  };

  /**
   * Deliver a finished child's outcome to its parent as a
   * `child.finished` event. Used both live (`onFinished`) and during
   * recovery (for a child that finished before a crash without its
   * completion reaching the parent's journal).
   *
   * @param {LiveRun} parentRun
   * @param {LiveRun} child
   */
  const deliverChildFinished = (parentRun, child) => {
    if (child.parent === undefined) {
      return;
    }
    const final = /** @type {WorkflowFinal} */ (child.runState.final);
    const output =
      final === 'succeeded'
        ? child.interpreter.outputOf(
            child.runState.state,
            child.runState.context,
          )
        : undefined;
    const journaled = output === undefined ? {} : aliasValue(parentRun, output);
    dispatch(
      parentRun,
      harden({
        type: 'child.finished',
        as: child.parent.as,
        final,
        ...('ref' in journaled
          ? { ref: journaled.ref }
          : 'value' in journaled
            ? { output: journaled.value }
            : {}),
      }),
    );
  };

  onFinished = (run, _final) => {
    if (run.cancelTimer !== undefined) {
      run.cancelTimer();
      run.cancelTimer = undefined;
    }
    // Snapshot so recovery folds a short tail.
    run.journal
      .writeSnapshot({
        throughSeq: run.runState.throughSeq,
        state: run.runState,
      })
      .catch(error =>
        warn(`snapshot: ${/** @type {Error} */ (error).message}`),
      );
    // Notify the parent: a child's end is an ordinary parent event.
    if (run.parent !== undefined) {
      const parentRun = runs.get(run.parent.parentRunId);
      if (parentRun !== undefined) {
        parentRun.children.delete(run.runId);
        deliverChildFinished(parentRun, run);
      }
    }
    // A finished run emits nothing more; terminate its event topic so
    // current and future history subscribers complete cleanly (done)
    // instead of parking forever on a run that will never publish again.
    Promise.resolve(run.eventsTopic.publisher.return(undefined)).catch(
      () => {},
    );
  };

  /**
   * Abort a run and cascade to its descendants.
   *
   * @param {LiveRun} run
   * @param {string} reason
   * @param {string} actor
   * @returns {Promise<void>}
   */
  const abortRun = async (run, reason, actor) => {
    await enqueue(run, async () => {
      if (run.runState.final !== undefined) {
        return;
      }
      await commit(run, [
        harden({ type: 'admin.forced', action: 'abort', reason, actor }),
        harden({ type: 'run.finished', final: 'aborted' }),
      ]);
    });
    for (const childRunId of [...run.children]) {
      const child = runs.get(childRunId);
      if (child !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        await abortRun(child, `parent run aborted: ${reason}`, actor);
      }
    }
  };

  /**
   * @param {LiveRun} run
   * @param {number} [fromSeq]
   */
  const makeHistoryReader = (run, fromSeq = 1) => {
    // Subscribe first, then replay, then drain the overlap: the reader
    // observes each record exactly once, in order.
    const subscription = run.eventsTopic.subscribe();
    const replay = run.journal.readFrom(fromSeq);
    let lastSeq =
      replay.length > 0 ? replay[replay.length - 1].seq : fromSeq - 1;
    let replayIndex = 0;
    const reader = harden({
      /** @returns {Promise<IteratorResult<JournalRecord>>} */
      async next() {
        await null;
        if (replayIndex < replay.length) {
          const value = replay[replayIndex];
          replayIndex += 1;
          return harden({ value, done: false });
        }
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const result = await subscription.next(undefined);
          if (result.done) {
            return harden({ value: undefined, done: true });
          }
          const record = /** @type {JournalRecord} */ (result.value);
          if (record.seq > lastSeq) {
            lastSeq = record.seq;
            return harden({ value: record, done: false });
          }
        }
      },
      /** @param {unknown} value */
      async return(value) {
        // Best-effort cleanup: a change-topic subscriber's return()
        // awaits the next published value, which never arrives on an
        // idle run — so fire it without blocking the caller's teardown,
        // or `done`/`stop()` would hang.
        Promise.resolve(subscription.return?.(undefined)).catch(() => {});
        return harden({ value, done: true });
      },
      [Symbol.asyncIterator]: () => reader,
    });
    return reader;
  };

  /** @param {LiveRun} run */
  const makeRunFacets = run => {
    const observerMethods = {
      help: () =>
        'Workflow run observer: status(), stateAt(seq), history(fromSeq), followStatus(), explain(), exportJournal(fromSeq). Read-only; capability references appear as opaque ref:n aliases.',
      status: () => statusOf(run),
      /** @param {number} seq */
      stateAt: seq => foldRecords(run.journal.records(), seq),
      /** @param {number} [fromSeq] */
      history: (fromSeq = 1) => makeHistoryReader(run, fromSeq),
      followStatus: () => run.statusTopic.subscribe(),
      explain: () => {
        const at = now();
        const waitingFor = new Set();
        const state = run.interpreter.definition.states[run.runState.state];
        for (const type of Object.keys(state?.on ?? {})) {
          waitingFor.add(type);
        }
        if (state?.after !== undefined) {
          waitingFor.add('timeout');
        }
        const records = run.journal.records();
        const issuedAt = new Map(
          records
            .filter(record => record.type === 'effect.issued')
            .map(record => [record.as, record.at]),
        );
        return harden({
          runId: run.runId,
          state: run.runState.state,
          paused: run.runState.paused,
          pending: Object.values(run.runState.pending).map(pending =>
            harden({
              as: pending.as,
              effect: pending.effect,
              ...(pending.to === undefined ? {} : { to: pending.to }),
              ageMs:
                at - /** @type {number} */ (issuedAt.get(pending.as) ?? at),
            }),
          ),
          waitingFor: harden([...waitingFor]),
          unauthorized: records
            .filter(record => record.type === 'event.unauthorized')
            .slice(-5),
        });
      },
      /** @param {number} [fromSeq] */
      exportJournal: (fromSeq = 1) => run.journal.readFrom(fromSeq),
    };

    const controllerMethods = {
      ...observerMethods,
      help: () =>
        'Workflow run controller: observer plus signal(name, payload) for events the definition declares.',
      /**
       * @param {string} name
       * @param {Record<string, unknown>} [payload]
       */
      signal: (name, payload = {}) => {
        // Alias any capability in the payload: a controller must not use
        // signals to plant a live cap for a lower-privilege observer to
        // read back out of the journal or `status()`.
        dispatch(
          run,
          harden({
            type: `signal.${name}`,
            payload: journalablePayload(run, payload),
          }),
        );
        return undefined;
      },
    };

    const adminMethods = {
      ...controllerMethods,
      help: () =>
        'Workflow run admin: controller plus pause(), resume(), abort(reason), retryEffect(as), forceTransition(target), injectEvent(event), resolveRef(alias). Every override is journaled with its actor.',
      pause: () => {
        enqueue(run, async () => {
          if (run.runState.paused || run.runState.final !== undefined) {
            return;
          }
          await commit(run, [
            harden({ type: 'admin.forced', action: 'pause', actor: 'admin' }),
          ]);
        });
        return undefined;
      },
      resume: () =>
        enqueue(run, async () => {
          if (!run.runState.paused) {
            return;
          }
          await commit(run, [
            harden({ type: 'admin.forced', action: 'resume', actor: 'admin' }),
          ]);
          const deferred = run.deferred.splice(0);
          for (const event of deferred) {
            // eslint-disable-next-line no-await-in-loop
            await commit(run, run.interpreter.handle(run.runState, event));
          }
        }),
      /** @param {string} reason */
      abort: reason => abortRun(run, reason, 'admin'),
      /** @param {string} as */
      retryEffect: as =>
        enqueue(run, async () => {
          const records = run.journal.records();
          const issued = records.find(
            record => record.type === 'effect.issued' && record.as === as,
          );
          if (issued === undefined || run.runState.pending[as] === undefined) {
            throw makeError(X`No pending effect ${q(as)} to retry`);
          }
          await commit(run, [
            harden({
              type: 'admin.forced',
              action: 'retryEffect',
              as,
              actor: 'admin',
            }),
          ]);
          executeEffect(run, issued);
        }),
      /** @param {string} target */
      forceTransition: target =>
        enqueue(run, async () => {
          if (
            run.interpreter.definition.states[target] === undefined ||
            run.runState.final !== undefined
          ) {
            throw makeError(X`Cannot force transition to ${q(target)}`);
          }
          await commit(run, [
            harden({
              type: 'admin.forced',
              action: 'forceTransition',
              to: target,
              actor: 'admin',
            }),
            ...run.interpreter.enter(target, run.runState.context),
          ]);
          armTimer(run);
        }),
      /** @param {Record<string, unknown>} event */
      injectEvent: event =>
        enqueue(run, async () => {
          await commit(run, [
            harden({
              type: 'admin.forced',
              action: 'injectEvent',
              event: /** @type {string} */ (event.type),
              actor: 'admin',
            }),
          ]);
          await commit(
            run,
            run.interpreter.handle(
              run.runState,
              /** @type {JournalEventInput} */ (harden(event)),
            ),
          );
        }),
      /** @param {string} alias */
      resolveRef: alias =>
        enqueue(run, async () => {
          if (!run.refs.has(alias)) {
            throw makeError(X`Unknown ref ${q(alias)}`);
          }
          await commit(run, [
            harden({
              type: 'admin.forced',
              action: 'resolveRef',
              alias,
              actor: 'admin',
            }),
          ]);
          return run.refs.get(alias);
        }),
    };

    return harden({
      observer: makeExo(
        'WorkflowRunObserver',
        WorkflowRunObserverInterface,
        observerMethods,
      ),
      controller: makeExo(
        'WorkflowRunController',
        WorkflowRunControllerInterface,
        controllerMethods,
      ),
      admin: makeExo(
        'WorkflowRunAdmin',
        WorkflowRunAdminInterface,
        adminMethods,
      ),
    });
  };

  /**
   * @param {WorkflowDefinition} definition an already-validated (inlined)
   *   definition
   * @param {object} options
   * @param {Record<string, unknown>} [options.input]
   * @param {Record<string, unknown>} [options.participants]
   * @param {{ parentRunId: string, as: string } | undefined} [options.parent]
   * @param {string} [options.factoryId]
   * @returns {Promise<LiveRun>}
   */
  const startRun = async (definition, options) => {
    const { input = {}, participants = {}, parent, factoryId } = options;
    const interpreter = makeInterpreter(definition);
    const runId = `run-${makeId()}`;
    const runDirectory = await E(runsDirectory).makeDirectory(runId, {});
    const journal = await provideRunJournal(runDirectory, {
      runId,
      now,
      warn,
    });
    await atomicWrite(runDirectory, 'meta.json', {
      runId,
      definitionHash: hashRecord(definition),
      definitionName: definition.name,
      createdAt: now(),
      ...(parent === undefined ? {} : { parent }),
      ...(factoryId === undefined ? {} : { factoryId }),
      participants: Object.keys(definition.participants),
    });

    /** @type {LiveRun} */
    const run = {
      runId,
      definitionHash: hashRecord(definition),
      interpreter,
      journal,
      runState: /** @type {RunState} */ (/** @type {unknown} */ (undefined)),
      participants: harden({ ...participants }),
      refs: new Map(),
      parent,
      children: new Set(),
      fanouts: new Map(),
      cancelTimer: undefined,
      tail: Promise.resolve(),
      deferred: [],
      eventsTopic: makeChangeTopic(),
      statusTopic: makeLatestTopic(),
      facets: /** @type {any} */ (undefined),
    };
    runs.set(runId, run);
    if (parent !== undefined) {
      runs.get(parent.parentRunId)?.children.add(runId);
    }
    run.facets = makeRunFacets(run);

    await enqueue(run, async () => {
      const begin = interpreter.begin({ runId, input, participants });
      const events =
        factoryId === undefined
          ? begin
          : [harden({ ...begin[0], factory: factoryId }), ...begin.slice(1)];
      await commit(run, events);
      armTimer(run);
    });
    return run;
  };

  // #endregion

  // #region Factories

  /** @type {Map<string, { revoked: boolean, derived: Set<string> }>} */
  const factoryRegistry = new Map();

  /**
   * @param {object} config
   * @param {string} config.definition name or hash
   * @param {Record<string, unknown>} [config.participants]
   * @param {Record<string, unknown>} [config.input]
   * @param {{ maxConcurrent?: number }} [config.limits]
   * @param {string} [config.parentFactoryId]
   */
  const makeFactory = config => {
    const {
      definition: definitionName,
      participants: bound = {},
      input: inputDefaults = {},
      limits = {},
      parentFactoryId,
    } = config;
    const { hash, definition } = resolveDefinition(definitionName);
    const factoryId = `factory-${makeId()}`;
    const registryEntry = { revoked: false, derived: new Set() };
    factoryRegistry.set(factoryId, registryEntry);
    if (parentFactoryId !== undefined) {
      factoryRegistry.get(parentFactoryId)?.derived.add(factoryId);
    }
    /** @type {Set<string>} */
    const startedRuns = new Set();

    const assertUsable = () => {
      if (registryEntry.revoked) {
        throw makeError(X`Factory ${q(factoryId)} has been revoked`);
      }
    };

    const factory = makeExo('WorkflowFactory', WorkflowFactoryInterface, {
      help: () =>
        `Workflow factory for ${definition.name} v${definition.version}: start(input, participants) fills unbound slots only; with({ participants, input }) derives a narrower factory; describe() lists bound slot names.`,
      describe: () =>
        harden({
          definition: { name: definition.name, version: definition.version },
          hash,
          boundSlotNames: harden(Object.keys(bound)),
          openSlots: harden(
            Object.keys(definition.participants).filter(
              slot => !Object.hasOwn(bound, slot),
            ),
          ),
          inputDefaults: harden({ ...inputDefaults }),
          limits: harden({ ...limits }),
        }),
      /**
       * @param {Record<string, unknown>} [input]
       * @param {Record<string, unknown>} [participants]
       */
      start: async (input = {}, participants = {}) => {
        assertUsable();
        for (const slot of Object.keys(participants)) {
          if (Object.hasOwn(bound, slot)) {
            throw makeError(
              X`Factory slot ${q(slot)} is bound and cannot be overridden`,
            );
          }
        }
        if (limits.maxConcurrent !== undefined) {
          const live = [...startedRuns].filter(
            startedRunId =>
              runs.get(startedRunId)?.runState.final === undefined,
          ).length;
          if (live >= limits.maxConcurrent) {
            throw makeError(
              X`Factory ${q(factoryId)} is at its concurrency limit`,
            );
          }
        }
        const run = await startRun(definition, {
          input: { ...inputDefaults, ...input },
          participants: { ...bound, ...participants },
          factoryId,
        });
        startedRuns.add(run.runId);
        return run.facets.observer;
      },
      /**
       * @param {{ participants?: Record<string, unknown>, input?: Record<string, unknown>, limits?: { maxConcurrent?: number } }} refinement
       */
      with: (refinement = {}) => {
        assertUsable();
        for (const slot of Object.keys(refinement.participants ?? {})) {
          if (Object.hasOwn(bound, slot)) {
            throw makeError(
              X`Derived factory cannot rebind bound slot ${q(slot)}`,
            );
          }
        }
        if (
          refinement.limits?.maxConcurrent !== undefined &&
          limits.maxConcurrent !== undefined &&
          refinement.limits.maxConcurrent > limits.maxConcurrent
        ) {
          throw makeError(X`Derived factory cannot loosen limits`);
        }
        return makeFactoryKit({
          definition: hash,
          participants: { ...bound, ...(refinement.participants ?? {}) },
          input: { ...inputDefaults, ...(refinement.input ?? {}) },
          limits: { ...limits, ...(refinement.limits ?? {}) },
          parentFactoryId: factoryId,
        }).factory;
      },
    });

    const factoryAdmin = makeExo(
      'WorkflowFactoryAdmin',
      WorkflowFactoryAdminInterface,
      {
        help: () =>
          'Workflow factory admin: runs() lists runs this factory started; revoke() disables the factory and every factory derived from it.',
        runs: () =>
          harden(
            [...startedRuns]
              .map(startedRunId => runs.get(startedRunId))
              .filter(run => run !== undefined)
              .map(run => summarize(/** @type {LiveRun} */ (run))),
          ),
        revoke: () => {
          /** @param {string} id */
          const revokeTree = id => {
            const entry = factoryRegistry.get(id);
            if (entry === undefined || entry.revoked) {
              return;
            }
            entry.revoked = true;
            for (const derivedId of entry.derived) {
              revokeTree(derivedId);
            }
          };
          revokeTree(factoryId);
          return undefined;
        },
      },
    );

    return harden({ factory, factoryAdmin, factoryId });
  };
  const makeFactoryKit = makeFactory;

  // #endregion

  // #region Recovery

  const recover = async () => {
    // Reload registries.
    {
      const names = await readJson(definitionsDirectory, NAMES_FILE);
      if (names !== undefined) {
        for (const [name, hashes] of Object.entries(names)) {
          definitionNames.set(name, /** @type {string[]} */ (hashes));
          for (const hash of /** @type {string[]} */ (hashes)) {
            // eslint-disable-next-line no-await-in-loop
            const body = await readJson(definitionsDirectory, `${hash}.json`);
            if (body !== undefined) {
              definitionsByHash.set(hash, harden(body));
            }
          }
        }
      }
      const cursor = await E(fragmentsDirectory).list();
      const entries = await E(cursor).toArray();
      for (const { name, kind } of entries) {
        if (kind === 'file' && name.endsWith('.json')) {
          // eslint-disable-next-line no-await-in-loop
          const body = await readJson(fragmentsDirectory, name);
          if (body !== undefined) {
            fragments.set(name.slice(0, -'.json'.length), harden(body));
          }
        }
      }
    }
    // Reload runs.
    const cursor = await E(runsDirectory).list();
    const entries = await E(cursor).toArray();
    for (const { name, kind } of entries) {
      if (kind !== 'directory') {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const runDirectory = await E(runsDirectory).lookup(name);
      // eslint-disable-next-line no-await-in-loop
      const meta = await readJson(runDirectory, 'meta.json');
      if (meta === undefined) {
        warn(`run ${name}: missing meta.json; skipping`);
        // eslint-disable-next-line no-continue
        continue;
      }
      const definition = definitionsByHash.get(
        /** @type {string} */ (meta.definitionHash),
      );
      if (definition === undefined) {
        warn(`run ${name}: missing definition; skipping`);
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const journal = await provideRunJournal(runDirectory, {
        runId: name,
        now,
        warn,
      });
      const runState = foldRecords(journal.records());
      if (runState === undefined) {
        // eslint-disable-next-line no-continue
        continue;
      }
      /** @type {LiveRun} */
      const run = {
        runId: name,
        definitionHash: /** @type {string} */ (meta.definitionHash),
        interpreter: makeInterpreter(definition),
        journal,
        runState,
        // Participant capabilities do not survive a restart in the core
        // engine; the daemon plugin re-binds them from its guest
        // namespace before recovery re-issues effects.
        participants: harden(
          /** @type {Record<string, unknown>} */ (
            powers.rebindParticipants === undefined
              ? {}
              : // eslint-disable-next-line no-await-in-loop
                await powers.rebindParticipants(name, meta)
          ),
        ),
        refs: new Map(),
        parent: /** @type {LiveRun['parent']} */ (meta.parent),
        children: new Set(),
        fanouts: new Map(),
        cancelTimer: undefined,
        tail: Promise.resolve(),
        deferred: [],
        eventsTopic: makeChangeTopic(),
        statusTopic: makeLatestTopic(),
        facets: /** @type {any} */ (undefined),
      };
      run.facets = makeRunFacets(run);
      runs.set(name, run);
    }
    // Wire children and re-issue pending effects.
    /** @type {Map<string, LiveRun>} (parentRunId, spawn-as) -> child run */
    const childByParentAs = new Map();
    for (const run of runs.values()) {
      if (run.parent !== undefined) {
        runs.get(run.parent.parentRunId)?.children.add(run.runId);
        childByParentAs.set(`${run.parent.parentRunId}\n${run.parent.as}`, run);
      }
    }
    for (const run of runs.values()) {
      if (run.runState.final !== undefined) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // Rebuild fanout partials from the journal before re-issuing.
      const records = run.journal.records();
      for (const record of records) {
        if (record.type === 'effect.issued' && record.effect === 'fanout') {
          const results = records
            .filter(
              partial =>
                partial.type === 'fanout.result' && partial.as === record.as,
            )
            .reduce((collected, partial) => {
              collected[/** @type {number} */ (partial.member)] =
                'value' in partial ? partial.value : partial.ref;
              return collected;
            }, /** @type {unknown[]} */ ([]));
          run.fanouts.set(/** @type {string} */ (record.as), {
            total: Number.MAX_SAFE_INTEGER, // corrected at re-issue
            results,
            arrived: results.filter(value => value !== undefined).length,
            joined: false,
            join: record.join ?? 'all',
          });
        }
      }
      const issuedByAs = new Map(
        records
          .filter(record => record.type === 'effect.issued')
          .map(record => [record.as, record]),
      );
      // Per-run counts so each run's `recovery.completed` reflects its
      // own resumption, not the engine-wide aggregate.
      let reissued = 0;
      let indeterminate = 0;
      for (const pending of Object.values(run.runState.pending)) {
        const issued = issuedByAs.get(pending.as);
        if (issued === undefined) {
          // eslint-disable-next-line no-continue
          continue;
        }
        if (pending.effect === 'spawn') {
          // Re-issuing a spawn would start a SECOND child. Only re-spawn
          // when no child exists for this correlation (the spawn never
          // completed before the crash). If the child exists and already
          // finished without its completion reaching us, deliver it now;
          // if it is still live, its own completion will notify us.
          const child = childByParentAs.get(`${run.runId}\n${pending.as}`);
          if (child === undefined) {
            reissued += 1;
            executeEffect(run, issued, true);
          } else if (child.runState.final !== undefined) {
            deliverChildFinished(run, child);
          }
          // eslint-disable-next-line no-continue
          continue;
        }
        if (pending.effect === 'call' && issued.idempotent !== true) {
          indeterminate += 1;
        } else {
          reissued += 1;
        }
        executeEffect(run, issued, true);
      }
      armTimer(run);
      enqueue(run, async () => {
        await commit(run, [
          harden({ type: 'recovery.completed', reissued, indeterminate }),
        ]);
      });
    }
  };

  // #endregion

  const service = makeExo('WorkflowService', WorkflowServiceInterface, {
    help: () =>
      'Workflow service: define(name, definition) registers a definition or fragment; start(name, { input, participants }) begins a run; makeFactory({ definition, participants, input, limits }) mints a start capability; run(runId), runs(), followRuns() observe.',
    define,
    definitions: () =>
      harden(
        [...definitionNames.entries()].map(([name, hashes]) => ({
          name,
          hash: hashes[hashes.length - 1],
          versions: hashes.length,
        })),
      ),
    /**
     * The inlined definition body, for graph rendering. Accepts a name,
     * a hash, or a `{ name }` record (as carried by run summaries).
     *
     * @param {string | { name: string }} nameOrHash
     */
    definitionBody: nameOrHash =>
      resolveDefinition(
        typeof nameOrHash === 'string' ? nameOrHash : nameOrHash.name,
      ).definition,
    /**
     * @param {string} nameOrHash
     * @param {{ input?: Record<string, unknown>, participants?: Record<string, unknown> }} [options]
     */
    start: async (nameOrHash, options = {}) => {
      const { definition } = resolveDefinition(nameOrHash);
      const run = await startRun(definition, {
        input: options.input,
        participants: options.participants,
      });
      return harden({
        runId: run.runId,
        observer: run.facets.observer,
        controller: run.facets.controller,
        admin: run.facets.admin,
      });
    },
    /**
     * @param {string} runId
     * @param {'observer' | 'controller' | 'admin'} [facet]
     */
    run: (runId, facet = 'observer') => {
      const run = runs.get(runId);
      if (run === undefined) {
        throw makeError(X`Unknown run ${q(runId)}`);
      }
      return run.facets[facet];
    },
    runs: () => harden([...runs.values()].map(summarize)),
    followRuns: () => runsTopic.subscribe(),
    makeFactory: (/** @type {any} */ config) => {
      const { factory, factoryAdmin } = makeFactory(config);
      return harden({ factory, factoryAdmin });
    },
  });

  await recover();

  return harden({ service, runs });
};
harden(makeWorkflowEngine);
