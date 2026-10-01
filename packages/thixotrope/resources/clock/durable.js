// @ts-check
/** @import { GuestGlobals } from '../../guest.js' */
/** @import { NativeDurablePowers, NativeDurableKit } from '../../src/native/contract.js' */
/** @import { PromiseKit } from '@endo/promise-kit' */
import harden from '@endo/harden';

// The rest of the prelude is read off globalThis, as in the vat; `harden`
// is imported so the module loads in a host that has not locked down, since
// the supervisor imports it to ship `make` by source.
const { makeExo, makePromiseKit, M } = /** @type {GuestGlobals} */ (globalThis);

/**
 * What this side registers under an alarm key and the adapter arms; the
 * adapter imports the type from here. A registration is made with one of
 * `at` and `after`; the adapter resolves `after` against its own clock and
 * answers the registration as `{ at, sink }`, which this side adopts, so a
 * restart restores the deadline and never the delay counted again.
 * @typedef {object} AlarmSpec
 * @property {bigint} [at] the deadline, Unix milliseconds
 * @property {bigint} [after] a delay in milliseconds from when the adapter
 *   arms it
 * @property {any} sink this side's `fire(key, now)`
 */

/**
 * The clock: alarms a vat can hold across sleep and restart. The deadlines
 * live in this manager's heap, durable for free; the timers live in the
 * adapter process, which owns a clock of its own, so this side never reads
 * the time and a caller never needs to. The public facet settles a promise
 * at or after a deadline, given absolutely or as a delay, and hands out a
 * per-alarm canceller; there is deliberately no way to list alarms, since
 * the facet is shared through the inventory and a holder that could
 * enumerate them could cancel every other holder's.
 *
 * Process creation and restart are the manager kit's; everything about
 * timers is the adapter's. What this module needs is in the guest prelude,
 * and the supervisor ships its factory by source.
 * @param {NativeDurablePowers} powers
 * @returns {NativeDurableKit}
 */
