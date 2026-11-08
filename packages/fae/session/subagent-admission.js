// @ts-check

/**
 * Reserve delegation capacity before provisioning can yield. The registry is
 * the durable source of live children; reservations cover the gap before a
 * creating entry is published. Count the union so publication never charges
 * twice. A failed cleanup stays in the registry and continues to consume space.
 *
 * @param {{getSessions: () => any[], maxSubagents: number, maxDepth: number}} options
 */
export const makeSubagentAdmission = ({
  getSessions,
  maxSubagents,
  maxDepth,
}) => {
  /** @type {Map<string, {rootId: string, parentId: string, done: Promise<void>}>} */
  const pending = new Map();
  /** @param {string} parentId @param {string} name */
  const keyFor = (parentId, name) => JSON.stringify([parentId, name]);

  /** @param {string} parentId */
  const lineage = parentId => {
    const sessions = new Map(getSessions().map(entry => [entry.id, entry]));
    const seen = new Set();
    let id = parentId;
    for (;;) {
      const entry = sessions.get(id);
      if (!entry || (entry.lifecycle || 'ready') !== 'ready') {
        throw Error('Parent session no longer accepts delegation');
      }
      if (seen.has(id)) throw Error('Invalid delegation ancestry');
      seen.add(id);
      if (!entry.parentSessionId) return { rootId: id, depth: seen.size };
      id = entry.parentSessionId;
    }
  };

  return harden({
    /** @param {string} parentId @param {string} name @param {number} depth */
    reserve(parentId, name, depth) {
      const { rootId, depth: actualDepth } = lineage(parentId);
      if (depth !== actualDepth || actualDepth > maxDepth) {
        throw Error(
          `Subagent depth limit of ${maxDepth} reached; finish the task yourself.`,
        );
      }
      const key = keyFor(parentId, name);
      const sessions = getSessions();
      if (
        pending.has(key) ||
        sessions.some(
          entry =>
            entry.parentSessionId === parentId && entry.subagentName === name,
        )
      ) {
        throw Error(`Subagent "${name}" already exists.`);
      }
      const descendants = new Set([rootId]);
      let previousSize;
      do {
        previousSize = descendants.size;
        for (const entry of sessions) {
          if (descendants.has(entry.parentSessionId)) descendants.add(entry.id);
        }
      } while (descendants.size !== previousSize);
      const live = sessions.filter(
        entry => entry.id !== rootId && descendants.has(entry.id),
      );
      const publishedKeys = new Set(
        live.map(entry => keyFor(entry.parentSessionId, entry.subagentName)),
      );
      // Count every durable row, including duplicate names left by an older
      // incarnation. Only reservations overlapping a published row are free.
      let occupied = live.length;
      for (const [reservedKey, reservation] of pending) {
        if (reservation.rootId === rootId && !publishedKeys.has(reservedKey))
          occupied += 1;
      }
      if (occupied >= maxSubagents) {
        throw Error(
          `Subagent tree limit of ${maxSubagents} reached; use existing helpers or finish the task yourself.`,
        );
      }
      /** @type {() => void} */
      let finish = () => {};
      /** @type {Promise<void>} */
      const done = new Promise(resolve => {
        finish = () => resolve(undefined);
      });
      pending.set(key, { rootId, parentId, done });
      let released = false;
      return harden({
        assertParent: () => lineage(parentId),
        release: () => {
          if (released) return;
          released = true;
          pending.delete(key);
          finish();
        },
      });
    },
    // Deletion fences the parent first, then drains its in-flight creations.
    // Those creations see the fence and roll back before this wait completes.
    /** @param {string} parentId */
    waitForChildren: parentId =>
      Promise.all(
        [...pending.values()]
          .filter(reservation => reservation.parentId === parentId)
          .map(reservation => reservation.done),
      ),
  });
};
harden(makeSubagentAdmission);
