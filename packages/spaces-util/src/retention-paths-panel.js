// @ts-check

/** @import { ERef } from '@endo/far' */
/** @import { EndoHost, RetentionPath, RetentionPathDelta } from '@endo/daemon' */

import harden from '@endo/harden';
import { E } from '@endo/far';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { h } from 'preact';
import { renderConfined, unmount } from '@endo/preact-container/renderer';

import { RetentionPathsView, applyRetentionDelta } from './retention-paths.js';

// Trusted host wrapper for the read-only retention-paths panel (design
// `daemon-retention-paths.md` § Chat UI, Phase 4). This is the only part of the
// feature that holds host authority: it resolves a value's endo:// locator,
// subscribes via `EndoHost.followRetentionPaths(locator)`, folds the
// microtask-coalesced `{ snapshot }` / `{ added, removed }` deltas into a live
// ordered set, and re-renders the confined `RetentionPathsView` in place. The
// view itself and the delta engine are pure (`retention-paths.js`).
//
// SUBSCRIPTION RELEASE. Closing the panel drops the far reference to the
// daemon's reader: the consume loop's `disposed` flag breaks the `for await`,
// and `iterateReader`'s return-on-break sends the underlying reader a
// `return()`, so the producer generator returns on its next poll and the
// subscription is released — exactly the handshake the design specifies and the
// inventory's `followNameChanges` consumer uses.
//
// LOCATOR RESOLUTION. `followRetentionPaths` keys on a locator. A value reaches
// the panel with whatever its surface already has: an explicit locator (inbox
// message ids are delivered as locators), a pet-name path (inventory items), or
// a bare formula id (the value modal). `resolveRetentionLocator` derives a
// locator from any of these using ONLY existing host methods — never re-walking
// the formula graph in the UI.

/**
 * A value descriptor: any subset is accepted, resolved in priority order.
 *
 * @typedef {object} RetentionTarget
 * @property {string} [locator] - An already-encoded endo:// locator.
 * @property {string[]} [petNamePath] - A pet-name path from the host root.
 * @property {string} [id] - A bare formula identifier.
 * @property {string} [label] - A human label for the panel header.
 */

/**
 * Resolve a value descriptor to an endo:// locator using only existing host
 * methods. Priority: an explicit locator; else a pet-name path via
 * `locate(...path)`; else a bare id via `reverseIdentify(id)` then
 * `locate(...firstName)`. Returns `undefined` for an ephemeral / unnamed value
 * that has no locator (the panel then shows the unsupported state).
 *
 * @param {ERef<EndoHost>} powers
 * @param {RetentionTarget} target
 * @returns {Promise<string | undefined>}
 */
export const resolveRetentionLocator = async (powers, target) => {
  if (target.locator) {
    return target.locator;
  }
  if (target.petNamePath && target.petNamePath.length > 0) {
    const locator = await E(powers).locate(...target.petNamePath);
    if (locator) return /** @type {string} */ (locator);
  }
  if (target.id) {
    const petNames = await E(powers).reverseIdentify(
      /** @type {Parameters<EndoHost['reverseIdentify']>[0]} */ (
        /** @type {unknown} */ (target.id)
      ),
    );
    const names = Array.isArray(petNames) ? petNames : [];
    if (names.length > 0) {
      const locator = await E(powers).locate(...names[0].split('/'));
      if (locator) return /** @type {string} */ (locator);
    }
  }
  return undefined;
};
harden(resolveRetentionLocator);

/**
 * Derive a one-line panel-header label for a target.
 *
 * @param {RetentionTarget} target
 * @returns {string}
 */
const targetLabel = target => {
  if (target.label) return target.label;
  if (target.petNamePath && target.petNamePath.length > 0) {
    return `@${target.petNamePath.join('/')}`;
  }
  if (target.id) return target.id;
  if (target.locator) return target.locator;
  return 'value';
};

// Static (no interpolation) chrome for the floating panel, so building the
// frame from this string is injection-free. The component owns its own DOM and
// removes it on `dispose()`, carrying no dependency on host markup or IDs.
const PATHS_FRAME_HTML = `
  <div class="retention-paths-panel window" role="dialog" aria-label="Retention paths">
    <div class="retention-paths-header">
      <span class="retention-paths-title"></span>
      <button class="retention-paths-close" aria-label="Close retention paths" title="Close (Esc)">&#215;</button>
    </div>
    <div class="retention-paths-mount"></div>
  </div>
`;

/**
 * Mount the floating retention-paths panel into `$parent`. Returns the imperative
 * API the controller threads as a `showPaths` callback (parallel to the value
 * modal's `showValue`): `showPaths(target, anchor?)` reveals the panel for a
 * value, `dismissPaths` hides it and releases the subscription, and `dispose`
 * tears the frame down.
 *
 * @param {HTMLElement} $parent
 * @param {ERef<EndoHost>} powers
 * @returns {{
 *   showPaths: (target: RetentionTarget, anchor?: { x: number, y: number } | null) => void,
 *   dismissPaths: () => void,
 *   dispose: () => void,
 * }}
 */
