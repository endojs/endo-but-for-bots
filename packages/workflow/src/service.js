// @ts-check

/**
 * The workflow service: durable runs of pure-kernel charts over an
 * agent's pet store, with mail-backed asks, idempotency-keyed invokes,
 * re-armed deadlines, and spawned child runs.
 *
 * Storage layout in the agent's namespace (the mailbox-store idiom —
 * decimal-named immutable marshal entries, rehydrated by scanning):
 *
 * ```
 * workflow/
 *   charts/<name>-v<version>     installed chart snapshots
 *   runs/<runId>/
 *     chart                      the run's self-contained chart snapshot
 *     endowments/<name>          the capabilities granted at start
 *     answers/<effectId>         ask answers land here (request responseName)
 *     0, 1, 2, ...               the journal, one marshal per entry
 * ```
 *
 * Restart contract, per effect kind:
 *
 * - `ask` (mail): exactly-once. The request/form message and its answer
 *   are durable daemon mail; recovery adopts an already-arrived answer
 *   (responseName, then the own-mailbox copy's `@mail/<n>/@result`) and
 *   otherwise re-attaches without re-sending — the correlation marker
 *   appended to each ask's description makes the send idempotent.
 * - `invoke` (eventual send): at-least-once. Recovery re-dispatches
 *   unsettled invokes with the same `effectId`, which is also passed to
 *   the target as its final argument for deduplication.
 * - `after`: re-armed from the journaled absolute deadline; past-due
 *   deadlines fire immediately.
 * - `spawn`: children are runs in the same store and recover
 *   independently; parent linkage is re-derived from the parent's
 *   pending spawn records.
 */

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { Fail, q } from '@endo/errors';
import { mustMatch } from '@endo/patterns';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import {
  assertChart,
  initialStep,
  transition,
  exitEffects,
} from './machine.js';
import {
  applyEntry,
  initialFoldState,
  foldJournal,
  effectRecordsFor,
} from './journal.js';
import { makeSerialJobs } from './serial-jobs.js';
import { makeChangeTopic } from './topic.js';
import {
  WorkflowServiceInterface,
  WorkflowRunInterface,
  WorkflowControlInterface,
  WorkflowPortInterface,
} from './interfaces.js';

const { entries, keys, fromEntries } = Object;
const { isArray } = Array;

const ROOT = 'workflow';
const CHARTS = 'charts';
const RUNS = 'runs';
const ENDOWMENTS = 'endowments';
const ANSWERS = 'answers';
const CHART_NAME = 'chart';

/** Cap on engine-generated event cascades per external trigger. */
const MAX_CASCADE_DEPTH = 64;
/** Attempts to find our own mailbox copy of a just-sent ask. */
const CORRELATION_SCAN_ATTEMPTS = 8;
const CORRELATION_SCAN_DELAY_MS = 50;
/** Journal a state snapshot every this many entries. */
const SNAPSHOT_EVERY = 64;

const DECIMAL_NAME = /^(0|[1-9][0-9]*)$/;
const CHART_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * @param {number} [length]
 */
const randomHex = (length = 12) => {
  let hex = '';
  while (hex.length < length) {
    hex += Math.floor(Math.random() * 0x1_0000)
      .toString(16)
      .padStart(4, '0');
  }
  return hex.slice(0, length);
};

const defaultClock = harden({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle),
});

/**
 * Resolve installed-chart string references (in region specs and spawn
 * effects) into inline charts, so a run's stored chart snapshot is fully
 * self-contained. Cycle-checked.
 *
 * @param {any} chart
 * @param {(key: string) => Promise<any>} loadChart
 * @param {string[]} [stack]
 * @returns {Promise<any>}
 */
export const resolveChartRefs = async (chart, loadChart, stack = []) => {
  /** @type {(ref: any) => Promise<any>} */
  let resolveRef;
  const resolveEffects = async effects => {
    await null;
    if (effects === undefined) {
      return undefined;
    }
    return harden(
      await Promise.all(
        effects.map(async effect => {
          await null;
          if (effect.kind === 'spawn' && typeof effect.chart === 'string') {
            return harden({ ...effect, chart: await resolveRef(effect.chart) });
          }
          return effect;
        }),
      ),
    );
  };
  const resolveBody = async body => {
    await null;
    const states = fromEntries(
      await Promise.all(
        entries(body.states).map(async ([name, def]) => {
          await null;
          let next = def;
          if (next.states !== undefined) {
            const child = await resolveBody(next);
            next = harden({ ...next, states: child.states });
          }
          if (next.regions !== undefined) {
            if (isArray(next.regions)) {
              const regions = await Promise.all(
                next.regions.map(region => resolveRef(region)),
              );
              next = harden({ ...next, regions: harden(regions) });
            } else {
              const inline = await resolveRef(next.regions.chart);
              next = harden({
                ...next,
                regions: harden({ ...next.regions, chart: inline }),
              });
            }
          }
          const entry = await resolveEffects(next.entry);
          const exit = await resolveEffects(next.exit);
          let on = next.on;
          if (on !== undefined) {
            on = harden(
              fromEntries(
                await Promise.all(
                  entries(on).map(async ([type, candidates]) => {
                    await null;
                    return [
                      type,
                      harden(
                        await Promise.all(
                          candidates.map(async t => {
                            await null;
                            if (t.effects === undefined) {
                              return t;
                            }
                            return harden({
                              ...t,
                              effects: await resolveEffects(t.effects),
                            });
                          }),
                        ),
                      ),
                    ];
                  }),
                ),
              ),
            );
          }
          return [
            name,
            harden({
              ...next,
              ...(entry !== undefined ? { entry } : {}),
              ...(exit !== undefined ? { exit } : {}),
              ...(on !== undefined ? { on } : {}),
            }),
          ];
        }),
      ),
    );
    return harden({ ...body, states: harden(states) });
  };
  resolveRef = async ref => {
    if (typeof ref !== 'string') {
      return resolveBody(ref);
    }
    !stack.includes(ref) || Fail`chart reference cycle: ${q([...stack, ref])}`;
    const loaded = await loadChart(ref);
    loaded !== undefined || Fail`no installed chart ${q(ref)}`;
    return resolveChartRefs(loaded, loadChart, [...stack, ref]);
  };
  return resolveBody(chart);
};
harden(resolveChartRefs);

