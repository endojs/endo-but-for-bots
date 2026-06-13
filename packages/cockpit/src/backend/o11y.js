// @ts-check
//
// Observability: tokens, turns, and cost aggregated per thread, per template,
// and per model (designs/garden-cockpit.md § Observability). The mock engine
// is free; a real provider's price table would slot into COST_PER_MTOK.

/** @type {Record<string, { input: number, output: number }>} */
const COST_PER_MTOK = {
  mock: { input: 0, output: 0 },
};

const blank = () => ({ tokens: 0, turns: 0, threads: 0, cost: 0 });

/**
 * @param {object} options
 * @param {{ list: () => Array<{ templateName: string, engineKind: string, o11y: { tokens: number, turns: number } }> }} options.registry
 */
export const makeO11y = ({ registry }) => {
  const summary = () => {
    const total = blank();
    /** @type {Record<string, ReturnType<typeof blank>>} */
    const byTemplate = {};
    /** @type {Record<string, ReturnType<typeof blank>>} */
    const byModel = {};
    for (const t of registry.list()) {
      const price = COST_PER_MTOK[t.engineKind] || { input: 0, output: 0 };
      const cost = (t.o11y.tokens / 1_000_000) * price.output;
      for (const bucket of [
        total,
        (byTemplate[t.templateName] ||= blank()),
        (byModel[t.engineKind] ||= blank()),
      ]) {
        bucket.tokens += t.o11y.tokens;
        bucket.turns += t.o11y.turns;
        bucket.threads += 1;
        bucket.cost += cost;
      }
    }
    return { total, byTemplate, byModel };
  };
  return { summary };
};
