// @ts-check

/**
 * The run journal: entry shapes and the fold that reproduces a run's
 * state from its entries.
 *
 * The journal is both the durability substrate and the audit log. Every
 * entry is a passable record with the common envelope
 * `{ seq, at, by, kind, ... }`; the run's current state is
 * `foldJournal(entries)`, and the live engine applies the same
 * `applyEntry` to the same state shape as it appends, so a recovered run
 * and a live run can never disagree.
 *
 * One deliberate deviation from the design document's first sketch: the
 * `event` and `fired` entries are coalesced into a single `event` entry
 * whose optional `fired` payload carries the step result. The kernel is
 * synchronous, so the step is computed before the append and the two
 * halves commit in one write — there is no crash window in which an
 * event was durably received but its transition lost.
 *
 * Entry kinds:
 *
 * | kind               | payload                                                       |
 * | ------------------ | ------------------------------------------------------------- |
 * | `started`          | chartName, chartVersion, params, endowmentNames,              |
 * |                    | configuration, context, effects                               |
 * | `event`            | event envelope; optional `fired` `{ configuration, context,   |
 * |                    | exited, effects }`; optional `replays` (seq of a queued event  |
 * |                    | being stepped after `resumed`)                                |
 * | `effect-dispatched`| effectId, correlation? (mail message ids, responseName, or an |
 * |                    | absolute timer deadline)                                      |
 * | `effect-settled`   | effectId, status `fulfilled` \| `failed`, value? / reason?    |
 * | `spawned`          | effectId, childRunId                                          |
 * | `paused`/`resumed` | —                                                             |
 * | `cancelled`        | reason?                                                       |
 * | `completed`        | output?                                                       |
 * | `failed`           | reason                                                        |
 * | `snapshot`         | configuration, context, pending (replay shortener; the engine |
 * |                    | only snapshots at rest — not paused, no queued events)        |
 */

import { Fail, q } from '@endo/errors';

export const JOURNAL_KINDS = harden([
  'started',
  'event',
  'effect-dispatched',
  'effect-settled',
  'spawned',
  'paused',
  'resumed',
  'cancelled',
  'completed',
  'failed',
  'snapshot',
]);

/**
 * True when `prefix` is a (non-strict) path prefix of `path`.
 *
 * @param {string[]} prefix
 * @param {string[]} path
 */
export const isPathPrefix = (prefix, path) =>
  prefix.length <= path.length &&
  prefix.every((segment, i) => segment === path[i]);
harden(isPathPrefix);

/**
 * Assign effect identifiers to a step result's effect descriptions. The
 * id is derived from the journal seq of the entry that introduces the
 * effect, so ids are stable across replay and safe as idempotency keys
 * and pet-name segments.
 *
 * @param {bigint} seq
 * @param {{ path: string[], effect: any }[]} effects
 * @returns {{ effectId: string, path: string[], effect: any }[]}
 */
export const effectRecordsFor = (seq, effects) =>
  harden(
    effects.map(({ path, effect }, index) => ({
      effectId: `${seq}-${index}`,
      path,
      effect,
    })),
  );
harden(effectRecordsFor);

/**
 * @typedef {object} FoldState
 * @property {bigint} nextSeq
 * @property {string | undefined} chartName
 * @property {number | undefined} chartVersion
 * @property {Record<string, any>} params
 * @property {string[]} endowmentNames
 * @property {any} configuration
 * @property {Record<string, any>} context
 * @property {Map<string, { effectId: string, path: string[], effect: any, correlation?: any }>} pending
 * @property {boolean} paused
 * @property {Map<string, any>} queuedEvents - envelopes journaled while
 *   paused and not yet stepped, keyed by decimal seq
 * @property {boolean} done
 * @property {'completed' | 'cancelled' | 'failed' | undefined} outcome
 * @property {any} output
 * @property {any} reason
 * @property {string | undefined} startedAt
 * @property {string | undefined} updatedAt
 */

