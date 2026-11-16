// @ts-check

// Channel IDs are uint32 on the wire. Clients allocate the upper half and
// relays allocate the lower half so a peer can dial and accept concurrently.
// Keep allocation monotonic: reusing a closed ID could route delayed frames
// from an old connection into a new connection.
/**
 * @param {number} first
 * @param {number} last
 * @returns {() => number | undefined}
 */
export const makeChannelIdAllocator = (first, last) => {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1 ||
    last > 0xffff_ffff ||
    first > last
  )
    throw new Error('Invalid relay channel ID range');
  let next = first;
  return () => {
    if (next > last) return undefined;
    const id = next;
    next += 1;
    return id;
  };
};
