// @ts-check

import './init.js';

/**
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
    const summary = byModel.get(model) || {
      scores: [],
      withinLimits: 0,
    };
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
