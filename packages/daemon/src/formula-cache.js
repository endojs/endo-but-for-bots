// @ts-check

/** @import { Context, Formula, MarshalFormula } from './types.js' */

/**
 * Graph metadata never needs a marshal's serialized body. Keep its slots so
 * reachability and retention diagnostics remain complete, and read the body
 * from persistence only for evaluation or formula inspection.
 * @typedef {Exclude<Formula, MarshalFormula> | Omit<MarshalFormula, 'body'>} FormulaMetadata
 */

/**
 * @param {Formula} formula
 * @returns {FormulaMetadata}
 */
export const formulaMetadata = formula =>
  formula.type === 'marshal'
    ? harden({ type: 'marshal', slots: formula.slots })
    : formula;
harden(formulaMetadata);

/**
 * Copy data has no capability identity or maker side effects. Retain its
 * lifecycle context, but only retain an evaluation promise while it is in
 * flight. Subsequent reads reconstruct the data from its durable formula.
 * @param {Context} context
 * @param {() => Promise<unknown>} evaluate
 */
export const makeReloadableController = (context, evaluate) => {
  /** @type {Promise<unknown> | undefined} */
  let pending;
  return harden({
    context,
    get value() {
      context.assertActive();
      if (pending === undefined) {
        const evaluation = Promise.resolve().then(evaluate);
        pending = evaluation;
        void evaluation.catch(context.cancel).catch(() => {});
        const release = () => {
          if (pending === evaluation) pending = undefined;
        };
        void evaluation.then(release, release);
      }
      return pending;
    },
  });
};
harden(makeReloadableController);
