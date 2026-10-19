// @ts-check

/**
 * Simulated-stall fault injector for the session send queue (Phase 2
 * of designs/ocapn-noise-session-reconnect.md).
 *
 * `wrap` turns a transport instance's write into one that, while the
 * injector is stalled, holds the bytes and returns a promise that
 * settles only on `release`, the way a TCP write blocks on a full send
 * buffer. The bytes reach the underlying write at release time.
 */

/**
 * @import { QueueWrite } from '../src/client/send-queue.js'
 */

export const makeStallInjector = () => {
  let stalled = false;
  /** @type {Array<() => void>} */
  let held = [];
  let stalledWrites = 0;

  /**
   * @param {QueueWrite} write
   * @returns {QueueWrite}
   */
  const wrap = write => bytes => {
    if (!stalled) return write(bytes);
    stalledWrites += 1;
    return new Promise((resolve, reject) => {
      held.push(() => {
        try {
          resolve(write(bytes));
        } catch (error) {
          reject(error);
        }
      });
    });
  };

  return {
    wrap,
    stall: () => {
      stalled = true;
    },
    release: () => {
      stalled = false;
      const toRelease = held;
      held = [];
      for (const go of toRelease) go();
    },
    isStalled: () => stalled,
    getStalledWrites: () => stalledWrites,
  };
};