export const make = ({ makeManager }) => {
  // Nonnegative signed 64-bit Unix milliseconds, as the adapter keeps them.
  const DeadlineShape = M.and(M.bigint(), M.gte(0n), M.lte(2n ** 63n - 1n));
  // A delay that keeps its deadline inside the same range from any present.
  const DelayShape = M.and(M.bigint(), M.gte(0n), M.lte(2n ** 53n));
  // Exactly one of the two, and nothing else: a record with both would
  // mean one thing here and another in the adapter.
  const ArmShape = M.or(
    harden({ at: DeadlineShape }),
    harden({ after: DelayShape }),
  );
  const ClockI = M.interface('Clock', {
    help: M.call().returns(M.string()),
    at: M.call(DeadlineShape).returns(M.promise()),
    after: M.call(DelayShape).returns(M.promise()),
    arm: M.call(ArmShape).returns(M.promise()),
    status: M.call().returns(M.record()),
  });
  const AlarmCancellerI = M.interface('AlarmCanceller', {
    cancel: M.call().returns(M.promise()),
  });
  const AlarmSinkI = M.interface('AlarmSink', {
    fire: M.call(M.string(), DeadlineShape).returns(M.boolean()),
  });

  /**
   * One alarm this side still owes a settlement for, keyed as registered.
   * The handle arrives once registration answers; a fire that outruns it
   * (a deadline already past) is kept until then.
   * @type {Map<string, {kit: PromiseKit<bigint>, handle: any, firedAt?: bigint}>}
   */
  const pending = new Map();
  let nextId = 0n;

  /** @type {ReturnType<typeof makeManager>} */
  const manager = makeManager({
    label: 'Alarm',
    // Keys are fresh per alarm, so the only repeated registration is this
    // side's own, in the resolved form or the one it was made with.
    /**
     * @param {AlarmSpec} existing
     * @param {AlarmSpec} wanted
     */
    same: (existing, wanted) =>
      existing.sink === wanted.sink &&
      (wanted.at === undefined || existing.at === wanted.at),
    /**
     * @param {unknown} key
     * @param {AlarmSpec | undefined} spec
     * @param {'bound' | 'inactive' | 'closed'} state
     * @param {string} [error]
     */
    describe: (key, spec, state, error) =>
      harden({
        key,
        ...(spec?.at === undefined ? {} : { at: spec.at }),
        status: state === 'bound' ? 'armed' : state,
        ...(error === undefined ? {} : { error }),
      }),
  });

  /**
   * Settle an alarm the adapter reports fired. Idempotent per key: a rebuilt
   * adapter fires an overdue alarm again if this side never recorded the
   * first report, and a second report finds nothing to settle.
   */
  const sink = makeExo('AlarmSink', AlarmSinkI, {
    /**
     * @param {string} key
     * @param {bigint} now
     */
    fire: (key, now) => {
      const entry = pending.get(key);
      if (entry === undefined) return false;
      if (entry.handle === undefined) {
        entry.firedAt = now;
        return true;
      }
      pending.delete(key);
      entry.kit.resolve(now);
      void entry.handle.close().catch(() => {});
      return true;
    },
  });

  /**
   * Register an alarm and hand back its settlement and a cancel.
   * Registration is a host round trip, so a host restart in the middle of
   * it rejects; once it has answered, the waiting afterwards is durable.
   * @param {{at?: bigint, after?: bigint}} when
   */
  const arm = async when => {
    nextId += 1n;
    const key = `${nextId}`;
    /** @type {PromiseKit<bigint>} */
    const kit = makePromiseKit();
    // A discarded alarm must not produce an unhandled rejection.
    void kit.promise.catch(() => {});
    /** @type {{kit: PromiseKit<bigint>, handle: any, firedAt?: bigint}} */
    const entry = { kit, handle: undefined };
    pending.set(key, entry);
    try {
      entry.handle = await manager.register(
        key,
        harden(
          when.at === undefined
            ? { after: when.after, sink }
            : { at: when.at, sink },
        ),
      );
      // A registration the adapter could not take (no adapter could be
      // built, or it refused the alarm) would otherwise wait in silence
      // until the next rebuild; the caller hears about it instead and may
      // arm again.
      const status = /** @type {{status: string, error?: string}} */ (
        await entry.handle.status()
      );
      if (status.status === 'inactive')
        throw Error(
          `Alarm not armed: ${status.error ?? 'adapter unavailable'}`,
        );
    } catch (error) {
      if (pending.get(key) === entry) {
        pending.delete(key);
        kit.reject(error);
        if (entry.handle !== undefined)
          void entry.handle.close().catch(() => {});
      }
      throw error;
    }
    if (entry.firedAt !== undefined) {
      pending.delete(key);
      kit.resolve(entry.firedAt);
      void entry.handle.close().catch(() => {});
    }
    return harden({
      settlement: kit.promise,
      cancel: async () => {
        if (pending.get(key) !== entry) return false;
        pending.delete(key);
        kit.reject(Error('Alarm cancelled'));
        await entry.handle.close();
        return true;
      },
    });
  };

  const facet = makeExo('Clock', ClockI, {
    help: () =>
      'at(deadline) and after(delay) settle at or after the deadline with the host time; arm({at}|{after}) also returns a canceller for that one alarm; status() counts pending alarms.',
    /** @param {bigint} deadline */
    at: async deadline => {
      const { settlement } = await arm(harden({ at: deadline }));
      return settlement;
    },
    /** @param {bigint} delay */
    after: async delay => {
      const { settlement } = await arm(harden({ after: delay }));
      return settlement;
    },
    /**
     * `at` or `after`, plus the authority to cancel this one alarm. The
     * cancel is a capability rather than an id.
     * @param {{at?: bigint, after?: bigint}} when
     */
    arm: async when => {
      const { settlement, cancel } = await arm(when);
      return harden({
        settlement,
        canceller: makeExo('AlarmCanceller', AlarmCancellerI, { cancel }),
      });
    },
    status: () => harden({ pending: pending.size }),
  });
  return harden({ facet, lifecycle: manager.lifecycle });
};
harden(make);
