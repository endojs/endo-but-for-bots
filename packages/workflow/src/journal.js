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
 * | `admin`            | action, detail — journaled administrative access (for         |
 * |                    | example `resolve-ref`); no effect on the fold                 |
 *
 * Every entry also carries `prev`: the hex SHA-256 of the canonical
 * encoding of the previous entry (`GENESIS_HASH` for seq 0), forming a
 * hash chain over the journal. `verifyJournalChain` checks it on
 * recovery. Because `canonicalStringify` refuses remotables and
 * promises, hashing doubles as the enforcement that journal entries are
 * capability-free — the service redacts capabilities to `ref-<n>` alias
 * strings (durably stored under the run's `refs/` directory) before
 * appending.
 */

import { Fail, q } from '@endo/errors';
import { passStyleOf, getTag } from '@endo/pass-style';
import { sha256 } from '@endo/sha256';
import { encodeHex } from '@endo/hex';

const { keys } = Object;

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
  'admin',
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
 * and pet-name segments. Extra marks on the description (the kernel's
 * `exit` compensation flag) are preserved.
 *
 * @param {bigint} seq
 * @param {{ path: string[], effect: any, exit?: boolean }[]} effects
 * @returns {{ effectId: string, path: string[], effect: any, exit?: boolean }[]}
 */
export const effectRecordsFor = (seq, effects) =>
  harden(
    effects.map((description, index) => ({
      effectId: `${seq}-${index}`,
      ...description,
    })),
  );
harden(effectRecordsFor);

/**
 * @typedef {object} FoldState
 * @property {bigint} nextSeq
 * @property {string | undefined} chartName
 * @property {number | undefined} chartVersion
 * @property {string | undefined} factory - the factory id the run was
 *   started through, when it was
 * @property {Record<string, any>} params
 * @property {string[]} endowmentNames
 * @property {any} configuration
 * @property {Record<string, any>} context
 * @property {Map<string, { effectId: string, path: string[], effect: any, since?: string, correlation?: any, childRunId?: string }>} pending
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
  factory: undefined,
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

const addEffects = (state, effectRecords, at) => {
  for (const record of effectRecords) {
    // `emit` effects are instantaneous internal events: journaled for
    // audit, never pending against the world.
    if (record.effect.kind !== 'emit') {
      state.pending.set(record.effectId, harden({ ...record, since: at }));
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
    state.factory = entry.factory;
    state.params = entry.params;
    state.endowmentNames = entry.endowmentNames;
    state.configuration = entry.configuration;
    state.context = entry.context;
    addEffects(state, entry.effects, entry.at);
    state.startedAt = entry.at;
  } else if (kind === 'event') {
    if (entry.replays !== undefined) {
      state.queuedEvents.delete(String(entry.replays));
    }
    if (entry.fired !== undefined) {
      state.configuration = entry.fired.configuration;
      state.context = entry.fired.context;
      pruneExited(state, entry.fired.exited);
      addEffects(state, entry.fired.effects, entry.at);
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
  // `admin` entries are audit-only: they take the common envelope
  // bookkeeping above and change nothing else.
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

/**
 * Deterministically encode a capability-free passable as a string, for
 * hashing. JSON syntax with sorted record keys plus escape records for
 * the passable extensions: `{"#":"undefined"}`, `{"#num":"NaN"}` (and
 * `-0`, `Infinity`, `-Infinity`), `{"#big":"7"}` for bigints,
 * `{"#tag":t,"payload":p}` for tagged values, and
 * `{"#error":name,"message":m}` for errors. Literal record keys
 * beginning with `#` are escaped by doubling, so the encoding is
 * prefix-unambiguous.
 *
 * Throws on remotables and promises: journal entries must have been
 * redacted to data before hashing, and this refusal is the enforcement.
 *
 * @param {any} value
 * @returns {string}
 */
export const canonicalStringify = value => {
  if (value === undefined) {
    return '{"#":"undefined"}';
  }
  if (value === null) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (type === 'number') {
    if (Object.is(value, -0)) {
      return '{"#num":"-0"}';
    }
    if (Number.isNaN(value)) {
      return '{"#num":"NaN"}';
    }
    if (value === Infinity) {
      return '{"#num":"Infinity"}';
    }
    if (value === -Infinity) {
      return '{"#num":"-Infinity"}';
    }
    return JSON.stringify(value);
  }
  if (type === 'bigint') {
    return `{"#big":"${value}"}`;
  }
  const style = passStyleOf(value);
  if (style === 'copyArray') {
    const array = /** @type {any[]} */ (value);
    return `[${array.map(canonicalStringify).join(',')}]`;
  }
  if (style === 'copyRecord') {
    const inner = keys(value)
      .sort()
      .map(name => {
        const escaped = name.startsWith('#') ? `#${name}` : name;
        return `${JSON.stringify(escaped)}:${canonicalStringify(value[name])}`;
      })
      .join(',');
    return `{${inner}}`;
  }
  if (style === 'tagged') {
    return `{"#tag":${JSON.stringify(getTag(value))},"payload":${canonicalStringify(value.payload)}}`;
  }
  if (style === 'error') {
    const error = /** @type {Error} */ (value);
    return `{"#error":${JSON.stringify(error.name)},"message":${JSON.stringify(error.message)}}`;
  }
  throw Fail`journal entries must be capability-free data, cannot encode a ${q(style)}`;
};
harden(canonicalStringify);

const textEncoder = new TextEncoder();

/** The `prev` of the first journal entry. */
export const GENESIS_HASH = '0'.repeat(64);
harden(GENESIS_HASH);

/**
 * The hex SHA-256 of an entry's canonical encoding. Throws if the entry
 * contains a remotable or promise.
 *
 * @param {any} entry
 * @returns {string}
 */
export const hashEntry = entry =>
  encodeHex(sha256(textEncoder.encode(canonicalStringify(entry))));
harden(hashEntry);

/**
 * Verify the journal's hash chain: each entry's `prev` must be the hash
 * of the entry before it (`GENESIS_HASH` for the first). Returns the
 * running tail hash and, on the first break, the offending seq.
 *
 * @param {Iterable<any>} entries - in seq order
 * @returns {{ ok: boolean, tail: string, badSeq?: bigint }}
 */
export const verifyJournalChain = entries => {
  let tail = GENESIS_HASH;
  for (const entry of entries) {
    if (entry.prev !== tail) {
      return harden({ ok: false, tail, badSeq: entry.seq });
    }
    tail = hashEntry(entry);
  }
  return harden({ ok: true, tail });
};
harden(verifyJournalChain);
