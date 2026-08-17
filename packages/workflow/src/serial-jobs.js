// @ts-check

/**
 * A minimal serial job queue: `enqueue(job)` runs jobs strictly one at a
 * time in arrival order and returns each job's own settlement. The run
 * engine serializes every journal append through one of these, the same
 * discipline the daemon's mailbox uses for message numbering.
 */

/**
 * @returns {{ enqueue: <T>(job: () => Promise<T> | T) => Promise<T> }}
 */
export const makeSerialJobs = () => {
  let tail = Promise.resolve();
  return harden({
    enqueue: job => {
      const result = tail.then(() => job());
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  });
};
harden(makeSerialJobs);
