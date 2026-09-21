// @ts-check

import { Fail, q } from '@endo/errors';

/** CLI --effort values verified in Tokyo's pinned Claude Code 2.1.233. */
export const CLAUDE_EFFORTS = harden(['low', 'medium', 'high', 'xhigh', 'max']);
harden(CLAUDE_EFFORTS);

/** @param {unknown} effort */
export const assertClaudeEffort = effort => {
  if (typeof effort !== 'string')
    throw Fail`Claude reasoning effort must be text`;
  CLAUDE_EFFORTS.includes(effort) ||
    Fail`Unsupported Claude reasoning effort ${q(effort)}`;
  return effort;
};
harden(assertClaudeEffort);
