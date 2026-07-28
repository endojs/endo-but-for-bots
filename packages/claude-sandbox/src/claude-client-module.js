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
 * Expected env (set by the factory; all strings). The caps the client
 * needs are passed by reference through `powers`, **not** by pet name, so
 * no cap-name env vars appear here:
 *   SESSION_ID            Stable session id (the mount path + pet names
 *                         derive from it, so it must survive restarts).
 *   CREATED_AT            ISO timestamp (diagnostic).
 *   WORKSPACE_MOUNT_POINT Host path the workspace 9P mount lives at (also
 *                         the only path `provideMount` will accept).
 *   WORKSPACE_PET_NAME    Pet name to register the workspace Mount cap
 *                         under.
 *   WORKSPACE_PATH        Slice-internal workspace path (default
 *                         `/workspace`).
 *   CONFIG_MOUNT_POINT    Host path the persistent Claude config 9P mount
 *                         lives at (present only when a dedicated config
 *                         filesystem was provisioned; its presence enables
 *                         cross-restart conversation persistence).
 *   CONFIG_PET_NAME       Pet name for the config Mount cap.
 *   CLAUDE_CONFIG_INNER_DIR Slice-internal mount path for the config dir
 *                         (default `/claude-config`); also CLAUDE_CONFIG_DIR.
 *   CLAUDE_CONFIG_HOST_DIR Plain host backing directory of the config
 *                         filesystem, read directly at construction to detect
 *                         a pre-restart transcript worth resuming.
 *   BACKEND               Sandbox backend (default `podman`).
 *   NETWORK               Sandbox network profile (default `private`).
 *   CLAUDE_ROOTFS         Raw `rootfs` form value (may be empty).
 *   DEFAULT_IMAGE         Default OCI image when CLAUDE_ROOTFS is blank.
 *   MODEL                 Optional claude model id.
 *   INITIAL_PROMPT        Optional one-shot prompt fired on creation.
 *
 * This caplet does **not** run with `@agent`. The factory builds a
 * **per-session powers** cap (factory.js, via `evaluate`) that is a total
 * attenuation: it bundles the four caps the client needs **by reference**
 * and exposes only `sandboxFactory()` / `fsMounter()` / `filesystem()` /
 * `credentials()` accessors plus a `provideMount(path, name)` bounded to
 * *this session's* workspace mountpoint. There is **no `lookup`**, so the
 * client cannot resolve any host name beyond its own four caps, and cannot
 * reach `makeUnconfined`, `remove`, `provideHostPath`, `provideGuest`,
 * etc. See DESIGN.md § Known issue #8.
 *
 * @module
 */

import { existsSync, readdirSync } from 'node:fs';
import nodePath from 'node:path';

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';

import { makeClaudeClient } from './claude-client.js';
import { parseRootfs, rootfsLabel } from './parse-rootfs.js';

/** @import { FarRef } from '@endo/eventual-send' */

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
 * Create a cancellation context kit: an in-process passable context and
 * a `cancel` function that triggers it. The context exposes
 * `whenCancelled()` — the same method the daemon's live context presence
 * exposes — so tests and callers can use one consistent shape.
 *
 * @returns {{ context: { whenCancelled: () => Promise<never> }, cancel: (reason?: Error) => void }}
 */
export const makeCancellationKit = () => {
  /** @type {(reason: Error) => void} */
  let rejectCancelled;
  const cancelled = /** @type {Promise<never>} */ (
    new Promise((_resolve, reject) => {
      rejectCancelled = reject;
    })
  );
  // Suppress unhandled-rejection noise: the promise is meant to stay pending
  // until cancel() is called, after which callers drain it.
  cancelled.catch(() => {});
  const cancel = (reason = new Error('Cancelled')) => rejectCancelled(reason);
  const context = harden({ whenCancelled: () => cancelled });
  return harden({ context, cancel });
};
harden(makeCancellationKit);

/**
 * Capture the caplet's cancellation promise from the daemon-context
 * passable shape. A context presence exposes `whenCancelled()`.
 * `null`/absent means no teardown signal.
 *
 * Note: we return the promise captured into a local, not via an
 * `async` return. An `async` return would adopt (flatten) the
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
  return null;
};

/**
 * Per-session ClaudeClient caplet entry point.
 *
 * @param {FarRef<object>} powers - The
 *   `@agent` host authority. Tests pass a mock host agent exposing
 *   `lookup` and `provideMount`.
 * @param {Promise<object> | object | undefined} context - The daemon
 *   cancellation context. When the formula is cancelled or collected,
 *   the session is torn down (container disposed, workspace unmounted).
 * @param {{ env?: Record<string, string> }} [contextWrapper]
 * @returns {object}
 */
