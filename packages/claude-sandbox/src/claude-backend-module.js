// @ts-check

/**
 * The `claude-backend` caplet: a Floot hosted backend factory for the Claude
 * CLI runtime, minted by `setup-hosted.js` with `@agent` host powers and
 * bound into the Floot controller profile under the conventional
 * `claude-backend` name Floot's factory discovers.
 *
 * Sessions belong to the daemon's session owner. For each Floot session this
 * caplet writes one approved plan and records the exact formula identities of
 * the services it depends on — the native sandbox service, the Anthropic
 * provider broker, the state provider, and the storage owner — then asks the
 * owner to start the native controller with the tool set Floot pinned. The
 * broker's persisted profile is the source of the pinned slice image and the
 * credential kind every plan records; the credential itself stays in the
 * daemon's Secrets manager, read by the broker at request time and never by
 * a session. The workspace is a recorded directory the controller projects
 * itself, not a formula: this caplet never holds a disposable capability,
 * since the daemon closes a worker retaining one whose formula is later
 * collected. Floot only ever holds the guarded factory facet; the host powers
 * this caplet runs with never cross that boundary.
 *
 * Formula env (set by `setup-hosted.js`; no process fallback):
 *   CLAUDE_WORKSPACE_BASE_DIR  Root of owned per-session workspaces.
 *   CLAUDE_MCP_DIR             Root of per-session private directories
 *                              (socket relay, 9P socket, mount point).
 *   CLAUDE_NATIVE_PROFILE      The deployment resource profile recorded into
 *                              every plan; JSON with digit-string
 *                              quantities, validated before use.
 *   CLAUDE_MOUNTER_ENV         Optional JSON: the rootless mount settings
 *                              recorded into every plan for the session's
 *                              own 9P mounter.
 *
 * Both roots must equal the recorded storage owner's roots, so every session
 * this backend records lies where that owner can remove it.
 *
 * @module
 */

import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { assertPetNames } from '@endo/daemon/pet-name.js';
import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { makeClaudeBackendFactory } from './claude-backend-factory.js';
import {
  containsPath,
  isNormalizedAbsolutePath,
  makeSandboxSessionId,
  readClaudeSessionPlan,
  readMounterEnv,
  readNativeProfile,
} from './claude-session-plan.js';
import {
  SANDBOX_DIR,
  controllerSpecifier,
  readBrokerService,
  readNativeSandbox,
  readSessionStorage,
  readStateProvider,
  resolveFuturePath,
} from './hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */
/** @import { SessionRequest } from './claude-backend-factory.js' */
/** @import { PlanNativeProfile, RecordedClaudeSessionPlan } from './claude-session-plan.js' */

/**
 * Where the daemon session owner keeps this backend's records; shared with
 * `setup-hosted.js`.
 */
export const SESSION_RECORDS_PATH = harden([SANDBOX_DIR, 'session-records']);

export { controllerSpecifier };

/**
 * Read the backend's explicit configuration. Nothing is defaulted: a missing
 * root or profile is a setup error, not a guess. The slice image and the
 * credential kind are not configuration here; they are read from the
 * recorded broker's persisted profile so a plan can never name an image the
 * broker did not pin.
 *
 * @param {Record<string, string>} env
 */
