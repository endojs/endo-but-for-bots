// @ts-check

import harden from '@endo/harden';

// Screen wake lock policy, kept apart from the component that drives it so the
// awkward parts are testable without a browser.
//
// The awkward parts, all of which are real:
//   - `request()` is async, so the reason for holding the lock can be gone by
//     the time it resolves.
//   - The browser releases the lock ITSELF whenever the page is hidden, and
//     does not restore it. A held handle therefore goes stale on its own, and
//     re-requesting on return only works if that is noticed.
//   - The API is absent on Firefox and pre-16.4 Safari, and `request` rejects
//     outside a secure context. Neither is an error worth surfacing: the app
//     works, the screen just behaves as it always has.

/**
 * @typedef {{
 *   release: () => Promise<void>,
 *   addEventListener: (type: string, listener: () => void) => void,
 * }} SentinelLike
 */

/**
 * @typedef {{ request: (type: string) => Promise<SentinelLike> }} WakeLockApiLike
 */

/**
 * @param {object} io
 * @param {() => WakeLockApiLike | undefined} io.getApi - the platform's
 *   `navigator.wakeLock`, read afresh each time rather than captured, since a
 *   component may outlive a navigation.
 * @param {() => boolean} io.isVisible - whether the page can hold a lock at all.
 * @returns {{ set: (wanted: boolean) => void, refresh: () => void,
 *   isHeld: () => boolean }}
 */
export const makeScreenWakeLock = ({ getApi, isVisible }) => {
  /** @type {SentinelLike | null} */
  let held = null;
  let wanted = false;

  const apply = () => {
    const api = getApi();
    if (!api) return;
    if (!wanted) {
      const sentinel = held;
      held = null;
      if (sentinel) sentinel.release().catch(() => {});
      return;
    }
    // Already holding one, or the page cannot hold one right now. A hidden page
    // is not an error: `refresh()` on becoming visible picks it back up.
    if (held || !isVisible()) return;
    api.request('screen').then(
      sentinel => {
        if (!wanted) {
          // The turn ended (or the component unmounted) while the request was
          // in flight; do not leave a lock nobody asked for still held.
          sentinel.release().catch(() => {});
          return;
        }
        held = sentinel;
        // Drop our handle when the browser releases it on its own, so a later
        // re-request is not skipped as already-held.
        sentinel.addEventListener('release', () => {
          if (held === sentinel) held = null;
        });
      },
      () => {
        // No secure context, or the platform refused. Best effort by design.
      },
    );
  };

  return harden({
    /** @param {boolean} next - whether the app is currently busy */
    set(next) {
      wanted = Boolean(next);
      apply();
    },
    /** Re-evaluate without changing intent (page visibility changed). */
    refresh() {
      apply();
    },
    isHeld() {
      return held !== null;
    },
  });
};
harden(makeScreenWakeLock);
