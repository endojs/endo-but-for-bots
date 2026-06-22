// @ts-check

/**
 * Retention policy for an un-named formula returned by `evaluate` (the
 * formula is already pinned as a transient root inside `formulateEval`).
 *
 * Without `retainUntil` the result is **ephemeral**: the transient pin is
 * released as soon as the value resolves, which triggers collection (an
 * un-named result with no other root is reclaimed immediately). This keeps
 * one-shot evaluations (e.g. `endo eval expr`) from leaking a formula.
 *
 * With `retainUntil` the transient pin is **held until the caller's promise
 * settles** (resolve or reject) — the ephemeral-root sibling of
 * `resultName`. This lets a caller hold an un-named result long enough to
 * compose it by reference (e.g. pass an eval'd powers exo as `powers` to
 * `makeUnconfined`), after which a durable dependency edge roots it and the
 * caller settles the promise to drop the transient pin. The retention is
 * in-memory, so it is lost on daemon restart — which is harmless, because
 * by then any durable edge that captured the result has been persisted.
 *
 * @param {(id: import('./types.js').FormulaIdentifier) => void} unpinTransient
 * @returns {(
 *   id: import('./types.js').FormulaIdentifier,
 *   value: unknown,
 *   retainUntil: Promise<unknown> | undefined,
 * ) => Promise<unknown>}
 */
export const makeRetainUnnamed =
  unpinTransient => async (id, value, retainUntil) => {
    let resolved;
    try {
      resolved = await value;
    } catch (error) {
      // The evaluation itself failed — release the pin rather than leak it.
      unpinTransient(id);
      throw error;
    }
    if (retainUntil === undefined) {
      // Ephemeral: drop the pin now (this triggers collection).
      unpinTransient(id);
    } else {
      // Hold the pin until the caller's retention promise settles, either
      // way. A remote promise rejects when its connection drops, so the
      // pin is also released if the holder disconnects.
      Promise.resolve(retainUntil).then(
        () => unpinTransient(id),
        () => unpinTransient(id),
      );
    }
    return resolved;
  };
harden(makeRetainUnnamed);