export const retentionPathsComponent = ($parent, powers) => {
  const $document = $parent.ownerDocument;
  const $frame = /** @type {HTMLElement} */ ($document.createElement('div'));
  $frame.className = 'frame retention-paths-frame';
  $frame.dataset.show = 'false';
  $frame.innerHTML = PATHS_FRAME_HTML;
  $parent.appendChild($frame);

  const $panel = /** @type {HTMLElement} */ (
    $frame.querySelector('.retention-paths-panel')
  );
  const $title = /** @type {HTMLElement} */ (
    $frame.querySelector('.retention-paths-title')
  );
  const $close = /** @type {HTMLElement} */ (
    $frame.querySelector('.retention-paths-close')
  );
  const $mount = /** @type {HTMLElement} */ (
    $frame.querySelector('.retention-paths-mount')
  );

  /**
   * Monotonic session token. Each `showPaths` bumps it; an in-flight async
   * continuation (locator resolution, a delta) only acts when its captured
   * token still matches, so a stale subscription cannot render over a newer one.
   */
  let session = 0;
  /**
   * The active subscription, when one is running. `disposed` is captured by the
   * consume loop so a parked `await` exits on the next value; `iterator`, once
   * the reader is open, is actively `return()`-ed on dismiss so the far
   * reference drops immediately (rather than only on the next delta), releasing
   * the producer generator on its next poll.
   *
   * @type {{ disposed: boolean, iterator: { return?: () => unknown } | null } | null}
   */
  let active = null;

  const setShown = (/** @type {boolean} */ shown) => {
    $frame.dataset.show = shown ? 'true' : 'false';
  };

  /**
   * @param {'loading' | 'ready' | 'error' | 'unsupported'} state
   * @param {RetentionPath[]} paths
   * @param {string} [error]
   */
  const render = (state, paths, error) => {
    renderConfined(h(RetentionPathsView, { state, paths, error }), $mount);
  };

  // Stop the current subscription: flag the loop and drop the far reference by
  // returning the iterator (which `iterateReader` forwards to the daemon reader,
  // so the producer generator returns on its next poll).
  const stopSubscription = () => {
    if (active) {
      active.disposed = true;
      const { iterator } = active;
      active = null;
      if (iterator && typeof iterator.return === 'function') {
        try {
          Promise.resolve(iterator.return()).catch(() => {});
        } catch {
          // A reader that rejects its return is still released by the broken
          // loop; swallow so dismiss never throws.
        }
      }
    }
  };

  const dismissPaths = () => {
    session += 1;
    stopSubscription();
    setShown(false);
    unmount($mount);
  };

  /**
   * @param {RetentionTarget} target
   * @param {{ x: number, y: number } | null} [anchor]
   */
  const showPaths = (target, anchor = null) => {
    session += 1;
    const mySession = session;
    stopSubscription();

    setShown(true);
    $title.textContent = targetLabel(target);

    // Position the panel near its anchor when one is given; otherwise the CSS
    // centers it. Layout math is intentionally simple: a left/top offset from
    // the anchor point, clamped on the right/bottom by the panel's own width.
    if (anchor && typeof anchor.x === 'number') {
      $panel.style.position = 'fixed';
      $panel.style.left = `${anchor.x}px`;
      $panel.style.top = `${anchor.y}px`;
    } else {
      $panel.style.position = '';
      $panel.style.left = '';
      $panel.style.top = '';
    }

    render('loading', []);

    /** @type {{ disposed: boolean, iterator: { return?: () => unknown } | null }} */
    const loop = { disposed: false, iterator: null };
    active = loop;

    const run = async () => {
      const locator = await resolveRetentionLocator(powers, target);
      if (loop.disposed || mySession !== session) return;
      if (!locator) {
        render('unsupported', []);
        return;
      }

      // The daemon's delta reader is loosely typed (Passable); narrow it at the
      // boundary as the rest of the app does for `follow*` readers.
      const deltas = iterateReader(
        /** @type {Parameters<typeof iterateReader>[0]} */ (
          /** @type {unknown} */ (E(powers).followRetentionPaths(locator))
        ),
      );
      // A dismiss that landed during locator resolution already cleared
      // `active`; release this just-opened reader rather than leaking it.
      if (loop.disposed || mySession !== session) {
        if (typeof deltas.return === 'function') {
          Promise.resolve(deltas.return()).catch(() => {});
        }
        return;
      }
      loop.iterator = deltas;

      /** @type {Map<string, RetentionPath>} */
      let byKey = new Map();
      for await (const rawDelta of deltas) {
        if (loop.disposed || mySession !== session) break;
        const delta = /** @type {RetentionPathDelta} */ (rawDelta);
        byKey = applyRetentionDelta(byKey, delta);
        render('ready', [...byKey.values()]);
      }
    };

    run().catch(err => {
      if (loop.disposed || mySession !== session) return;
      render('error', [], /** @type {Error} */ (err).message);
    });
  };

  const onClose = () => dismissPaths();
  const onFrameClick = (
    /** @type {{ target: EventTarget | null }} */ event,
  ) => {
    if (event.target === $frame) dismissPaths();
  };
  /** @param {KeyboardEvent} event */
  const onKey = event => {
    if (event.key === 'Escape' && $frame.dataset.show === 'true') {
      dismissPaths();
      event.stopPropagation();
    }
  };

  $close.addEventListener('click', onClose);
  $frame.addEventListener('click', onFrameClick);
  $document.addEventListener('keyup', onKey);

  const dispose = () => {
    dismissPaths();
    $close.removeEventListener('click', onClose);
    $frame.removeEventListener('click', onFrameClick);
    $document.removeEventListener('keyup', onKey);
    $frame.remove();
  };

  return harden({ showPaths, dismissPaths, dispose });
};
harden(retentionPathsComponent);
