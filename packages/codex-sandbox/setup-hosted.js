// @ts-check
/* global process */

/**
 * Codex operator setup after setup-host.js. Retained services own native
 * resources and subscription renewal; the replaceable backend records plans.
 * Required: ENDO_CODEX_ENABLE=1, ENDO_CODEX_HOST_DIR,
 * ENDO_CODEX_SANDBOX_IMAGE, ENDO_CODEX_BROKER_LISTENER_IMAGE. No model
 * list: the account's own catalog is the menu and admits each request.
 * Optional workspace/private roots, Secrets name/account, session concurrency,
 * public-internet/diagnostics switches and rootless NINEP settings remain.
 * No volume registry, storage lease, project-id range or quota helper.
 * Retained service identity changes require explicit retirement, never live
 * replacement. The broker's operator settings (session capacity, public
 * internet, diagnostics) are applied to it at every start instead.
 * @module
 */
import { installationPath } from '@endo/hosted-agent/installation-path.js';
import { Fail, q } from '@endo/errors';
import { readBrokerWorkloadEnv } from '@endo/hosted-agent/provider-broker-service.js';
import { E } from '@endo/eventual-send';
import { bindFlootBackend } from '@endo/hosted-agent/hosted-backend-setup.js';
import {
  configureBroker,
  forgetBrokerSettings,
  mintWithPowersPath,
  providePrivateDirectory,
  publishAccountOracle,
  publishBrokerSubscription,
  republishDelegatedRunners,
  readAccountAuthority,
  readBrokerSettings,
} from '@endo/hosted-agent/hosted-setup.js';
import {
  containsPath,
  readMounterEnv,
  readRecordedPath,
} from '@endo/hosted-agent/session-plan.js';
import { join } from 'node:path';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from '@endo/hosted-agent/current-specifier.js';
import { deriveCodexOwnerId } from './setup-host.js';
import { readCodexBrokerConfig } from './src/codex-broker-service-agent.js';
import {
  SANDBOX_DIR,
  backendSpecifier,
  readNativeSandbox,
  readStateProvider,
  readProvisionedEnvironment,
  resolvePinnedImageRef,
  resolveFuturePath,
} from './src/hosted-runtime-setup.js';
import { prepareCodexSubscriptions } from './src/codex-pool-setup.js';

const current = relative =>
  assertCurrentSpecifier(
    toCurrentSpecifier(new URL(relative, import.meta.url).href),
    'Codex setup',
  );
const brokerSpecifier = current('./src/codex-broker-service-agent.js');
const storageSpecifier = current('./src/codex-session-storage-module.js');

