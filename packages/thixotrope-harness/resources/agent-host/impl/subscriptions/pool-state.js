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
 */

/** @type {BridgeSettings} */
export const bridgeSettingsDefaults = harden({ servedFlushMs: 1000 });

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
 * @returns {PoolStateBridge & { pending: () => number }}
 */
export const makePoolStateBridge = ({ sink, backend, timers, settings }) => {
  const { servedFlushMs } = { ...bridgeSettingsDefaults, ...settings };
  const sinkNow = () => (typeof sink === 'function' ? sink() : sink);

  /** @type {{ sink: any, promise: Promise<any> } | undefined} */
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
      if (loaded !== undefined && loaded.sink === target) return loaded.promise;
      if (target === undefined) {
        return Promise.reject(Error('No agent-host sink'));
      }
      const promise = E(target)
        .poolState(backend)
        .then(state => harden(state));
      const entry = { sink: target, promise };
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
    pending: () => waiting.size,
  });
};
harden(makePoolStateBridge);
