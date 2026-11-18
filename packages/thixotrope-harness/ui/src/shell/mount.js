// @ts-check
/**
 * Mount the shell into a page element and keep it drawn: one top-level
 * render per batch of controller notifications (an animation frame in the
 * browser), and again when the window crosses `drawerMaxWidthPx` (R6-61).
 */
import { h, render } from 'preact';

import { drawerMaxWidthPx } from '../../../resources/agent-host/impl/gateway/contract-m3.js';
import { App } from './App.js';

/** @import { UiFeature } from '../../../resources/agent-host/impl/gateway/contract-m3.js' */
/** @import { ShellViews } from './App.js' */

/** The media query of the drawer layout. */
export const narrowQuery = `(max-width: ${drawerMaxWidthPx}px)`;

/**
 * @param {object} options
 * @param {any} options.root the element to render into
 * @param {any} options.controller
 * @param {readonly UiFeature[]} options.features
 * @param {ShellViews} [options.views]
 * @param {any} [options.window] `globalThis` (for `matchMedia` and
 *   `requestAnimationFrame`)
 * @param {(fn: () => void) => void} [options.schedule] when to draw after
 *   a change (tests: at once)
 */
export const mount = ({
  root,
  controller,
  features,
  views = {},
  window = globalThis,
  schedule,
}) => {
  const query =
    typeof window.matchMedia === 'function'
      ? window.matchMedia(narrowQuery)
      : undefined;
  let narrow = query ? Boolean(query.matches) : false;
  const later =
    schedule ??
    (typeof window.requestAnimationFrame === 'function'
      ? (/** @type {() => void} */ fn) => window.requestAnimationFrame(fn)
      : (/** @type {() => void} */ fn) => {
          Promise.resolve().then(fn);
        });
  let mounted = true;
  const draw = () => {
    if (!mounted) return;
    render(h(App, { controller, features, views, narrow }), root);
  };
  let queued = false;
  const request = () => {
    if (queued) return;
    queued = true;
    later(() => {
      queued = false;
      draw();
    });
  };
  const unsubscribe = controller.subscribe(request);
  /** @param {{ matches: boolean }} event */
  const onChange = event => {
    narrow = Boolean(event.matches);
    request();
  };
  if (query && typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
  }
  draw();
  return {
    draw,
    unmount: () => {
      mounted = false;
      unsubscribe();
      if (query && typeof query.removeEventListener === 'function') {
        query.removeEventListener('change', onChange);
      }
      render(null, root);
    },
  };
};
