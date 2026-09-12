// @ts-check
/* global process */

/**
 * Per-session `OpencodeClient` caplet.
 *
 * The factory provisions one of these per session via `makeUnconfined`, so
 * the resulting exo is a first-class formulated Endo capability with a real
 * daemon identity — which is what lets `@host` store it under a pet name and
 * reincarnate it across daemon restarts.
 *
 * Why the client (not the factory) owns the slice and mounts: an
 * `@endo/sandbox` slice and the `@endo/9p-server` mount handle are
 * worker-local remotables with no formula identity, so they cannot be
 * passed across a formula boundary into a separately-formulated client.
 * Instead this module re-creates them itself, lazily, from its `env`: the
 * first `send()` mounts the workspace and mints the slice; subsequent
 * daemon restarts reincarnate the formula and re-provision on demand.  The
 * workspace persists in its `Filesystem` cap, the opencode session store
 * persists in the per-session **host-backed state directory** (not 9P:
 * SQLite WAL needs same-host shared memory), and the (possibly
 * peer-hosted) credential is re-materialised at spawn time, so no secret
 * ever lands in the formula `env`.
 *
 * Expected env (set by the provisioner; all strings).  The caps the client
 * needs are passed by reference through `powers`, **not** by pet name, so
 * no cap-name env vars appear here:
 *   SESSION_ID            Stable session id (mount paths and pet names
 *                         derive from it, so it must survive restarts).
 *   CREATED_AT            ISO timestamp (diagnostic).
 *   WORKSPACE_MOUNT_POINT Host path the workspace 9P mount lives at.
 *   WORKSPACE_PET_NAME    Pet name to register the workspace Mount cap under.
 *   WORKSPACE_PATH        Slice-internal workspace path (default `/workspace`).
 *   STATE_INNER_PATH      Slice-internal durable state path
 *                         (`XDG_DATA_HOME`, default `/opencode-state`).
 *   CONFIG_MOUNT_POINT    Host path of the optional config 9P mount.
 *   CONFIG_PET_NAME       Pet name for the config Mount cap.
 *   OPENCODE_CONFIG_INNER_DIR Slice-internal config path (also
 *                         OPENCODE_CONFIG_DIR); read-only.
 *   OPENCODE_CONFIG_HOST_DIR Plain host backing directory of the config
 *                         filesystem (diagnostic).
 *   BACKEND               Sandbox backend (default `podman`).
 *   NETWORK               Sandbox network profile (default `private`).
 *   OPENCODE_ROOTFS       Raw `rootfs` form value (may be empty).
 *   DEFAULT_IMAGE         Default OCI image when OPENCODE_ROOTFS is blank.
 *   MODEL                 Optional opencode model ref.
 *   SYSTEM_PROMPT         Session persona baked into the opencode agent.
 *   INITIAL_PROMPT        Optional one-shot prompt fired on creation.
 *   OPENCODE_SESSION_ID   Persisted opencode session id to resume (revival).
 *   OPENCODE_BRIDGE_TURN_TIMEOUT_MS  Per-turn wall-clock budget for the bridge.
 *   MCP_CONFIG_PATH       Slice-internal path of the bridge's mcp.json (its
 *                         presence enables the Endo tool bridge).
 *   MCP_INNER_DIR         Slice path the bridge socket dir mounts at.
 *   MCP_SOCKET_NAME       Socket file name inside that directory.
 *   MCP_BRIDGE_NAME       stdio relay file name inside that directory.
 *   MCP_SERVER_NAME       MCP server key opencode sees the tools under.
 *
 * This caplet does **not** run with `@agent`.  The provisioner builds a
 * **per-session powers** cap (via `evaluate`) that is a total attenuation:
 * it bundles the caps the client needs **by reference** and exposes only
 * accessors plus a `provideMount(path, name)` bounded to *this session's*
 * mountpoints.  There is **no `lookup`**, so the client cannot resolve any
 * host name beyond its own caps.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

import { E } from '@endo/eventual-send';
import { Fail, makeError, q, X } from '@endo/errors';

import { makeOpencodeClient } from './opencode-client.js';
import { parseRootfs, rootfsLabel } from './parse-rootfs.js';
import { makeOpencodeConfig } from './opencode-agent-config.js';
import {
  DEFAULT_SERVER_NAME,
  DEFAULT_SOCKET_NAME,
  STDIO_BRIDGE_NAME,
  buildOpencodeMcpServer,
} from './mcp-socket-server.js';

/** @import { FarRef } from '@endo/eventual-send' */

