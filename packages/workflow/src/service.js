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
 *   unsettled invokes under the same identity; the run-qualified key
 *   `${runId}:${effectId}` is passed to the target as its final argument
 *   for deduplication (globally unique, since bare effect ids repeat
 *   across runs sharing an endowment).
 * - `after`: re-armed from the journaled absolute deadline; past-due
 *   deadlines fire immediately.
 * - `spawn`: children are runs in the same store and recover
 *   independently; parent linkage is re-derived from the parent's
 *   pending spawn records.
 */

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { makeTagged, passStyleOf, getTag } from '@endo/pass-style';
import { mustMatch } from '@endo/patterns';

import {
  assertChart,
  chartDiagnostics,
  engineEventTypes,
  initialStep,
  transition,
  exitEffects,
} from './machine.js';
import {
  applyEntry,
  initialFoldState,
  foldJournal,
  effectRecordsFor,
  canonicalStringify,
  hashEntry,
  verifyJournalChain,
  GENESIS_HASH,
  MAX_ENCODING_DEPTH,
} from './journal.js';
import { makeSerialJobs } from './serial-jobs.js';
import { makeChangeTopic } from './topic.js';
import {
  WorkflowServiceInterface,
  WorkflowRunInterface,
  WorkflowControlInterface,
  WorkflowPortInterface,
  WorkflowFactoryInterface,
} from './interfaces.js';

const { entries, keys, fromEntries } = Object;
const { isArray } = Array;

const ROOT = 'workflow';
const CHARTS = 'charts';
const RUNS = 'runs';
const FACTORIES = 'factories';
const ENDOWMENTS = 'endowments';
const ANSWERS = 'answers';
const REFS = 'refs';
const CHART_NAME = 'chart';
const FACTORY_RECORD = 'record';
const FACTORY_PARAMS = 'params';

/** Cap on engine-generated event cascades per external trigger. */
const MAX_CASCADE_DEPTH = 64;
/** Attempts to find our own mailbox copy of a just-sent ask. */
const CORRELATION_SCAN_ATTEMPTS = 8;
const CORRELATION_SCAN_DELAY_MS = 50;
/** Journal a state snapshot every this many entries. */
const SNAPSHOT_EVERY = 64;

