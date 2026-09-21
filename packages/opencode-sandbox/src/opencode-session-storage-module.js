// @ts-check

/**
 * The `opencode-sandbox/session-storage` caplet: the durable storage owner the
 * daemon session owner records as each session's optional `storage` role and
 * invokes as `remove(planText)` inside record removal. Minted by
 * `setup-hosted.js` with null powers. OpenCode has no durable CLI state;
 * its conversation is restored from the stack's transcript.
 *
 * Formula env (set by `setup-hosted.js`; no process fallback):
 *   OPENCODE_WORKSPACE_BASE_DIR  Root of per-session workspace storage.
 *   OPENCODE_MCP_DIR             Root of per-session private socket parents.
 *
 * @module
 */

import { Fail } from '@endo/errors';

import { makeOpencodeSessionStorage } from './opencode-session-storage.js';

/**
 * @param {null | Promise<null>} powers Slot-free constructor powers.
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, _context, { env = {} } = {}) => {
  const supplied = await powers;
  supplied === null || Fail`OpenCode session storage requires null powers`;
  const {
    OPENCODE_WORKSPACE_BASE_DIR: workspaceDir,
    OPENCODE_MCP_DIR: mcpDir,
  } = env;
  (typeof workspaceDir === 'string' && workspaceDir !== '') ||
    Fail`OPENCODE_WORKSPACE_BASE_DIR is required`;
  (typeof mcpDir === 'string' && mcpDir !== '') ||
    Fail`OPENCODE_MCP_DIR is required`;
  return makeOpencodeSessionStorage({
    roots: harden({ workspaceDir, mcpDir }),
  });
};
harden(make);