/** @returns {FoldState} */
export const initialFoldState = () => ({
  nextSeq: 0n,
  chartName: undefined,
  chartVersion: undefined,
  params: harden({}),
  endowmentNames: harden([]),
  configuration: undefined,
  context: harden({}),
  pending: new Map(),
  paused: false,
  queuedEvents: new Map(),
  done: false,
  outcome: undefined,
  output: undefined,
  reason: undefined,
  startedAt: undefined,
  updatedAt: undefined,
});
harden(initialFoldState);

const addEffects = (state, effectRecords) => {
  for (const record of effectRecords) {
    // `emit` effects are instantaneous internal events: journaled for
    // audit, never pending against the world.
    if (record.effect.kind !== 'emit') {
      state.pending.set(record.effectId, record);
    }
  }
};

const pruneExited = (state, exited) => {
  if (exited.length === 0) {
    return;
  }
  for (const [effectId, record] of state.pending) {
    if (exited.some(prefix => isPathPrefix(prefix, record.path))) {
      state.pending.delete(effectId);
    }
  }
};

/**
 * Apply one journal entry to a fold state, mutating it. The live engine
 * calls this as it appends; recovery calls it over the stored entries.
 *
 * @param {FoldState} state
 * @param {any} entry
 */
export const applyEntry = (state, entry) => {
  const { seq, kind } = entry;
  typeof seq === 'bigint' || Fail`journal entry seq must be a bigint`;
  seq === state.nextSeq ||
    Fail`journal entry out of order: expected seq ${q(state.nextSeq)}, got ${q(seq)}`;
  JOURNAL_KINDS.includes(kind) || Fail`unknown journal entry kind ${q(kind)}`;
  state.nextSeq = seq + 1n;
  state.updatedAt = entry.at;
  if (kind === 'started') {
    state.chartName = entry.chartName;
    state.chartVersion = entry.chartVersion;
    state.params = entry.params;
    state.endowmentNames = entry.endowmentNames;
    state.configuration = entry.configuration;
    state.context = entry.context;
    addEffects(state, entry.effects);
    state.startedAt = entry.at;
  } else if (kind === 'event') {
    if (entry.replays !== undefined) {
      state.queuedEvents.delete(String(entry.replays));
    }
    if (entry.fired !== undefined) {
      state.configuration = entry.fired.configuration;
      state.context = entry.fired.context;
      pruneExited(state, entry.fired.exited);
      addEffects(state, entry.fired.effects);
    } else if (state.paused && entry.replays === undefined) {
      state.queuedEvents.set(String(seq), entry.event);
    }
  } else if (kind === 'effect-dispatched') {
    const record = state.pending.get(entry.effectId);
    if (record !== undefined) {
      state.pending.set(
        entry.effectId,
        harden({ ...record, correlation: entry.correlation }),
      );
    }
  } else if (kind === 'effect-settled') {
    state.pending.delete(entry.effectId);
  } else if (kind === 'spawned') {
    const record = state.pending.get(entry.effectId);
    if (record !== undefined) {
      state.pending.set(
        entry.effectId,
        harden({ ...record, childRunId: entry.childRunId }),
      );
    }
  } else if (kind === 'paused') {
    state.paused = true;
  } else if (kind === 'resumed') {
    state.paused = false;
  } else if (kind === 'cancelled') {
    state.done = true;
    state.outcome = 'cancelled';
    state.reason = entry.reason;
    state.pending.clear();
    state.queuedEvents.clear();
  } else if (kind === 'completed') {
    state.done = true;
    state.outcome = 'completed';
    state.output = entry.output;
    state.pending.clear();
    state.queuedEvents.clear();
  } else if (kind === 'failed') {
    state.done = true;
    state.outcome = 'failed';
    state.reason = entry.reason;
    state.pending.clear();
    state.queuedEvents.clear();
  } else if (kind === 'snapshot') {
    state.configuration = entry.configuration;
    state.context = entry.context;
    state.pending = new Map(
      entry.pending.map(record => [record.effectId, record]),
    );
  }
  return state;
};
harden(applyEntry);

/**
 * Fold a journal into the run state it denotes.
 *
 * @param {Iterable<any>} entries - in seq order
 * @returns {FoldState}
 */
export const foldJournal = entries => {
  const state = initialFoldState();
  for (const entry of entries) {
    applyEntry(state, entry);
  }
  return state;
};
harden(foldJournal);
