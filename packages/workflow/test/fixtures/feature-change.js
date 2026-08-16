// @ts-check

/* eslint-disable no-template-curly-in-string -- ${context.x} is the workflow template DSL, not a JS template literal */
/**
 * The design document's motivating definition: implement -> fan-out
 * review -> CI -> human approval -> merge, with changes-requested and
 * red-CI loops back to implementation.
 *
 * Mirrors `designs/endo-workflow.md` § "Definitions".
 */

import harden from '@endo/harden';

/** @import { WorkflowDefinition } from '../../src/types.js' */

/** @type {WorkflowDefinition} */
export const featureChange = harden({
  name: 'feature-change',
  version: 1,
  participants: {
    implementer: { description: 'coding agent handle' },
    reviewers: { description: 'specialist reviewer handles', many: true },
    ci: { description: 'CI runner' },
    approver: { description: 'human agent handle for the approval form' },
    repo: { description: 'Git writer facet scoped to the feature branch' },
  },
  input: { request: 'M.string()', branch: 'M.string()' },
  attenuators: ['readOnly'],
  initial: 'implementing',
  states: {
    implementing: {
      entry: [
        {
          effect: 'request',
          to: 'implementer',
          description:
            'Implement: ${context.request} on ${context.branch}',
          attach: ['repo'],
          as: 'implementation',
        },
      ],
      on: {
        'effect.settled': {
          when: { as: 'implementation' },
          assign:
            '({ context, event }) => ({ ...context, changeSetId: event.ref })',
          target: 'reviewing',
        },
        'effect.rejected': {
          when: { as: 'implementation' },
          target: 'failed',
        },
      },
    },
    reviewing: {
      entry: [
        {
          effect: 'fanout',
          to: 'reviewers',
          description: 'Review change set ${context.changeSetId}',
          attach: ['repo:readOnly'],
          as: 'reviews',
          join: 'all',
        },
      ],
      after: { ms: 604_800_000, target: 'abandoned' },
      on: {
        'fanout.joined': [
          {
            when: { as: 'reviews' },
            guard:
              '({ event }) => event.results.every(r => r.verdict === "approve")',
            target: 'testing',
          },
          {
            when: { as: 'reviews' },
            assign:
              '({ context, event }) => ({ ...context, feedback: event.results })',
            target: 'implementing',
          },
        ],
      },
    },
    testing: {
      entry: [
        {
          effect: 'call',
          to: 'ci',
          method: 'run',
          as: 'ci-run',
          retry: { max: 2, backoff: 'exponential' },
        },
      ],
      on: {
        'effect.settled': { when: { as: 'ci-run' }, target: 'approving' },
        'effect.rejected': {
          when: { as: 'ci-run' },
          target: 'implementing',
        },
      },
    },
    approving: {
      entry: [
        {
          effect: 'form',
          to: 'approver',
          description: 'Merge ${context.branch}? Reviews and CI passed.',
          fields: [{ name: 'decision', label: 'Approve merge?' }],
          as: 'approval',
        },
      ],
      after: { ms: 604_800_000, target: 'abandoned' },
      on: {
        'form.value': [
          {
            when: { as: 'approval' },
            guard: '({ event }) => event.values.decision === "yes"',
            target: 'merging',
          },
          { when: { as: 'approval' }, target: 'abandoned' },
        ],
      },
    },
    merging: {
      entry: [
        {
          effect: 'call',
          to: 'repo',
          method: 'merge',
          as: 'merge',
        },
      ],
      on: {
        'effect.settled': { when: { as: 'merge' }, target: 'done' },
        'effect.rejected': { when: { as: 'merge' }, target: 'failed' },
      },
    },
    done: { final: 'succeeded' },
    abandoned: { final: 'abandoned' },
    failed: { final: 'failed' },
  },
});

export const featureChangeParticipants = harden({
  implementer: 'lal-coder',
  reviewers: ['sec-reviewer', 'style-reviewer'],
  ci: 'repo-ci',
  approver: 'SELF',
  repo: 'repo-writer',
});
