// @ts-check
import harden from '@endo/harden';

/**
 * A diagnostic channel with a path. The three level names are the ones an
 * OCapN client expects, so a `Logger` can be handed to `makeOcapn` as its
 * `logger` directly instead of being re-wrapped at each call site:
 *
 * - `log` is a user-facing view's own output, and belongs to views alone;
 * - `info` is protocol tracing, emitted per frame and per session step;
 * - `error` is a diagnostic a library should report whether or not anyone
 *   asked for tracing.
 *
 * Every channel is supplied by the host, so no module in between decides
 * to throw one away. A host that wants no tracing says so once, where it
 * composes its powers, rather than each library writing its own no-op.
 *
 * `sub` extends the logger's path and prepends it to every line as one
 * bracketed token, so `logging.sub('thixotrope', 'daemon')` writes
 * `[thixotrope:daemon] ...`. Filtering a log by subsystem is then a
 * substring match, and a caller stops repeating a literal prefix argument
 * at every call site. The path is a value, so a subsystem can extend it
 * further with a run-time name such as a worker id.
 *
 * @typedef {object} Logger
 * @property {readonly string[]} path
 * @property {(...args: unknown[]) => void} log
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} error
 * @property {(...path: string[]) => Logger} sub
 */

/**
 * @param {{ log: Logger['log'], info: Logger['info'], error: Logger['error'] }} write
 * @param {string[]} path
 * @returns {Logger}
 */
const makeLogger = (write, path) => {
  const prefix = path.length === 0 ? [] : [`[${path.join(':')}]`];
  /** @param {'log' | 'info' | 'error'} level */
  const at =
    level =>
    (...args) =>
      write[level](...prefix, ...args);
  return harden({
    path: harden([...path]),
    log: at('log'),
    info: at('info'),
    error: at('error'),
    sub: (...more) => makeLogger(write, [...path, ...more]),
  });
};

/**
 * @param {object} host
 * @param {Logger['log']} host.log
 * @param {Logger['info']} host.info pass the same function as `error` to
 *   merge the channels, or a no-op to run without tracing
 * @param {Logger['error']} host.error
 * @returns {Logger}
 */
export const makeLogPowers = ({ log, info, error }) =>
  makeLogger(harden({ log, info, error }), []);
harden(makeLogPowers);

/**
 * Discards every line at every level. A caller that deliberately wants no
 * output says so with this instead of assembling anonymous no-ops, which
 * are easy to mistake for a level that was overlooked.
 *
 * @type {Logger}
 */
export const silentLogger = makeLogPowers({
  log: () => {},
  info: () => {},
  error: () => {},
});
harden(silentLogger);
