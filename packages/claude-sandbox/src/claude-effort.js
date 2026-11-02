// @ts-check

import { Fail, q } from '@endo/errors';

/** CLI --effort values verified in Tokyo's pinned Claude Code 2.1.233. */
export const CLAUDE_EFFORTS = harden(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The efforts the pinned Claude Code runtime can drive a model with, and the
 * one it is given when none is chosen. A runtime axis, not the provider's:
 * Anthropic's model list says nothing of effort, and Claude Code's model
 * table does (https://code.claude.com/docs/en/model-config#adjust-effort-level).
 * A Haiku model takes no effort; Sonnet 4.6 all but `xhigh`; the rest all.
 *
 * @param {string} modelId
 * @returns {{ reasoningEfforts: string[], defaultReasoningEffort: string | null }}
 */
export const claudeEffortsFor = modelId => {
  if (modelId.startsWith('claude-haiku-')) {
    return harden({ reasoningEfforts: [], defaultReasoningEffort: null });
  }
  return harden({
    reasoningEfforts:
      modelId === 'claude-sonnet-4-6'
        ? CLAUDE_EFFORTS.filter(effort => effort !== 'xhigh')
        : [...CLAUDE_EFFORTS],
    defaultReasoningEffort: 'max',
  });
};
harden(claudeEffortsFor);

/** @param {unknown} effort */
export const assertClaudeEffort = effort => {
  if (typeof effort !== 'string')
    throw Fail`Claude reasoning effort must be text`;
  CLAUDE_EFFORTS.includes(effort) ||
    Fail`Unsupported Claude reasoning effort ${q(effort)}`;
  return effort;
};
harden(assertClaudeEffort);