export const make = (powers, context, contextWrapper = {}) => {
  // The per-session powers cap (factory.js builds it via `evaluate`): a
  // total attenuation that exposes only `sandboxFactory()` / `fsMounter()`
  // / `filesystem()` / `credentials()` accessors (the caps bundled by
  // reference at creation) and a `provideMount(path, name)` bounded to
  // *this session's* workspace mountpoint. There is no `lookup`, so the
  // client cannot reach any host name beyond its four caps.
  /** @type {any} */
  const sessionPowers = powers;
  const env = contextWrapper.env ?? process.env;

  const sessionId = env.SESSION_ID;
  if (!sessionId) {
    throw makeError(X`claude-client-module: SESSION_ID required`);
  }
  const workspaceMountPoint = env.WORKSPACE_MOUNT_POINT;
  if (!workspaceMountPoint) {
    throw makeError(X`claude-client-module: WORKSPACE_MOUNT_POINT required`);
  }

  const createdAt = env.CREATED_AT || new Date().toISOString();
  const workspacePetName =
    env.WORKSPACE_PET_NAME || `claude-${sessionId}-workspace`;
  const workspacePath = env.WORKSPACE_PATH || '/workspace';
  const backend = env.BACKEND || 'podman';
  const network = env.NETWORK || 'private';
  const model = env.MODEL || undefined;
  const initialPrompt = env.INITIAL_PROMPT || undefined;
  // Optional Endo tool bridge (see @endo/floot). When the factory provisioned
  // one, MCP_CONFIG_PATH is the slice-internal path to its mcp.json and
  // MCP_INNER_DIR is where the bridge's socket directory bind-mounts (read-only).
  // The Mount cap itself is bundled by reference into the session powers, so the
  // client never resolves a host name for it.
  const mcpConfigPath = env.MCP_CONFIG_PATH || undefined;
  const mcpInnerDir = env.MCP_INNER_DIR || '/endo-mcp';

  // Persistent per-session Claude config dir. When the factory provisioned a
  // dedicated config filesystem (new sessions do), CONFIG_MOUNT_POINT /
  // CONFIG_PET_NAME are set and the client mounts it rw at CLAUDE_CONFIG_INNER_DIR
  // and points CLAUDE_CONFIG_DIR there, so the CLI's conversation transcript
  // lands on a host directory that outlives the container. Absent (older
  // sessions minted before this mount existed), the config dir stays on the
  // ephemeral tmpfs and conversations do not survive a daemon restart.
  const configMountPoint = env.CONFIG_MOUNT_POINT || '';
  const configPetName = env.CONFIG_PET_NAME || '';
  const configInnerDir = env.CLAUDE_CONFIG_INNER_DIR || '/claude-config';
  const configHostDir = env.CLAUDE_CONFIG_HOST_DIR || '';
  const persistConfig = Boolean(configMountPoint && configPetName);

  // A session reincarnated after a daemon restart whose persistent config dir
  // already holds a transcript must resume it on the first post-restart turn,
  // not fork a fresh, context-free conversation (the reported bug). Detect that
  // here — at construction, before any mount — by reading the config dir's
  // plain host backing directory directly: Claude Code persists a conversation
  // under `<config>/projects/<encoded-cwd>/*.jsonl`, so any project entry means
  // at least one turn already ran for this session.
  let resumePriorConversation = false;
  if (persistConfig && configHostDir) {
    try {
      const projectsDir = nodePath.join(configHostDir, 'projects');
      resumePriorConversation =
        existsSync(projectsDir) && readdirSync(projectsDir).length > 0;
    } catch {
      // Unreadable backing dir (first run, races): treat as a fresh session.
    }
  }

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
    // Pull the caps from the per-session powers by reference (no name
    // lookup). The factory bundled exactly these four when it built the
    // powers cap.
    const sandboxFactory = await E(sessionPowers).sandboxFactory();
    const fsMounter = await E(sessionPowers).fsMounter();
    const fs = await E(sessionPowers).filesystem();
    if (!fs) {
      throw makeError(X`claude-sandbox: no Filesystem cap was provided`);
    }

    // The credentials cap (or null when the session has none). Resolved up
    // front so a failure (or terminate) can revoke the per-session grant
    // rather than leak it in the credentials cap's outstanding set.
    /** @type {any} */
    const credCap = (await E(sessionPowers).credentials()) || null;
    const revokeCredential = async () => {
      if (credCap) {
        await E(credCap).revoke(sessionId);
      }
    };

    // Materialise the credential, mount the FS over 9P, register the
    // mountpoint as a daemon Mount cap, then mint the slice. On any
    // failure release whatever was created — unmount the 9P mount and
    // revoke the issued credential grant — rather than leak it.
    /** @type {any} */
    let mountHandle = null;
    /** @type {any} */
    let configMountHandle = null;
    try {
      // Materialise the credential immediately before it flows into the
      // slice env. The cap may live on a remote peer; the host only ever
      // receives the short-lived secret it mints here.
      /** @type {Record<string, string>} */
      const credentialEnv = {};
      if (credCap) {
        // `kind()` is interface-guaranteed on ClaudeCredentials, so call it
        // directly rather than probing `__getMethodNames__`: probing could
        // miss an oauthToken cap that doesn't surface introspection and
        // silently mis-route its token into ANTHROPIC_API_KEY. A cap with no
        // `kind()` at all degrades to a raw API key.
        let kind = 'apiKey';
        try {
          kind = await E(credCap).kind();
        } catch {
          // No kind() method — treat as a raw API key.
        }
        // `Object.hasOwn` guard so a hostile `kind()` returning an inherited
        // key (e.g. `"__proto__"`) can't resolve to a truthy prototype value
        // and mis-route the secret under a coerced env key.
        const envVar = Object.hasOwn(CREDENTIAL_ENV_VARS, kind)
          ? CREDENTIAL_ENV_VARS[kind]
          : undefined;
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

      mountHandle = await E(fsMounter).mount(
        fs,
        workspaceMountPoint,
        harden({ lazyUnmount: true }),
      );
      const workspaceCap = await E(sessionPowers).provideMount(
        workspaceMountPoint,
        workspacePetName,
      );
      // The persistent Claude config dir, mounted rw at `configInnerDir`. It is
      // a *separate* filesystem from the workspace, so the CLI's transcript
      // never pollutes a new-project git worktree nor gets served by
      // `publishWorkspace`. Its backing directory outlives the container, so
      // the conversation survives a daemon restart. Only new sessions carry
      // CONFIG_MOUNT_POINT; older ones keep the ephemeral tmpfs config dir.
      /** @type {any} */
      let configCap = null;
      if (persistConfig) {
        const configFs = await E(sessionPowers).configFilesystem();
        if (!configFs) {
          throw makeError(
            X`claude-sandbox: no config Filesystem cap was provided`,
          );
        }
        configMountHandle = await E(fsMounter).mount(
          configFs,
          configMountPoint,
          harden({ lazyUnmount: true }),
        );
        configCap = await E(sessionPowers).provideMount(
          configMountPoint,
          configPetName,
        );
      }
      // The Endo tool bridge's socket directory, if this session has one, bound
      // read-only so the CLI's stdio relay can reach the host-side MCP server.
      const mcpCap = mcpConfigPath
        ? (await E(sessionPowers).mcpMount()) || null
        : null;
      const mounts = [
        {
          cap: workspaceCap,
          innerPath: workspacePath,
          mode: 'rw',
        },
        ...(configCap
          ? [{ cap: configCap, innerPath: configInnerDir, mode: 'rw' }]
          : []),
        ...(mcpCap
          ? [{ cap: mcpCap, innerPath: mcpInnerDir, mode: 'ro' }]
          : []),
      ];
      const slice = await E(sandboxFactory).make(
        harden({
          rootfs: parsedRootfs,
          mounts,
          network,
          env: credentialEnv,
          cwd: workspacePath,
          backend,
        }),
      );
      return harden({
        slice,
        mountHandle,
        configMountHandle,
        revoke: revokeCredential,
        // Reclaim the Mount pet names that `provideMount` registered at the
        // host root (workspace and, when present, config), so a torn-down
        // session leaves no live Mount formula behind. `removeMount()` drops
        // every mount name the powers cap allows for this session.
        removeMount: () => E(sessionPowers).removeMount(),
      });
    } catch (error) {
      if (mountHandle) {
        try {
          await E(mountHandle).unmount();
        } catch {
          // best-effort
        }
      }
      if (configMountHandle) {
        try {
          await E(configMountHandle).unmount();
        } catch {
          // best-effort
        }
      }
      // If `provideMount` had already registered the workspace Mount name
      // before this failure, drop it so a failed provision leaks nothing.
      try {
        await E(sessionPowers).removeMount();
      } catch {
        // best-effort; the name may not have been registered yet
      }
      try {
        await revokeCredential();
      } catch {
        // best-effort; the credential cap may be gone
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
    mcpConfigPath,
    // The OCI root is intentionally read-only. Claude Code and its Bash tool
    // still need per-session config/state, so HOME stays on the slice's
    // writable tmpfs. CLAUDE_CONFIG_DIR — which holds the conversation
    // transcript — points at the persistent config mount when one was
    // provisioned (so history survives daemon restarts), falling back to the
    // ephemeral tmpfs for older sessions minted before that mount existed.
    env: harden({
      HOME: '/tmp/claude-home',
      XDG_CONFIG_HOME: '/tmp/claude-home/.config',
      CLAUDE_CONFIG_DIR: persistConfig
        ? configInnerDir
        : '/tmp/claude-home/.claude',
      // Claude refuses bypass-permissions mode for uid 0 unless the caller
      // attests that the process is already inside a sandbox. This process is
      // root only inside a rootless Podman user namespace.
      IS_SANDBOX: '1',
    }),
    initialPrompt,
    resumePriorConversation,
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
