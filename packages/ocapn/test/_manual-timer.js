// @ts-check

import harden from '@endo/harden';

/**
 * A manually advanced clock satisfying `HeartbeatTimer`.
 */
export const makeManualTimer = () => {
  let now = 0;
  let nextId = 0;
  /** @type {Map<number, { at: number, callback: () => void }>} */
  const pending = new Map();
  const timer = harden({
    setTimeout: (callback, delayMs) => {
      nextId += 1;
      pending.set(nextId, { at: now + delayMs, callback });
      return nextId;
    },
    clearTimeout: handle => {
      pending.delete(handle);
    },
  });
  /** @param {number} ms */
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      let dueId;
      let due;
      for (const [id, entry] of pending) {
        if (entry.at <= end && (!due || entry.at < due.at)) {
          dueId = id;
          due = entry;
        }
      }
      if (!due) break;
      pending.delete(/** @type {number} */ (dueId));
      now = due.at;
      due.callback();
    }
    now = end;
  };
  return { timer, advance, pendingCount: () => pending.size };
};
