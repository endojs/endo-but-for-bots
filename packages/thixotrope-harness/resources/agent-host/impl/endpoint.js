// @ts-check
/**
 * The Endpoint (M1a W1a.2; architecture D-5, D-9; `designs/m1a-interfaces.md`
 * sections 3.2, 6 and 7): one per `Backend.open`, held by one session vat
 * for every turn of this adapter incarnation (the session opens its ports
 * once per incarnation, J-9151). Transient: after a restart the vat's
 * reference is a tombstone, so its pending `holdTurn` breaks with the
 * retired text, which is the session's restart signal, and a `holdTurn` sent
 * to it later breaks at once.
 *
 * - `holdTurn(turn)` is the lease, one per turn: it settles only at
 *   `releaseTurn(turn)`. A second `holdTurn` for the same turn returns the
 *   same pending lease. Released turns are forgotten (`held` keeps only the
 *   turns of this session that are not released: one at a time).
 * - `startRound(req)` runs a round with the provider only for a turn whose
 *   lease is held. The session sends `holdTurn` (answered, guarded with
 *   `M.callWhen`, so its body runs a few microtasks after delivery) and
 *   `startRound` (sendOnly) in one crank; a `startRound` that overtakes its
 *   lease is parked until the lease arrives, never run without it.
 * - `releaseTurn(turn)` settles the lease, stops a round still running for
 *   the turn, disarms the turn's timers and forgets the turn.
 * - `armDeadline` / `disarm`: adapter timers that call
 *   `E.sendOnly(sink).deadline({ opId })`; an arm that arrives before the
 *   turn's first round (which brings the sink) waits for it (M2 W2.9).
 * - M1b W1b.2: every round run is handed `prepare`, a thunk the provider
 *   calls first to bring the session's context cache up to the request and
 *   get the projection (context-cache.js); without `prepare` (M1a tests)
 *   the provider gets none.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';

import { interfaces } from '../../../guest/lib/interfaces.js';
import { cutText } from '../../../guest/lib/bounded.js';
import { limits } from '../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

const { makeExo } = /** @type {any} */ (globalThis);

/** Timers one turn may have armed at once (retained state bound, rule 12.6). */
const MAX_TIMERS_PER_TURN = 64;
/** Turns one endpoint tracks at once (one per session at a time; a bound, not a quota). */
const MAX_TURNS = 8;
/** Node's timer ceiling (a longer delay would fire at once). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * @param {object} options
 * @param {{ startRound: (req: any, channel: any, prepare?: () => Promise<any>, owner?: any) => Promise<void>, cancelRound: (turn: any) => void, releaseTurn?: (turn: any) => void, unexpectedFailure?: string }} options.provider
 *   `cancelRound` and `releaseTurn` stop the turn's round; an API provider
 *   aborts its request with them (M2 W2.1a, R4-7: the provider's server
 *   sees the connection close) and sends nothing more to the vat.
 *   `unexpectedFailure` (M2): the fixed reason of a round whose provider
 *   threw (R4-79)
 * @param {any} options.channel the session's channel (deltas go here, in-process)
 * @param {import('./timers.js').Timers} options.timers
 * @param {() => number} [options.now]
 * @param {(req: any) => Promise<any>} [options.prepare] W1b.2: the
 *   session's context cache for one RoundRequest
 * @param {any} [options.owner] the Session presence this endpoint serves;
 *   the provider stages its text for it (disk quota, provenance; J-9361)
 */
