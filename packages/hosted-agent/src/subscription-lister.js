// @ts-check
/* global setTimeout, clearTimeout */

/**
 * What a broker says a session may be pinned to, asked at most every half
 * minute and for at most five seconds.
 *
 * "Could not ask" is not "none". A broker that answers, or that is from
 * before it could (it has no such method), is believed. A broker that could
 * not be reached leaves the last answer standing, and with no answer yet the
 * failure is the caller's to handle: a descriptor then says nothing about
 * subscriptions, and a pinned session is refused for that reason and not as
 * an unknown subscription.
 *
 * @module
 */

/**
 * @typedef {{ id: string, label: string, pinnedOnly?: boolean }} DeclaredSubscription
 */

/**
 * @param {() => Promise<DeclaredSubscription[]>} ask The broker service's
 *   `subscriptions()`.
 * @param {object} [options]
 * @param {string} [options.label] The adapter's name for messages.
 * @param {() => number} [options.now]
 * @returns {() => Promise<DeclaredSubscription[]>}
 */
export const makeSubscriptionLister = (
  ask,
  { label = 'Hosted', now = Date.now } = {},
) => {
  /** @type {DeclaredSubscription[] | undefined} */
  let known;
  let knownAt = -Infinity;
  return async () => {
    await null;
    if (known !== undefined && now() - knownAt < 30_000) return known;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
      const answer = await Promise.race([
        ask(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(Error(`${label} broker did not answer in time`)),
            5000,
          );
        }),
      ]);
      known = harden(Array.isArray(answer) ? [...answer] : []);
      knownAt = now();
      return known;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/has no method|is not a function/i.test(message)) {
        known = harden([]);
        knownAt = now();
        return known;
      }
      if (known !== undefined) return known;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
};
harden(makeSubscriptionLister);
