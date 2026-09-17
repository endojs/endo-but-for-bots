// @ts-check
/* global process */

/**
 * Codex operator setup after setup-host.js. Retained services own native
 * resources and subscription renewal; the replaceable backend records plans.
 * Required: ENDO_CODEX_ENABLE=1, ENDO_CODEX_HOST_DIR,
 * ENDO_CODEX_SANDBOX_IMAGE, ENDO_CODEX_BROKER_LISTENER_IMAGE,
 * ENDO_CODEX_NATIVE_PROFILE and ENDO_CODEX_MODELS (JSON).
 * Optional workspace/private roots, Secrets name/account, session concurrency,
 * public-internet/diagnostics switches and rootless NINEP settings remain.
 * No volume registry, storage lease, project-id range or quota helper.
 * Retained service changes require explicit retirement, never live replacement.
 * @module
 */
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import {
  mintWithPowersPath,
  providePrivateDirectory,
} from '@endo/hosted-agent/hosted-setup.js';
import { provideManagedRenewableCredentials } from '@endo/hosted-agent/managed-renewable-credentials.js';
import {
  containsPath,
  readMounterEnv,
  readNativeProfile,
  readRecordedPath,
} from '@endo/hosted-agent/session-plan.js';
import { join } from 'node:path';

import { deriveCodexOwnerId } from './setup-host.js';
import { normalizeCodexModelDescriptor } from './src/codex-models.js';
import { readCodexBrokerConfig } from './src/codex-broker-service-agent.js';
import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './src/current-specifier.js';
import {
  SANDBOX_DIR,
  backendSpecifier,
  readNativeSandbox,
  readStateProvider,
  readProvisionedEnvironment,
  resolvePinnedImageRef,
  resolveFuturePath,
} from './src/hosted-runtime-setup.js';
import { assertSubscriptionAccount } from './src/subscription-setup.js';

const current = relative =>
  assertCurrentSpecifier(
    toCurrentSpecifier(new URL(relative, import.meta.url).href),
    'Codex setup',
  );
const brokerSpecifier = current('./src/codex-broker-service-agent.js');
const storageSpecifier = current('./src/codex-session-storage-module.js');

/**
 * @param {Record<string,string | undefined>} env
 * @param {string} name
 */
const required = (env, name) => {
  const value = env[name];
  if (typeof value !== 'string' || value === '')
    throw Fail`Missing Codex setup setting ${name}`;
  return value;
};

/**
 * @param {any} host
 * @param {{exec?: Parameters<typeof resolvePinnedImageRef>[1]}} [powers]
 */
