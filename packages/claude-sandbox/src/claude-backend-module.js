// @ts-check

/**
 * The `claude-backend` caplet: a Floot hosted backend factory for the Claude
 * CLI runtime, minted by `setup-hosted.js` with `@agent` host powers and
 * bound into the Floot controller profile under the conventional
 * `claude-backend` name Floot's factory discovers.
 *
 * Sessions belong to the daemon's session owner. For each Floot session the
 * shared provisioner (`@endo/hosted-agent/session-provisioner.js`) writes one
 * approved plan and records the exact formula identities of the services it
 * depends on — the native sandbox service, the Anthropic provider broker, the
 * state provider, and the storage owner — then asks the owner to start the
 * native controller with the tool set Floot pinned. This module declares what
 * is Claude's: the plan records the broker's pinned image and credential
 * kind, neither of which a reopen may change; the CLI needs a private MCP
 * socket directory; a session that names no model runs the runtime's own
 * default unpinned, with an effort checked against the runtime's table. The
 * credential itself stays in the daemon's Secrets manager, read by the broker
 * at request time and never by a session. The workspace is a recorded
 * directory the controller projects itself, not a formula: this caplet never
 * holds a disposable capability. Floot only ever holds the guarded factory
 * facet; the host powers this caplet runs with never cross that boundary.
 *
 * Formula env (set by `setup-hosted.js`; no process fallback):
 *   CLAUDE_WORKSPACE_BASE_DIR  Root of owned per-session workspaces.
 *   CLAUDE_MCP_DIR             Root of per-session private directories
 *                              (socket relay, 9P socket, mount point).
 *   CLAUDE_MOUNTER_ENV         Optional JSON: the rootless mount settings
 *                              recorded into every plan for the session's
 *                              own 9P mounter.
 *
 * Both roots must equal the recorded storage owner's roots, so every session
 * this backend records lies where that owner can remove it.
 *
 * @module
 */

import { assertPetNames } from '@endo/daemon/pet-name.js';
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js';
import { makeSessionProvisioner } from '@endo/hosted-agent/session-provisioner.js';
import { makeSubscriptionLister } from '@endo/hosted-agent/subscription-lister.js';

import { makeClaudeBackendFactory } from './claude-backend-factory.js';
import { assertClaudeEffort, claudeEffortsFor } from './claude-effort.js';
import {
  isNormalizedAbsolutePath,
  readClaudeSessionPlan,
  readMounterEnv,
} from './claude-session-plan.js';
import {
  SANDBOX_DIR,
  controllerSpecifier,
  readBrokerService,
  readNativeSandbox,
  readSessionStorage,
  readStateProvider,
} from './hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */
/** @import { makeBackendCatalog as MakeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js' */

/**
 * Where the daemon session owner keeps this backend's records; shared with
 * `setup-hosted.js`.
 */
export const SESSION_RECORDS_PATH = harden([SANDBOX_DIR, 'session-records']);

export { controllerSpecifier };

/**
 * Read the backend's explicit configuration. Nothing is defaulted: a missing
 * root is a setup error, not a guess. The slice image and the credential kind
 * are not configuration here; they are read from the recorded broker's
 * persisted profile so a plan can never name an image the broker did not pin.
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
  const mounterEnvText = env.CLAUDE_MOUNTER_ENV;
  const mounterEnv =
    mounterEnvText === undefined
      ? undefined
      : readMounterEnv(JSON.parse(mounterEnvText));
  return harden({
    workspaceBaseDir,
    mcpBaseDir,
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
};
harden(resolveBackendConfig);

/**
 * Claude's declaration over the shared session provisioner.
 *
 * @param {object} powers
 * @param {any} powers.owner
 * @param {Record<string, string>} powers.dependencies
 * @param {string} powers.workspaceRoot
 * @param {string} powers.privateRoot
 * @param {readonly string[]} powers.protectedRoots
 * @param {string} powers.rootfs The broker's pinned image, as `oci:<ref>`.
 * @param {string} powers.accountRef The account authority the broker serves,
 *   recorded into every plan (`@endo/hosted-agent/account-authority.js`).
 * @param {'apiKey' | 'oauthToken'} powers.credentialKind
 * @param {ReturnType<MakeBackendCatalog>} powers.catalog
 * @param {Record<string, string>} [powers.mounterEnv]
 */