export const makeEndpoint = ({
  provider,
  channel,
  timers,
  now = () => Date.now(),
  prepare,
  owner,
}) => {
  /**
   * @typedef {object} HeldTurn
   * @property {Promise<undefined>} lease
   * @property {() => void} settle
   * @property {any} sink the TurnSink of the turn's last startRound
   * @property {Map<string, () => void>} armed opId -> cancel
   */
  /** @type {Map<any, HeldTurn>} */
  const held = new Map();
  /** Rounds that arrived before their lease (turn -> RoundRequest). */
  /** @type {Map<any, any>} */
  const parked = new Map();
  /** Turns released here; their late rounds and leases are ignored. */
  const released = new WeakSet();
  /**
   * Deadlines armed before the turn's first round ran here (turn -> opId ->
   * ms): the session sends `holdTurn` (callWhen, its body runs later),
   * `armDeadline` and `startRound` in one crank, so an arm usually arrives
   * before the lease and the sink (M2 W2.9; m2-interfaces.md 2.4 seam 4).
   * Bounded like `parked`.
   * @type {Map<any, Map<string, number>>}
   */
  const early = new Map();

  /**
   * @param {HeldTurn} state
   * @param {string} opId
   * @param {number} ms
   */
  const arm = (state, opId, ms) => {
    state.armed.get(opId)?.();
    state.armed.delete(opId);
    if (state.armed.size >= MAX_TIMERS_PER_TURN) return;
    const { sink } = state;
    const cancel = timers.after(Math.min(ms, MAX_TIMER_MS), () => {
      state.armed.delete(opId);
      E.sendOnly(sink).deadline(harden({ opId }));
    });
    state.armed.set(opId, cancel);
  };

  /**
   * Run a round with the provider; a provider that throws fails the round
   * rather than leaving the session waiting.
   * @param {HeldTurn} state
   * @param {any} req
   */
  const run = (state, req) => {
    state.sink = req.sink;
    const waiting = early.get(req.turn);
    if (waiting !== undefined) {
      early.delete(req.turn);
      for (const [opId, ms] of waiting) arm(state, opId, ms);
    }
    const project = prepare === undefined ? undefined : () => prepare(req);
    provider.startRound(req, channel, project, owner).catch(error => {
      if (released.has(req.turn)) return;
      // M2 W2.1a (R4-79): an API provider names a fixed text for a failure
      // it did not foresee, so no lower layer's message (which may quote a
      // provider body) reaches the turn's record.
      const reason =
        provider.unexpectedFailure ??
        cutText(
          `scripted provider failed: ${error?.message ?? error}`,
          limits.reasonUnits,
        );
      E.sendOnly(req.sink).roundFailed(
        harden({ round: req.round, reason, at: now() }),
      );
    });
  };

  /** @param {any} turn */
  const forget = turn => {
    const state = held.get(turn);
    held.delete(turn);
    parked.delete(turn);
    early.delete(turn);
    if (state === undefined) return;
    for (const cancel of state.armed.values()) cancel();
    state.armed.clear();
    state.settle();
  };

  return makeExo('Endpoint', interfaces.Endpoint, {
    /** @param {any} turn */
    holdTurn: async turn => {
      if (released.has(turn)) return undefined;
      let state = held.get(turn);
      if (state === undefined) {
        if (held.size >= MAX_TURNS)
          throw Error(`this endpoint already holds ${MAX_TURNS} turns`);
        /** @type {() => void} */
        let settle = () => {};
        /** @type {Promise<undefined>} */
        const lease = new Promise(resolve => {
          settle = () => resolve(undefined);
        });
        state = { lease, settle, sink: undefined, armed: new Map() };
        held.set(turn, state);
        const waiting = parked.get(turn);
        if (waiting !== undefined) {
          parked.delete(turn);
          run(state, waiting);
        }
      }
      return state.lease;
    },
    /** @param {any} turn */
    releaseTurn: turn => {
      released.add(turn);
      forget(turn);
      provider.releaseTurn?.(turn);
    },
    /** @param {any} req */
    startRound: req => {
      if (released.has(req.turn)) return;
      const state = held.get(req.turn);
      if (state === undefined) {
        // The lease has not arrived yet (or never will): never run a round
        // without it. One parked round per turn; bounded like `held`.
        if (parked.size < MAX_TURNS || parked.has(req.turn))
          parked.set(req.turn, req);
        return;
      }
      run(state, req);
    },
    /** @param {any} turn */
    cancelRound: turn => {
      parked.delete(turn);
      provider.cancelRound(turn);
    },
    /** @param {{ turn: any, opId: string, ms: number }} request */
    armDeadline: ({ turn, opId, ms }) => {
      if (released.has(turn)) return;
      const state = held.get(turn);
      if (state === undefined || state.sink === undefined) {
        // Kept until the turn's first round runs here (it brings the sink).
        let waiting = early.get(turn);
        if (waiting === undefined) {
          if (early.size >= MAX_TURNS) return;
          waiting = new Map();
          early.set(turn, waiting);
        }
        if (waiting.size < MAX_TIMERS_PER_TURN || waiting.has(opId))
          waiting.set(opId, ms);
        return;
      }
      arm(state, opId, ms);
    },
    /** @param {{ turn: any, opId: string }} request */
    disarm: ({ turn, opId }) => {
      early.get(turn)?.delete(opId);
      const state = held.get(turn);
      if (state === undefined) return;
      state.armed.get(opId)?.();
      state.armed.delete(opId);
    },
  });
};
harden(makeEndpoint);
