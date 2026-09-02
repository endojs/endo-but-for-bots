// @ts-check

import harden from '@endo/harden';

/** @import { CommitOutcome, DeferredTask, DeferredTasks, FormulaGraphLockContext } from './types.js' */

/**
 * Classify a name-commit failure.
 * Local validation / authority failures prove no write occurred.
 * Anything else (including CapTP/remote ack loss) is ambiguous.
 *
 * @param {unknown} error
 * @returns {Exclude<CommitOutcome, 'committed'>}
 */
export const classifyCommitError = error => {
  if (error && typeof error === 'object' && 'commitOutcome' in error) {
    const tagged = /** @type {{ commitOutcome?: string }} */ (error)
      .commitOutcome;
    if (tagged === 'rejected-before-write' || tagged === 'ambiguous') {
      return tagged;
    }
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return 'rejected-before-write';
  }
  if (
    error instanceof Error &&
    /pet name|Invalid|must be|not a valid|Unknown pet name|path syntax/i.test(
      error.message,
    )
  ) {
    return 'rejected-before-write';
  }
  return 'ambiguous';
};
harden(classifyCommitError);

/**
 * Rank commit outcomes; higher is worse.
 *
 * @param {CommitOutcome} outcome
 * @returns {number}
 */
const outcomeRank = outcome => {
  if (outcome === 'ambiguous') return 2;
  if (outcome === 'rejected-before-write') return 1;
  return 0;
};

/**
 * Two-phase deferred task collection: preflight (path syntax only) then
 * commit (name writes under the formula-graph lock context).
 *
 * @template {Record<string, string | string[]>} T
 * @returns {DeferredTasks<T>}
 */
export const makeDeferredTasks = () => {
  /** @type {DeferredTask<T>[]} */
  const tasks = [];

  /** @type {DeferredTasks<T>} */
  const collection = {
    preflight: async () => {
      await Promise.all(tasks.map(task => task.preflight()));
    },
    commit: async (identifiers, lockContext) => {
      /** @type {CommitOutcome} */
      let worst = 'committed';
      /** @type {Error | undefined} */
      let firstError;
      const results = await Promise.all(
        tasks.map(async task => {
          try {
            return {
              outcome: /** @type {CommitOutcome} */ (
                await task.commit(
                  /** @type {Readonly<T>} */ (identifiers),
                  lockContext,
                )
              ),
            };
          } catch (error) {
            const outcome = classifyCommitError(error);
            return {
              outcome,
              error: /** @type {Error} */ (error),
            };
          }
        }),
      );
      for (const result of results) {
        if (outcomeRank(result.outcome) > outcomeRank(worst)) {
          worst = result.outcome;
        }
        if (result.error !== undefined && firstError === undefined) {
          firstError = result.error;
        }
      }
      if (worst !== 'committed') {
        const error =
          firstError ||
          Error(
            worst === 'ambiguous'
              ? 'Name commit failed with ambiguous outcome'
              : 'Name commit rejected before write',
          );
        // @ts-expect-error attach outcome for formulateWithCommit
        error.commitOutcome = worst;
        throw error;
      }
      return worst;
    },
    push: task => {
      tasks.push(task);
    },
  };
  return harden(collection);
};
harden(makeDeferredTasks);

/**
 * Structured task that validates a pet-name path in preflight and writes
 * the selected formula identifier at commit time.
 *
 * @template {Record<string, string | string[]>} T
 * @param {(path: string | string[], id: string) => Promise<void>} storeIdentifier
 * @param {string | string[]} petNamePath - already normalized path or name
 * @param {(identifiers: Readonly<T>) => string} selectIdentifier
 * @returns {DeferredTask<T>}
 */
export const makeStoreIdentifierTask = (
  storeIdentifier,
  petNamePath,
  selectIdentifier,
) => {
  // Capture path eagerly so preflight only re-validates shape.
  const path = Array.isArray(petNamePath)
    ? petNamePath.slice()
    : /** @type {string} */ (petNamePath);

  return harden({
    preflight: async () => {
      // Synchronous path-syntax validation only (design milestone 2).
      if (Array.isArray(path)) {
        if (path.length === 0) {
          throw new TypeError('Pet name path must not be empty');
        }
        for (const segment of path) {
          if (typeof segment !== 'string' || segment.length === 0) {
            throw new TypeError(`Invalid pet name path segment: ${segment}`);
          }
        }
      } else if (typeof path !== 'string' || path.length === 0) {
        throw new TypeError(`Invalid pet name: ${path}`);
      }
    },
    commit: async (identifiers, _lockContext) => {
      try {
        await storeIdentifier(path, selectIdentifier(identifiers));
        return /** @type {const} */ ('committed');
      } catch (error) {
        const outcome = classifyCommitError(error);
        // @ts-expect-error attach outcome
        error.commitOutcome = outcome;
        throw error;
      }
    },
  });
};
harden(makeStoreIdentifierTask);

/**
 * Local-guest acceptance retention task: pin a handle during commit.
 * Preflight is a no-op; the caller still owns later `@pins` write and unpin.
 *
 * @template {Record<string, string | string[]>} T
 * @param {(id: import('./types.js').FormulaIdentifier) => void} pinTransient
 * @param {(identifiers: Readonly<T>) => import('./types.js').FormulaIdentifier} selectIdentifier
 * @returns {DeferredTask<T>}
 */
export const makePinTransientTask = (pinTransient, selectIdentifier) =>
  harden({
    preflight: async () => {},
    commit: async (identifiers, _lockContext) => {
      pinTransient(selectIdentifier(identifiers));
      return /** @type {const} */ ('committed');
    },
  });
harden(makePinTransientTask);

/**
 * Empty / no-op task bag element (for producers that push no name write).
 * Kept so empty bags still compile against the structured contract.
 *
 * @template {Record<string, string | string[]>} T
 * @returns {DeferredTask<T>}
 */
export const makeNoOpDeferredTask = () =>
  harden({
    preflight: async () => {},
    commit: async (_identifiers, _lockContext) =>
      /** @type {const} */ ('committed'),
  });
harden(makeNoOpDeferredTask);

/**
 * Store under a single-segment pet name via a local pet store, or under a
 * multi-segment path via a directory hub.
 *
 * @template {Record<string, string | string[]>} T
 * @param {{
 *   storeIdentifier: import('./types.js').StoreController['storeIdentifier'],
 * }} localStore - pet store (or special store) for single-segment names
 * @param {(path: string[], id: string) => Promise<void>} directoryStoreIdentifier
 * @param {string[]} namePath
 * @param {import('./types.js').PetName} leafPetName
 * @param {(identifiers: Readonly<T>) => string} selectIdentifier
 * @returns {DeferredTask<T>}
 */
export const makeLocalOrDirectoryStoreTask = (
  localStore,
  directoryStoreIdentifier,
  namePath,
  leafPetName,
  selectIdentifier,
) => {
  const path = namePath.slice();
  return harden({
    preflight: async () => {
      if (path.length === 0) {
        throw new TypeError('Pet name path must not be empty');
      }
    },
    commit: async (identifiers, _lockContext) => {
      try {
        const id = selectIdentifier(identifiers);
        if (path.length === 1) {
          await localStore.storeIdentifier(leafPetName, id);
        } else {
          await directoryStoreIdentifier(path, id);
        }
        return /** @type {const} */ ('committed');
      } catch (error) {
        const outcome = classifyCommitError(error);
        // @ts-expect-error attach outcome
        error.commitOutcome = outcome;
        throw error;
      }
    },
  });
};
harden(makeLocalOrDirectoryStoreTask);
