// @ts-check

import { E } from '@endo/eventual-send';

/** @import { TraceRecord } from '../trace-aggregator.js' */

/**
 * Build a `marshalSaveError` callback that forwards each outbound
 * error to `powers.reportTrace`. The push uses `E.sendOnly` so the
 * caller never blocks an outbound error on the trace push, mirroring
 * the worker pattern in `worker.js`.
 *
 * The constructed `TraceRecord` carries an empty `workerId`; the
 * daemon-side host implementation overwrites it with
 * `@network:${hostId}` so a caplet cannot forge entries under
 * another scope.
 *
 * @param {unknown} powers the host ref the caplet received as its
 *   `@agent` powers; must implement `HostInterface.reportTrace`.
 * @param {string} site label recorded with each trace, e.g.
 *   `'libp2p-inbound'`, `'ws-relay-outbound'`.
 */
export const makeNetworkMarshalSaveError = (powers, site) => {
  /**
   * @param {Error} err
   * @param {string} [errorId]
   */
  return function marshalSaveError(err, errorId) {
    if (errorId === undefined) return;
    const stack = typeof err.stack === 'string' ? err.stack : '';
    /** @type {TraceRecord} */
    const record = harden({
      errorId,
      workerId: '',
      name: typeof err.name === 'string' ? err.name : 'Error',
      message: typeof err.message === 'string' ? err.message : `${err}`,
      stack,
      annotations: [],
      causes: [],
      t: Date.now(),
      site,
    });
    try {
      E.sendOnly(/** @type {any} */ (powers)).reportTrace(record);
    } catch (pushError) {
      console.error(
        'Endo network trace push failed:',
        /** @type {Error} */ (pushError).message || pushError,
      );
    }
  };
};
harden(makeNetworkMarshalSaveError);
