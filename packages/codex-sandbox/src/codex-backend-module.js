// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { readRuntimeConfig } from '@endo/sandbox/runtime-config.js';
import {
  readProvisionedEnvironment,
  resolveFuturePath,
} from '@endo/hosted-agent/hosted-setup.js';
import {
  containsPath,
  makeSandboxSessionId,
  readMounterEnv,
  readNativeProfile,
  readRecordedPath,
} from '@endo/hosted-agent/session-plan.js';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from '@endo/hosted-agent/current-specifier.js';
import { makeCodexBackendFactory } from './codex-backend-factory.js';
import { readCodexBrokerConfig } from './codex-broker-service-agent.js';
import { readCodexSessionPlan } from './codex-session-plan.js';
import { assertCodexStateRoot } from './codex-state-provider.js';

const current = relative =>
  assertCurrentSpecifier(
    toCurrentSpecifier(new URL(relative, import.meta.url).href),
    'Codex session dependency',
  );

export const controllerSpecifier = current('./codex-native-controller.js');
harden(controllerSpecifier);

/**
 * Compose session placement with one durable daemon owner. All identities
 * are captured by the operator backend, never supplied by Floot or a guest.
 * @param {object} powers
 * @param {any} powers.owner
 * @param {Record<string,string>} powers.dependencies
 * @param {string} powers.workspaceRoot
 * @param {string} powers.privateRoot
 * @param {readonly string[]} powers.protectedRoots Host-only records and services.
 * @param {string} powers.imageRef
 * @param {string} powers.accountRef
 * @param {any} powers.nativeProfile
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
  nativeProfile,
  mounterEnv,
}) => {
  readRecordedPath('workspace root', workspaceRoot);
  readRecordedPath('private root', privateRoot);
  (!containsPath(workspaceRoot, privateRoot) &&
    !containsPath(privateRoot, workspaceRoot)) ||
    Fail`Codex storage roots must be disjoint`;
  readNativeProfile(nativeProfile);
  for (const root of protectedRoots) readRecordedPath('protected root', root);
  if (mounterEnv !== undefined) readMounterEnv(mounterEnv);
  /**
   * @param {string} sessionId
   * @param {Record<string,any>} request
   * @param {any} tools
   */
  const provision = async (sessionId, request, tools) => {
    const sandboxSessionId = makeSandboxSessionId(sessionId, 'codex');
    const privateDir = join(privateRoot, sandboxSessionId);
    const proposed = harden({
      sessionId,
      sandboxSessionId,
      imageRef,
      accountRef,
      networkPolicy: request.networkPolicy,
      ...(request.workspaceHostPath === undefined
        ? { workspaceDir: join(workspaceRoot, sandboxSessionId) }
        : { workspaceHostPath: request.workspaceHostPath }),
      workspaceMountPoint: join(privateDir, 'workspace'),
      mounterSocketDir: join(privateDir, '9p'),
      nativeProfile,
      containerMounts: request.containerMounts,
      ...(mounterEnv === undefined ? {} : { mounterEnv }),
      ...Object.fromEntries(
        ['model', 'reasoningEffort', 'systemPrompt']
          .filter(key => request[key] !== undefined)
          .map(key => [key, request[key]]),
      ),
    });
    const text = JSON.stringify(proposed);
    const plan = readCodexSessionPlan(text);
    // Resolve even roots not created yet: lexical disjointness alone admits
    // aliases into host checkpoints or service-private state. Recheck before
    // every activation, including owned workspaces, not just foreign ones.
    const canonicalRoots = await Promise.all(
      [workspaceRoot, privateRoot, ...protectedRoots].map(root =>
        resolveFuturePath(root, 'Codex'),
      ),
    );
    for (const [index, root] of canonicalRoots.slice(0, 2).entries()) {
      for (const other of canonicalRoots.slice(index + 1)) {
        (!containsPath(root, other) && !containsPath(other, root)) ||
          Fail`Codex guest storage overlaps protected session storage`;
      }
    }
    if (plan.workspaceHostPath !== undefined) {
      const foreign = plan.workspaceHostPath;
      const info = await lstat(foreign);
      (info.isDirectory() &&
        !info.isSymbolicLink() &&
        (await realpath(foreign)) === foreign) ||
        Fail`Codex operator workspace must be a canonical directory`;
      for (const canonicalRoot of canonicalRoots) {
        (!containsPath(canonicalRoot, foreign) &&
          !containsPath(foreign, canonicalRoot)) ||
          Fail`Codex operator workspace overlaps session storage`;
      }
    }
    const record = await E(owner).inspect(sessionId);
    if (record === undefined) {
      await E(owner).create(sessionId, text, harden({ ...dependencies }));
    } else {
      typeof record.plan === 'string' ||
        Fail`Incomplete Codex session record; destroy it before reuse`;
      const old = readCodexSessionPlan(record.plan);
      for (const key of [
        'sessionId',
        'sandboxSessionId',
        'imageRef',
        'accountRef',
        'workspaceDir',
        'workspaceHostPath',
        'workspaceMountPoint',
        'mounterSocketDir',
      ]) {
        old[key] === plan[key] ||
          Fail`Codex session placement cannot change; destroy it before reuse`;
      }
      await E(owner).stop(sessionId);
      if (record.plan !== text) await E(owner).revise(sessionId, text);
    }
    for (const directory of [
      privateDir,
      plan.mounterSocketDir,
      ...(plan.workspaceDir === undefined ? [] : [plan.workspaceDir]),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    return E(owner).start(sessionId, tools);
  };
  return harden(provision);
};
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
  typeof env.CODEX_NATIVE_PROFILE === 'string' ||
    Fail`Missing CODEX_NATIVE_PROFILE`;
  const nativeProfile = JSON.parse(env.CODEX_NATIVE_PROFILE);
  const mounterEnv =
    env.CODEX_MOUNTER_ENV === undefined
      ? undefined
      : JSON.parse(env.CODEX_MOUNTER_ENV);
  typeof env.CODEX_MODELS === 'string' || Fail`Missing CODEX_MODELS`;
  const models = JSON.parse(env.CODEX_MODELS);
  (Array.isArray(models) &&
    models.every(model => brokerConfig.models.includes(model.id))) ||
    Fail`Codex catalog must be admitted by its broker`;
  const owner = await E(host).provideSessionOwner(
    harden(['codex-sandbox', 'session-records']),
    controllerSpecifier,
  );
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
    nativeProfile,
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
  return makeCodexBackendFactory({
    models,
    publicInternetEnabled: brokerConfig.publicInternet === true,
    provisionSession,
    stopSession: id => E(owner).stop(id),
    removeSession: id => E(owner).remove(id),
  });
};
harden(make);
