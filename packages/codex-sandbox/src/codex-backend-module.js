// @ts-check

/**
 * The `codex-backend` caplet: a Floot hosted backend factory for the Codex
 * app-server runtime, minted by `setup-hosted.js` with `@agent` host powers.
 *
 * Sessions belong to the daemon's session owner. The shared provisioner
 * (`@endo/hosted-agent/session-provisioner.js`) writes one approved plan per
 * Floot session and records the exact formula identities of the services it
 * depends on; this module declares what is Codex's: the plan pins the slice
 * image and the subscription account, neither of which a reopen may change,
 * and carries the operator's container mounts; there is no MCP directory; a
 * session that names no model takes the default the account's catalog marks.
 * Host checkpoints, the runtime directory and the broker's directory are
 * protected roots no guest storage may resolve into.
 *
 * Formula env (set by `setup-hosted.js`; no process fallback):
 *   CODEX_WORKSPACE_BASE_DIR  Root of owned per-session workspaces.
 *   CODEX_PRIVATE_DIR         Root of per-session private directories.
 *   CODEX_MOUNTER_ENV         Optional JSON: the rootless mount settings.
 *
 * @module
 */

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { readRuntimeConfig } from '@endo/sandbox/runtime-config.js';
import { readProvisionedEnvironment } from '@endo/hosted-agent/hosted-setup.js';
import { readRecordedPath } from '@endo/hosted-agent/session-plan.js';
import { makeSessionProvisioner } from '@endo/hosted-agent/session-provisioner.js';
import { makeSubscriptionLister } from '@endo/hosted-agent/subscription-lister.js';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from '@endo/hosted-agent/current-specifier.js';
import { makeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js';

import { makeCodexBackendFactory } from './codex-backend-factory.js';
import { readCodexBrokerConfig } from './codex-broker-service-agent.js';
import { readCodexSessionPlan } from './codex-session-plan.js';
import { assertCodexStateRoot } from './codex-state-provider.js';

/** @import { makeBackendCatalog as MakeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js' */

const current = relative =>
  assertCurrentSpecifier(
    toCurrentSpecifier(new URL(relative, import.meta.url).href),
    'Codex session dependency',
  );

export const controllerSpecifier = current('./codex-native-controller.js');
harden(controllerSpecifier);

/**
 * Codex's declaration over the shared session provisioner. All identities
 * are captured by the operator backend, never supplied by Floot or a guest.
 *
 * @param {object} powers
 * @param {any} powers.owner
 * @param {Record<string,string>} powers.dependencies
 * @param {string} powers.workspaceRoot
 * @param {string} powers.privateRoot
 * @param {readonly string[]} powers.protectedRoots Host-only records and services.
 * @param {string} powers.imageRef
 * @param {string} powers.accountRef
 * @param {ReturnType<MakeBackendCatalog>} powers.catalog Admits a new
 *   session's pin against the accounts it may be served from.
 * @param {Record<string,string>} [powers.mounterEnv]
 */
export const makeCodexSessionProvisioner = ({
  owner,
  dependencies,
  workspaceRoot,
  privateRoot,
  protectedRoots,
  imageRef,
  accountRef,
  catalog,
  mounterEnv,
}) =>
  makeSessionProvisioner({
    label: 'Codex',
    owner,
    dependencies,
    workspaceRoot,
    privateRoot,
    protectedRoots,
    sandboxIdFallback: 'codex',
    readPlan: readCodexSessionPlan,
    fields: ({ request }) => ({
      imageRef,
      accountRef,
      containerMounts: request.containerMounts,
    }),
    rebindable: { imageRef: 'image', accountRef: 'account' },
    catalog,
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
harden(makeCodexSessionProvisioner);

/**
 * Operator entrypoint. Floot receives only the guarded factory returned here.
 * @param {any} host
 * @param {unknown} _context
 * @param {{env?: Record<string,string>}} [options]
 */
export const make = async (host, _context, { env = {} } = {}) => {
  const read = (name, relative) =>
    readProvisionedEnvironment(host, {
      label: 'Codex',
      namePath: ['codex-sandbox', name],
      expectedSpecifier: current(relative),
    });
  const [sandbox, broker, state, storage] = await Promise.all([
    read('native-sandbox', '../../sandbox/src/native-agent.js'),
    read('broker-service', './codex-broker-service-agent.js'),
    read('state-provider', './codex-state-provider-module.js'),
    read('session-storage', './codex-session-storage-module.js'),
  ]);
  const brokerConfig = readCodexBrokerConfig(broker.env);
  const protectedRoots = harden([
    assertCodexStateRoot(state.env.ENDO_CODEX_STATE_DIR),
    readRuntimeConfig(sandbox.env).directory,
    brokerConfig.directory,
  ]);
  const workspaceRoot = readRecordedPath(
    'workspace root',
    env.CODEX_WORKSPACE_BASE_DIR,
  );
  const privateRoot = readRecordedPath('private root', env.CODEX_PRIVATE_DIR);
  (storage.env.CODEX_WORKSPACE_BASE_DIR === workspaceRoot &&
    storage.env.CODEX_PRIVATE_DIR === privateRoot) ||
    Fail`Codex backend roots must match its storage owner`;
  const mounterEnv =
    env.CODEX_MOUNTER_ENV === undefined
      ? undefined
      : JSON.parse(env.CODEX_MOUNTER_ENV);
  const owner = await E(host).provideSessionOwner(
    harden(['codex-sandbox', 'session-records']),
    controllerSpecifier,
  );
  const brokerService = () =>
    E(host).lookup(['codex-sandbox', 'broker-service']);
  // What a session may be pinned to: the broker's declared subscriptions.
  // A broker over one credential, or one from before it could say, has
  // none, and there is then nothing to choose.
  const listSubscriptions = makeSubscriptionLister(
    async () => E(await brokerService()).subscriptions(),
    { label: 'Codex' },
  );
  // What each account lists, from the ChatGPT model list under the broker's
  // credential, with the reasoning levels the provider declares.
  const catalog = makeBackendCatalog({
    label: 'Codex',
    readCatalog: async subscriptionId =>
      E(await brokerService()).modelCatalog(subscriptionId),
    listSubscriptions,
  });
  const provisionSession = makeCodexSessionProvisioner({
    owner,
    dependencies: harden({
      sandboxService: sandbox.identifier,
      brokerService: broker.identifier,
      stateProvider: state.identifier,
      storage: storage.identifier,
    }),
    workspaceRoot,
    privateRoot,
    protectedRoots,
    imageRef: brokerConfig.imageRef,
    accountRef: brokerConfig.accountRef,
    catalog,
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
  return makeCodexBackendFactory({
    catalog,
    publicInternetEnabled: brokerConfig.publicInternet === true,
    listSubscriptions,
    provisionSession,
    stopSession: id => E(owner).stop(id),
    removeSession: id => E(owner).remove(id),
  });
};
harden(make);
