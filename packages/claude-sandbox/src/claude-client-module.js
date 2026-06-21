// @ts-check
/* global process */

/**
 * Per-session `ClaudeClient` caplet.
 *
 * The factory provisions one of these per "Create Claude Sandbox"
 * submission via `makeUnconfined`, so the resulting exo is a
 * first-class formulated Endo capability with a real daemon identity —
 * which is what lets `@host` store it under a pet name and reincarnate
 * it across daemon restarts.
 *
 * Why the client (not the factory) owns the slice and mount: an
 * `@endo/sandbox` slice and the `@endo/9p-server` mount handle are
 * worker-local remotables with no formula identity, so they cannot be
 * passed across a formula boundary into a separately-formulated client.
 * Instead this module re-creates them itself, lazily, from its `env`:
 * the first `send()` (or an `initialPrompt`) mounts the workspace and
 * mints the slice; subsequent daemon restarts reincarnate the formula
 * and re-provision on demand. The workspace and the conversation
 * persist in the `Filesystem` cap, and the (possibly peer-hosted)
 * credential is re-materialised at spawn time, so no secret ever lands
 * in the formula `env`.
 *
 * Expected env (set by the factory; all strings):
 *   SESSION_ID            Stable session id (the mount path + pet names
 *                         derive from it, so it must survive restarts).
 *   CREATED_AT            ISO timestamp (diagnostic).
 *   FILESYSTEM_NAME       Pet name of the workspace `Filesystem` cap in
 *                         @host's petstore.
 *   SANDBOX_FACTORY_NAME  Pet name of the `@endo/sandbox` factory
 *                         (default `sandbox-factory`).
 *   FS_MOUNTER_NAME       Pet name of the `@endo/9p-server` mounter
 *                         (default `fs-mounter`).
 *   WORKSPACE_MOUNT_POINT Host path the workspace 9P mount lives at.
 *   WORKSPACE_PET_NAME    Pet name to register the workspace Mount cap
 *                         under.
 *   WORKSPACE_PATH        Slice-internal workspace path (default
 *                         `/workspace`).
 *   BACKEND               Sandbox backend (default `podman`).
 *   NETWORK               Sandbox network profile (default `private`).
 *   CLAUDE_ROOTFS         Raw `rootfs` form value (may be empty).
 *   DEFAULT_IMAGE         Default OCI image when CLAUDE_ROOTFS is blank.
 *   MODEL                 Optional claude model id.
 *   CREDENTIALS_NAME      Optional pet name of a `ClaudeCredentials`
 *                         cap.
 *   INITIAL_PROMPT        Optional one-shot prompt fired on creation.
 *
 * This caplet runs with `@agent` (full host authority): it looks up the
 * factory / mounter / filesystem / credential caps by pet name, mounts
 * the workspace, and calls the privileged `provideMount`. Scoping that
 * down to a per-session guest profile that introduces only those caps
 * is tracked as future work (DESIGN.md).
 *
 * @module
 */

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';

import { makeClaudeClient } from './claude-client.js';
import { parseRootfs, rootfsLabel } from './parse-rootfs.js';

/**
 * Map a credential kind to the environment variable Claude Code reads
 * it from inside the slice. See `claude-sandbox-factory.js` for the
 * peer-hosted, short-lived-secret rationale.
 */
const CREDENTIAL_ENV_VARS = harden({
  apiKey: 'ANTHROPIC_API_KEY',
  oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
});

/**
 * Capture the caplet's cancellation promise from whatever shape the
 * daemon hands us as `context`: a context presence exposes
 * `whenCancelled()`; an in-process context exposes a `cancelled`
 * promise; `null`/absent means "no teardown signal".
 *
 * Note: we return the promise *captured into a local*, not via an
 * `async` return — an `async` return would adopt (flatten) the
 * cancellation promise, so the caller would hang until cancellation
 * instead of receiving the still-pending promise to subscribe to.
 *
 * @param {any} resolvedContext
 * @returns {Promise<never> | null}
 */
const cancellationPromiseOf = resolvedContext => {
  if (!resolvedContext) return null;
  if (typeof resolvedContext.whenCancelled === 'function') {
    return E(resolvedContext).whenCancelled();
  }
  if (resolvedContext.cancelled) {
    return resolvedContext.cancelled;
  }
  return null;
};

/**
 * Per-session ClaudeClient caplet entry point.
 *
 * @param {import('@endo/eventual-send').FarRef<object>} powers - The
 *   `@agent` host authority. Tests pass a mock host agent exposing
 *   `lookup` and `provideMount`.
 * @param {Promise<object> | object | undefined} context - The daemon
 *   cancellation context. When the formula is cancelled or collected,
 *   the session is torn down (container disposed, workspace unmounted).
 * @param {{ env?: Record<string, string> }} [contextWrapper]
 * @returns {object}
 */
