// @ts-check
/* eslint-disable import/no-extraneous-dependencies */
/**
 * Ax harness for lal: bridges Ax's optimizer API to lal's trial runner.
 *
 * Ax sees one optimizable instruction string (the system prompt). The
 * lal trial runner is what actually executes that prompt against a
 * `PiAgent` over mock guest powers, returning a structured trace.
 */

import './init.js';

import { AxACE, AxBootstrapFewShot, AxGEPA, AxGen } from '@ax-llm/ax';

import { systemPrompt as defaultSystemPrompt } from '../prompts/system.js';
import { scoreObservedTrace } from './trace-metric.js';

/**
 * @typedef {import('./trace-metric.js').TraceEvent} TraceEvent
 * @typedef {import('./trace-metric.js').TraceExample} TraceExample
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
 * mock-powers + PiAgent inner loop.
 */
export class LalPromptProgram extends AxGen {
  /** @type {RunTrial} */
  #runTrial;

  /**
   * @param {RunTrial} runTrial
   * @param {string} [initialSystemPrompt]
   */
  constructor(runTrial, initialSystemPrompt = defaultSystemPrompt) {
    super('prompt:string, attachments:json -> trace:json');
    this.#runTrial = runTrial;
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
    const systemPrompt = this.getInstruction() || defaultSystemPrompt;
    return this.#runTrial({
      example,
      systemPrompt,
      model: example.model,
    });
  }
}

/**
 * @param {'gepa' | 'ace' | 'bootstrap'} kind
 * @param {{ studentAI: unknown, teacherAI?: unknown, rounds?: number }} options
 */
export const makePromptOptimizer = (kind, options) => {
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
 * @param {{ prediction: TrialResult, example: TraceExample }} input
 */
export const traceMetric = ({ prediction, example }) =>
  scoreObservedTrace(prediction.trace, example).score;
harden(traceMetric);
