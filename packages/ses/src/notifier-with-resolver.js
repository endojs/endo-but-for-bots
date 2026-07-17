/**
 * @module Synchronous variant of `Promise.withResolvers` for the
 *   star-export notifier wiring used by `module-instance.js`. Provides a
 *   `notify` / `resolve` pair where subscribers attached before the
 *   resolver is settled are queued and replayed once a target notifier is
 *   supplied.
 */

import { arrayPush } from './commons.js';

/**
 * Creates a notifier that defers subscribers until a resolver is invoked,
 * then forwards all subsequent subscribers to a target notifier.
 *
 * This is a synchronous variant of `Promise.withResolvers`: `notify` is the
 * "subscribe" side and `resolve` is the "settle" side. Subscribers attached
 * via `notify(update)` before `resolve(targetNotify)` is called are queued;
 * once `resolve` is called, queued updaters are replayed to the target
 * notifier and subsequent `notify(update)` calls forward directly through.
 *
 * `resolve` is one-shot: the first call settles the resolver to its target,
 * and subsequent calls are no-ops. (This matches `Promise.withResolvers`
 * semantics: a promise settles once.) Callers that need to discover the
 * target lazily may safely call `resolve` again on each `notify`; only the
 * first call has effect.
 *
 * @returns {{
 *   notify: (update: (value: any) => void) => void,
 *   resolve: (targetNotify: (update: (value: any) => void) => void) => void,
 * }}
 */
export const makeNotifierWithResolver = () => {
  /** @type {Array<(value: any) => void>} */
  const pendingUpdaters = [];
  /** @type {((update: (value: any) => void) => void) | undefined} */
  let resolvedTargetNotify;

  const notify = update => {
    if (resolvedTargetNotify === undefined) {
      arrayPush(pendingUpdaters, update);
    } else {
      resolvedTargetNotify(update);
    }
  };

  const resolve = targetNotify => {
    if (resolvedTargetNotify === undefined) {
      resolvedTargetNotify = targetNotify;
      for (const pending of pendingUpdaters) {
        targetNotify(pending);
      }
      pendingUpdaters.length = 0;
    }
  };

  return { notify, resolve };
};
