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
 * One deliberate principle, extended after the durability review: every
 * causally-coupled pair of facts commits in ONE entry, so there is no
 * crash window between them. The `event` entry therefore optionally
 * carries, alongside its envelope:
 *
 * - `fired` — the step result `{ configuration, context, exited,
 *   effects, internals? }`; `internals` are the id'd internal envelopes
 *   (`regions-settled` / `state-done`) the step raised, tracked as
 *   delivery obligations until their own entries land (an envelope's
 *   `delivers` field discharges one).
 * - `settles` — `{ effectId, status, value? / reason? }` when the event
 *   IS an effect settlement; the pending record is removed by the same
 *   write that journals its transition.
 * - `terminal` — `{ outcome, output? / reason? }` when the step entered
 *   a top-level final state (or the fail-loud policy fired); completion
 *   commits with the step, never as a separate write.
 * - `replays` — the seq of a queued event being stepped after `resumed`.
 *
 * `emit` effects are likewise delivery obligations: their effect
 * records (journaled in `fired.effects` / `started.effects`) enter
 * `pendingInternals` keyed by effectId until the emitted envelope's own
 * entry (carrying `delivers`) lands. Recovery re-dispatches whatever
 * obligations remain.
 *
 * Entry kinds:
 *
 * | kind               | payload                                                       |
 * | ------------------ | ------------------------------------------------------------- |
 * | `started`          | chartName, chartVersion, factory?, params, endowmentNames,    |
 * |                    | configuration, context, effects, internals?, terminal?        |
 * | `event`            | event envelope; optional `fired`, `settles`, `terminal`,      |
 * |                    | `replays` as above                                            |
 * | `effect-dispatched`| effectId, correlation? (mail message ids, responseName, or an |
 * |                    | absolute timer deadline)                                      |
 * | `effect-settled`   | legacy shape (still folded); live engines journal settlements |
 * |                    | as `event` entries with `settles`                             |
 * | `spawned`          | effectId, childRunId                                          |
 * | `paused`/`resumed` | —                                                             |
 * | `cancelled`        | reason?                                                       |
 * | `completed`        | output? (legacy; live engines use `terminal`)                 |
 * | `failed`           | reason (standalone failures, e.g. cascade overflow)           |
 * | `snapshot`         | configuration, context, pending, internals (replay shortener; |
 * |                    | the engine only snapshots at rest)                            |
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
import { encodeHex } from '@endo/hex';
import { passStyleOf, getTag } from '@endo/pass-style';
import { sha256 } from '@endo/sha256';

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
 * @property {Map<string, { effectId: string, path: string[], effect: any, since?: string, correlation?: any, childRunId?: string, exit?: boolean }>} pending
 * @property {Map<string, any>} pendingInternals - engine-generated
 *   envelopes (internal events and `emit`s) journaled but not yet
 *   delivered as their own entries, keyed by internalId / effectId; the
 *   recovery path re-dispatches whatever remains
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
  pendingInternals: new Map(),
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
    if (record.effect.kind === 'emit') {
      // `emit` effects never pend against the world, but their delivery
      // (the emitted envelope's own entry) is a durable obligation.
      state.pendingInternals.set(
        record.effectId,
        harden({ ...record.effect.event, by: 'engine', path: record.path }),
      );
    } else {
      state.pending.set(record.effectId, harden({ ...record, since: at }));
    }
  }
};

const addInternals = (state, internals) => {
  for (const internal of internals ?? []) {
    state.pendingInternals.set(internal.internalId, internal.envelope);
  }
};

