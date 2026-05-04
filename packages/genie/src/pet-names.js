// @ts-check

/**
 * Pet names the genie launcher (`packages/genie/setup.js`) and root
 * worker (`packages/genie/main.js`) agree on at the host pet-store
 * boundary.  Kept in one module so the two files cannot drift on the
 * spelling.
 *
 * Each name is the operator-visible identifier the launcher pins under
 * the daemon's host agent — `setup.js` populates them on first
 * `bottle.sh invoke`, and `main.js` resolves them from `powers` on boot
 * (see `TADA/22_endo_posix_sandbox_phase3_5a_genie_workspace.md`
 * § Decisions 1 + 3 for the rationale: the slice is minted main-side
 * because `MakeCapletOptionsShape` has no `introducedNames` channel
 * today, so the supporting capabilities must live in the host pet
 * store rather than be threaded through `makeUnconfined`'s `env`).
 */

/**
 * Pet name under which the host agent pins the workspace `Mount`
 * capability covering `GENIE_WORKSPACE`.  `setup.js` calls
 * `provideMount` to create it; `main.js` looks it up to thread into
 * the sandbox slice's `mounts: [{ cap, innerPath: '/workspace',
 * mode: 'rw' }]` array.
 */
export const WORKSPACE_MOUNT_NAME = 'workspace-mount';
harden(WORKSPACE_MOUNT_NAME);

/**
 * Pet name under which the host agent pins the `SandboxFactory` exo
 * returned by `@endo/sandbox`'s `make-unconfined` entry point.
 * `setup.js` registers it; `main.js` resolves it on boot to mint the
 * workspace slice.
 */
export const SANDBOX_FACTORY_NAME = 'sandbox-factory';
harden(SANDBOX_FACTORY_NAME);

/**
 * Pet name `main.js` passes to `SandboxFactory.makePersistent` so the
 * resulting `SandboxHandle` is GC-pinned and reincarnated on daemon
 * restart from the same recorded spec
 * (`TADA/33_endo_genie_sandbox_persist_slice.md`).
 *
 * Setup-side code does not reference this name — only the worker mints
 * the slice — but it is centralised here so a future setup-side hook
 * (e.g. a `forgetPersistent` cleanup) can use the same identifier
 * without re-deriving it.
 */
export const SANDBOX_SLICE_NAME = 'main-genie-sandbox';
harden(SANDBOX_SLICE_NAME);

/**
 * Pet-name pattern `spawnAgent` passes to
 * `SandboxFactory.makePersistent` for a child agent's sub-slice and
 * that `removeChildAgent` resolves on teardown so a still-running
 * child cannot race the guest removal and resurrect itself via its
 * own pet store
 * (TADA/23 Decision 2 — flat `<agentName>-sandbox` keyspace,
 * deliberately parallel to `SANDBOX_SLICE_NAME` for the root genie
 * rather than scoped under the parent's `agentDirectory`).
 *
 * Centralised here so the spawn helper (sub-task
 * [`TODO/51_endo_genie_subagent_fork_slice.md`](../../../TODO/51_endo_genie_subagent_fork_slice.md))
 * and the dispose path (sub-task
 * [`TODO/55_endo_genie_subagent_remove.md`](../../../TODO/55_endo_genie_subagent_remove.md))
 * derive the same identifier from `agentName` rather than re-spelling
 * the `${agentName}-sandbox` template.
 *
 * @param {string} agentName - Pet name of the child agent.  No
 *   validation here; the daemon's `provideGuest` and the sandbox
 *   plugin's `makePersistent` both enforce the pet-name shape
 *   (`/^[a-z0-9][a-z0-9-]{0,127}$/`) at their respective boundaries.
 * @returns {string} The flat slice-handle pet name
 *   (`<agentName>-sandbox`).
 */
export const subAgentSliceName = agentName => `${agentName}-sandbox`;
harden(subAgentSliceName);
