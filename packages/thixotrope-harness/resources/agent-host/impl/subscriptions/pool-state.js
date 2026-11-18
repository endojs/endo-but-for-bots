// @ts-check
/**
 * The manager bridge of one pool (M4 W4.2; `designs/m4-interfaces.md` 3.1
 * sink additions, 5.1 persistence, 10). The manager vat is the system of
 * record for marks and last-served records; the adapter decides per round
 * in memory (`pool.js`) and keeps the manager up to date:
 *
 * - `load()`: one `E(sink).poolState(backend)` per pool per incarnation,
 *   lazily at the pool's first use. The answer is cached; a rejected load
 *   (a retired break: the manager restarted, or the adapter is between
 *   sinks) is forgotten, so the next `load()` asks again; a new sink (the
 *   adapter re-attached to a restarted manager) is asked again too.
 * - `invalidate()` (XB, m4-interfaces 3.1): the manager retired a pool or a
 *   member and said so (`CredentialOps.poolsChanged`, sendOnly): the
 *   answer held, or the one being asked, is stale, and the next `load()`
 *   asks again, so the next round sees the retirement. An answer older
 *   than `stateRefreshMs` is asked again too, as a safety net for a push
 *   that was lost (one manager crank per pool per bound while the pool is
 *   used, none while it is idle). A failed re-ask keeps the answer it had
 *   (and stays stale when it was); a retired pool's answer is final.
 * - `record(change)`: marks are sent **at once** (`E.sendOnly(sink)
 *   .poolChanged`, one manager crank per refusal, never more than one per
 *   member per round: the core reports a mark only when it changes), with
 *   any served stamps already waiting riding along. Served stamps are
 *   **coalesced**: the latest per session is kept and sent at most once per
 *   `servedFlushMs` (one second) per pool, in messages of at most
 *   `m4Limits.poolChangeServed` (32) records.
 * - `flush()`: sends what waits now (tests, shutdown).
 *
 * A send to a retired sink is lost (sendOnly): a lost mark costs one more
 * refusal at the next round (10, K-2), a lost stamp at most one cold choice.
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';

import { m4Limits } from '../../../../guest/lib/limits-m4.js';
/* eslint-enable import/no-relative-packages */

/** @typedef {import('./types.js').PoolChange} PoolChange */
/** @typedef {import('./types.js').PoolStateBridge} PoolStateBridge */
/** @typedef {import('./types.js').Mark} Mark */

/**
 * @typedef {object} BridgeSettings
 * @property {number} servedFlushMs served stamps are sent at most this often
 *   per pool (`subscriptionDefaults.servedFlushMs`, 1,000)
 * @property {number} stateRefreshMs a loaded `PoolState` is asked again
 *   when older (`subscriptionDefaults.poolStateRefreshMs`, 600,000; 0:
 *   only after `invalidate()`)
 */

/** @type {BridgeSettings} */
export const bridgeSettingsDefaults = harden({
  servedFlushMs: 1000,
  stateRefreshMs: 600_000,
});

/**
 * @template T
 * @param {readonly T[]} list
 * @param {number} size
 * @returns {T[][]}
 */
const chunks = (list, size) => {
  /** @type {T[][]} */
  const out = [];
  for (let start = 0; start < list.length; start += size) {
    out.push(list.slice(start, start + size));
  }
  return out;
};

/**
 * The core's `initial` from a loaded `PoolState` (`pool.js` `makePoolCore`):
 * the members' marks and the last-served records.
 *
 * @param {{ members: readonly { member: any, mark?: Mark }[], served: readonly { session: any, member: any, at: number }[] }} state
 */
export const initialFromPoolState = state =>
  harden({
    marks: state.members
      .filter(entry => entry.mark !== undefined)
      .map(({ member, mark }) => ({ member, mark })),
    served: [...state.served],
  });
harden(initialFromPoolState);

/**
 * @param {object} options
 * @param {any} options.sink the `AgentHostSink`, or a function answering the
 *   current one (`undefined` while the adapter has none)
 * @param {any} options.backend the pool's `Backend` presence
 * @param {import('../timers.js').Timers} options.timers
 * @param {Partial<BridgeSettings>} [options.settings]
 * @param {() => number} [options.now]
 * @returns {PoolStateBridge & { pending: () => number }}
 */
