// @ts-check
/**
 * The screen wake lock (`designs/m11-interfaces.md` section 9; P-66,
 * R5-62): held while the mic is on, a reply is audible or the active turn
 * is busy, released otherwise, and asked for again when the page becomes
 * visible (the browser drops the lock on a hidden page and does not give
 * it back). Ported from Endo's `packages/chat/wake-lock.js`.
 *
 * The parts that make this more than one call:
 * - `request()` is async, so the reason to hold the lock can be gone when
 *   it answers: an answer nobody wants any more is released at once;
 * - "already asking" is tracked apart from "holding", so the caller may
 *   call `set` on every state change without stacking requests (each
 *   surplus sentinel would be held by the platform and unreachable);
 * - a sentinel the browser released on its own is forgotten, so the next
 *   `refresh` asks again;
 * - no API (Firefox, older Safari) or a refusal (no secure context) is not
 *   an error: the screen behaves as it always did. A refusal is not
 *   retried until the next change, so a platform that always refuses does
 *   not spin.
 */

/**
 * @typedef {{
 *   release: () => Promise<void>,
 *   addEventListener: (type: string, listener: () => void) => void,
 * }} SentinelLike
 * @typedef {{ request: (type: 'screen') => Promise<SentinelLike> }} WakeLockApiLike
 */

/**
 * Whether the page wants the screen kept on.
 *
 * @param {{ micOn: boolean, audible: boolean, busy: boolean }} state
 */
export const wakeWanted = ({ micOn, audible, busy }) =>
  Boolean(micOn || audible || busy);
harden(wakeWanted);

/**
 * @param {object} io
 * @param {() => WakeLockApiLike | undefined} io.getApi
 *   `navigator.wakeLock`, read afresh each time
 * @param {() => boolean} io.isVisible whether the page can hold a lock now
 */
export const makeScreenWakeLock = ({ getApi, isVisible }) => {
  /** @type {SentinelLike | null} */
  let held = null;
  let asking = false;
  let wanted = false;

  const apply = () => {
    if (!wanted) {
      // Before the API check: a lock taken must be droppable even when the
      // API has since gone.
      const sentinel = held;
      held = null;
      if (sentinel) sentinel.release().catch(() => {});
      return;
    }
    const api = getApi();
    if (!api || held || asking || !isVisible()) return;
    asking = true;
    api.request('screen').then(
      sentinel => {
        asking = false;
        if (!wanted) {
          sentinel.release().catch(() => {});
          return;
        }
        held = sentinel;
        sentinel.addEventListener('release', () => {
          if (held === sentinel) held = null;
        });
      },
      () => {
        asking = false;
      },
    );
  };

  return harden({
    /** @param {boolean} next whether the page is busy */
    set(next) {
      wanted = Boolean(next);
      apply();
    },
    /** The page's visibility changed: ask again if still wanted. */
    refresh() {
      apply();
    },
    isHeld: () => held !== null,
  });
};
harden(makeScreenWakeLock);