/**
 * Build the workflow service over agent-shaped powers.
 *
 * @param {object} options
 * @param {any} options.powers - agent-shaped powers (a guest or host):
 *   the pet-store surface (`lookup`, `maybeLookup`, `has`, `list`,
 *   `makeDirectory`, `storeValue`) plus, for `ask` effects, the mail
 *   surface (`request`, `form`, `listMessages`, `followMessages`).
 * @param {any} [options.context] - caplet lifecycle context; cancellation
 *   stops timers and the mail watcher.
 * @param {{ now: () => number, setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (handle: any) => void }} [options.clock]
 * @param {() => string} [options.makeId]
 * @param {(reader: any) => AsyncIterable<any>} [options.iterateMessages] -
 *   seam for consuming the `followMessages` reader; defaults to treating
 *   the reader as an async iterable (tests) — the daemon integration
 *   passes `iterateReader` from `@endo/exo-stream`.
 */
export const makeWorkflowService = async ({
  powers,
  context = undefined,
  clock = defaultClock,
  makeId = randomHex,
  iterateMessages = reader => reader,
}) => {
  const isoNow = () => new Date(clock.now()).toISOString();

  /** @type {Map<string, any>} */
  const engines = new Map();
  /** @type {Map<string, { runId: string, effectId: string }>} */
  const formCorrelations = new Map();
  /** @type {Map<string, { runId: string, effectId: string }>} */
  const parentLinks = new Map();
  const runsTopic = makeChangeTopic();
  let stopped = false;
  /** @type {Set<any>} */
  const liveTimers = new Set();
  /** @type {(chartOrKey: any, options?: any) => Promise<any>} */
  let startRun;

  // #region storage helpers

  const ensureDirectory = async path => {
    const present = await E(powers).has(...path);
    if (!present) {
      await E(powers).makeDirectory(path);
    }
  };

  const runPath = (runId, ...rest) => [ROOT, RUNS, runId, ...rest];

  const readJournal = async runId => {
    /** @type {string[]} */
    const names = await E(powers).list(ROOT, RUNS, runId);
    const seqs = names
      .filter(name => DECIMAL_NAME.test(name))
      .map(name => BigInt(name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const journal = [];
    for (const seq of seqs) {
      // eslint-disable-next-line no-await-in-loop
      journal.push(await E(powers).lookup(runPath(runId, String(seq))));
    }
    return journal;
  };

  const loadInstalledChart = async key =>
    E(powers).maybeLookup([ROOT, CHARTS, key]);

  // #endregion

  // #region run engine

  /**
   * @param {object} options
   * @param {string} options.runId
   * @param {any} options.chart
   * @param {import('./journal.js').FoldState} options.fold
   */
  const makeRunEngine = ({ runId, chart, fold }) => {
    const jobs = makeSerialJobs();
    const topic = makeChangeTopic();
    /** @type {Map<string, any>} */
    const timers = new Map();
    /** @type {Set<string>} */
    const attachedAsks = new Set();

    /** @type {any} */
    const engine = {};
    engine.runId = runId;
    engine.chart = chart;
    engine.fold = fold;

    const summary = () =>
      harden({
        runId,
        chartName: chart.name,
        chartVersion: chart.version,
        state:
          fold.configuration === undefined
            ? undefined
            : fold.configuration.state,
        seq: fold.nextSeq,
        paused: fold.paused,
        done: fold.done,
        outcome: fold.outcome,
        updatedAt: fold.updatedAt,
      });
    engine.summary = summary;

    const clearTimer = effectId => {
      const handle = timers.get(effectId);
      if (handle !== undefined) {
        timers.delete(effectId);
        liveTimers.delete(handle);
        clock.clearTimeout(handle);
      }
    };

    const clearStaleSideEffects = () => {
      for (const effectId of [...timers.keys()]) {
        if (!fold.pending.has(effectId)) {
          clearTimer(effectId);
        }
      }
      for (const [messageId, corr] of [...formCorrelations]) {
        if (corr.runId === runId && !fold.pending.has(corr.effectId)) {
          formCorrelations.delete(messageId);
        }
      }
    };

    // Append one journal entry: store first, then fold, then publish.
    const append = async fields => {
      const entry = harden({ seq: fold.nextSeq, at: isoNow(), ...fields });
      await E(powers).storeValue(entry, runPath(runId, String(entry.seq)));
      applyEntry(fold, entry);
      topic.publisher.next(entry);
      runsTopic.publisher.next(summary());
      return entry;
    };

    const maybeSnapshot = async () => {
      if (
        fold.done ||
        fold.paused ||
        fold.queuedEvents.size > 0 ||
        fold.nextSeq === 0n ||
        fold.nextSeq % BigInt(SNAPSHOT_EVERY) !== 0n
      ) {
        return;
      }
      await append({
        kind: 'snapshot',
        by: 'engine',
        configuration: fold.configuration,
        context: fold.context,
        pending: harden([...fold.pending.values()]),
      });
    };

    // Terminal bookkeeping: timers, children, and parent notification.
    const settleTerminal = terminalKind => {
      for (const effectId of [...timers.keys()]) {
        clearTimer(effectId);
      }
      clearStaleSideEffects();
      for (const [childRunId, link] of [...parentLinks]) {
        if (link.runId === runId) {
          parentLinks.delete(childRunId);
          const child = engines.get(childRunId);
          if (child !== undefined && !child.fold.done) {
            child.cancel(`parent run ${runId} ${terminalKind}`).catch(() => {});
          }
        }
      }
      const link = parentLinks.get(runId);
      if (link !== undefined) {
        parentLinks.delete(runId);
        const parent = engines.get(link.runId);
        if (parent !== undefined) {
          parent
            .settleChild(link.effectId, {
              status: fold.outcome,
              ...(fold.output !== undefined ? { output: fold.output } : {}),
              ...(fold.reason !== undefined ? { reason: fold.reason } : {}),
            })
            .catch(() => {});
        }
      }
    };

    /**
     * Step an envelope through the kernel and journal the result as one
     * atomic entry, then perform its effects and schedule its internal
     * events. Runs inside the run's serial queue.
     *
     * @param {any} envelope
     * @param {number} depth
     * @param {bigint} [replays]
     */
    const stepEnvelope = async (envelope, depth, replays) => {
      await null;
      const machineState = {
        configuration: fold.configuration,
        context: fold.context,
        params: fold.params,
      };
      const result = transition(chart, machineState, envelope);
      if (!result.fired) {
        await append({
          kind: 'event',
          by: envelope.by,
          event: envelope,
          ...(replays !== undefined ? { replays } : {}),
        });
        return;
      }
      const effects = effectRecordsFor(fold.nextSeq, result.effects);
      await append({
        kind: 'event',
        by: envelope.by,
        event: envelope,
        ...(replays !== undefined ? { replays } : {}),
        fired: harden({
          configuration: result.configuration,
          context: result.context,
          exited: result.exited,
          effects,
        }),
      });
      clearStaleSideEffects();
      await dispatchEffects(effects, depth);
      for (const internal of result.internalEvents) {
        scheduleEnvelope(harden({ ...internal, by: 'engine' }), depth + 1);
      }
      if (result.terminal !== undefined && !fold.done) {
        await append({
          kind: 'completed',
          by: 'engine',
          ...(result.terminal.output !== undefined
            ? { output: result.terminal.output }
            : {}),
        });
        settleTerminal('completed');
      }
      await maybeSnapshot();
    };

    /**
     * Process one envelope under the run's serial queue.
     *
     * @param {any} envelope
     * @param {number} depth
     */
    const processEnvelope = async (envelope, depth) => {
      await null;
      if (fold.done || stopped) {
        return fold.nextSeq;
      }
      if (depth > MAX_CASCADE_DEPTH) {
        await append({
          kind: 'failed',
          by: 'engine',
          reason: `internal event cascade exceeded ${MAX_CASCADE_DEPTH}`,
        });
        settleTerminal('failed');
        return fold.nextSeq;
      }
      if (fold.paused) {
        const entry = await append({
          kind: 'event',
          by: envelope.by,
          event: envelope,
        });
        return entry.seq;
      }
      const seq = fold.nextSeq;
      await stepEnvelope(envelope, depth);
      return seq;
    };

    const scheduleEnvelope = (envelope, depth) => {
      jobs
        .enqueue(() => processEnvelope(envelope, depth))
        .catch(error =>
          console.error(`workflow run ${runId}: event failed`, error),
        );
    };

    // Public event injection; returns the seq of the journaled entry.
    engine.inject = (envelope, depth = 0) =>
      jobs.enqueue(() => processEnvelope(envelope, depth));

    // Settle a pending effect; stale and duplicate settlements drop.
    const settleEffect = (effectId, status, value) =>
      jobs.enqueue(async () => {
        if (stopped || fold.done || !fold.pending.has(effectId)) {
          return;
        }
        const record = fold.pending.get(effectId);
        await append({
          kind: 'effect-settled',
          by: 'engine',
          effectId,
          status,
          ...(status === 'fulfilled' ? { value } : { reason: value }),
        });
        clearTimer(effectId);
        clearStaleSideEffects();
        const { effect } = record;
        const type =
          status === 'fulfilled'
            ? effect.outcome
            : (effect.failure ?? 'effect-failed');
        const by =
          effect.kind === 'ask'
            ? `ask:${effect.to}`
            : effect.kind === 'invoke'
              ? `invoke:${effect.target}`
              : effect.kind === 'spawn'
                ? 'spawn'
                : 'engine';
        const envelope = harden({
          type,
          value: status === 'fulfilled' ? value : harden({ reason: value }),
          by,
          at: isoNow(),
          path: record.path,
          effectId,
        });
        if (fold.paused) {
          await append({ kind: 'event', by, event: envelope });
          return;
        }
        await stepEnvelope(envelope, 0);
      });
    engine.settleEffect = settleEffect;
    engine.settleChild = (effectId, outcome) =>
      outcome.status === 'completed'
        ? settleEffect(effectId, 'fulfilled', outcome)
        : settleEffect(
            effectId,
            'failed',
            `child run ${outcome.status}${
              outcome.reason !== undefined ? `: ${outcome.reason}` : ''
            }`,
          );

    // #region effect dispatch

    const answersPathFor = effectId => runPath(runId, ANSWERS, effectId);

    const markerFor = effectId => `[workflow ${runId} ${effectId}]`;

    const findOwnMessage = async (type, marker) => {
      const messages = await E(powers).listMessages();
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (
          message.type === type &&
          typeof message.description === 'string' &&
          message.description.endsWith(marker)
        ) {
          return message;
        }
      }
      return undefined;
    };

    const scanForOwnMessage = async (type, marker) => {
      await null;
      for (let attempt = 0; attempt < CORRELATION_SCAN_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const found = await findOwnMessage(type, marker);
        if (found !== undefined) {
          return found;
        }
        if (attempt < 3) {
          // Local delivery lands within a few turns; spin the microtask
          // queue before falling back to timed retries.
          // eslint-disable-next-line no-await-in-loop
          await null;
        } else {
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => {
            const handle = clock.setTimeout(() => {
              liveTimers.delete(handle);
              resolve(undefined);
            }, CORRELATION_SCAN_DELAY_MS);
            liveTimers.add(handle);
          });
        }
      }
      return undefined;
    };

    // Attach settlement listeners for a request-mode ask.
    const attachRequestAsk = async (effectId, correlation) => {
      if (attachedAsks.has(effectId)) {
        return;
      }
      attachedAsks.add(effectId);
      // An already-stored answer settles immediately and idempotently.
      const stored = await E(powers).maybeLookup(correlation.responseName);
      if (stored !== undefined) {
        settleEffect(effectId, 'fulfilled', stored).catch(() => {});
        return;
      }
      if (correlation.messageNumber !== undefined) {
        // The durable path: follow our own mailbox copy's resolution.
        E(powers)
          .lookup(['@mail', correlation.messageNumber, '@result'])
          .then(
            value => settleEffect(effectId, 'fulfilled', value),
            error =>
              settleEffect(effectId, 'failed', `${error.message ?? error}`),
          )
          .catch(() => {});
      }
    };

    const dispatchAsk = async record => {
      const { effectId, effect } = record;
      const marker = markerFor(effectId);
      const mode = effect.what !== undefined ? 'request' : 'form';
      const base =
        mode === 'request' ? effect.what.description : effect.form.description;
      const description = `${base} ${marker}`;
      const recipientPath = runPath(runId, ENDOWMENTS, effect.to);
      let existing = await findOwnMessage(mode, marker);
      if (existing === undefined) {
        if (mode === 'request') {
          const responseName = answersPathFor(effectId);
          attachedAsks.add(effectId);
          E(powers)
            .request(recipientPath, description, responseName)
            .then(
              value => settleEffect(effectId, 'fulfilled', value),
              error =>
                settleEffect(effectId, 'failed', `${error.message ?? error}`),
            )
            .catch(() => {});
        } else {
          await E(powers).form(recipientPath, description, effect.form.fields);
        }
        existing = await scanForOwnMessage(mode, marker);
      }
      const correlation = harden({
        mode,
        responseName: answersPathFor(effectId),
        ...(existing !== undefined
          ? {
              messageId: existing.messageId,
              messageNumber: String(existing.number),
            }
          : {}),
      });
      await append({
        kind: 'effect-dispatched',
        by: 'engine',
        effectId,
        correlation,
      });
      if (mode === 'form') {
        if (existing !== undefined) {
          formCorrelations.set(existing.messageId, { runId, effectId });
          // Adopt a reply that arrived before the correlation was
          // registered (or while the daemon was down).
          const messages = await E(powers).listMessages();
          for (const message of messages) {
            if (
              message.type === 'value' &&
              message.replyTo === existing.messageId
            ) {
              // eslint-disable-next-line no-await-in-loop
              const value = await E(powers).lookup([
                '@mail',
                String(message.number),
                '@value',
              ]);
              settleEffect(effectId, 'fulfilled', value).catch(() => {});
              break;
            }
          }
        }
      } else {
        await attachRequestAsk(effectId, correlation);
      }
    };

    // After an `after` deadline elapses, emit its declared event.
    const fireAfter = record =>
      jobs.enqueue(async () => {
        if (stopped || fold.done || !fold.pending.has(record.effectId)) {
          return;
        }
        await append({
          kind: 'effect-settled',
          by: 'engine',
          effectId: record.effectId,
          status: 'fulfilled',
        });
        const envelope = harden({
          ...record.effect.emit,
          by: 'engine',
          at: isoNow(),
          path: record.path,
          effectId: record.effectId,
        });
        if (fold.paused) {
          await append({ kind: 'event', by: 'engine', event: envelope });
          return;
        }
        await stepEnvelope(envelope, 0);
      });

    const armAfterTimer = (record, deadline) => {
      const { effectId } = record;
      clearTimer(effectId);
      const remaining = Math.max(0, deadline - clock.now());
      const handle = clock.setTimeout(() => {
        liveTimers.delete(handle);
        timers.delete(effectId);
        fireAfter(record).catch(() => {});
      }, remaining);
      timers.set(effectId, handle);
      liveTimers.add(handle);
    };

    const afterDeadlineOf = effect => {
      const deadline =
        effect.ms !== undefined
          ? clock.now() + effect.ms
          : Date.parse(effect.at);
      Number.isFinite(deadline) ||
        Fail`after.at must be a parseable date, got ${q(effect.at)}`;
      return deadline;
    };

    const dispatchInvoke = async record => {
      const { effectId, effect } = record;
      await append({ kind: 'effect-dispatched', by: 'engine', effectId });
      const targetPath = runPath(runId, ENDOWMENTS, effect.target);
      E(powers)
        .lookup(targetPath)
        .then(target =>
          E(target)[effect.method](...(effect.args ?? []), effectId),
        )
        .then(
          value => settleEffect(effectId, 'fulfilled', value),
          error =>
            settleEffect(effectId, 'failed', `${error.message ?? error}`),
        )
        .catch(() => {});
    };

    const dispatchSpawn = async record => {
      await null;
      const { effectId, effect } = record;
      const endowmentNames = effect.endowments ?? [];
      /** @type {Record<string, any>} */
      const childEndowments = {};
      for (const name of endowmentNames) {
        // eslint-disable-next-line no-await-in-loop
        childEndowments[name] = await E(powers).lookup(
          runPath(runId, ENDOWMENTS, name),
        );
      }
      const child = await startRun(effect.chart, {
        params: effect.params ?? harden({}),
        endowments: harden(childEndowments),
      });
      await append({
        kind: 'spawned',
        by: 'engine',
        effectId,
        childRunId: child.runId,
      });
      if (child.fold.done) {
        engine
          .settleChild(effectId, {
            status: child.fold.outcome,
            ...(child.fold.output !== undefined
              ? { output: child.fold.output }
              : {}),
            ...(child.fold.reason !== undefined
              ? { reason: child.fold.reason }
              : {}),
          })
          .catch(() => {});
      } else {
        parentLinks.set(child.runId, { runId, effectId });
      }
    };

    const dispatchEffects = async (effectRecords, depth) => {
      await null;
      for (const record of effectRecords) {
        const { effect, effectId } = record;
        if (effect.kind === 'emit') {
          scheduleEnvelope(
            harden({
              ...effect.event,
              by: 'engine',
              at: isoNow(),
              path: record.path,
            }),
            depth + 1,
          );
        } else if (effect.kind === 'invoke') {
          // eslint-disable-next-line no-await-in-loop
          await dispatchInvoke(record);
        } else if (effect.kind === 'ask') {
          // eslint-disable-next-line no-await-in-loop
          await dispatchAsk(record);
        } else if (effect.kind === 'after') {
          const deadline = afterDeadlineOf(effect);
          // eslint-disable-next-line no-await-in-loop
          await append({
            kind: 'effect-dispatched',
            by: 'engine',
            effectId,
            correlation: harden({ deadline }),
          });
          armAfterTimer(record, deadline);
        } else if (effect.kind === 'spawn') {
          // eslint-disable-next-line no-await-in-loop
          await dispatchSpawn(record);
        }
      }
    };

    // #endregion

    engine.start = (params, endowmentNames) =>
      jobs.enqueue(async () => {
        const result = initialStep(chart, { params });
        const effects = effectRecordsFor(fold.nextSeq, result.effects);
        await append({
          kind: 'started',
          by: 'control',
          chartName: chart.name,
          chartVersion: chart.version,
          params,
          endowmentNames,
          configuration: result.configuration,
          context: result.context,
          effects,
        });
        await dispatchEffects(effects, 0);
        for (const internal of result.internalEvents) {
          scheduleEnvelope(harden({ ...internal, by: 'engine' }), 1);
        }
        if (result.terminal !== undefined && !fold.done) {
          await append({
            kind: 'completed',
            by: 'engine',
            ...(result.terminal.output !== undefined
              ? { output: result.terminal.output }
              : {}),
          });
          settleTerminal('completed');
        }
      });

    engine.cancel = reason =>
      jobs.enqueue(async () => {
        if (fold.done) {
          return;
        }
        const compensation = exitEffects(chart, {
          configuration: fold.configuration,
          context: fold.context,
          params: fold.params,
        });
        // Fire-and-forget compensation: invokes go out; emits are inert
        // against a run that is about to be terminal; settlements of a
        // terminal run drop as stale.
        for (const { effect } of compensation) {
          if (effect.kind === 'invoke') {
            const targetPath = runPath(runId, ENDOWMENTS, effect.target);
            E(powers)
              .lookup(targetPath)
              .then(target =>
                E(target)[effect.method](...(effect.args ?? []), 'cancel'),
              )
              .catch(() => {});
          }
        }
        await append({
          kind: 'cancelled',
          by: 'control',
          ...(reason !== undefined ? { reason } : {}),
        });
        settleTerminal('cancelled');
      });

    engine.pause = () =>
      jobs.enqueue(async () => {
        if (fold.done || fold.paused) {
          return;
        }
        await append({ kind: 'paused', by: 'control' });
      });

    engine.resume = () =>
      jobs.enqueue(async () => {
        if (fold.done || !fold.paused) {
          return;
        }
        const queued = [...fold.queuedEvents.entries()];
        await append({ kind: 'resumed', by: 'control' });
        for (const [seqName, envelope] of queued) {
          // eslint-disable-next-line no-await-in-loop
          await stepEnvelope(envelope, 0, BigInt(seqName));
        }
      });

    /** Re-arm the world half of every pending effect after recovery. */
    engine.rearm = () =>
      jobs.enqueue(async () => {
        await null;
        if (fold.done) {
          return;
        }
        for (const record of [...fold.pending.values()]) {
          const { effect, effectId, correlation } = record;
          if (effect.kind === 'invoke') {
            // At-least-once: re-dispatch under the same effectId whether
            // or not the previous incarnation got the send off.
            // eslint-disable-next-line no-await-in-loop
            await dispatchInvoke(record);
          } else if (effect.kind === 'ask') {
            if (correlation === undefined) {
              // Crash between the event append and the dispatch record:
              // dispatchAsk scans for an existing message bearing the
              // effect's marker before sending, so this cannot double-ask.
              // eslint-disable-next-line no-await-in-loop
              await dispatchAsk(record);
            } else if (correlation.mode === 'form') {
              if (correlation.messageId !== undefined) {
                formCorrelations.set(correlation.messageId, {
                  runId,
                  effectId,
                });
              }
              // Adopt an answer that arrived while the daemon was down.
              // eslint-disable-next-line no-await-in-loop
              const messages = await E(powers).listMessages();
              for (const message of messages) {
                if (
                  message.type === 'value' &&
                  message.replyTo === correlation.messageId
                ) {
                  // eslint-disable-next-line no-await-in-loop
                  const value = await E(powers).lookup([
                    '@mail',
                    String(message.number),
                    '@value',
                  ]);
                  settleEffect(effectId, 'fulfilled', value).catch(() => {});
                  break;
                }
              }
            } else {
              // eslint-disable-next-line no-await-in-loop
              await attachRequestAsk(effectId, correlation);
            }
          } else if (effect.kind === 'after') {
            if (correlation === undefined) {
              const deadline = afterDeadlineOf(effect);
              // eslint-disable-next-line no-await-in-loop
              await append({
                kind: 'effect-dispatched',
                by: 'engine',
                effectId,
                correlation: harden({ deadline }),
              });
              armAfterTimer(record, deadline);
            } else {
              armAfterTimer(record, correlation.deadline);
            }
          } else if (effect.kind === 'spawn') {
            if (record.childRunId === undefined) {
              // eslint-disable-next-line no-await-in-loop
              await dispatchSpawn(record);
            } else {
              const child = engines.get(record.childRunId);
              if (child === undefined || child.fold.done) {
                const outcome =
                  child === undefined
                    ? { status: 'failed', reason: 'child run missing' }
                    : {
                        status: child.fold.outcome,
                        ...(child.fold.output !== undefined
                          ? { output: child.fold.output }
                          : {}),
                        ...(child.fold.reason !== undefined
                          ? { reason: child.fold.reason }
                          : {}),
                      };
                engine.settleChild(effectId, outcome).catch(() => {});
              } else {
                parentLinks.set(record.childRunId, { runId, effectId });
              }
            }
          }
        }
      });

    // #region facets

    /**
     * @param {bigint} from
     * @param {bigint} [to]
     */
    const readEntries = async (from, to) => {
      await null;
      const last = to === undefined || to > fold.nextSeq ? fold.nextSeq : to;
      const journal = [];
      for (let seq = from; seq < last; seq += 1n) {
        // eslint-disable-next-line no-await-in-loop
        journal.push(await E(powers).lookup(runPath(runId, String(seq))));
      }
      return harden(journal);
    };

    /** @param {bigint} since */
    async function* followEntries(since) {
      await null;
      // Subscribe before replaying so nothing falls in the gap, then
      // dedupe the overlap by seq — the snapshot-then-tail idiom with a
      // real cursor.
      const subscription = topic.subscribe();
      const replayEnd = fold.nextSeq;
      const wasDone = fold.done;
      let last = since - 1n;
      for (let seq = since; seq < replayEnd; seq += 1n) {
        // eslint-disable-next-line no-await-in-loop
        const entry = await E(powers).lookup(runPath(runId, String(seq)));
        last = /** @type {bigint} */ (entry.seq);
        yield entry;
      }
      if (wasDone) {
        return;
      }
      for await (const entry of subscription) {
        const entrySeq = /** @type {bigint} */ (entry.seq);
        if (entrySeq > last) {
          last = entrySeq;
          yield entry;
          if (
            entry.kind === 'completed' ||
            entry.kind === 'cancelled' ||
            entry.kind === 'failed'
          ) {
            return;
          }
        }
      }
    }

    const status = () =>
      harden({
        runId,
        chartName: chart.name,
        chartVersion: chart.version,
        configuration: fold.configuration,
        context: fold.context,
        seq: fold.nextSeq,
        startedAt: fold.startedAt,
        updatedAt: fold.updatedAt,
        paused: fold.paused,
        done: fold.done,
        ...(fold.outcome !== undefined ? { outcome: fold.outcome } : {}),
        ...(fold.output !== undefined ? { output: fold.output } : {}),
        ...(fold.reason !== undefined ? { reason: fold.reason } : {}),
        pending: harden(
          [...fold.pending.values()].map(record =>
            harden({
              effectId: record.effectId,
              kind: record.effect.kind,
              path: record.path,
              ...(record.correlation !== undefined
                ? { correlation: record.correlation }
                : {}),
              ...(record.childRunId !== undefined
                ? { childRunId: record.childRunId }
                : {}),
            }),
          ),
        ),
        prompts: harden(
          [...fold.pending.values()]
            .filter(record => record.effect.kind === 'ask')
            .map(record =>
              harden({
                effectId: record.effectId,
                to: record.effect.to,
                description:
                  record.effect.what?.description ??
                  record.effect.form?.description,
              }),
            ),
        ),
      });

    /** @type {Map<string, any>} */
    const ports = new Map();

    engine.runFacet = makeExo('WorkflowRun', WorkflowRunInterface, {
      status: async () => status(),
      follow: async ({ since = 0n } = {}) =>
        readerFromIterator(followEntries(since)),
      journal: async ({ from = 0n, to = undefined } = {}) =>
        readEntries(from, to),
      chart: async () => chart,
      port: async role => {
        const pattern =
          chart.ports?.[role] ??
          Fail`chart ${q(chart.name)} declares no port ${q(role)}`;
        let port = ports.get(role);
        if (port === undefined) {
          port = makeExo('WorkflowPort', WorkflowPortInterface, {
            submit: async event => {
              mustMatch(event, pattern, `port ${role}`);
              return engine.inject(
                harden({ ...event, by: `port:${role}`, at: isoNow() }),
              );
            },
            help: () =>
              `submit(event) -> seq: inject a pattern-checked event as port ${role}`,
          });
          ports.set(role, port);
        }
        return port;
      },
      help: () =>
        `Workflow run ${runId} of ${chart.name} v${chart.version}: status(), follow({ since }), journal({ from, to }), chart(), port(role)`,
    });

    engine.controlFacet = makeExo('WorkflowControl', WorkflowControlInterface, {
      signal: async event =>
        engine.inject(harden({ ...event, by: 'control', at: isoNow() })),
      pause: async () => engine.pause(),
      resume: async () => engine.resume(),
      cancel: async reason => engine.cancel(reason),
      help: () =>
        `Control for workflow run ${runId}: signal(event), pause(), resume(), cancel(reason?)`,
    });

    // #endregion

    return engine;
  };

  // #endregion

  // #region service

  const chartKeyFor = chart => {
    CHART_NAME_PATTERN.test(chart.name) ||
      Fail`chart.name must be pet-name-safe (${q(CHART_NAME_PATTERN.source)}), got ${q(chart.name)}`;
    Number.isInteger(chart.version) ||
      Fail`chart.version must be an integer, got ${q(chart.version)}`;
    return `${chart.name}-v${chart.version}`;
  };

  startRun = async (
    chartOrKey,
    { params = harden({}), endowments = harden({}) } = {},
  ) => {
    await null;
    !stopped || Fail`workflow service is stopped`;
    let chart = chartOrKey;
    if (typeof chart === 'string') {
      chart = await loadInstalledChart(chart);
      chart !== undefined || Fail`no installed chart ${q(chartOrKey)}`;
    }
    chart = await resolveChartRefs(chart, loadInstalledChart);
    assertChart(chart);
    chartKeyFor(chart);
    const runId = `r-${makeId()}`;
    await E(powers).makeDirectory([ROOT, RUNS, runId]);
    await E(powers).makeDirectory(runPath(runId, ANSWERS));
    await E(powers).makeDirectory(runPath(runId, ENDOWMENTS));
    await E(powers).storeValue(chart, runPath(runId, CHART_NAME));
    const endowmentNames = harden(keys(endowments).sort());
    for (const name of endowmentNames) {
      // eslint-disable-next-line no-await-in-loop
      await E(powers).storeValue(
        endowments[name],
        runPath(runId, ENDOWMENTS, name),
      );
    }
    const engine = makeRunEngine({ runId, chart, fold: initialFoldState() });
    engines.set(runId, engine);
    await engine.start(params, endowmentNames);
    return engine;
  };

  const recoverRun = async runId => {
    const chart = await E(powers).lookup(runPath(runId, CHART_NAME));
    const journal = await readJournal(runId);
    const fold = foldJournal(journal);
    const engine = makeRunEngine({ runId, chart, fold });
    engines.set(runId, engine);
    return engine;
  };

  const getEngine = runId =>
    engines.get(runId) ?? Fail`no workflow run ${q(runId)}`;

  const watchMail = async () => {
    await null;
    let messages;
    try {
      messages = await E(powers).followMessages();
    } catch {
      // Powers without a mail surface: asks will fail loudly at dispatch;
      // everything else works.
      return;
    }
    try {
      for await (const message of iterateMessages(messages)) {
        if (stopped) {
          return;
        }
        if (message.type === 'value' && message.replyTo !== undefined) {
          const correlation = formCorrelations.get(message.replyTo);
          const engine =
            correlation === undefined
              ? undefined
              : engines.get(correlation.runId);
          if (correlation !== undefined && engine !== undefined) {
            const value = await E(powers).lookup([
              '@mail',
              String(message.number),
              '@value',
            ]);
            engine
              .settleEffect(correlation.effectId, 'fulfilled', value)
              .catch(() => {});
          }
        }
      }
    } catch (error) {
      if (!stopped) {
        console.error('workflow service: mail watcher failed', error);
      }
    }
  };

  const stop = () => {
    stopped = true;
    for (const handle of [...liveTimers]) {
      clock.clearTimeout(handle);
    }
    liveTimers.clear();
  };

  // Initialization: ensure the directory skeleton, recover every stored
  // run, then re-arm the live ones (two phases, so parent-child links
  // resolve regardless of recovery order).
  await ensureDirectory([ROOT]);
  await ensureDirectory([ROOT, CHARTS]);
  await ensureDirectory([ROOT, RUNS]);
  const runIds = await E(powers).list(ROOT, RUNS);
  for (const runId of runIds) {
    // eslint-disable-next-line no-await-in-loop
    await recoverRun(runId);
  }
  for (const engine of engines.values()) {
    if (!engine.fold.done) {
      engine
        .rearm()
        .catch(error =>
          console.error(
            `workflow run ${engine.runId}: recovery re-arm failed`,
            error,
          ),
        );
    }
  }
  watchMail().catch(() => {});
  if (context !== undefined) {
    E(context)
      .whenCancelled()
      .catch(() => {})
      .then(() => stop());
  }

  const service = makeExo('WorkflowService', WorkflowServiceInterface, {
    install: async chart => {
      const resolved = await resolveChartRefs(chart, loadInstalledChart);
      assertChart(resolved);
      const key = chartKeyFor(resolved);
      await E(powers).storeValue(resolved, [ROOT, CHARTS, key]);
      return key;
    },
    charts: async () => {
      const names = await E(powers).list(ROOT, CHARTS);
      const installed = [];
      for (const key of names) {
        // eslint-disable-next-line no-await-in-loop
        const chart = await E(powers).lookup([ROOT, CHARTS, key]);
        installed.push(
          harden({ key, name: chart.name, version: chart.version }),
        );
      }
      return harden(installed);
    },
    start: async (chartOrKey, options = {}) => {
      const engine = await startRun(chartOrKey, options);
      return harden({
        runId: engine.runId,
        run: engine.runFacet,
        control: engine.controlFacet,
      });
    },
    run: async runId => getEngine(runId).runFacet,
    control: async runId => getEngine(runId).controlFacet,
    list: async () =>
      harden([...engines.values()].map(engine => engine.summary())),
    followRuns: async () => {
      async function* summaries() {
        const subscription = runsTopic.subscribe();
        for (const engine of [...engines.values()]) {
          yield engine.summary();
        }
        yield* subscription;
      }
      return readerFromIterator(summaries());
    },
    help: () =>
      `Durable workflow service: install(chart), charts(), start(chartOrKey, { params, endowments }), run(runId), control(runId), list(), followRuns()`,
  });

  return harden({ service, stop, startRun, engines });
};
harden(makeWorkflowService);

// #endregion