export const make = (powers, context, contextWrapper = {}) => {
  /** @type {any} */
  const hostAgent = powers;
  const env = contextWrapper.env ?? process.env;

  const sessionId = env.SESSION_ID;
  if (!sessionId) {
    throw makeError(X`claude-client-module: SESSION_ID required`);
  }
  const filesystemName = env.FILESYSTEM_NAME;
  if (!filesystemName) {
    throw makeError(X`claude-client-module: FILESYSTEM_NAME required`);
  }
  const workspaceMountPoint = env.WORKSPACE_MOUNT_POINT;
  if (!workspaceMountPoint) {
    throw makeError(X`claude-client-module: WORKSPACE_MOUNT_POINT required`);
  }

  const createdAt = env.CREATED_AT || new Date().toISOString();
  const sandboxFactoryName = env.SANDBOX_FACTORY_NAME || 'sandbox-factory';
  const fsMounterName = env.FS_MOUNTER_NAME || 'fs-mounter';
  const workspacePetName =
    env.WORKSPACE_PET_NAME || `claude-${sessionId}-workspace`;
  const workspacePath = env.WORKSPACE_PATH || '/workspace';
  const backend = env.BACKEND || 'podman';
  const network = env.NETWORK || 'private';
  const model = env.MODEL || undefined;
  const credentialsName = env.CREDENTIALS_NAME || undefined;
  const initialPrompt = env.INITIAL_PROMPT || undefined;

  // Parse (and validate) the rootfs synchronously so a bad value fails
  // at construction rather than on first use.
  const parsedRootfs = parseRootfs(env.CLAUDE_ROOTFS, {
    defaultImage: env.DEFAULT_IMAGE || undefined,
  });

  /**
   * Lazily mount the workspace and mint the slice. Run once on first
   * use and memoized by `makeClaudeClient`.
   *
   * @returns {Promise<{ slice: any, mountHandle: { unmount: () => Promise<void> } }>}
   */
  const provision = async () => {
    const sandboxFactory = await E(hostAgent).lookup(sandboxFactoryName);
    const fsMounter = await E(hostAgent).lookup(fsMounterName);
    const fs = await E(hostAgent).lookup(filesystemName);
    if (!fs) {
      throw makeError(X`Unknown filesystem: ${q(filesystemName)}`);
    }

    // Materialise the credential immediately before it flows into the
    // slice env. The cap may live on a remote peer; the host only ever
    // receives the short-lived secret it mints here.
    /** @type {Record<string, string>} */
    const credentialEnv = {};
    if (credentialsName) {
      const credCap = await E(hostAgent).lookup(credentialsName);
      if (!credCap) {
        throw makeError(X`Unknown credentials: ${q(credentialsName)}`);
      }
      let kind = 'apiKey';
      try {
        // eslint-disable-next-line no-underscore-dangle
        const methodNames = await E(credCap).__getMethodNames__();
        if (methodNames.includes('kind')) {
          kind = await E(credCap).kind();
        }
      } catch {
        // No introspection surface; treat as an API key.
      }
      const envVar = CREDENTIAL_ENV_VARS[kind];
      if (!envVar) {
        throw makeError(
          X`Unknown credential kind ${q(kind)}; expected one of ${q(
            Object.keys(CREDENTIAL_ENV_VARS).join(', '),
          )}`,
        );
      }
      const issuedCred = await E(credCap).issue(sessionId);
      credentialEnv[envVar] = await E(issuedCred).materialise();
    }

    // Mount the FS over 9P on the host, register the mountpoint as a
    // daemon Mount cap, then mint the slice with it bound at the
    // workspace path. On any failure after the mount, release it
    // rather than leak a mounted filesystem.
    const mountHandle = await E(fsMounter).mount(
      fs,
      workspaceMountPoint,
      harden({ lazyUnmount: true }),
    );
    try {
      const workspaceCap = await E(hostAgent).provideMount(
        workspaceMountPoint,
        workspacePetName,
      );
      const slice = await E(sandboxFactory).make(
        harden({
          rootfs: parsedRootfs,
          mounts: [
            {
              cap: workspaceCap,
              innerPath: workspacePath,
              mode: 'rw',
            },
          ],
          network,
          env: credentialEnv,
          cwd: workspacePath,
          backend,
        }),
      );
      return harden({ slice, mountHandle });
    } catch (error) {
      try {
        await E(mountHandle).unmount();
      } catch {
        // best-effort
      }
      throw error;
    }
  };

  const client = makeClaudeClient({
    sessionId,
    createdAt,
    provision,
    workspaceMountPoint,
    workspacePath,
    backend,
    rootfsLabel: rootfsLabel(parsedRootfs),
    model,
    initialPrompt,
  });

  // Tear down on cancellation/collection. `cancel` is transient (the
  // formula persists and reincarnates after a daemon restart, then
  // re-provisions on the next send); `remove`/GC additionally deletes
  // the formula. Either way the container and 9P mount must be released
  // — `terminate()` does exactly that and is a no-op when nothing was
  // provisioned, so a never-used session cancels for free.
  const armTeardown = async () => {
    const resolvedContext = context ? await context : null;
    const cancelled = cancellationPromiseOf(resolvedContext);
    if (!cancelled) return;
    // The cancellation promise settles (resolves, or rejects with the
    // cancel reason) when the formula is cancelled or collected.
    // Normalize both settlements to a resolution, then tear down.
    await cancelled.then(
      () => {},
      () => {},
    );
    await client.terminate();
  };
  armTeardown().catch(() => {});

  return client;
};
harden(make);
