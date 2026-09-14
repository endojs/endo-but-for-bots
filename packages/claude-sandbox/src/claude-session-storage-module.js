// @ts-check

/**
 * The `claude-sandbox/session-storage` caplet: the durable storage owner the
 * daemon session owner records as each session's `storage` role and invokes
 * as `remove(planText)` inside record removal. To be minted by
 * `setup-hosted.js` (nothing mints it yet) with the state provider as its
 * sole powers, so removal of the session's persistent Claude config directory
 * keeps that provider's ownership-marker checks.
 *
 * Formula env (to be set by `setup-hosted.js`; no process fallback):
 *   CLAUDE_WORKSPACE_BASE_DIR  Root of per-session workspace storage.
 *   CLAUDE_MCP_DIR             Root of per-session private socket parents.
 *
 * @module
 */

import { Fail } from '@endo/errors';
import { makeSessionStorage } from '@endo/hosted-agent/session-storage.js';

import { readClaudeSessionPlan } from './claude-session-plan.js';

/**
 * @param {any} stateStorage The state provider facet supplied as powers.
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (stateStorage, _context, { env = {} } = {}) => {
  const { CLAUDE_WORKSPACE_BASE_DIR: workspaceDir, CLAUDE_MCP_DIR: mcpDir } =
    env;
  (typeof workspaceDir === 'string' && workspaceDir !== '') ||
    Fail`CLAUDE_WORKSPACE_BASE_DIR is required`;
  (typeof mcpDir === 'string' && mcpDir !== '') ||
    Fail`CLAUDE_MCP_DIR is required`;
  return makeSessionStorage({
    stateStorage,
    roots: harden({ workspaceDir, mcpDir }),
    readPlan: readClaudeSessionPlan,
  });
};
harden(make);
