// @ts-check

/**
 * The `opencode-backend` caplet: a Floot hosted backend factory for the
 * opencode runtime, minted by `setup-hosted.js` with `@agent` host powers and
 * bound into the Floot controller profile under the conventional
 * `opencode-backend` name Floot's factory discovers.
 *
 * Sessions belong to the daemon's session owner. The shared provisioner
 * (`@endo/hosted-agent/session-provisioner.js`) writes one approved plan per
 * Floot session and records the exact formula identities of the services it
 * depends on — the native sandbox service, the provider broker and the
 * storage owner — then asks the owner to start the native controller with the
 * tool set Floot pinned. This module declares what is OpenCode's: the plan
 * records the broker's pinned image, which a reopen may not change; the CLI
 * needs a private MCP socket directory; the runtime cannot run without a
 * model, so a session that names none takes only a default the account's
 * catalog marks. The workspace is a recorded directory the controller
 * projects itself, not a formula: this caplet never holds a disposable
 * capability. Floot only ever holds the guarded factory facet; the host
 * powers this caplet runs with never cross that boundary.
 *
 * Formula env (set by `setup-hosted.js`; no process fallback):
 *   OPENCODE_WORKSPACE_BASE_DIR  Root of owned per-session workspaces.
 *   OPENCODE_MCP_DIR             Root of per-session private directories
 *                                (socket relay, 9P socket, mount point).
 *   OPENCODE_MOUNTER_ENV         Optional JSON: the rootless mount settings
 *                                (`NINEP_SUDO`, `NINEP_MOUNT_PROGRAM`,
 *                                `NINEP_UMOUNT_PROGRAM`) recorded into every
 *                                plan for the session's own 9P mounter.
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
import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from '@endo/hosted-agent/current-specifier.js';
import { makeSessionProvisioner } from '@endo/hosted-agent/session-provisioner.js';

import {
  OPENROUTER_PROVIDER_ID,
  parseModelRef,
} from './opencode-agent-config.js';
import { makeOpencodeBackendFactory } from './opencode-backend-factory.js';
import {
  isNormalizedAbsolutePath,
  readMounterEnv,
  readSessionPlan,
} from './opencode-session-plan.js';
import {
  SANDBOX_DIR,
  readBrokerService,
  readNativeSandbox,
  readSessionStorage,
} from './hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */
/** @import { makeBackendCatalog as MakeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js' */

/** The host-private records directory the session owner is configured on. */
export const SESSION_RECORDS_PATH = harden([SANDBOX_DIR, 'session-records']);

export const controllerSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./opencode-native-controller.js', import.meta.url).href,
  ),
  'native controller',
);
harden(controllerSpecifier);

/**
 * Read the backend's explicit configuration. Nothing is defaulted: a missing
 * root is a setup error, not a guess.
 *
 * @param {Record<string, string>} env
 */
export const resolveBackendConfig = env => {
  const {
    OPENCODE_WORKSPACE_BASE_DIR: workspaceBaseDir,
    OPENCODE_MCP_DIR: mcpBaseDir,
  } = env;
  isNormalizedAbsolutePath(workspaceBaseDir) ||
    Fail`OPENCODE_WORKSPACE_BASE_DIR must be a normalized absolute path`;
  isNormalizedAbsolutePath(mcpBaseDir) ||
    Fail`OPENCODE_MCP_DIR must be a normalized absolute path`;
  const mounterEnvText = env.OPENCODE_MOUNTER_ENV;
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
 * OpenCode's declaration over the shared session provisioner.
 *
 * @param {object} powers
 * @param {any} powers.owner
 * @param {Record<string, string>} powers.dependencies
 * @param {string} powers.workspaceRoot
 * @param {string} powers.privateRoot
 * @param {readonly string[]} powers.protectedRoots
 * @param {string} powers.rootfs The broker's pinned image, as `oci:<ref>`.
 * @param {ReturnType<MakeBackendCatalog>} powers.catalog
 * @param {Record<string, string>} [powers.mounterEnv]
 */
export const makeOpencodeSessionProvisioner = ({
  owner,
  dependencies,
  workspaceRoot,
  privateRoot,
  protectedRoots,
  rootfs,
  catalog,
  mounterEnv,
}) =>
  makeSessionProvisioner({
    label: 'OpenCode',
    owner,
    dependencies,
    workspaceRoot,
    privateRoot,
    protectedRoots,
    sandboxIdFallback: 'opencode',
    privatePaths: { mcpDir: 'mcp' },
    readPlan: readSessionPlan,
    // The slice runs the exact image the broker pinned; the controller checks
    // the broker's evidence against this reference at activation, and a
    // broker that now pins a different image is a different session.
    fields: () => ({ rootfs }),
    immutable: { rootfs: 'image' },
    catalog,
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
harden(makeOpencodeSessionProvisioner);

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
  const [sandbox, broker, storage] = await Promise.all([
    readNativeSandbox(hostAgent),
    readBrokerService(hostAgent),
    readSessionStorage(hostAgent),
  ]);
  (storage.roots.workspaceDir === workspaceBaseDir &&
    storage.roots.mcpDir === mcpBaseDir) ||
    Fail`Backend roots must equal the recorded session storage owner's roots`;
  const recordsPath = [...SESSION_RECORDS_PATH];
  assertPetNames(recordsPath);
  const owner = await E(hostAgent).provideSessionOwner(
    recordsPath,
    controllerSpecifier,
  );
  // What the OpenRouter account lists, as opencode routes it: under the
  // `openrouter/` provider prefix its config names, and with no effort,
  // which the runtime has no setting for.
  const catalog = makeBackendCatalog({
    label: 'OpenCode',
    readCatalog: subscriptionId =>
      E(
        /** @type {Promise<{ modelCatalog(subscriptionId?: string): Promise<any> }>} */ (
          E(hostAgent).lookup([SANDBOX_DIR, 'broker-service'])
        ),
      ).modelCatalog(subscriptionId),
    project: model => {
      const id = `${OPENROUTER_PROVIDER_ID}/${model.id}`;
      // A provider id opencode's config could not name is not offered.
      try {
        parseModelRef(id);
      } catch (_error) {
        return undefined;
      }
      return {
        ...model,
        id,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
      };
    },
  });
  const provisionSession = makeOpencodeSessionProvisioner({
    owner,
    dependencies: harden({
      sandboxService: sandbox.identifier,
      brokerService: broker.identifier,
      storage: storage.identifier,
    }),
    workspaceRoot: workspaceBaseDir,
    privateRoot: mcpBaseDir,
    // The runtime directory and the broker's directory: no guest storage may
    // resolve into them.
    protectedRoots: harden([sandbox.config.directory, broker.config.directory]),
    rootfs: `oci:${broker.config.imageRef}`,
    catalog,
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
  return makeOpencodeBackendFactory({
    publicInternetEnabled: broker.config.publicInternet === true,
    catalog,
    provisionSession,
    stopSession: sessionId => E(owner).stop(sessionId),
    removeSession: sessionId => E(owner).remove(sessionId),
  });
};
harden(make);