export const makePoolStateBridge = ({
  sink,
  backend,
  timers,
  settings,
  now = () => Date.now(),
}) => {
  const { servedFlushMs, stateRefreshMs } = {
    ...bridgeSettingsDefaults,
    ...settings,
  };
  const sinkNow = () => (typeof sink === 'function' ? sink() : sink);

  /**
   * The current load: its sink, its promise, when it was asked, whether a
   * push made it stale, and once answered the answer.
   * @typedef {{ sink: any, promise: Promise<any>, at: number, stale: boolean, state?: any }} Load
   */
  /** @type {Load | undefined} */
  let loaded;
  /**
   * Served stamps waiting, latest per session.
   * @type {Map<any, { session: any, member: any, at: number }>}
   */
  const waiting = new Map();
  /** @type {(() => void) | undefined} */
  let cancelTimer;

  /**
   * @param {{ member: any, mark?: Mark }[]} markList
   */
  const send = markList => {
    if (cancelTimer !== undefined) {
      cancelTimer();
      cancelTimer = undefined;
    }
    const target = sinkNow();
    const served = [...waiting.values()];
    waiting.clear();
    if (target === undefined) return;
    const markParts = chunks(markList, m4Limits.maxPoolMembers);
    const servedParts = chunks(served, m4Limits.poolChangeServed);
    const count = Math.max(markParts.length, servedParts.length);
    for (let index = 0; index < count; index += 1) {
      /** @type {PoolChange} */
      const change = {
        ...(markParts[index] ? { marks: markParts[index] } : {}),
        ...(servedParts[index] ? { served: servedParts[index] } : {}),
      };
      E.sendOnly(target).poolChanged(backend, harden(change));
    }
  };

  const arm = () => {
    if (cancelTimer !== undefined) return;
    cancelTimer = timers.after(servedFlushMs, () => {
      cancelTimer = undefined;
      send([]);
    });
  };

  return harden({
    load: () => {
      const target = sinkNow();
      if (loaded !== undefined && loaded.sink === target) {
        const known = loaded;
        if (
          known.state === undefined ||
          known.state.state === 'retired' ||
          !(
            known.stale ||
            (stateRefreshMs > 0 && now() - known.at >= stateRefreshMs)
          )
        )
          return known.promise;
        // Stale: ask again; until answered, concurrent loads share the ask;
        // a failed ask keeps the old answer (and waits another bound, or
        // the next load when a push made it stale).
        const kept = known.state;
        const wasStale = known.stale;
        const promise = E(target)
          .poolState(backend)
          .then(
            state => {
              const fresh = harden(state);
              if (loaded === entry) entry.state = fresh;
              return fresh;
            },
            () => {
              if (loaded === entry) entry.stale ||= wasStale;
              return kept;
            },
          );
        /** @type {Load} */
        const entry = {
          sink: target,
          promise,
          at: now(),
          stale: false,
          state: kept,
        };
        loaded = entry;
        return promise;
      }
      if (target === undefined) {
        return Promise.reject(Error('No agent-host sink'));
      }
      const promise = E(target)
        .poolState(backend)
        .then(state => {
          const answer = harden(state);
          if (loaded === entry) entry.state = answer;
          return answer;
        });
      /** @type {Load} */
      const entry = { sink: target, promise, at: now(), stale: false };
      loaded = entry;
      promise.catch(() => {
        if (loaded === entry) loaded = undefined;
      });
      return promise;
    },
    record: change => {
      for (const record of change.served ?? []) {
        waiting.delete(record.session);
        waiting.set(record.session, record);
        // Retained-state bound (rule 12.6): never more stamps waiting than
        // the manager keeps per pool; the oldest would be dropped there too.
        while (waiting.size > m4Limits.servedRecords) {
          const [oldest] = waiting.keys();
          waiting.delete(oldest);
        }
      }
      const markList = change.marks ?? [];
      if (markList.length > 0) send([...markList]);
      else if (waiting.size > 0) arm();
    },
    flush: async () => {
      if (waiting.size > 0) send([]);
    },
    invalidate: () => {
      // A retired pool's answer is final; anything else is asked again at
      // the next load (an answer still being asked may predate the push).
      if (loaded !== undefined && loaded.state?.state !== 'retired')
        loaded.stale = true;
    },
    pending: () => waiting.size,
  });
};
harden(makePoolStateBridge);
