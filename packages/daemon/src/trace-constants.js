// @ts-check

/**
 * Synthetic worker-id sentinels used by the trace aggregator to scope
 * records that do not originate from a real worker.
 *
 * `DAEMON_WORKER_ID` labels records emitted by the daemon process
 * itself (e.g., stub traces minted when the daemon's outbound
 * `marshalSaveError` hook fires on a daemon-internal error with no
 * preceding worker push). CLI and chat formatters substitute this
 * value when rendering a trace whose `workerId` is empty.
 *
 * `networkWorkerId(hostId)` is the synthetic prefix used for records
 * pushed by a network caplet that holds the host as its `@agent`
 * powers. The daemon overwrites any caplet-supplied scope with this
 * value so a caplet cannot forge entries under another scope.
 */

/**
 * Synthetic worker-id scope for daemon-internal trace records.
 */
export const DAEMON_WORKER_ID = '@daemon';

/**
 * Build the synthetic worker-id scope for a network caplet attached to
 * the host identified by `hostId`. Callers (the host's reportTrace
 * binding and any test exercising the network code path) import this
 * helper rather than repeating the string literal.
 *
 * @param {string} hostId
 * @returns {string}
 */
export const networkWorkerId = hostId => `@network:${hostId}`;
harden(networkWorkerId);
