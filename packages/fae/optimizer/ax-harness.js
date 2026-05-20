// @ts-check
/* eslint-disable import/no-extraneous-dependencies */

import './init.js';

import { AxACE, AxBootstrapFewShot, AxGEPA, AxGen } from '@ax-llm/ax';

import {
  guestSystemPromptSections,
  makeGuestSystemPrompt,
} from '../src/system-prompt.js';
import { scoreObservedTrace } from './trace-metric.js';

/**
 * @typedef {import('./trace-metric.js').ObservedTrace} ObservedTrace
 * @typedef {import('./trace-metric.js').TraceExample} TraceExample
 *
 * @typedef {object} TrialResult
 * @property {ObservedTrace} trace
 * @property {string} [workerLog]
 * @property {string} [replyText]
 * @property {boolean} [timedOut]
 *
 * @typedef {(input: {
 *   example: TraceExample,
 *   adoptionSection: string,
 *   systemPrompt: string,
 *   model?: string,
 * }) => Promise<TrialResult>} RunTrial
 */

/**
 * Ax sees one optimizable instruction string; the Fae runner sees the full
 * assembled system prompt plus the smoke example to execute.
 */
export class FaePromptProgram extends AxGen {
  /** @type {RunTrial} */
  #runTrial;

  /**
   * @param {RunTrial} runTrial
   * @param {string} [adoptionSection]
   */
  constructor(runTrial, adoptionSection = guestSystemPromptSections.adoption) {
    super('prompt:string, attachments:json -> trace:json');
    this.#runTrial = runTrial;
    this.setInstruction(adoptionSection);
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
    const adoptionSection =
      this.getInstruction() || guestSystemPromptSections.adoption;
    return this.#runTrial({
      example,
      adoptionSection,
      systemPrompt: makeGuestSystemPrompt({ adoption: adoptionSection }),
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
 * @param {{ prediction: TrialResult, example: TraceExample }} input
 */
export const traceMetric = ({ prediction, example }) =>
  scoreObservedTrace(prediction.trace, example, {
    timedOut: prediction.timedOut,
  }).score;
harden(traceMetric);
