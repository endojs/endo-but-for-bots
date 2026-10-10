// @ts-check

import harden from '@endo/harden';

// Screen wake lock policy, kept apart from the component that drives it so the
// awkward parts are testable without a browser.
//
// The awkward parts, all of which are real:
//   - `request()` is async, so the reason for holding the lock can be gone by
//     the time it resolves.
//   - `request()` being async also means "am I already holding one?" is not the
//     same question as "have I already asked?". The driver here is `notify()`,
//     which fires per repaint — at animation-frame rate while the mic is open —
//     so several requests overlap one resolution unless asking is tracked
//     separately from holding. Each surplus sentinel would be overwritten and
//     leaked: held by the platform, unreachable by us, never released.
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
 * `'screen'` is the only lock type the platform defines, and typing it that
 * narrowly is what lets the real `navigator.wakeLock` satisfy this.
 *
 * @typedef {{ request: (type: 'screen') => Promise<SentinelLike> }} WakeLockApiLike
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
  // Whether a `request()` is outstanding. Distinct from `held` on purpose: see
  // the second awkward part above.
  let asking = false;
  let wanted = false;

  const apply = () => {
    if (!wanted) {
      // Releasing needs the sentinel, not the API, so it comes before the
      // availability check: a lock already taken must be droppable even if
      // `getApi()` has since stopped answering.
      const sentinel = held;
      held = null;
      if (sentinel) sentinel.release().catch(() => {});
      return;
    }
    const api = getApi();
    if (!api) return;
    // Already holding one, already asking for one, or the page cannot hold one
    // right now. A hidden page is not an error: `refresh()` on becoming visible
    // picks it back up.
    if (held || asking || !isVisible()) return;
    asking = true;
    api.request('screen').then(
      sentinel => {
        asking = false;
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
        // Deliberately not retried here: a platform that always refuses would
        // spin.
        asking = false;
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
