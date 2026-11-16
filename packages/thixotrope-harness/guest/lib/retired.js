// @ts-check
/**
 * Recognise a retired break (M1a W1a.1; `designs/m1a-interfaces.md`
 * section 7).
 *
 * When the hub retires a session, every pending answer and every later call
 * to an object of that session rejects with an Error whose message contains
 * this text (`packages/thixotrope/src/net/hub.js:1522` and `:1947`, both
 * `'ocapn hub: the target session has been retired'`). From an adapter
 * object (a host resource's transient object) it means the daemon restarted
 * (D-5); from a guest vat it means that vat is lost (halted or given up,
 * D-17). The text alone cannot tell the two apart: callers classify by the
 * call site (the 15-row table in m1a-interfaces.md section 7) and use this
 * predicate only to recognise the break.
 *
 * Runs in vats and in Node: plain JavaScript, no prelude names.
 */

/** The text the hub breaks a retired session's answers with. */
export const RETIRED_TEXT = 'the target session has been retired';

/**
 * Whether `error` is a retired break: an object whose own or inherited
 * `message` is a string containing `RETIRED_TEXT`. Never throws: a getter
 * that throws, a primitive, or a record without a string message is not a
 * retired break.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export const isRetiredBreak = error => {
  if (typeof error !== 'object' || error === null) return false;
  let message;
  try {
    message = /** @type {{ message?: unknown }} */ (error).message;
  } catch {
    return false;
  }
  return typeof message === 'string' && message.includes(RETIRED_TEXT);
};
harden(isRetiredBreak);
