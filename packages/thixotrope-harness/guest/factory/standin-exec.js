// @ts-check
/**
 * A stand-in exec program for the pool's own tests (M1b W1b.5).
 *
 * Not the exec program: W1b.3 writes `guest/exec/main.js`. This module lets
 * the pool's exec spares (createWorker, staged bundle, evaluating crank
 * returning an `ExecScope`) be tested before it lands. It is bundled on its
 * own (`bundleGuest('guest/factory/standin-exec.js')`), never by the
 * factory's `main.js`.
 *
 * `makeExecScope()` returns an `ExecScope` whose `run` evaluates nothing:
 * it counts its calls in the vat heap and answers `{ status: 'ok', text:
 * 'calls <n>' }`, so a test can tell one scope (and one vat) from another
 * and see that the count survives a restart.
 *
 * Guest rules: prelude globals only.
 */
import { interfaces } from '../lib/guards/factory.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

/** The program's entry: the completion value of the evaluating crank. */
export const makeExecScope = () => {
  let calls = 0;
  return makeExo('ExecScope', interfaces.ExecScope, {
    async run() {
      calls += 1;
      return harden({ status: 'ok', text: `calls ${calls}` });
    },
    abandon() {},
    async inspect() {
      return harden({
        status: 'failed',
        text: 'The stand-in exec vat does not inspect',
      });
    },
  });
};
harden(makeExecScope);
