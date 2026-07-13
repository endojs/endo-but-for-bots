// @ts-check
/* eslint-disable import/no-extraneous-dependencies */
/**
 * Ax harness for the agentry prompt optimizer.
 *
 * Ax sees one optimizable instruction string (the system prompt). The
 * consumer's trial runner is what actually executes that prompt against
 * the agent under test (over its mock powers or otherwise), returning a
 * structured trace.
 */

import './init.js';

import { AxACE, AxBootstrapFewShot, AxGEPA, AxGen } from '@ax-llm/ax';

import { scoreObservedTrace } from './trace-metric.js';

/**
 * @typedef {import('./trace-metric.js').TraceEvent} TraceEvent
 * @typedef {import('./trace-metric.js').TraceExample} TraceExample
 * @typedef {import('@ax-llm/ax').AxAIService<
 *   unknown,
 *   unknown,
 *   string
 * >} AxAIService
 * @typedef {import('@ax-llm/ax').AxMetricFn} AxMetricFn
 *
 * @typedef {object} TrialResult
 * @property {TraceEvent[]} trace
 * @property {string} [replyText]
 * @property {string} [workerLog]
 *
 * @typedef {(input: {
 *   example: TraceExample,
 *   systemPrompt: string,
 *   model?: string,
 * }) => Promise<TrialResult>} RunTrial
 */

/**
 * One trial per Ax `forward(...)` call. Ax owns the
 * instruction-mutation outer loop; the trial runner owns the
 * mock-powers + agent inner loop.
 *
 * The caller supplies the initial system prompt; agentry does not own a
 * default. lal passes `prompts/system.js`'s baseline.
 */
export class AgentryPromptProgram extends AxGen {
  /** @type {RunTrial} */
  #runTrial;

  /** @type {string} */
  #defaultSystemPrompt;

  /**
   * @param {RunTrial} runTrial
   * @param {string} initialSystemPrompt
   */
  constructor(runTrial, initialSystemPrompt) {
    super('prompt:string, attachments:json -> trace:json');
    this.#runTrial = runTrial;
    this.#defaultSystemPrompt = initialSystemPrompt;
    this.setInstruction(initialSystemPrompt);
  }

  /**
   * @param {unknown} _ai
   * @param {TraceExample & {
   *   prompt?: string | string[],
   *   attachments?: object[],
   *   model?: string,
   * }} example
   */
  async forward(_ai, example) {
    const systemPrompt = this.getInstruction() || this.#defaultSystemPrompt;
    return this.#runTrial({
      example,
      systemPrompt,
      model: example.model,
    });
  }
}

/**
 * @param {'gepa' | 'ace' | 'bootstrap'} kind
 * @param {{ studentAI: AxAIService, teacherAI?: AxAIService, rounds?: number }} options
 */
export const makePromptOptimizer = (kind, options) => {
  /** @type {{ studentAI: AxAIService, teacherAI?: AxAIService }} */
  const common = harden({
    studentAI: options.studentAI,
    teacherAI: options.teacherAI,
  });
  switch (kind) {
    case 'ace':
      return new AxACE(common, {
        maxEpochs: options.rounds || 1,
        maxReflectorRounds: 1,
      });
    case 'bootstrap':
      return new AxBootstrapFewShot({
        ...common,
        options: {
          maxRounds: options.rounds || 1,
          maxDemos: 4,
        },
      });
    case 'gepa':
    default:
      return new AxGEPA({
        ...common,
        numTrials: options.rounds || 4,
        minibatch: true,
        minibatchSize: 3,
        earlyStoppingTrials: 2,
        sampleCount: 1,
      });
  }
};
harden(makePromptOptimizer);

/**
 * Metric Ax calls with each candidate's prediction + the example.
 *
 * @type {AxMetricFn}
 */
export const traceMetric = ({ prediction, example }) =>
  scoreObservedTrace(
    /** @type {TrialResult} */ (prediction).trace,
    /** @type {TraceExample} */ (example),
  ).score;
harden(traceMetric);
