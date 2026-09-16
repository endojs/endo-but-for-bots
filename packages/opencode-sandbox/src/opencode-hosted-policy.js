// @ts-check

/**
 * OpenCode's half of the shared hosted-agent contract.
 *
 * Every adapter runs under the same attested policy — the same controls,
 * namespaces and limit ceilings, verified by the same code in
 * `@endo/hosted-agent/hosted-agent-policy.js`. What an adapter brings is the
 * mount table its CLI needs, and that is all this module is.
 *
 * OpenCode's table is the shape the unification argues for: the workspace is a
 * 9P projection of the session's worktree, the CLI's own home and the MCP
 * socket directory are host binds attested as host binds, and the writable
 * scratch is declared tmpfs rather than whatever `--read-only-tmpfs` happened
 * to give. `HOME` lives on `/tmp`, so that ceiling is load-bearing rather than
 * a formality.
 *
 * The state row is a bind rather than a projection because opencode forces
 * SQLite WAL, which needs a local filesystem — the one constraint that rules
 * out carrying every adapter's state over 9P.
 *
 * @module
 */

import { makeHostedAgentPolicyVerifier } from '@endo/hosted-agent/hosted-agent-policy.js';

/** Where the CLI's own data directory lives in the slice (`XDG_DATA_HOME`). */
export const STATE_PATH = '/opencode-state';
/** Where the MCP socket directory is bound, read-only. */
export const MCP_PATH = '/endo-mcp';

export const OPENCODE_FIXED_MOUNTS = harden([
  { role: 'workspace', kind: 'session', destination: '/workspace', mode: 'rw' },
  {
    role: 'opencode-state',
    kind: 'session',
    destination: STATE_PATH,
    mode: 'rw',
  },
  // The bridge's socket and its stdio shim. Read-only: the guest connects to
  // the socket, and nothing it does should be able to replace the shim it
  // runs.
  { role: 'mcp', kind: 'session', destination: MCP_PATH, mode: 'ro' },
  { role: 'tmp', kind: 'tmpfs', destination: '/tmp', mode: 'rw' },
  { role: 'run', kind: 'tmpfs', destination: '/run', mode: 'rw' },
]);

const opencodePolicy = makeHostedAgentPolicyVerifier({
  fixedMounts: OPENCODE_FIXED_MOUNTS,
});

export const assertContainerMounts = opencodePolicy.assertContainerMounts;
export const assertHostedAgentPolicyV1 =
  opencodePolicy.assertHostedAgentPolicyV1;