const applyTerminal = (state, terminal) => {
  state.done = true;
  state.outcome = terminal.outcome;
  if (terminal.output !== undefined) {
    state.output = terminal.output;
  }
  if (terminal.reason !== undefined) {
    state.reason = terminal.reason;
  }
  state.pending.clear();
  state.pendingInternals.clear();
  state.queuedEvents.clear();
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
    addInternals(state, entry.internals);
    state.startedAt = entry.at;
    if (entry.terminal !== undefined) {
      applyTerminal(state, entry.terminal);
    }
  } else if (kind === 'event') {
    if (entry.settles !== undefined) {
      state.pending.delete(entry.settles.effectId);
    }
    if (entry.event !== undefined && entry.event.delivers !== undefined) {
      state.pendingInternals.delete(entry.event.delivers);
    }
    if (entry.replays !== undefined) {
      state.queuedEvents.delete(String(entry.replays));
    }
    if (entry.fired !== undefined) {
      state.configuration = entry.fired.configuration;
      state.context = entry.fired.context;
      pruneExited(state, entry.fired.exited);
      addEffects(state, entry.fired.effects, entry.at);
      addInternals(state, entry.fired.internals);
    } else if (
      state.paused &&
      entry.replays === undefined &&
      entry.terminal === undefined
    ) {
      state.queuedEvents.set(String(seq), entry.event);
    }
    if (entry.terminal !== undefined) {
      applyTerminal(state, entry.terminal);
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
    // Legacy settlement shape; live engines coalesce settlements into
    // `event` entries with `settles`.
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
    applyTerminal(
      state,
      harden({
        outcome: 'cancelled',
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      }),
    );
  } else if (kind === 'completed') {
    applyTerminal(
      state,
      harden({
        outcome: 'completed',
        ...(entry.output !== undefined ? { output: entry.output } : {}),
      }),
    );
  } else if (kind === 'failed') {
    applyTerminal(state, harden({ outcome: 'failed', reason: entry.reason }));
  } else if (kind === 'snapshot') {
    state.configuration = entry.configuration;
    state.context = entry.context;
    state.pending = new Map(
      entry.pending.map(record => [record.effectId, record]),
    );
    state.pendingInternals = new Map(entry.internals ?? []);
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
 * The deepest structure the canonical encoder (and, in the service, the
 * redactor) will walk. Journal entries built by the engine are shallow;
 * participant-supplied values beyond this depth are refused rather than
 * risking the stack.
 */
export const MAX_ENCODING_DEPTH = 128;
harden(MAX_ENCODING_DEPTH);

/**
 * @param {any} value
 * @param {number} depth
 * @returns {string}
 */
const encodeCanonical = (value, depth) => {
  depth <= MAX_ENCODING_DEPTH ||
    Fail`journal value exceeds encoding depth ${q(MAX_ENCODING_DEPTH)}`;
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
  if (type === 'symbol') {
    // Passable symbols are well-known or registered; the description
    // names them for hashing purposes.
    const description = /** @type {symbol} */ (value).description;
    return `{"#sym":${JSON.stringify(String(description ?? ''))}}`;
  }
  const style = passStyleOf(value);
  if (style === 'copyArray') {
    const array = /** @type {any[]} */ (value);
    return `[${array.map(member => encodeCanonical(member, depth + 1)).join(',')}]`;
  }
  if (style === 'copyRecord') {
    const inner = keys(value)
      .sort()
      .map(name => {
        const escaped = name.startsWith('#') ? `#${name}` : name;
        return `${JSON.stringify(escaped)}:${encodeCanonical(value[name], depth + 1)}`;
      })
      .join(',');
    return `{${inner}}`;
  }
  if (style === 'tagged') {
    return `{"#tag":${JSON.stringify(getTag(value))},"payload":${encodeCanonical(value.payload, depth + 1)}}`;
  }
  if (style === 'error') {
    const error = /** @type {Error & { cause?: any, errors?: any }} */ (value);
    let encoded = `{"#error":${JSON.stringify(error.name)},"message":${JSON.stringify(error.message)}`;
    // Aux data participates in the hash, so tampering with a stored
    // error's cause chain is as detectable as any other edit.
    if (error.cause !== undefined) {
      encoded += `,"cause":${encodeCanonical(error.cause, depth + 1)}`;
    }
    if (error.errors !== undefined) {
      encoded += `,"errors":${encodeCanonical(error.errors, depth + 1)}`;
    }
    return `${encoded}}`;
  }
  throw Fail`journal entries must be capability-free data, cannot encode a ${q(style)}`;
};

/**
 * Deterministically encode a capability-free passable as a string, for
 * hashing. JSON syntax with sorted record keys plus escape records for
 * the passable extensions: `{"#":"undefined"}`, `{"#num":"NaN"}` (and
 * `-0`, `Infinity`, `-Infinity`), `{"#big":"7"}` for bigints,
 * `{"#sym":d}` for passable symbols, `{"#tag":t,"payload":p}` for
 * tagged values, and `{"#error":name,"message":m,"cause"?,"errors"?}`
 * for errors (aux data included). Literal record keys beginning with
 * `#` are escaped by doubling, so the encoding is prefix-unambiguous.
 *
 * Throws on remotables and promises — journal entries must have been
 * redacted to data before hashing, and this refusal is the enforcement
 * — and on structures deeper than `MAX_ENCODING_DEPTH`.
 *
 * @param {any} value
 * @returns {string}
 */
export const canonicalStringify = value => encodeCanonical(value, 0);
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