export const main = async (host, { exec } = {}) => {
  await null;
  const { env } = process;
  if (env.ENDO_CODEX_ENABLE !== '1') return;
  const runtime = await readNativeSandbox(host);
  const state = await readStateProvider(host);
  const ownerId =
    env.ENDO_CODEX_SANDBOX_OWNER_ID || (await deriveCodexOwnerId(host));
  runtime.config.ownerId === ownerId ||
    Fail`Codex native runtime owner differs from setup`;
  const hostDir = readRecordedPath(
    'Codex host directory',
    required(env, 'ENDO_CODEX_HOST_DIR'),
  );
  const workspaceDir = readRecordedPath(
    'workspace root',
    env.ENDO_CODEX_WORKSPACE_DIR || join(hostDir, 'workspaces'),
  );
  const privateDir = readRecordedPath(
    'private root',
    env.ENDO_CODEX_PRIVATE_DIR || join(hostDir, 'sessions'),
  );
  const brokerDir = join(hostDir, 'broker');
  const roots = await Promise.all(
    [
      workspaceDir,
      privateDir,
      state.stateDir,
      brokerDir,
      runtime.config.directory,
    ].map(resolveFuturePath),
  );
  for (const [index, root] of roots.slice(0, 2).entries()) {
    for (const other of roots.slice(index + 1)) {
      (!containsPath(root, other) && !containsPath(other, root)) ||
        Fail`Codex guest roots overlap protected storage`;
    }
  }
  const nativeProfile = required(env, 'ENDO_CODEX_NATIVE_PROFILE');
  readNativeProfile(JSON.parse(nativeProfile));
  const mounterEnv = readMounterEnv(
    Object.fromEntries(
      ['NINEP_MOUNT_PROGRAM', 'NINEP_UMOUNT_PROGRAM', 'NINEP_SUDO']
        .map(name => [name, env[`ENDO_${name}`] || env[name]])
        .filter(
          ([name, value]) => value && (name !== 'NINEP_SUDO' || value === '1'),
        ),
    ),
  );
  const models = JSON.parse(required(env, 'ENDO_CODEX_MODELS'));
  (Array.isArray(models) && models.length > 0) ||
    Fail`Codex models must be nonempty`;
  models.map(normalizeCodexModelDescriptor);
  const { imageRef, imageDigest } = await resolvePinnedImageRef(
    required(env, 'ENDO_CODEX_SANDBOX_IMAGE'),
    exec,
  );
  const listenerImageRef = required(env, 'ENDO_CODEX_BROKER_LISTENER_IMAGE');
  const credsName = env.ENDO_CODEX_CREDS_NAME || 'codex-subscription-auth';
  await provideManagedRenewableCredentials(host, {
    namePath: [SANDBOX_DIR, 'credential'],
    secretPath: ['secrets', credsName],
    label: 'Codex',
  });
  const credential = await E(host).lookup([SANDBOX_DIR, 'credential']);
  let stored;
  try {
    stored = JSON.parse(
      globalThis.atob((await E(credential).readBase64WithGeneration()).base64),
    );
  } catch {
    throw Fail`Invalid Codex subscription credential`;
  }
  stored?.version === 'BrokerOAuthStateV1' ||
    Fail`Import the normalized Codex subscription credential before setup`;
  const accountRef = assertSubscriptionAccount(
    env.ENDO_CODEX_ACCOUNT_REF || stored.accountId,
    stored,
  );
  const brokerEnv = harden({
    CODEX_BROKER_CONFIG: JSON.stringify({
      ownerId,
      directory: brokerDir,
      imageRef,
      imageDigest,
      listenerImageRef,
      accountRef,
      models: models.map(model => model.id),
      ...(env.ENDO_CODEX_MAX_SESSIONS
        ? { maxSessions: Number(env.ENDO_CODEX_MAX_SESSIONS) }
        : {}),
      publicInternet: env.ENDO_CODEX_PUBLIC_INTERNET === '1',
      diagnostics: env.ENDO_CODEX_DIAGNOSTICS === '1',
    }),
  });
  readCodexBrokerConfig(brokerEnv);
  const storageEnv = harden({
    CODEX_WORKSPACE_BASE_DIR: workspaceDir,
    CODEX_PRIVATE_DIR: privateDir,
  });
  /** @type {readonly [string, string, Record<string,string>, string[]][]} */
  const services = [
    ['broker-service', brokerSpecifier, brokerEnv, [SANDBOX_DIR, 'credential']],
    [
      'session-storage',
      storageSpecifier,
      storageEnv,
      [SANDBOX_DIR, 'state-provider'],
    ],
  ];
  for (const [name, specifier, formulaEnv, powersPath] of services) {
    // eslint-disable-next-line no-await-in-loop
    if (await E(host).has(SANDBOX_DIR, name)) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await readProvisionedEnvironment(host, name, specifier);
      // eslint-disable-next-line no-await-in-loop
      const diagnostics = await E(host).diagnostics();
      // eslint-disable-next-line no-await-in-loop
      const formula = await E(diagnostics).getFormula(existing.identifier);
      // eslint-disable-next-line no-await-in-loop
      const powersId = await E(host).identify(...powersPath);
      (formula.properties?.powers?.kind === 'reference' &&
        formula.properties.powers.identifier === powersId) ||
        Fail`Codex retained service dependency changed; retire it deliberately`;
      JSON.stringify(existing.env) === JSON.stringify(formulaEnv) ||
        Fail`Codex retained service configuration changed; retire it deliberately`;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await providePrivateDirectory('Codex broker directory', brokerDir);
      // eslint-disable-next-line no-await-in-loop
      await mintWithPowersPath(host, {
        powersPath,
        temporary: `codex.${name}-powers`,
        specifier,
        resultName: [SANDBOX_DIR, name],
        env: formulaEnv,
      });
    }
  }
  const next = [SANDBOX_DIR, 'backend-next'];
  const backend = [SANDBOX_DIR, 'backend'];
  if (await E(host).has(...next)) await E(host).remove(...next);
  await E(host).makeUnconfined('@main', backendSpecifier, {
    powersName: '@agent',
    resultName: next,
    env: harden({
      ...storageEnv,
      CODEX_NATIVE_PROFILE: nativeProfile,
      CODEX_MOUNTER_ENV: JSON.stringify(mounterEnv),
      CODEX_MODELS: JSON.stringify(models),
    }),
  });
  await E(host).copy(next, backend);
  await E(host).remove(...next);
  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  if (await E(host).has(flootDir, 'controller-profile')) {
    await E(host).copy(backend, [
      flootDir,
      'controller-profile',
      env.ENDO_CODEX_BACKEND_NAME || 'codex-backend',
    ]);
  }
  console.log(
    'Hosted Codex ready: common scoped sandbox, retained subscription broker, daemon-owned sessions.',
  );
};
harden(main);
