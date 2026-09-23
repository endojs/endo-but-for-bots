// @ts-check

/** @import { DeferredTasks, DeferredTask } from './types.js' */

/**
 * @template {Record<string, string | string[]>} T
 * @returns {DeferredTasks<T>}
 */
export const makeDeferredTasks = () => {
  /** @type {DeferredTask<T>[]} */
  const tasks = [];

  return {
    execute: async param => {
      // A rejection must not let callers release construction pins while a
      // sibling publication still uses them. Capture synchronous throws too.
      const results = await Promise.allSettled(
        tasks.map(async task => task(/** @type {Readonly<T>} */ (param))),
      );
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
    push: task => {
      tasks.push(task);
    },
  };
};
