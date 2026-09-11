// @ts-check
/// <reference types="ses"/>

/* eslint-disable no-await-in-loop */

/** @import { AgentEvent } from '@earendil-works/pi-agent-core' */
/** @import { EvalCondition, EvalMatrixAggregate, EvalMatrixModel, EvalMatrixResult, EvalMatrixRow, GitScenarioSpec, ReadText, RunGitScenarioResult } from './types.js' */
/** @import { ThinkingLevel } from '../harness/types.js' */

import { runGitScenarioUnder } from './run.js';

/**
 * @param {number[]} values
 * @returns {number}
 */
const mean = values =>
  values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;

/**
 * @param {number[]} values
 * @returns {number}
 */
const median = values => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[midpoint];
  }
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
};

/**
 * @param {{ provider?: string, id?: string, name?: string }} model
 * @returns {string}
 */
const modelDisplayName = model =>
  model.name || `${model.provider || 'model'}/${model.id || 'unknown'}`;

/**
 * @param {EvalMatrixRow[]} rows
 * @returns {EvalMatrixAggregate[]}
 */
export const aggregateEvalMatrixRows = rows => {
  /** @type {Map<string, EvalMatrixRow[]>} */
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.scenario, row.condition, row.model]);
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  return harden(
    [...groups.values()].map(group => {
      const [{ scenario, condition, model }] = group;
      const tokenValues = group.map(row => row.metrics.usage.totalTokens);
      const turnValues = group.map(row => row.metrics.turns);
      const wallTimeValues = group.map(row => row.metrics.wallTimeMs);
      return harden({
        scenario,
        condition,
        model,
        runs: group.length,
        passRate:
          group.filter(row => row.pass).length / Math.max(group.length, 1),
        meanTokens: mean(tokenValues),
        medianTokens: median(tokenValues),
        meanTurns: mean(turnValues),
        medianTurns: median(turnValues),
        meanWallTimeMs: mean(wallTimeValues),
        medianWallTimeMs: median(wallTimeValues),
      });
    }),
  );
};
harden(aggregateEvalMatrixRows);

/**
 * @param {number} value
 * @returns {string}
 */
const fixedOne = value => value.toFixed(1);

/**
 * @param {number} value
 * @returns {string}
 */
const percent = value => `${(value * 100).toFixed(0)}%`;

/**
 * @param {EvalMatrixAggregate[]} aggregates
 * @returns {string}
 */
export const renderEvalMatrixMarkdownTable = aggregates => {
  const lines = [
    '| scenario | condition | model | runs | pass rate | mean tokens | median tokens | mean turns | median turns | mean wall ms | median wall ms |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const aggregate of aggregates) {
    lines.push(
      `| ${aggregate.scenario} | ${aggregate.condition} | ${aggregate.model} | ${aggregate.runs} | ${percent(
        aggregate.passRate,
      )} | ${fixedOne(aggregate.meanTokens)} | ${fixedOne(
        aggregate.medianTokens,
      )} | ${fixedOne(aggregate.meanTurns)} | ${fixedOne(
        aggregate.medianTurns,
      )} | ${fixedOne(aggregate.meanWallTimeMs)} | ${fixedOne(
        aggregate.medianWallTimeMs,
      )} |`,
    );
  }
  return `${lines.join('\n')}\n`;
};
harden(renderEvalMatrixMarkdownTable);

/**
 * @param {object} options
 * @param {GitScenarioSpec[]} options.scenarios
 * @param {EvalCondition[]} options.conditions
 * @param {EvalMatrixModel[]} options.models
 * @param {number} [options.repeats]
 * @param {ReadText} options.readText
 * @param {ThinkingLevel} [options.thinkingLevel]
 * @param {(event: AgentEvent, context: { scenario: string, condition: string, model: string, repeat: number }) => void | Promise<void>} [options.onEvent]
 * @returns {Promise<EvalMatrixResult>}
 */
export const runEvalMatrix = async ({
  scenarios,
  conditions,
  models,
  repeats = 1,
  readText,
  thinkingLevel,
  onEvent,
}) => {
  if (!Number.isFinite(repeats) || !Number.isInteger(repeats) || repeats < 1) {
    throw new Error('repeats must be a positive finite integer');
  }
  /** @type {EvalMatrixRow[]} */
  const rows = [];
  await null; // safe-await-separator
  for (const scenarioSpec of scenarios) {
    for (const condition of conditions) {
      for (const modelEntry of models) {
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
          const scenario = scenarioSpec.makeScenario();
          const requirements = scenario.requirements || harden({});
          const repo = await scenarioSpec.provisionRepo({
            scenario,
            requirements,
          });
          const runScenario = repo.scenario || scenario;
          try {
            const result = /** @type {RunGitScenarioResult} */ (
              await runGitScenarioUnder(condition, {
                model: modelEntry.model,
                workspace: repo.workspace,
                git: repo.git,
                shell: repo.shell,
                scenario: runScenario,
                readText,
                getApiKey: modelEntry.getApiKey,
                thinkingLevel,
                onEvent:
                  onEvent === undefined
                    ? undefined
                    : event =>
                        onEvent(event, {
                          scenario: scenarioSpec.name || scenario.name,
                          condition: condition.name,
                          model:
                            modelEntry.name ||
                            modelDisplayName(modelEntry.model),
                          repeat,
                        }),
              })
            );
            rows.push(
              harden({
                scenario: scenarioSpec.name || runScenario.name,
                condition: condition.name,
                model: modelEntry.name || modelDisplayName(modelEntry.model),
                repeat,
                pass: result.outcome.pass,
                metrics: result.metrics,
                outcome: result.outcome,
              }),
            );
          } finally {
            await repo.cleanup?.();
          }
        }
      }
    }
  }
  const modelNames = models.map(
    modelEntry => modelEntry.name || modelDisplayName(modelEntry.model),
  );
  const providers = [
    ...new Set(models.map(modelEntry => modelEntry.model.provider)),
  ].sort();
  return harden({
    provenance: harden({
      recordedAt: new Date().toISOString(),
      providers: harden(providers),
      models: harden(modelNames),
    }),
    rows: harden(rows),
    aggregates: aggregateEvalMatrixRows(rows),
  });
};
harden(runEvalMatrix);