export const resolveBackendConfig = env => {
  const {
    CLAUDE_WORKSPACE_BASE_DIR: workspaceBaseDir,
    CLAUDE_MCP_DIR: mcpBaseDir,
  } = env;
  isNormalizedAbsolutePath(workspaceBaseDir) ||
    Fail`CLAUDE_WORKSPACE_BASE_DIR must be a normalized absolute path`;
  isNormalizedAbsolutePath(mcpBaseDir) ||
    Fail`CLAUDE_MCP_DIR must be a normalized absolute path`;
  const profileText = env.CLAUDE_NATIVE_PROFILE;
  typeof profileText === 'string' || Fail`CLAUDE_NATIVE_PROFILE is required`;
  /** @type {PlanNativeProfile} */
  const nativeProfile = JSON.parse(profileText);
  readNativeProfile(nativeProfile);
  const mounterEnvText = env.CLAUDE_MOUNTER_ENV;
  const mounterEnv =
    mounterEnvText === undefined
      ? undefined
      : readMounterEnv(JSON.parse(mounterEnvText));
  return harden({
    workspaceBaseDir,
    mcpBaseDir,
    nativeProfile,
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
};
harden(resolveBackendConfig);

/**
 * Caplet entry point.
 *
 * @param {EndoHost} hostAgent - `@agent` host powers.
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (hostAgent, _context, { env = {} } = {}) => {
  const { workspaceBaseDir, mcpBaseDir, nativeProfile, mounterEnv } =
    resolveBackendConfig(env);
  // Exact dependency identities are captured once, by verified entrypoint,
  // for the sessions this incarnation records; an existing record keeps the
  // identities it was created with.
  const [sandbox, broker, state, storage] = await Promise.all([
    readNativeSandbox(hostAgent),
    readBrokerService(hostAgent),
    readStateProvider(hostAgent),
    readSessionStorage(hostAgent),
  ]);
  (storage.roots.workspaceDir === workspaceBaseDir &&
    storage.roots.mcpDir === mcpBaseDir) ||
    Fail`Backend roots must equal the recorded session storage owner's roots`;
  // The plan records the broker's pinned image and credential kind; the
  // controller later refuses a broker whose evidence names another digest.
  const rootfs = `oci:${broker.config.imageRef}`;
  const { credentialKind } = broker.config;
  const recordsPath = [...SESSION_RECORDS_PATH];
  assertPetNames(recordsPath);
  const owner = await E(hostAgent).provideSessionOwner(
    recordsPath,
    controllerSpecifier,
  );

  /**
   * @param {string} sessionId
   * @param {SessionRequest} request
   */
  const makePlan = (sessionId, request) => {
    const sandboxSessionId = makeSandboxSessionId(sessionId);
    const privateDir = path.join(mcpBaseDir, sandboxSessionId);
    const owned = request.workspaceHostPath === undefined;
    if (!owned) {
      // An operator-supplied workspace may not overlap either root: exported
      // through 9P, it would expose other sessions' storage or this
      // session's own sockets and mount point. This is the spelling check;
      // aliases are refused against the canonical roots before the record
      // is created.
      const foreign = request.workspaceHostPath;
      if (!isNormalizedAbsolutePath(foreign)) {
        throw Fail`workspaceHostPath ${q(foreign)} must be a normalized absolute path`;
      }
      for (const root of [workspaceBaseDir, mcpBaseDir]) {
        (!containsPath(root, foreign) && !containsPath(foreign, root)) ||
          Fail`workspaceHostPath ${q(foreign)} must be disjoint from the session storage roots`;
      }
    }
    /** @type {RecordedClaudeSessionPlan} */
    const plan = harden({
      sessionId,
      sandboxSessionId,
      rootfs,
      networkPolicy: request.networkPolicy,
      credentialKind,
      ...(owned
        ? { workspaceDir: path.join(workspaceBaseDir, sandboxSessionId) }
        : { workspaceHostPath: request.workspaceHostPath }),
      workspaceMountPoint: path.join(privateDir, 'workspace'),
      mcpDir: path.join(privateDir, 'mcp'),
      mounterSocketDir: path.join(privateDir, '9p'),
      nativeProfile,
      ...(mounterEnv === undefined ? {} : { mounterEnv }),
      ...(request.model ? { model: request.model } : {}),
      ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    });
    const text = JSON.stringify(plan);
    // The controller and the storage owner parse exactly this text later;
    // refuse now what they would refuse then.
    readClaudeSessionPlan(text);
    return harden({ plan, text, privateDir });
  };

  /**
   * Refuse what the guest would only discover on first use, on every request
   * that will project the path: an operator-supplied workspace must be an
   * existing real directory in its own canonical spelling, disjoint from the
   * roots' canonical forms. Like the storage owner's checks, these are
   * point-in-time: an operator who replaces the directory afterwards, or an
   * ancestor of it, does so with host authority this backend does not check
   * again while the session runs.
   *
   * @param {RecordedClaudeSessionPlan} plan
   */
  const assertForeignWorkspace = async plan => {
    if (plan.workspaceHostPath === undefined) return;
    const info = await lstat(plan.workspaceHostPath).catch(error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
        return undefined;
      throw error;
    });
    (info !== undefined && info.isDirectory() && !info.isSymbolicLink()) ||
      Fail`workspaceHostPath ${q(plan.workspaceHostPath)} must be an existing directory`;
    // A path spelled through an alias (a symbolic link above its last
    // component, `/var` for `/private/var`) could resolve inside a root the
    // spelling check cleared, so the recorded path must be its own canonical
    // form and disjoint from the roots' canonical forms, which need not exist
    // yet.
    const canonical = await realpath(plan.workspaceHostPath);
    canonical === plan.workspaceHostPath ||
      Fail`workspaceHostPath ${q(plan.workspaceHostPath)} must be a canonical path; it resolves to ${q(canonical)}`;
    for (const root of [workspaceBaseDir, mcpBaseDir]) {
      // eslint-disable-next-line no-await-in-loop
      const realRoot = await resolveFuturePath(root);
      (!containsPath(realRoot, canonical) &&
        !containsPath(canonical, realRoot)) ||
        Fail`workspaceHostPath ${q(canonical)} must be disjoint from the session storage roots`;
    }
  };

  /**
   * @param {string} sessionId
   * @param {SessionRequest} request
   * @param {any} toolSet
   */
  const provisionSession = async (sessionId, request, toolSet) => {
    const { plan, text, privateDir } = makePlan(sessionId, request);
    const record = await E(owner).inspect(sessionId);
    if (record === undefined) {
      await assertForeignWorkspace(plan);
      await E(owner).create(
        sessionId,
        text,
        harden({
          sandboxService: sandbox.identifier,
          brokerService: broker.identifier,
          stateProvider: state.identifier,
          storage: storage.identifier,
        }),
      );
    } else {
      if (record.plan === undefined) {
        throw Fail`Session ${q(sessionId)} has an incomplete record; destroy it before reuse`;
      }
      const recorded = readClaudeSessionPlan(record.plan);
      // The workspace, the pinned image, the credential kind, and the private
      // directories are recorded with dependencies that cannot be revised: a
      // request naming different storage, a re-pinned or re-credentialed
      // broker, or a re-rooted backend is a different session. The network
      // policy, model, and persona may change between incarnations.
      (recorded.workspaceDir === plan.workspaceDir &&
        recorded.workspaceHostPath === plan.workspaceHostPath) ||
        Fail`Session ${q(sessionId)} workspace cannot change; destroy the session first`;
      recorded.rootfs === plan.rootfs ||
        Fail`Session ${q(sessionId)} image cannot change; destroy the session first`;
      recorded.credentialKind === plan.credentialKind ||
        Fail`Session ${q(sessionId)} credential kind cannot change; destroy the session first`;
      (recorded.workspaceMountPoint === plan.workspaceMountPoint &&
        recorded.mcpDir === plan.mcpDir &&
        recorded.mounterSocketDir === plan.mounterSocketDir) ||
        Fail`Session ${q(sessionId)} private directories cannot change; destroy the session first`;
      await assertForeignWorkspace(plan);
      // Stop before reuse, whatever the record's phase: an interrupted start
      // is retried through its cleanup here rather than only through
      // deletion, and a live incarnation from an earlier backend cannot keep
      // a tool authority this request does not hold.
      await E(owner).stop(sessionId);
      if (record.plan !== text) await E(owner).revise(sessionId, text);
    }
    // Only a recorded plan owns these; the mounter creates the mount point.
    // Idempotent on every start, so a record whose directories were never
    // created, or were removed between incarnations, heals here rather than
    // failing at the controller until it is destroyed.
    for (const directory of [
      privateDir,
      plan.mcpDir,
      plan.mounterSocketDir,
      ...(plan.workspaceDir === undefined ? [] : [plan.workspaceDir]),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    return E(owner).start(sessionId, toolSet);
  };

  return makeClaudeBackendFactory({
    provisionSession,
    stopSession: sessionId => E(owner).stop(sessionId),
    removeSession: sessionId => E(owner).remove(sessionId),
  });
};
harden(make);
