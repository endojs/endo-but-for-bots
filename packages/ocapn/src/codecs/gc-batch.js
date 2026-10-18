// @ts-check
import harden from '@endo/harden';

/**
 * Coalesce consecutive GC notices without moving them past ordinary messages.
 * The 64-position cap bounds buffering; positions and wire deltas retain order.
 * The caller chooses the flush boundary (microtask or synchronous transaction).
 * @param {(message: Record<string, any>) => void} emit
 */
export const makeGcBatcher = emit => {
  /** @type {Record<string, any> | undefined} */
  let pending;
  const flush = () => {
    if (!pending) return;
    const message = pending;
    pending = undefined;
    // A thrown emit has ambiguous acceptance. Propagate it; never retry a
    // decrement under a new transport identity merely because emit threw.
    emit(harden(message));
  };
  /** @param {Record<string, any>} message */
  const send = message => {
    const answers = message.type === 'op:gc-answers';
    const exports = message.type === 'op:gc-exports';
    if (!answers && !exports) {
      flush();
      emit(message);
      return;
    }
    const positions = answers
      ? message.answerPositions
      : message.exportPositions;
    // Let the normal codec preserve synchronous errors for malformed input,
    // and preserve explicit empty-list sends rather than hiding them.
    if (
      !Array.isArray(positions) ||
      positions.length === 0 ||
      !positions.every(n => typeof n === 'bigint' && n >= 0n) ||
      (exports &&
        (!Array.isArray(message.wireDeltas) ||
          message.wireDeltas.length !== positions.length ||
          !message.wireDeltas.every(n => typeof n === 'bigint' && n > 0n)))
    ) {
      flush();
      emit(message);
      return;
    }
    if (pending && pending.type !== message.type) flush();
    for (let i = 0; i < positions.length; i += 1) {
      if (!pending)
        pending = answers
          ? { type: message.type, answerPositions: [] }
          : { type: message.type, exportPositions: [], wireDeltas: [] };
      if (answers) pending.answerPositions.push(positions[i]);
      else {
        pending.exportPositions.push(positions[i]);
        pending.wireDeltas.push(message.wireDeltas[i]);
      }
      if ((pending.answerPositions ?? pending.exportPositions).length === 64)
        flush();
    }
  };
  return harden({ send, flush, hasPending: () => pending !== undefined });
};
harden(makeGcBatcher);