/**
 * The broker-only transport, when the provisioner supplied one. Both the
 * loopback base URL (where the provider listener answers inside the shared
 * namespace) and the listener container (the namespace this slice joins) are
 * required together; the API key is a non-secret placeholder because the
 * broker injects the real credential upstream and never forwards this one.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ broker: false } | { broker: true, baseUrl: string, container: string, apiKey: string }}
 */
export const resolveBrokerTransport = env => {
  const baseUrl = env.OPENCODE_BROKER_BASE_URL || '';
  const container = env.OPENCODE_BROKER_CONTAINER || '';
  if (!baseUrl && !container) return harden({ broker: false });
  (baseUrl !== '' && container !== '') ||
    Fail`OpenCode broker transport requires both the loopback base URL and the listener container`;
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container) ||
    Fail`OpenCode broker listener container name is invalid`;
  // Synthesized, never taken from the environment: a deployment must not be
  // able to park a real provider key in the slice under the placeholder's
  // name while still routing through the broker.
  return harden({
    broker: true,
    baseUrl,
    container,
    apiKey: 'opencode-broker-placeholder',
  });
};
harden(resolveBrokerTransport);

/**
 * Everything the broker decision changes, in one place so it can be tested
 * without a slice: the config options, the placeholder env, whether the real
 * credential cap may be used, and the sandbox network to request.
 *
 * @param {{ transport: ReturnType<typeof resolveBrokerTransport>, network: string }} options
 */
export const planBrokerClient = ({ transport, network }) =>
  transport.broker
    ? harden({
        broker: true,
        configOptions: harden({
          baseUrl: transport.baseUrl,
          allowLoopbackHttp: true,
        }),
        credentialEnv: harden({ OPENROUTER_API_KEY: transport.apiKey }),
        useCredentialCap: false,
        network: 'join',
        networkRef: transport.container,
      })
    : harden({
        broker: false,
        configOptions: harden({}),
        credentialEnv: harden({}),
        useCredentialCap: true,
        network,
      });
harden(planBrokerClient);

/**
 * The per-turn wall-clock budget handed to the in-slice bridge. The backend's
 * own value wins; a daemon-wide `ENDO_OPENCODE_BRIDGE_TURN_TIMEOUT_MS` (the
 * only spelling the daemon env filter forwards) is the operator-level
 * fallback, and empty lets the bridge apply its default.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export const resolveBridgeTurnTimeout = env => {
  const value =
    env.OPENCODE_BRIDGE_TURN_TIMEOUT_MS ||
    process.env.ENDO_OPENCODE_BRIDGE_TURN_TIMEOUT_MS ||
    '';
  return `${value}`;
};
harden(resolveBridgeTurnTimeout);

/**
 * Map a credential kind to the environment variable opencode reads it from
 * inside the slice.  OpenRouter is the only provider this backend offers,
 * and it authenticates with a plain API key; an OAuth token has no home in
 * the slice config and is refused rather than mis-routed.
 */
const CREDENTIAL_ENV_VARS = harden({
  apiKey: 'OPENROUTER_API_KEY',
});

/**
 * List an exo's method names without tripping the underscore-dangle rule at
 * the call site.
 *
 * @param {any} cap
 */
const listMethodNames = cap =>
  // eslint-disable-next-line no-underscore-dangle
  E(cap).__getMethodNames__();
harden(listMethodNames);

/**
 * Create a cancellation context kit: an in-process passable context and a
 * `cancel` function that triggers it.  The context exposes
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
  // Suppress unhandled-rejection noise: the promise is meant to stay
  // pending until cancel() is called, after which callers drain it.
  cancelled.catch(() => {});
  const cancel = (reason = new Error('Cancelled')) => rejectCancelled(reason);
  const context = harden({ whenCancelled: () => cancelled });
  return harden({ context, cancel });
};
harden(makeCancellationKit);

/**
 * Capture the caplet's cancellation promise from the daemon context.
 * `null`/absent context means no teardown signal.
 *
 * Called, never duck-typed.  In production the context arrives over CapTP as
 * a *presence* — an empty object whose methods are reachable only through
 * `E()` — so a property test answers "no teardown signal" for every real
 * session, and cancel/remove would leave the container, its mounts, and the
 * credential grant running.  All three settlements mean stop: the formula
 * was cancelled or collected; the connection to the daemon dropped; or the
 * context does not implement the method (a construction bug better surfaced
 * as a torn-down session than one nothing can stop).
 *
 * Return the promise captured into a local, not via an `async` return: an
 * `async` return would flatten the cancellation promise, hanging the caller
 * instead of handing it the still-pending promise to subscribe to.
 *
 * @param {any} resolvedContext
 * @returns {Promise<never> | null}
 */