// A retained formula's environment without the broker's operator settings,
// which `configureBroker` applies at every start instead of a retirement.
/** @param {Record<string, string>} formulaEnv */
const retainedIdentity = formulaEnv => {
  if (formulaEnv.CODEX_BROKER_CONFIG === undefined) return formulaEnv;
  const {
    maxSessions: _maxSessions,
    publicInternet: _publicInternet,
    diagnostics: _diagnostics,
    ...identity
  } = JSON.parse(formulaEnv.CODEX_BROKER_CONFIG);
  return { ...formulaEnv, CODEX_BROKER_CONFIG: identity };
};

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
  const workloadEnv = readBrokerWorkloadEnv(env);
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
  const mounterEnv = readMounterEnv(
    Object.fromEntries(
      ['NINEP_MOUNT_PROGRAM', 'NINEP_UMOUNT_PROGRAM', 'NINEP_SUDO']
        .map(name => [name, env[`ENDO_${name}`] || env[name]])
        .filter(
          ([name, value]) => value && (name !== 'NINEP_SUDO' || value === '1'),
        ),
    ),
  );
  const { imageRef, imageDigest } = await resolvePinnedImageRef(
    required(env, 'ENDO_CODEX_SANDBOX_IMAGE'),
    exec,
  );
  const listenerImageRef = required(env, 'ENDO_CODEX_BROKER_LISTENER_IMAGE');
  const pooled = env.ENDO_CODEX_SUBSCRIPTIONS !== undefined;
  const accountAuthority = readAccountAuthority(
    env,
    'ENDO_CODEX_ACCOUNT_AUTHORITY',
    'Codex',
  );
  const brokerPowersPath = installationPath(
    SANDBOX_DIR,
    pooled ? 'broker-powers' : 'credential',
  );
  // Before anything is minted: a broker retained over one credential cannot
  // become a broker over a namespace in place. Refused here, and not by the
  // retained-service check further down, so that the refusal leaves no
  // credential formulas, guest or stored set behind it.
  if (
    pooled &&
    (await E(host).has(...installationPath(SANDBOX_DIR, 'broker-service'))) &&
    !(await E(host).has(...brokerPowersPath))
  ) {
    throw Fail`The retained Codex broker holds one credential. Declaring several subscriptions changes what it holds: retire it deliberately first. Its sessions are bound to that account and do not carry over.`;
  }
  // A retained broker serves the authority it was minted over. A changed
  // declaration is a retirement, refused here before any set or credential
  // is written, as a change of pool mode is; the byte-for-byte comparison of
  // the retained service further down would catch it too, but only after the
  // stored set had been rewritten under the new id.
  if (await E(host).has(...installationPath(SANDBOX_DIR, 'broker-service'))) {
    const retained = await readProvisionedEnvironment(
      host,
      'broker-service',
      brokerSpecifier,
    );
    /** @type {unknown} */
    let retainedAuthority;
    try {
      retainedAuthority = JSON.parse(
        retained.env.CODEX_BROKER_CONFIG ?? '{}',
      ).accountAuthority;
    } catch {
      retainedAuthority = undefined;
    }
    if (retainedAuthority === undefined) {
      throw Fail`The retained ${q(`${installationPath(SANDBOX_DIR).join('/')}/broker-service`)} names no account authority, which this release records into every session plan; retire it deliberately`;
    }
    retainedAuthority === accountAuthority ||
      Fail`The retained ${q(`${installationPath(SANDBOX_DIR).join('/')}/broker-service`)} serves account authority ${q(retainedAuthority)} but the configuration now names ${q(accountAuthority)}; retire it deliberately`;
  }
  const { accountRef, subscriptionIds } = await prepareCodexSubscriptions(
    host,
    env,
    accountAuthority,
  );
  const brokerSettings = readBrokerSettings(env, 'ENDO_CODEX');
  const brokerEnv = harden({
    ...workloadEnv,
    CODEX_BROKER_CONFIG: JSON.stringify({
      ownerId,
      directory: brokerDir,
      imageRef,
      imageDigest,
      listenerImageRef,
      accountAuthority,
      ...(accountRef === undefined ? {} : { accountRef }),
      // Where a new broker's settings start; `configureBroker` below keeps
      // them current at every start, so they are not compared.
      ...brokerSettings,
      ...(pooled ? { pool: true } : {}),
    }),
  });
  readCodexBrokerConfig(brokerEnv);
  const storageEnv = harden({
    CODEX_WORKSPACE_BASE_DIR: workspaceDir,
    CODEX_PRIVATE_DIR: privateDir,
  });
  /** @type {readonly [string, string, Record<string,string>, string[]][]} */
  const services = [
    ['broker-service', brokerSpecifier, brokerEnv, brokerPowersPath],
    [
      'session-storage',
      storageSpecifier,
      storageEnv,
      installationPath(SANDBOX_DIR, 'state-provider'),
    ],
  ];
  for (const [name, specifier, formulaEnv, powersPath] of services) {
    // eslint-disable-next-line no-await-in-loop
    if (await E(host).has(...installationPath(SANDBOX_DIR, name))) {
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
      JSON.stringify(retainedIdentity(existing.env)) ===
        JSON.stringify(retainedIdentity(formulaEnv)) ||
        Fail`Codex retained service configuration changed; retire it deliberately`;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await providePrivateDirectory('Codex broker directory', brokerDir);
      // eslint-disable-next-line no-await-in-loop
      if (name === 'broker-service') await forgetBrokerSettings(brokerDir);
      // eslint-disable-next-line no-await-in-loop
      await mintWithPowersPath(host, {
        powersPath,
        temporary: `codex.${name}-powers`,
        specifier,
        resultName: installationPath(SANDBOX_DIR, name),
        env: formulaEnv,
      });
    }
  }
  await configureBroker(
    host,
    installationPath(SANDBOX_DIR, 'broker-service'),
    brokerSettings,
    'Codex',
  );
  const next = installationPath(SANDBOX_DIR, 'backend-next');
  const backend = installationPath(SANDBOX_DIR, 'backend');
  if (await E(host).has(...next)) await E(host).remove(...next);
  await E(host).makeUnconfined('@main', backendSpecifier, {
    powersName: '@agent',
    resultName: next,
    env: harden({
      ...storageEnv,
      CODEX_MOUNTER_ENV: JSON.stringify(mounterEnv),
    }),
  });
  await E(host).copy(next, backend);
  await E(host).remove(...next);
  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  await bindFlootBackend(host, {
    flootDir,
    backendName: env.ENDO_CODEX_BACKEND_NAME || 'codex-backend',
    backendPath: backend,
  });
  await publishAccountOracle(host, {
    label: 'Codex',
    dir: SANDBOX_DIR,
    providerId: 'codex',
    flootDir,
    backendId: 'codex',
    additionalBackendIds: ['fae-codex'],
    accountAuthority,
    ...(subscriptionIds === undefined ? {} : { subscriptionIds }),
    // ChatGPT plans bank rate-limit resets; an operator redeems them here.
    resetCredits: true,
  });
  // The broker as a Subscription, which shares are made over
  // (`provideSubscriptionShare`); re-minted here so they follow a new broker.
  await publishBrokerSubscription(host, { label: 'Codex', dir: SANDBOX_DIR });
  if (await E(host).has(flootDir, 'controller-profile')) {
    await E(host).copy(installationPath(SANDBOX_DIR, 'subscription'), [
      flootDir,
      'controller-profile',
      'codex-inference',
    ]);
  }
  // Delegated runners (`provideDelegatedRunner`) follow the backend that was
  // bound above.
  await republishDelegatedRunners(host, { label: 'Codex', dir: SANDBOX_DIR });
  console.log(
    'Hosted Codex ready: common scoped sandbox, retained subscription broker, daemon-owned sessions.',
  );
};
harden(main);
