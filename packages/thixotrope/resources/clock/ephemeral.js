// @ts-check
import { E } from '@endo/far';
import harden from '@endo/harden';
import { clearTimeout, setTimeout } from 'node:timers';

import { makeAdapter } from '../../native-adapter.js';

/** @import { AlarmSpec } from './durable.js' */

/**
 * The longest delay one timer takes. Node treats a larger one as about a
 * millisecond, so a far deadline is reached by re-arming until it is near.
 */
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * The adapter over a clock and timers, for a test to hand in its own. Every
 * alarm belongs to this disposable process: the adapter kit keeps the
 * bindings, this module arms and clears a timer per key and reports the
 * firing to the manager's sink. A registration made with a delay is
 * resolved here, against this clock, to the deadline it means, and that is
 * what the manager keeps.
 *
 * @param {object} powers
 * @param {() => bigint} powers.now Unix milliseconds
 * @param {(callback: () => void, delayMs: number) => unknown} powers.setTimer
 * @param {(handle: unknown) => void} powers.clearTimer
 */
export const makeClockAdapter = ({ now, setTimer, clearTimer }) =>
  makeAdapter({
    label: 'Alarm',
    /**
     * @param {AlarmSpec} existing
     * @param {AlarmSpec} wanted
     */
    same: (existing, wanted) =>
      existing.sink === wanted.sink &&
      (wanted.at === undefined || existing.at === wanted.at),
    /**
     * @param {unknown} key
     * @param {AlarmSpec} spec
     */
    bind: (key, spec) => {
      if (typeof key !== 'string') throw Error('Expected an alarm key');
      const deadline =
        spec.at !== undefined
          ? spec.at
          : spec.after !== undefined
            ? now() + spec.after
            : undefined;
      if (typeof deadline !== 'bigint' || deadline < 0n)
        throw Error('Alarm needs a deadline (at) or a delay (after)');
      /** @type {unknown} */
      let timer;
      const check = () => {
        timer = undefined;
        const remaining = deadline - now();
        if (remaining <= 0n) {
          E(spec.sink)
            .fire(key, now())
            .catch(error => console.error('Alarm report failed:', error));
          return;
        }
        timer = setTimer(
          check,
          Number(remaining > BigInt(MAX_DELAY_MS) ? MAX_DELAY_MS : remaining),
        );
      };
      // The first check is a turn away, so a deadline already past is
      // reported after the bind answers rather than before it.
      timer = setTimer(check, 0);
      return harden({
        deadline,
        clear: () => {
          if (timer !== undefined) clearTimer(timer);
          timer = undefined;
        },
      });
    },
    /**
     * @param {{deadline: bigint, clear: () => void}} binding
     * @param {AlarmSpec} spec
     * @returns {AlarmSpec}
     */
    resolve: (binding, spec) =>
      harden({ at: binding.deadline, sink: spec.sink }),
    /** @param {{deadline: bigint, clear: () => void}} binding */
    unbind: binding => binding.clear(),
  });
harden(makeClockAdapter);

export const make = () =>
  makeClockAdapter({
    now: () => BigInt(Date.now()),
    setTimer: setTimeout,
    clearTimer: handle => clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
  });
harden(make);
