// @ts-check
/**
 * Per-model rollup utilities for matrix evaluation.
 *
 * `expandExamplesByModel` clones the examples once per requested model
 * so the trial runner can iterate over a single (example, model)
 * cartesian product. `summarizeModelTrials` groups trial scores by
 * model and reports avg / min / within-limits / count.
 *
 * The whitelist `KNOWN_MODELS` is a small, intentional set: cheap
 * defaults the baseline-scoring engagement should reach for first. Add
 * larger / pricier models behind explicit `--eval-models=` opt-in.
 */

import './init.js';

/**
 * A short whitelist of models the optimizer knows about. The CLI will
 * accept any model the underlying provider accepts; this list exists so
 * the default `--evaluate` run picks a cheap, broadly-available model
 * when no `--eval-models=` arg is passed.
 *
 * @type {readonly string[]}
 */
export const KNOWN_MODELS = harden([
  'google/gemini-2.0-flash',
  'google/gemini-2.5-flash',
  'anthropic/claude-haiku-4-5',
  'openai/gpt-4o-mini',
]);
harden(KNOWN_MODELS);

/** @type {string} */
export const DEFAULT_MODEL = KNOWN_MODELS[0];
harden(DEFAULT_MODEL);

/**
 * Expand a flat example list into a (model, example) cross product.
 * When `models` is empty, returns the examples unchanged so a single
 * default-model run does not over-iterate.
 *
 * @template {object} E
 * @param {E[]} examples
 * @param {string[]} models
 * @returns {Array<E & { model?: string }>}
 */
export const expandExamplesByModel = (examples, models) =>
  models.length > 0
    ? models.flatMap(model => examples.map(example => ({ ...example, model })))
    : examples.map(example => ({ ...example }));
harden(expandExamplesByModel);

/**
 * Reduce a flat list of trial results into per-model rollup. Each
 * trial's `score.score` and `score.withinLimits` are aggregated.
 *
 * @param {Array<{
 *   model?: string,
 *   score: { score: number, withinLimits: boolean },
 * }>} trials
 */
export const summarizeModelTrials = trials => {
  /** @type {Map<string, { scores: number[], withinLimits: number }>} */
  const byModel = new Map();
  for (const trial of trials) {
    const model = trial.model || '<default>';
    const summary = byModel.get(model) || { scores: [], withinLimits: 0 };
    summary.scores.push(trial.score.score);
    if (trial.score.withinLimits) {
      summary.withinLimits += 1;
    }
    byModel.set(model, summary);
  }
  const modelSummaries = [...byModel.entries()].map(([model, summary]) => ({
    model,
    examples: summary.scores.length,
    averageScore:
      summary.scores.reduce((total, score) => total + score, 0) /
      summary.scores.length,
    minimumScore: Math.min(...summary.scores),
    withinLimits: summary.withinLimits,
  }));
  const averageScore =
    modelSummaries.reduce((total, summary) => total + summary.averageScore, 0) /
    Math.max(modelSummaries.length, 1);
  const minimumScore =
    modelSummaries.length > 0
      ? Math.min(...modelSummaries.map(summary => summary.minimumScore))
      : 0;
  return harden({
    averageScore,
    minimumScore,
    byModel: modelSummaries,
  });
};
harden(summarizeModelTrials);
