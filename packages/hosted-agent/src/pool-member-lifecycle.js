// @ts-check

import { Fail } from '@endo/errors';

/**
 * One module instance's member admission/drain boundary. This is not a
 * cross-worker lock. Credential rotation already admitted must finish its
 * private persistence transaction; only the result crossing this boundary
 * is fenced. Cleanup failures retain their owner for a later close attempt.
 */
export const makePoolMemberLifecycle = () => {
  let stopped = false;
  let uncertainCredential = false;
  /** @type {Set<Promise<any>>} */
  const pending = new Set();
  /** @type {Set<() => void | Promise<void>>} */
  const dependents = new Set();
  const check = () => {
    !uncertainCredential || Fail`Provider subscription credential is uncertain`;
    !stopped || Fail`Provider subscription retired`;
  };
  /**
   * @template T
   * @param {() => T | Promise<T>} operation
   * @param {boolean} [preserveOutcome] A dispatched reset must report its real outcome.
   */
  const run = (operation, preserveOutcome = false) => {
    check();
    const task = (async () => {
      // Register before invoking even a synchronously reentrant adapter.
      await null;
      check();
      const result = await operation();
      if (!preserveOutcome) check();
      return result;
    })();
    pending.add(task);
    return task.finally(() => pending.delete(task));
  };
  /**
   * Conservative until credentials expose a typed safe-retirement outcome:
   * every raw current() failure is sticky, even a transient read failure.
   * Metadata HTTP failures and our own post-fence rejection are not sticky.
   * Durable pendingRefresh remains the authority after process loss.
   * @template T
   * @param {() => T | Promise<T>} operation
   */
  const runCredential = operation =>
    run(async () => {
      try {
        return await operation();
      } catch (error) {
        uncertainCredential = true;
        throw error;
      }
    });
  /** @param {() => void | Promise<void>} cleanup */
  const retain = cleanup => {
    check();
    dependents.add(cleanup);
    return () => dependents.delete(cleanup);
  };
  const fence = () => {
    stopped = true;
  };
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => {
    fence();
    if (closing) return closing;
    closing = (async () => {
      const results = await Promise.allSettled(
        [...dependents].map(async cleanup => {
          await cleanup();
          dependents.delete(cleanup);
        }),
      );
      // Fenced admission makes this set monotonic, including paused renewals.
      await Promise.allSettled([...pending]);
      const failures = results.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (uncertainCredential)
        failures.push(
          Error('Provider credential retirement remains uncertain'),
        );
      if (failures.length) {
        throw AggregateError(failures, 'Provider subscription cleanup pending');
      }
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  return harden({ check, run, runCredential, retain, fence, close });
};
harden(makePoolMemberLifecycle);