const DECIMAL_NAME = /^(0|[1-9][0-9]*)$/;
const CHART_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
const REF_ALIAS = /^ref-(0|[1-9][0-9]*)$/;

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

  // #region redaction

  /**
   * Make a per-run redactor: deep-replace remotables with `ref-<n>`
   * alias strings, durably storing each capability at the run's
   * `refs/ref-<n>` pet name — so journal entries are capability-free
   * data (enforced by the hash chain's `canonicalStringify`), the
   * audit log stays legible to any observer, and the capability itself
   * remains recoverable by the control holder via `resolveRef` (a
   * journaled `admin` action). Promises redact to the marker string
   * `'<promise>'` and are not stored — an unresolved promise inside a
   * settlement is not durable evidence of anything.
   *
   * Tagged values (patterns, copySets) are walked and rebuilt only when
   * their payload contained a capability.
   *
   * @param {object} options
   * @param {string} options.runId
   * @param {number} options.initialNextRef
   */
  const makeRedactor = ({ runId, initialNextRef }) => {
    let nextRef = initialNextRef;
    const redact = async value => {
      await null;
      // Defensive: values arrive from arbitrary callers; freeze before
      // the passStyleOf walk.
      harden(value);
      /** @type {{ alias: string, cap: any }[]} */
      const captured = [];
      /** @type {(v: any, depth: number) => any} */
      const walk = (v, depth) => {
        depth <= MAX_ENCODING_DEPTH ||
          Fail`value exceeds redaction depth ${q(MAX_ENCODING_DEPTH)}`;
        if (v === null || typeof v !== 'object') {
          if (typeof v === 'function') {
            // A far function is a remotable.
            const alias = `ref-${nextRef}`;
            nextRef += 1;
            captured.push({ alias, cap: v });
            return alias;
          }
          return v;
        }
        const style = passStyleOf(v);
        if (style === 'remotable') {
          const alias = `ref-${nextRef}`;
          nextRef += 1;
          captured.push({ alias, cap: v });
          return alias;
        }
        if (style === 'promise') {
          return '<promise>';
        }
        if (style === 'copyArray') {
          const mapped = v.map(member => walk(member, depth + 1));
          return mapped.some((member, i) => member !== v[i])
            ? harden(mapped)
            : v;
        }
        if (style === 'copyRecord') {
          let changed = false;
          const mapped = fromEntries(
            entries(v).map(([name, member]) => {
              const next = walk(member, depth + 1);
              if (next !== member) {
                changed = true;
              }
              return [name, next];
            }),
          );
          return changed ? harden(mapped) : v;
        }
        if (style === 'tagged') {
          const payload = walk(v.payload, depth + 1);
          return payload !== v.payload ? makeTagged(getTag(v), payload) : v;
        }
        if (style === 'error') {
          // An error's aux data (cause, AggregateError errors) can carry
          // capabilities too; rebuild the error around redacted aux.
          const error = /** @type {Error & { cause?: any, errors?: any }} */ (
            v
          );
          const cause =
            error.cause === undefined
              ? undefined
              : walk(error.cause, depth + 1);
          const errorList =
            error.errors === undefined
              ? undefined
              : walk(error.errors, depth + 1);
          if (cause === error.cause && errorList === error.errors) {
            return v;
          }
          const rebuilt = Error(
            error.message,
            ...(cause !== undefined ? [{ cause }] : []),
          );
          Object.defineProperty(rebuilt, 'name', { value: error.name });
          if (errorList !== undefined) {
            Object.defineProperty(rebuilt, 'errors', { value: errorList });
          }
          return harden(rebuilt);
        }
        return v;
      };
      const redacted = walk(value, 0);
      for (const { alias, cap } of captured) {
        // eslint-disable-next-line no-await-in-loop
        await E(powers).storeValue(cap, runPath(runId, REFS, alias));
      }
      return harden(redacted);
    };
    return redact;
  };

  /**
   * Assert a value is capability-free data (throws on remotables and
   * promises), by way of the canonical journal encoding.
   *
   * @param {any} value
   * @param {string} label
   */
  const assertDataOnly = (value, label) => {
    try {
      canonicalStringify(value);
    } catch {
      throw Fail`${q(label)} must be capability-free data`;
    }
  };

  // #endregion

  // #region run engine

  /**
   * @param {object} options
   * @param {string} options.runId
   * @param {any} options.chart
   * @param {import('./journal.js').FoldState} options.fold
   * @param {number} [options.initialNextRef] - next `ref-<n>` alias
   *   ordinal (recovered from the run's `refs/` directory)
   * @param {string} [options.tailHash] - hash of the last stored journal
   *   entry (`GENESIS_HASH` for a fresh run)
   * @param {{ ok: boolean, badSeq?: bigint } | undefined} [options.integrity] -
   *   set when recovery found the journal hash chain broken
   */
  const makeRunEngine = ({
    runId,
    chart,
    fold,
    initialNextRef = 0,
    tailHash = GENESIS_HASH,
    integrity = undefined,
  }) => {
    const jobs = makeSerialJobs();
    const topic = makeChangeTopic();
    /** @type {Map<string, any>} */
    const timers = new Map();
    /** @type {Set<string>} */
    const attachedAsks = new Set();
    /** @type {string} */
    let tail = tailHash;

    /** @type {any} */
    const engine = {};
    engine.runId = runId;
    engine.chart = chart;
    engine.fold = fold;
    const redact = makeRedactor({ runId, initialNextRef });
    engine.redact = redact;

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
        ...(fold.factory !== undefined ? { factory: fold.factory } : {}),
        ...(integrity !== undefined ? { integrity } : {}),
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

    // Append one journal entry: hash (which also enforces that the entry
    // is capability-free), store, fold, then publish. `prev` chains each
    // entry to the hash of the one before it.
    const append = async fields => {
      const entry = harden({
        seq: fold.nextSeq,
        at: isoNow(),
        prev: tail,
        ...fields,
      });
      const hash = hashEntry(entry);
      await E(powers).storeValue(entry, runPath(runId, String(entry.seq)));
      applyEntry(fold, entry);
      tail = hash;
      topic.publisher.next(entry);
      runsTopic.publisher.next(summary());
      return entry;
    };

    // Snapshot cadence is a delta, not a modulus: steps append several
    // entries at a time and would stride over exact multiples.
    let lastSnapshotAt = fold.nextSeq;
    const maybeSnapshot = async () => {
      if (
        fold.done ||
        fold.paused ||
        fold.queuedEvents.size > 0 ||
        fold.pendingInternals.size > 0 ||
        fold.nextSeq - lastSnapshotAt < BigInt(SNAPSHOT_EVERY)
      ) {
        return;
      }
      await append({
        kind: 'snapshot',
        by: 'engine',
        configuration: fold.configuration,
        context: fold.context,
        pending: harden([...fold.pending.values()]),
        internals: harden([...fold.pendingInternals]),
      });
      lastSnapshotAt = fold.nextSeq;
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
     * Step an envelope through the kernel and journal the result as ONE
     * atomic entry — the event, its `settles` half when it is an effect
     * settlement, the `fired` step result (with its raised internal
     * envelopes as id'd delivery obligations), and any `terminal`
     * outcome all commit in a single write, so no crash can separate a
     * durable cause from its durable consequence. Then perform the
     * effects and schedule the cascade. Runs inside the run's serial
     * queue.
     *
     * Fail-loud policy: a kernel throw fails the run, and so does a
     * settlement envelope (an ask answer, invoke result, or child-run
     * outcome) that fires no transition — a lost answer is a wedged run,
     * and a failed run is visible where a wedge is silent. Compensation
     * (exit-effect) settlements are exempt: their owner state is dead by
     * design. Timer emissions and external signals may fall through
     * guards without firing; the journaled no-fire event is their audit
     * trail.
     *
     * @param {any} envelope
     * @param {number} depth
     * @param {{ replays?: bigint, settles?: any }} [options]
     */
    const stepEnvelope = async (envelope, depth, options = {}) => {
      await null;
      const { replays, settles } = options;
      const base = harden({
        kind: 'event',
        by: envelope.by,
        event: envelope,
        ...(replays !== undefined ? { replays } : {}),
        ...(settles !== undefined ? { settles } : {}),
      });
      const machineState = {
        configuration: fold.configuration,
        context: fold.context,
        params: fold.params,
      };
      let result;
      try {
        result = transition(chart, machineState, envelope);
      } catch (error) {
        await append({
          ...base,
          terminal: harden({
            outcome: 'failed',
            reason: `kernel step threw: ${/** @type {Error} */ (error).message}`,
          }),
        });
        settleTerminal('failed');
        return;
      }
      if (!result.fired) {
        const { by } = envelope;
        const settlement =
          envelope.effectId !== undefined &&
          envelope.compensation !== true &&
          typeof by === 'string' &&
          (by.startsWith('ask:') || by.startsWith('invoke:') || by === 'spawn');
        if (settlement) {
          await append({
            ...base,
            terminal: harden({
              outcome: 'failed',
              reason: `unhandled '${envelope.type}' settlement of effect ${envelope.effectId} at ${isArray(envelope.path) ? envelope.path.join('.') : '?'}`,
            }),
          });
          settleTerminal('failed');
        } else {
          await append(base);
        }
        return;
      }
      const effects = effectRecordsFor(fold.nextSeq, result.effects);
      const internals = harden(
        result.internalEvents.map((internal, index) => ({
          internalId: `${fold.nextSeq}-i${index}`,
          envelope: harden({ ...internal, by: 'engine' }),
        })),
      );
      await append({
        ...base,
        fired: harden({
          configuration: result.configuration,
          context: result.context,
          exited: result.exited,
          effects,
          ...(internals.length > 0 ? { internals } : {}),
        }),
        ...(result.terminal !== undefined
          ? {
              terminal: harden({
                outcome: 'completed',
                ...(result.terminal.output !== undefined
                  ? { output: result.terminal.output }
                  : {}),
              }),
            }
          : {}),
      });
      if (result.terminal !== undefined) {
        settleTerminal('completed');
        return;
      }
      clearStaleSideEffects();
      await dispatchEffects(effects, depth);
      for (const { internalId, envelope: internalEnvelope } of internals) {
        scheduleEnvelope(
          harden({ ...internalEnvelope, at: isoNow(), delivers: internalId }),
          depth + 1,
        );
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
    // Refused on a settled run — a seq that names no entry would be a
    // lie.
    engine.inject = (envelope, depth = 0) => {
      !fold.done ||
        Fail`workflow run ${q(runId)} is ${q(fold.outcome)}; no further events`;
      !stopped || Fail`workflow service is stopped`;
      return jobs.enqueue(() => processEnvelope(envelope, depth));
    };

    // Settle a pending effect; stale and duplicate settlements drop. The
    // settled value is redacted before it touches the journal (any
    // remotable becomes a durable `ref-<n>` alias) and pre-flighted
    // against the canonical encoding, so a value the journal must
    // refuse (too deep, unencodable) becomes a failed settlement
    // instead of a silently rejected append. The settlement and the
    // transition it fires commit as ONE entry.
    const settleEffect = (effectId, status, value) =>
      jobs.enqueue(async () => {
        await null;
        const record = fold.pending.get(effectId);
        if (stopped || fold.done || record === undefined) {
          return;
        }
        let effectiveStatus = status;
        let redacted;
        try {
          redacted = await redact(value);
          canonicalStringify(redacted);
        } catch (error) {
          effectiveStatus = 'failed';
          redacted = `settlement value rejected: ${/** @type {Error} */ (error).message}`;
        }
        clearTimer(effectId);
        clearStaleSideEffects();
        const { effect } = record;
        const type =
          effectiveStatus === 'fulfilled'
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
        const settles = harden({
          effectId,
          status: effectiveStatus,
          ...(effectiveStatus === 'fulfilled'
            ? { value: redacted }
            : { reason: redacted }),
        });
        const envelope = harden({
          type,
          value:
            effectiveStatus === 'fulfilled'
              ? redacted
              : harden({ reason: redacted }),
          by,
          at: isoNow(),
          path: record.path,
          effectId,
          ...(record.exit === true ? { compensation: true } : {}),
        });
        if (fold.paused) {
          await append({ kind: 'event', by, event: envelope, settles });
          return;
        }
        await stepEnvelope(envelope, 0, { settles });
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

    // After an `after` deadline elapses, emit its declared event; the
    // settlement and the step commit as one entry.
    const fireAfter = record =>
      jobs.enqueue(async () => {
        await null;
        if (stopped || fold.done || !fold.pending.has(record.effectId)) {
          return;
        }
        const settles = harden({
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
          await append({
            kind: 'event',
            by: 'engine',
            event: envelope,
            settles,
          });
          return;
        }
        await stepEnvelope(envelope, 0, { settles });
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
      // The trailing idempotency key is run-qualified: effect ids are
      // `${seq}-${index}`, unique within one run only, and an endowment is
      // typically shared by many runs (factories bind one target for all
      // their runs), so the bare effect id would collide across runs.
      // `${runId}:${effectId}` is globally unique and stable across
      // recovery re-dispatch — the same contract the ask path's
      // `[workflow ${runId} ${effectId}]` marker already keeps.
      const idempotencyKey = `${runId}:${effectId}`;
      E(powers)
        .lookup(targetPath)
        .then(target =>
          E(target)[effect.method](...(effect.args ?? []), idempotencyKey),
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
      // The child's run id is a pure function of the parent and the
      // effect, so re-dispatch after a crash between child creation and
      // the parent's `spawned` linkage ADOPTS the existing child (which
      // recovery already revived) instead of minting a duplicate.
      const childRunId = `${runId}-c${effectId}`;
      let child = engines.get(childRunId);
      if (child === undefined) {
        const endowmentNames = effect.endowments ?? [];
        /** @type {Record<string, any>} */
        const childEndowments = {};
        for (const name of endowmentNames) {
          // eslint-disable-next-line no-await-in-loop
          childEndowments[name] = await E(powers).lookup(
            runPath(runId, ENDOWMENTS, name),
          );
        }
        child = await startRun(effect.chart, {
          params: effect.params ?? harden({}),
          endowments: harden(childEndowments),
          runId: childRunId,
        });
      }
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
              // Discharges the delivery obligation the effect record
              // opened in the fold.
              delivers: record.effectId,
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

    engine.start = (params, endowmentNames, factory) =>
      jobs.enqueue(async () => {
        const result = initialStep(chart, { params });
        const effects = effectRecordsFor(fold.nextSeq, result.effects);
        const internals = harden(
          result.internalEvents.map((internal, index) => ({
            internalId: `${fold.nextSeq}-i${index}`,
            envelope: harden({ ...internal, by: 'engine' }),
          })),
        );
        await append({
          kind: 'started',
          by: 'control',
          chartName: chart.name,
          chartVersion: chart.version,
          ...(factory !== undefined ? { factory } : {}),
          params,
          endowmentNames,
          configuration: result.configuration,
          context: result.context,
          effects,
          ...(internals.length > 0 ? { internals } : {}),
          ...(result.terminal !== undefined
            ? {
                terminal: harden({
                  outcome: 'completed',
                  ...(result.terminal.output !== undefined
                    ? { output: result.terminal.output }
                    : {}),
                }),
              }
            : {}),
        });
        if (result.terminal !== undefined) {
          settleTerminal('completed');
          return;
        }
        await dispatchEffects(effects, 0);
        for (const { internalId, envelope } of internals) {
          scheduleEnvelope(
            harden({ ...envelope, at: isoNow(), delivers: internalId }),
            1,
          );
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

    // Replay queued events in seq order; a terminal outcome mid-replay
    // (a fail-loud settlement, say) stops the replay — nothing steps
    // past the end of a run.
    const drainQueuedEvents = async () => {
      await null;
      const queued = [...fold.queuedEvents.entries()].sort(([a], [b]) => {
        const left = BigInt(a);
        const right = BigInt(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      for (const [seqName, envelope] of queued) {
        if (fold.done) {
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await stepEnvelope(envelope, 0, { replays: BigInt(seqName) });
      }
    };

    engine.resume = () =>
      jobs.enqueue(async () => {
        if (fold.done || !fold.paused) {
          return;
        }
        await append({ kind: 'resumed', by: 'control' });
        await drainQueuedEvents();
      });

    /**
     * Re-arm the world half of every pending obligation after recovery:
     * drain events stranded by a crash mid-resume, re-deliver journaled
     * but undelivered engine events, and re-attach every pending
     * effect.
     */
    engine.rearm = () =>
      jobs.enqueue(async () => {
        await null;
        if (fold.done) {
          return;
        }
        if (!fold.paused && fold.queuedEvents.size > 0) {
          // A crash between `resumed` and the last replay leaves the
          // run unpaused with queued events nothing would ever drain.
          await drainQueuedEvents();
          if (fold.done) {
            return;
          }
        }
        for (const [id, envelope] of [...fold.pendingInternals]) {
          scheduleEnvelope(
            harden({ ...envelope, at: isoNow(), delivers: id }),
            0,
          );
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
            if (
              correlation !== undefined &&
              typeof correlation.deadline === 'number' &&
              Number.isFinite(correlation.deadline)
            ) {
              armAfterTimer(record, correlation.deadline);
            } else {
              // No journaled deadline (crash before the dispatch entry)
              // or a non-numeric one (torn or tampered): recompute and
              // re-journal rather than arming a NaN timer. An `ms`
              // deadline restarts its full duration from now — the
              // original was never committed.
              const deadline = afterDeadlineOf(effect);
              // eslint-disable-next-line no-await-in-loop
              await append({
                kind: 'effect-dispatched',
                by: 'engine',
                effectId,
                correlation: harden({ deadline }),
              });
              armAfterTimer(record, deadline);
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
      const start = from < 0n ? 0n : from;
      const last = to === undefined || to > fold.nextSeq ? fold.nextSeq : to;
      const journal = [];
      for (let seq = start; seq < last; seq += 1n) {
        // eslint-disable-next-line no-await-in-loop
        journal.push(await E(powers).lookup(runPath(runId, String(seq))));
      }
      return harden(journal);
    };

    /** @param {bigint} rawSince */
    async function* followEntries(rawSince) {
      await null;
      // Subscribe before replaying so nothing falls in the gap, then
      // dedupe the overlap by seq — the snapshot-then-tail idiom with a
      // real cursor. The stream closes at the run's terminal entry;
      // post-terminal `admin` entries (resolveRef audit records) reach
      // later readers via replay or `journal()`, not live followers.
      const since = rawSince < 0n ? 0n : rawSince;
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
            entry.terminal !== undefined ||
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
        ...(fold.factory !== undefined ? { factory: fold.factory } : {}),
        ...(integrity !== undefined ? { integrity } : {}),
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
              ...(record.exit === true ? { exit: true } : {}),
              ...(record.since !== undefined ? { since: record.since } : {}),
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

    // A human-oriented account of what the run is waiting on right now.
    const explain = () => {
      const waiting = [...fold.pending.values()].map(record => {
        const { effect, effectId, path, since, correlation } = record;
        /** @type {string} */
        let detail;
        if (effect.kind === 'ask') {
          const description =
            effect.what?.description ?? effect.form?.description;
          detail = `ask '${effect.to}': ${description}${
            correlation === undefined ? ' (not yet delivered)' : ''
          }`;
        } else if (effect.kind === 'invoke') {
          detail = `invoke '${effect.target}.${effect.method}'${
            correlation === undefined && record.since === undefined
              ? ''
              : ' (dispatched)'
          }`;
        } else if (effect.kind === 'after') {
          detail =
            correlation === undefined
              ? 'timer (not yet armed)'
              : `timer fires at ${new Date(correlation.deadline).toISOString()}`;
        } else if (effect.kind === 'spawn') {
          detail =
            record.childRunId === undefined
              ? 'child run (starting)'
              : `child run ${record.childRunId}`;
        } else {
          detail = effect.kind;
        }
        if (record.exit === true) {
          // Compensation at an exited path: its settlement is welcome
          // but nothing waits on it.
          detail = `compensation, not awaited: ${detail}`;
        }
        return harden({
          effectId,
          kind: effect.kind,
          path,
          ...(record.exit === true ? { exit: true } : {}),
          ...(since !== undefined ? { since } : {}),
          detail,
        });
      });
      return harden({
        runId,
        chartName: chart.name,
        chartVersion: chart.version,
        ...(fold.factory !== undefined ? { factory: fold.factory } : {}),
        ...(integrity !== undefined ? { integrity } : {}),
        state:
          fold.configuration === undefined
            ? undefined
            : fold.configuration.state,
        paused: fold.paused,
        done: fold.done,
        ...(fold.outcome !== undefined ? { outcome: fold.outcome } : {}),
        ...(fold.reason !== undefined ? { reason: fold.reason } : {}),
        queuedEvents: fold.queuedEvents.size,
        waiting,
      });
    };

    /** @type {Map<string, any>} */
    const ports = new Map();
    // Event types the engine itself can produce for this chart —
    // internal joins, settlements, timer and emit types. A port may not
    // impersonate the engine or another participant's settlement.
    /** @type {string[] | undefined} */
    let reservedTypes;
    const reservedEventTypes = () => {
      if (reservedTypes === undefined) {
        reservedTypes = engineEventTypes(chart);
      }
      return reservedTypes;
    };

    // Observation only: status, journal, chart. Freely shareable — holds
    // no way to move the run or to reach redacted capabilities.
    engine.runFacet = makeExo('WorkflowRun', WorkflowRunInterface, {
      status: async () => status(),
      explain: async () => explain(),
      follow: async ({ since = 0n } = {}) =>
        readerFromIterator(followEntries(since)),
      journal: async ({ from = 0n, to = undefined } = {}) =>
        readEntries(from, to),
      chart: async () => chart,
      help: () =>
        `Workflow run ${runId} of ${chart.name} v${chart.version} (read-only): status(), explain(), follow({ since }), journal({ from, to }), chart()`,
    });

    engine.controlFacet = makeExo('WorkflowControl', WorkflowControlInterface, {
      signal: async event => {
        const redacted = await redact(event);
        return engine.inject(
          harden({ ...redacted, by: 'control', at: isoNow() }),
        );
      },
      pause: async () => engine.pause(),
      resume: async () => engine.resume(),
      cancel: async reason => engine.cancel(reason),
      port: async role => {
        const pattern =
          chart.ports?.[role] ??
          Fail`chart ${q(chart.name)} declares no port ${q(role)}`;
        let port = ports.get(role);
        if (port === undefined) {
          port = makeExo('WorkflowPort', WorkflowPortInterface, {
            submit: async event => {
              mustMatch(event, pattern, `port ${role}`);
              !reservedEventTypes().includes(event.type) ||
                Fail`port ${q(role)} may not submit engine event type ${q(event.type)}`;
              const redacted = await redact(event);
              // Routing, settlement, and delivery marks are the
              // engine's, not a participant's, to assert.
              const cleaned = fromEntries(
                entries(redacted).filter(
                  ([name]) =>
                    name !== 'path' &&
                    name !== 'effectId' &&
                    name !== 'compensation' &&
                    name !== 'delivers',
                ),
              );
              return engine.inject(
                harden({ ...cleaned, by: `port:${role}`, at: isoNow() }),
              );
            },
            help: () =>
              `submit(event) -> seq: inject a pattern-checked event as port ${role}`,
          });
          ports.set(role, port);
        }
        return port;
      },
      resolveRef: async alias => {
        REF_ALIAS.test(alias) || Fail`not a ref alias (ref-<n>): ${q(alias)}`;
        const cap = await E(powers).maybeLookup(runPath(runId, REFS, alias));
        cap !== undefined || Fail`run ${q(runId)} has no ref ${q(alias)}`;
        // Journal the access before releasing the capability.
        await jobs.enqueue(() =>
          append({
            kind: 'admin',
            by: 'control',
            action: 'resolve-ref',
            detail: alias,
          }),
        );
        return cap;
      },
      help: () =>
        `Control for workflow run ${runId}: signal(event), pause(), resume(), cancel(reason?), port(role), resolveRef(alias)`,
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
    {
      params = harden({}),
      endowments = harden({}),
      factory = undefined,
      runId: explicitRunId = undefined,
    } = {},
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
    // Charts are data; a capability embedded in one would leak through
    // the freely-shareable run facet's `chart()`.
    assertDataOnly(chart, 'chart');
    chartKeyFor(chart);
    // Spawn passes a deterministic child id so re-dispatch after a
    // crash adopts rather than duplicates; the directories are ensured,
    // not created, for the same reason.
    const runId = explicitRunId ?? `r-${makeId()}`;
    await ensureDirectory([ROOT, RUNS, runId]);
    await ensureDirectory(runPath(runId, ANSWERS));
    await ensureDirectory(runPath(runId, ENDOWMENTS));
    await ensureDirectory(runPath(runId, REFS));
    await E(powers).storeValue(chart, runPath(runId, CHART_NAME));
    const engine = makeRunEngine({ runId, chart, fold: initialFoldState() });
    // Params are redacted like any other journaled value, then
    // pre-validated with a pure kernel step before the run registers, so
    // a bad start throws to the caller instead of minting a broken run
    // (recovery skips the empty directory such a throw leaves behind).
    const redactedParams = await engine.redact(params);
    initialStep(chart, { params: redactedParams });
    const endowmentNames = harden(keys(endowments).sort());
    for (const name of endowmentNames) {
      // eslint-disable-next-line no-await-in-loop
      await E(powers).storeValue(
        endowments[name],
        runPath(runId, ENDOWMENTS, name),
      );
    }
    engines.set(runId, engine);
    await engine.start(redactedParams, endowmentNames, factory);
    return engine;
  };

  const recoverRun = async runId => {
    const chart = await E(powers).maybeLookup(runPath(runId, CHART_NAME));
    const journal = await readJournal(runId);
    if (chart === undefined || journal.length === 0) {
      // An aborted mint: `startRun` threw between directory creation and
      // the first journal entry. Nothing durable names this run; skip it
      // rather than reviving a phantom.
      console.error(
        `workflow run ${runId}: skipping aborted (empty) run directory`,
      );
      return undefined;
    }
    const chain = verifyJournalChain(journal);
    if (!chain.ok) {
      // Post-recovery appends chain from the pre-break tail, so every
      // later entry re-flags as broken — the integrity mark is sticky by
      // construction until the journal is repaired.
      console.error(
        `workflow run ${runId}: journal hash chain broken at seq ${chain.badSeq}`,
      );
    }
    const fold = foldJournal(journal);
    let initialNextRef = 0;
    const hasRefs = await E(powers).has(...runPath(runId, REFS));
    if (hasRefs) {
      /** @type {string[]} */
      const names = await E(powers).list(...runPath(runId, REFS));
      for (const name of names) {
        const found = REF_ALIAS.exec(name);
        if (found !== null) {
          initialNextRef = Math.max(initialNextRef, Number(found[1]) + 1);
        }
      }
    } else {
      await E(powers).makeDirectory(runPath(runId, REFS));
    }
    const engine = makeRunEngine({
      runId,
      chart,
      fold,
      initialNextRef,
      tailHash: chain.tail,
      integrity: chain.ok
        ? undefined
        : harden({ ok: false, badSeq: chain.badSeq }),
    });
    engines.set(runId, engine);
    return engine;
  };

  const getEngine = runId =>
    engines.get(runId) ?? Fail`no workflow run ${q(runId)}`;

  // #region factories

  const factoryPath = (fid, ...rest) => [ROOT, FACTORIES, fid, ...rest];

  const loadFactoryRecord = async fid => {
    const record = await E(powers).maybeLookup(
      factoryPath(fid, FACTORY_RECORD),
    );
    record !== undefined || Fail`no workflow factory ${q(fid)}`;
    return record;
  };

  /**
   * Create a durable factory: a revocable grant to start runs of one
   * chart with pre-bound params (capability-free data) and endowments
   * (the capability channel). Derived factories record their parent so
   * revocation can cascade.
   *
   * @param {object} options
   * @param {any} options.chart - inline chart or installed chart key
   * @param {Record<string, any>} [options.params]
   * @param {Record<string, any>} [options.endowments]
   * @param {string} [options.parent]
   * @returns {Promise<string>} the factory id
   */
  const createFactory = async ({
    chart: chartOrKey,
    params = harden({}),
    endowments = harden({}),
    parent = undefined,
  }) => {
    await null;
    !stopped || Fail`workflow service is stopped`;
    let chart = chartOrKey;
    if (typeof chart === 'string') {
      chart = await loadInstalledChart(chart);
      chart !== undefined || Fail`no installed chart ${q(chartOrKey)}`;
    }
    chart = await resolveChartRefs(chart, loadInstalledChart);
    assertChart(chart);
    assertDataOnly(chart, 'chart');
    const { errors } = chartDiagnostics(chart);
    errors.length === 0 || Fail`chart has diagnostic errors: ${q(errors)}`;
    assertDataOnly(params, 'factory-bound params');
    const fid = `f-${makeId()}`;
    await E(powers).makeDirectory([ROOT, FACTORIES, fid]);
    await E(powers).makeDirectory(factoryPath(fid, ENDOWMENTS));
    await E(powers).storeValue(chart, factoryPath(fid, CHART_NAME));
    await E(powers).storeValue(params, factoryPath(fid, FACTORY_PARAMS));
    const endowmentNames = harden(keys(endowments).sort());
    for (const name of endowmentNames) {
      // eslint-disable-next-line no-await-in-loop
      await E(powers).storeValue(
        endowments[name],
        factoryPath(fid, ENDOWMENTS, name),
      );
    }
    const record = harden({
      fid,
      chartName: chart.name,
      chartVersion: chart.version,
      boundParamNames: harden(keys(params).sort()),
      endowmentNames,
      revoked: false,
      createdAt: isoNow(),
      ...(parent !== undefined ? { parent } : {}),
    });
    await E(powers).storeValue(record, factoryPath(fid, FACTORY_RECORD));
    return fid;
  };

  const loadFactoryBindings = async fid => {
    const record = await loadFactoryRecord(fid);
    !record.revoked || Fail`workflow factory ${q(fid)} is revoked`;
    const chart = await E(powers).lookup(factoryPath(fid, CHART_NAME));
    const boundParams = await E(powers).lookup(
      factoryPath(fid, FACTORY_PARAMS),
    );
    /** @type {Record<string, any>} */
    const boundEndowments = {};
    for (const name of record.endowmentNames) {
      // eslint-disable-next-line no-await-in-loop
      boundEndowments[name] = await E(powers).lookup(
        factoryPath(fid, ENDOWMENTS, name),
      );
    }
    return harden({ record, chart, boundParams, boundEndowments });
  };

  const assertNoOverlap = (record, params, endowments) => {
    for (const name of keys(params)) {
      !record.boundParamNames.includes(name) ||
        Fail`factory ${q(record.fid)} already binds param ${q(name)}`;
    }
    for (const name of keys(endowments)) {
      !record.endowmentNames.includes(name) ||
        Fail`factory ${q(record.fid)} already binds endowment ${q(name)}`;
    }
  };

  /** @type {Map<string, any>} */
  const factoryFacets = new Map();

  const revokeFactory = async (fid, reason) => {
    await null;
    // Collect this factory and every descendant by durable parent links.
    /** @type {string[]} */
    const fids = await E(powers).list(ROOT, FACTORIES);
    /** @type {Map<string, any>} */
    const records = new Map();
    for (const each of fids) {
      // eslint-disable-next-line no-await-in-loop
      const record = await E(powers).maybeLookup(
        factoryPath(each, FACTORY_RECORD),
      );
      if (record !== undefined) {
        records.set(each, record);
      }
    }
    records.has(fid) || Fail`no workflow factory ${q(fid)}`;
    const condemned = new Set([fid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [each, record] of records) {
        if (
          !condemned.has(each) &&
          record.parent !== undefined &&
          condemned.has(record.parent)
        ) {
          condemned.add(each);
          grew = true;
        }
      }
    }
    const revokedAt = isoNow();
    for (const each of condemned) {
      const record = records.get(each);
      if (!record.revoked) {
        // eslint-disable-next-line no-await-in-loop
        await E(powers).storeValue(
          harden({
            ...record,
            revoked: true,
            revokedAt,
            ...(reason !== undefined ? { revokedReason: reason } : {}),
          }),
          factoryPath(each, FACTORY_RECORD),
        );
      }
    }
    // Cancel every live run started through a condemned factory.
    for (const engine of [...engines.values()]) {
      if (!engine.fold.done && condemned.has(engine.fold.factory)) {
        engine
          .cancel(
            `factory ${engine.fold.factory} revoked${
              reason !== undefined ? `: ${reason}` : ''
            }`,
          )
          .catch(() => {});
      }
    }
  };

  /** @type {(fid: string) => any} */
  const factoryFacetFor = fid => {
    let facet = factoryFacets.get(fid);
    if (facet !== undefined) {
      return facet;
    }
    facet = makeExo('WorkflowFactory', WorkflowFactoryInterface, {
      start: async ({ params = harden({}), endowments = harden({}) } = {}) => {
        const { record, chart, boundParams, boundEndowments } =
          await loadFactoryBindings(fid);
        assertNoOverlap(record, params, endowments);
        const engine = await startRun(chart, {
          params: harden({ ...params, ...boundParams }),
          endowments: harden({ ...endowments, ...boundEndowments }),
          factory: fid,
        });
        // Close the start/revoke race: the revocation sweep cancels
        // every registered run of a condemned factory, and any run that
        // registered after the sweep re-reads the durable record here —
        // one side always sees the other.
        const recheck = await loadFactoryRecord(fid);
        if (recheck.revoked) {
          engine.cancel(`factory ${fid} revoked`).catch(() => {});
          throw Fail`workflow factory ${q(fid)} is revoked`;
        }
        // The starter through a factory observes; it does not control.
        return harden({ runId: engine.runId, run: engine.runFacet });
      },
      describe: async () => {
        const record = await loadFactoryRecord(fid);
        return record;
      },
      with: async ({ params = harden({}), endowments = harden({}) } = {}) => {
        const { record, chart, boundParams, boundEndowments } =
          await loadFactoryBindings(fid);
        assertNoOverlap(record, params, endowments);
        const derived = await createFactory({
          chart,
          params: harden({ ...boundParams, ...params }),
          endowments: harden({ ...boundEndowments, ...endowments }),
          parent: fid,
        });
        // Close the derive/revoke race: a parent revoked while the
        // derivation was in flight condemns the fresh child too (its
        // record may have been stored after the cascade's sweep).
        const recheck = await loadFactoryRecord(fid);
        if (recheck.revoked) {
          await revokeFactory(derived, `parent ${fid} revoked`);
          throw Fail`workflow factory ${q(fid)} is revoked`;
        }
        return factoryFacetFor(derived);
      },
      revoke: async reason => {
        await revokeFactory(fid, reason);
      },
      help: () =>
        `Workflow factory ${fid}: start({ params, endowments }) -> { runId, run } (observer only), describe(), with({ params, endowments }) -> narrower factory, revoke(reason?) (cascades to derived factories and their runs)`,
    });
    factoryFacets.set(fid, facet);
    return facet;
  };

  // #endregion

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
  await ensureDirectory([ROOT, FACTORIES]);
  const runIds = await E(powers).list(ROOT, RUNS);
  for (const runId of runIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await recoverRun(runId);
    } catch (error) {
      // One corrupt run (torn journal, seq gap) must not brick every
      // healthy run's recovery; the damaged journal stays on disk for
      // forensics.
      console.error(`workflow run ${runId}: recovery failed`, error);
    }
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

  const resolveChartOrKey = async chartOrKey => {
    await null;
    let chart = chartOrKey;
    if (typeof chart === 'string') {
      chart = await loadInstalledChart(chart);
      chart !== undefined || Fail`no installed chart ${q(chartOrKey)}`;
    }
    const resolved = await resolveChartRefs(chart, loadInstalledChart);
    assertChart(resolved);
    return resolved;
  };

  const service = makeExo('WorkflowService', WorkflowServiceInterface, {
    install: async chart => {
      const resolved = await resolveChartRefs(chart, loadInstalledChart);
      assertChart(resolved);
      assertDataOnly(resolved, 'chart');
      const { errors } = chartDiagnostics(resolved);
      errors.length === 0 || Fail`chart has diagnostic errors: ${q(errors)}`;
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
    diagnose: async chartOrKey => {
      const resolved = await resolveChartOrKey(chartOrKey);
      return chartDiagnostics(resolved);
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
    makeFactory: async ({ chart, params, endowments }) => {
      const fid = await createFactory({ chart, params, endowments });
      return harden({ fid, factory: factoryFacetFor(fid) });
    },
    factory: async fid => {
      await loadFactoryRecord(fid);
      return factoryFacetFor(fid);
    },
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
      `Durable workflow service: install(chart), charts(), diagnose(chartOrKey), start(chartOrKey, { params, endowments }), run(runId), control(runId), makeFactory({ chart, params, endowments }), factory(fid), list(), followRuns()`,
  });

  return harden({ service, stop, startRun, engines });
};
harden(makeWorkflowService);

// #endregion