const cancellationPromiseOf = resolvedContext => {
  if (!resolvedContext) return null;
  return E(resolvedContext).whenCancelled();
};

/**
 * Per-session OpencodeClient caplet entry point.
 *
 * @param {FarRef<object>} powers - The per-session powers cap (built by the
 *   provisioner).  Tests pass a mock exposing the accessors the client uses.
 * @param {Promise<object> | object | undefined} context - The daemon
 *   cancellation context.  When the formula is cancelled or collected, the
 *   live session is torn down (container disposed, mounts released) while
 *   durable state is kept.
 * @param {{ env?: Record<string, string> }} [contextWrapper]
 * @returns {object}
 */
export const make = (powers, context, contextWrapper = {}) => {
  /** @type {any} */
  const sessionPowers = powers;
  const env = contextWrapper.env ?? process.env;

  const sessionId = env.SESSION_ID;
  if (!sessionId) {
    throw makeError(X`opencode-client-module: SESSION_ID required`);
  }
  const workspaceMountPoint = env.WORKSPACE_MOUNT_POINT;
  if (!workspaceMountPoint) {
    throw makeError(X`opencode-client-module: WORKSPACE_MOUNT_POINT required`);
  }

  const createdAt = env.CREATED_AT || new Date().toISOString();
  const workspacePetName =
    env.WORKSPACE_PET_NAME || `opencode-${sessionId}-workspace`;
  const workspacePath = env.WORKSPACE_PATH || '/workspace';
  const statePath = env.STATE_INNER_PATH || '/opencode-state';
  const backend = env.BACKEND || 'podman';
  const network = env.NETWORK || 'private';
  const brokerPlan = planBrokerClient({
    transport: resolveBrokerTransport(env),
    network,
  });
  const model = env.MODEL || undefined;
  const systemPrompt = env.SYSTEM_PROMPT || undefined;
  const initialPrompt = env.INITIAL_PROMPT || undefined;
  const resumeOpencodeSessionId = env.OPENCODE_SESSION_ID || '';
  // The daemon env filter only forwards ENDO_-prefixed variables, so accept
  // the operator's ENDO_OPENCODE_BRIDGE_TURN_TIMEOUT_MS as a fallback for the
  // backend-provided value.
  const turnTimeoutMs = resolveBridgeTurnTimeout(env);

  // Optional Endo tool bridge (see @endo/floot).  The Mount cap itself is
  // bundled by reference into the session powers, so the client never
  // resolves a host name for it; only the slice-internal names travel here.
  const mcpConfigPath = env.MCP_CONFIG_PATH || undefined;
  const mcpInnerDir = env.MCP_INNER_DIR || '/endo-mcp';
  const mcpSocketName = env.MCP_SOCKET_NAME || DEFAULT_SOCKET_NAME;
  const mcpBridgeName = env.MCP_BRIDGE_NAME || STDIO_BRIDGE_NAME;
  const mcpServerName = env.MCP_SERVER_NAME || DEFAULT_SERVER_NAME;
  const mcpEnabled = Boolean(mcpConfigPath);

  // Optional dedicated opencode config dir.  When provisioned it is mounted
  // READ-ONLY and named as `OPENCODE_CONFIG_DIR`, so opencode never treats
  // the workspace or its own state as a config layer.  `OPENCODE_CONFIG_CONTENT`
  // remains the authoritative config.
  const configMountPoint = env.CONFIG_MOUNT_POINT || '';
  const configPetName = env.CONFIG_PET_NAME || '';
  const configInnerDir = env.OPENCODE_CONFIG_INNER_DIR || '/opencode-config';
  const persistConfig = Boolean(configMountPoint && configPetName);

  // One random password per incarnation, shared with the bridge through the
  // slice env.  The server binds slice loopback only; the password keeps any
  // other in-slice process from driving it through a guessed port.
  const serverPassword = randomBytes(24).toString('hex');

  // Parse (and validate) the rootfs synchronously so a bad value fails at
  // construction rather than on first use.
  const parsedRootfs = parseRootfs(env.OPENCODE_ROOTFS, {
    defaultImage: env.DEFAULT_IMAGE || undefined,
  });

  const mcpServers = mcpEnabled
    ? harden({
        [mcpServerName]: buildOpencodeMcpServer({
          innerDir: mcpInnerDir,
          socketName: mcpSocketName,
          bridgeName: mcpBridgeName,
        }),
      })
    : undefined;

  // The whole session config travels in OPENCODE_CONFIG_CONTENT: a
  // hard-coded OpenRouter provider block, the persona-bearing agent, and
  // the Endo MCP server.  Per DESIGN § Security-hardening, the spawn env
  // also disables project config, plugins, model fetch, and auth.json.
  const configContent = JSON.stringify(
    makeOpencodeConfig({
      ...(model ? { model } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...brokerPlan.configOptions,
    }),
  );

  /**
   * Lazily mount the workspace + state + optional config/MCP dirs and mint
   * the slice.  Run once on first use and memoized by `makeOpencodeClient`.
   *
   * @returns {Promise<{ slice: any, mountHandle?: { unmount: () => Promise<void> }, configMountHandle?: { unmount: () => Promise<void> }, revoke: () => Promise<void>, removeMount: () => Promise<any> }>}
   */
  const provision = async () => {
    // Pull the caps from the per-session powers by reference (no name
    // lookup).  The provisioner bundled exactly these when it built the
    // powers cap.
    const sandboxFactory = await E(sessionPowers).sandboxFactory();
    const fsMounter = await E(sessionPowers).fsMounter();
    const stateProvider = await E(sessionPowers).stateProvider();
    if (!stateProvider) {
      throw makeError(X`opencode-sandbox: no state provider cap was provided`);
    }
    const fs = await E(sessionPowers).filesystem();
    if (!fs) {
      throw makeError(X`opencode-sandbox: no Filesystem cap was provided`);
    }

    // The credentials cap (or null when the session has none).  Resolved up
    // front so a failure (or terminate) can revoke the per-session grant
    // rather than leak it in the credentials cap's outstanding set.
    /** @type {any} */
    const credCap = brokerPlan.useCredentialCap
      ? (await E(sessionPowers).credentials()) || null
      : null;
    const revokeCredential = async () => {
      if (credCap) {
        await E(credCap).revoke(sessionId);
      }
    };

    /** @type {any} */
    let mountHandle = null;
    /** @type {any} */
    let configMountHandle = null;
    try {
      // Materialise the credential immediately before it flows into the
      // slice env.  The cap may live on a remote peer; the host only ever
      // receives the short-lived secret it mints here.  It is materialised
      // once per provision — formulas reincarnate, so a revival re-issues.
      /** @type {Record<string, string>} */
      const credentialEnv = { ...brokerPlan.credentialEnv };
      if (credCap) {
        // Only default to a raw API key when the cap provably lacks `kind()`.
        // A failing `kind()` call must fail closed: silently routing an OAuth
        // token to the API-key variable would send the wrong credential.
        let kind = 'apiKey';
        const methods = await listMethodNames(credCap).catch(() => []);
        if (methods.includes('kind')) {
          kind = await E(credCap).kind();
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

      /** @type {any} */
      let configCap = null;
      if (persistConfig) {
        const configFs = await E(sessionPowers).configFilesystem();
        if (!configFs) {
          throw makeError(
            X`opencode-sandbox: no config Filesystem cap was provided`,
          );
        }
        // Read-only: OPENCODE_CONFIG_DIR is a config source, never a writable
        // workspace.  A planted opencode.json in the workspace cannot reach
        // it because project config is disabled outright.
        configMountHandle = await E(fsMounter).mount(
          configFs,
          configMountPoint,
          harden({ lazyUnmount: true, readOnly: true }),
        );
        configCap = await E(sessionPowers).provideMount(
          configMountPoint,
          configPetName,
          harden({ readOnly: true }),
        );
      }

      // The Endo tool bridge's socket directory, bound read-only so the
      // CLI's stdio relay can reach the host-side MCP server.
      const mcpCap = mcpEnabled
        ? (await E(sessionPowers).mcpMount()) || null
        : null;
      if (mcpEnabled && !mcpCap) {
        // The config advertises an MCP server whose relay would not be
        // mounted; fail closed instead of spawning a broken command.
        throw makeError(X`MCP is configured but no MCP mount cap is available`);
      }

      // Durable session state, host-backed (NOT 9P): opencode's SQLite WAL
      // needs same-host shared memory. The state provider creates the host
      // directory and returns a daemon mount, which the sandbox factory
      // resolves through @agent.provideHostPath.
      const stateMountCap =
        await E(stateProvider).provideSessionMount(sessionId);

      const mounts = [
        {
          cap: workspaceCap,
          innerPath: workspacePath,
          mode: 'rw',
        },
        {
          cap: stateMountCap,
          innerPath: statePath,
          mode: 'rw',
        },
        ...(configCap
          ? [{ cap: configCap, innerPath: configInnerDir, mode: 'ro' }]
          : []),
        ...(mcpCap
          ? [{ cap: mcpCap, innerPath: mcpInnerDir, mode: 'ro' }]
          : []),
      ];

      /** @type {Record<string, string>} */
      const sliceEnv = {
        ...credentialEnv,
        // The image has no writable HOME of its own; keep the ephemeral
        // paths on the slice tmpfs and the durable paths on the state mount.
        HOME: '/tmp/opencode-home',
        XDG_CONFIG_HOME: '/tmp/opencode-home/.config',
        XDG_DATA_HOME: statePath,
        OPENCODE_CONFIG_CONTENT: configContent,
        OPENCODE_AUTH_CONTENT: '{}',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_PURE: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_BRIDGE_DIRECTORY: workspacePath,
        OPENCODE_SERVER_PASSWORD: serverPassword,
        // Deliberately NOT OPENCODE_CONFIG_DIR=configInnerDir: that mount is
        // read-only, and opencode bootstraps its config dir by writing
        // `.gitignore` into it, so pointing it at the RO mount fails every
        // instance with EROFS (observed as POST /session -> 500). The
        // authoritative config travels in OPENCODE_CONFIG_CONTENT; opencode's
        // own config home stays the writable, ephemeral XDG_CONFIG_HOME.
        ...(mcpEnabled ? { OPENCODE_MCP_SERVER_NAME: mcpServerName } : {}),
        ...(resumeOpencodeSessionId
          ? { OPENCODE_SESSION_ID: resumeOpencodeSessionId }
          : {}),
        ...(turnTimeoutMs
          ? { OPENCODE_BRIDGE_TURN_TIMEOUT_MS: turnTimeoutMs }
          : {}),
      };

      const slice = await E(sandboxFactory).make(
        harden({
          rootfs: parsedRootfs,
          mounts,
          // A broker session joins the listener's networkless namespace and
          // reaches the provider on its loopback. Everything else keeps the
          // caller's profile.
          network: brokerPlan.network,
          ...(brokerPlan.networkRef !== undefined
            ? { networkRef: brokerPlan.networkRef }
            : {}),
          env: sliceEnv,
          cwd: workspacePath,
          backend,
        }),
      );
      return harden({
        slice,
        ...(mountHandle ? { mountHandle } : {}),
        ...(configMountHandle ? { configMountHandle } : {}),
        revoke: revokeCredential,
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
      // If `provideMount` had already registered a Mount name before this
      // failure, drop it so a failed provision leaks nothing.
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

  /**
   * Destroy-side hook: delete the session's durable state through the
   * provider that minted it.  Called only from `OpencodeClient.destroy()`,
   * never from a plain terminate/cancel.
   */
  const removeState = async () => {
    const stateProvider = await E(sessionPowers).stateProvider();
    if (stateProvider) {
      await E(stateProvider).removeSession(sessionId);
    }
  };

  const client = makeOpencodeClient({
    sessionId,
    createdAt,
    provision,
    workspaceMountPoint,
    workspacePath,
    statePath,
    backend,
    rootfsLabel: rootfsLabel(parsedRootfs),
    model,
    systemPrompt,
    env: harden({ NETWORK: brokerPlan.network }),
    opencodeSessionId: resumeOpencodeSessionId,
    resumePriorConversation: Boolean(resumeOpencodeSessionId),
    initialPrompt,
    removeState,
  });

  // Tear down on cancellation/collection.  `cancel` is transient (the
  // formula persists and reincarnates after a daemon restart, then
  // re-provisions on the next send); `remove`/GC additionally deletes the
  // formula.  Either way the container, the 9P mounts, their pet names, and
  // the credential grant are released — but durable state is NOT deleted
  // here, so a cancelled session can be revived with its transcript intact.
  const armTeardown = async () => {
    const resolvedContext = context ? await context : null;
    const cancelled = cancellationPromiseOf(resolvedContext);
    if (!cancelled) return;
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