export const makeClaudeSessionProvisioner = ({
  owner,
  dependencies,
  workspaceRoot,
  privateRoot,
  protectedRoots,
  rootfs,
  accountRef,
  credentialKind,
  catalog,
  mounterEnv,
}) =>
  makeSessionProvisioner({
    label: 'Claude',
    owner,
    dependencies,
    workspaceRoot,
    privateRoot,
    protectedRoots,
    sandboxIdFallback: 'claude',
    privatePaths: { mcpDir: 'mcp' },
    readPlan: readClaudeSessionPlan,
    // The plan records the broker's pinned image and credential kind; the
    // controller later refuses a broker whose evidence names another digest,
    // and a session reopens under a broker re-minted over another image or
    // credential kind only when the request authorizes that rebind.
    fields: () => ({ rootfs, accountRef, credentialKind }),
    // The credential's kind is a property of the account authority's
    // credential, so it sits under `account`.
    rebindable: { credentialKind: 'account' },
    pin: { unpinned: 'runtime-default', assertEffort: assertClaudeEffort },
    catalog,
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
harden(makeClaudeSessionProvisioner);

/**
 * Caplet entry point.
 *
 * @param {EndoHost} hostAgent - `@agent` host powers.
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (hostAgent, _context, { env = {} } = {}) => {
  const { workspaceBaseDir, mcpBaseDir, mounterEnv } =
    resolveBackendConfig(env);
  // Exact dependency identities are captured once, by verified entrypoint,
  // for the sessions this incarnation records; an existing record keeps the
  // identities it was created with.
  const [sandbox, broker, state] = await Promise.all([
    readNativeSandbox(hostAgent),
    readBrokerService(hostAgent),
    readStateProvider(hostAgent),
  ]);
  const storage = await readSessionStorage(hostAgent, state.identifier);
  (storage.roots.workspaceDir === workspaceBaseDir &&
    storage.roots.mcpDir === mcpBaseDir) ||
    Fail`Backend roots must equal the recorded session storage owner's roots`;
  const recordsPath = [...SESSION_RECORDS_PATH];
  assertPetNames(recordsPath);
  const owner = await E(hostAgent).provideSessionOwner(
    recordsPath,
    controllerSpecifier,
  );
  const brokerService = () =>
    /** @type {Promise<{ subscriptions(): Promise<any>, modelCatalog(subscriptionId?: string): Promise<any> }>} */ (
      E(hostAgent).lookup([SANDBOX_DIR, 'broker-service'])
    );
  // What a session may be pinned to: the broker's declared subscriptions.
  const listSubscriptions = makeSubscriptionLister(
    async () => E(await brokerService()).subscriptions(),
    { label: 'Claude' },
  );
  // What each account lists, from Anthropic's model list under the broker's
  // credential, as the pinned Claude Code runtime offers it: with the
  // efforts it can drive each model at.
  const catalog = makeBackendCatalog({
    label: 'Claude',
    authority: broker.config.accountAuthority,
    readCatalog: async subscriptionId =>
      E(await brokerService()).modelCatalog(subscriptionId),
    listSubscriptions,
    project: model => ({ ...model, ...claudeEffortsFor(model.id) }),
  });
  const provisionSession = makeClaudeSessionProvisioner({
    owner,
    dependencies: harden({
      sandboxService: sandbox.identifier,
      brokerService: broker.identifier,
      stateProvider: state.identifier,
      storage: storage.identifier,
    }),
    workspaceRoot: workspaceBaseDir,
    privateRoot: mcpBaseDir,
    // Host records, the runtime directory and the broker's directory: no
    // guest storage may resolve into them.
    protectedRoots: harden([
      state.stateDir,
      sandbox.config.directory,
      broker.config.directory,
    ]),
    rootfs: `oci:${broker.config.imageRef}`,
    accountRef: broker.config.accountAuthority,
    credentialKind: broker.config.credentialKind,
    catalog,
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
  return makeClaudeBackendFactory({
    publicInternetEnabled: broker.config.publicInternet === true,
    catalog,
    listSubscriptions,
    provisionSession,
    stopSession: sessionId => E(owner).stop(sessionId),
    removeSession: sessionId => E(owner).remove(sessionId),
  });
};
harden(make);
