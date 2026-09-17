// @ts-check
import { Fail } from '@endo/errors';
import { makeCodexSessionStorage } from './codex-session-storage.js';

/**
 * Durable owner invoked only after the daemon acknowledges native stop.
 * @param {any} stateStorage
 * @param {unknown} _context
 * @param {{env?: Record<string,string>}} [options]
 */
export const make = (stateStorage, _context, { env = {} } = {}) => {
  const workspaceDir = env.CODEX_WORKSPACE_BASE_DIR;
  const mcpDir = env.CODEX_PRIVATE_DIR;
  (workspaceDir && mcpDir) || Fail`Codex storage roots are required`;
  return makeCodexSessionStorage({
    stateStorage,
    roots: { workspaceDir, mcpDir },
  });
};
harden(make);
