// @ts-check
import { limits } from '../lib/limits.js';
import { utf8Bytes } from '../lib/bounded.js';
import { isRetiredBreak } from '../lib/retired.js';
import { retireScope } from './tools/exec.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

/**
 * Model code runs only in the originating exec vat. Its public facet
 * forwards to this session before dispatching a declared method. The
 * alarm lives outside the worker, including when its owner has no turn.
 * @param {any} runtime
 */
export const makePublications = runtime => {
  let pending = 0;
  /** @type {any} last known native timer; a restart replaces it */
  let timer;
  const freshTimer = async () => {
    const ports = await E(runtime.services.backend).open(runtime.services.host);
    timer = ports.timer;
    return timer;
  };

  /**
   * @param {string} label
   * @param {any} executor
   * @param {any} facade
   */
  return harden((label, executor, facade) => {
    const state = runtime.exec.state();
    const scope = state.running?.scope;
    if (!scope || scope !== state.scope)
      throw Error('Publication needs an active exec call');
    timer = state.running.ports.timer;
    const supervisor = Far('Published method supervisor', {
      /**
       * @param {string} method
       * @param {string} args
       */
      async invoke(method, args) {
        await null;
        if (scope !== state.scope)
          throw Error('The published exec scope has ended');
        if (pending >= limits.callWindow)
          throw Error('Too many pending published calls');
        if (
          typeof method !== 'string' ||
          method.length > limits.methodNameUnits ||
          typeof args !== 'string' ||
          utf8Bytes(args) > limits.labelValueBytes
        ) {
          throw Error('Invalid published call');
        }
        pending += 1;
        let alarm;
        let finished = false;
        try {
          try {
            alarm = await E(timer).alarm(state.deadlineMs);
          } catch (error) {
            if (!isRetiredBreak(error)) throw error;
            // Safe to retry obtaining a clock: no model method has run.
            alarm = await E(await freshTimer()).alarm(state.deadlineMs);
          }
          if (scope !== state.scope)
            throw Error('The published exec scope has ended');
          const timeout = E(alarm)
            .whenExpired()
            .then(
              expired => {
                if (expired && !finished) {
                  retireScope(state, runtime.services.execVat, scope);
                  throw Error('Published method timed out');
                }
              },
              error => {
                if (!finished)
                  retireScope(state, runtime.services.execVat, scope);
                throw error;
              },
            );
          const result = await Promise.race([
            E(executor).invoke(method, args),
            timeout,
          ]);
          if (
            typeof result !== 'string' ||
            utf8Bytes(result) > limits.labelValueBytes
          ) {
            throw Error('Invalid published reply');
          }
          return result;
        } finally {
          finished = true;
          pending -= 1;
          if (alarm) E.sendOnly(alarm).cancel();
        }
      },
    });
    runtime.labels.bindObject(label, facade, 'stored');
    return supervisor;
  });
};
harden(makePublications);
