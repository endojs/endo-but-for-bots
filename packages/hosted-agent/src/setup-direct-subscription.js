// @ts-check
import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './current-specifier.js';
import {
  installationPath,
  migrateBackendInstallation,
  provideInstallationDirectory,
} from './installation-path.js';
import {
  mintWithPowersPath,
  publishAccountOracle,
  readProvisionedEnvironment,
} from './hosted-setup.js';

/**
 * Keep the broker formula and its exact renewable credential owner across
 * cutover. Both fresh and retained owners serve direct inference on revival.
 * @param {any} host
 * @param {object} options
 * @param {'codex'|'claude'} options.id
 * @param {string} options.label
 * @param {string} options.providerId
 * @param {string} options.flootDir
 * @param {string} options.accountAuthority
 * @param {string[]} [options.singlePowersPath]
 * @param {string} options.ownerModule
 * @param {Record<string,string>} options.workloadEnv
 * @param {(env: Record<string,string>) => any} options.readProfile
 * @param {Record<string,unknown>} options.profile
 * @param {() => Promise<{subscriptionIds?: string[], accountRef?: string}>} options.prepareCredentials
 */
export const setupDirectSubscription = async (
  host,
  {
    id,
    label,
    providerId,
    flootDir,
    accountAuthority,
    ownerModule,
    readProfile,
    profile,
    prepareCredentials,
    workloadEnv,
    singlePowersPath,
  },
) => {
  const dir = `${id}-sandbox`;
  const profilePath = [flootDir, 'controller-profile'];
  (await E(host).has(...profilePath)) ||
    Fail`Configure Floot before its direct subscriptions`;
  await migrateBackendInstallation(host, dir);
  await provideInstallationDirectory(host, dir);
  const servicePath = installationPath(dir, 'broker-service');
  const pooled = profile.pool === true;
  const powersPath = pooled
    ? installationPath(dir, 'broker-powers')
    : (singlePowersPath ?? installationPath(dir, 'credential'));
  const specifier = assertCurrentSpecifier(
    toCurrentSpecifier(ownerModule),
    label,
  );
  const existing = await E(host).has(...servicePath);
  let retained;
  if (existing) {
    (await E(host).has(...powersPath)) ||
      Fail`Retained broker uses different credentials`;
    const { env } = await readProvisionedEnvironment(host, {
      label,
      namePath: servicePath,
      expectedSpecifier: specifier,
      expectedPowersIdentifier: await E(host).identify(...powersPath),
    });
    retained = readProfile(env);
    (retained.accountAuthority === accountAuthority &&
      (retained.pool === true) === pooled &&
      retained.credentialKind === profile.credentialKind &&
      (profile.anthropicBeta === undefined ||
        retained.anthropicBeta === profile.anthropicBeta)) ||
      Fail`Retained subscription broker configuration differs`;
  }
  const { subscriptionIds, accountRef } = await prepareCredentials();
  if (retained) {
    retained.accountRef === accountRef ||
      Fail`Retained subscription account differs`;
  } else {
    const env = {
      ...workloadEnv,
      [`${id.toUpperCase()}_BROKER_CONFIG`]: JSON.stringify({
        ownerId: `${id}-subscription`,
        directOnly: true,
        accountAuthority,
        ...profile,
        ...(accountRef ? { accountRef } : {}),
      }),
    };
    readProfile(env);
    await mintWithPowersPath(host, {
      powersPath,
      temporary: `${id}.broker-powers`,
      specifier,
      resultName: servicePath,
      env,
    });
  }
  const ownerId = await E(host).identify(...servicePath);
  // These wrapped facets are durable dependencies of Fae sessions and shares.
  // A rerun keeps their identities and proves which broker each one wraps.
  for (const [name, moduleName, binding] of [
    ['subscription', 'subscription-module', `${id}-inference`],
    ['model-catalog', 'subscription-model-catalog', `${id}-model-catalog`],
  ]) {
    const path = installationPath(dir, name);
    const facetSpecifier = assertCurrentSpecifier(
      toCurrentSpecifier(new URL(`./${moduleName}.js`, import.meta.url).href),
      label,
    );
    // eslint-disable-next-line no-await-in-loop
    if (await E(host).has(...path)) {
      // eslint-disable-next-line no-await-in-loop
      await readProvisionedEnvironment(host, {
        label,
        namePath: path,
        expectedSpecifier: facetSpecifier,
        expectedPowersIdentifier: ownerId,
      });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await mintWithPowersPath(host, {
        powersPath: servicePath,
        temporary: `${id}.${name}-powers`,
        specifier: facetSpecifier,
        resultName: path,
        env: {},
      });
    }
    // eslint-disable-next-line no-await-in-loop
    await E(host).copy(path, [...profilePath, binding]);
  }
  await publishAccountOracle(host, {
    label,
    dir,
    providerId,
    flootDir,
    accountAuthority,
    backendId: `fae-${id}`,
    subscriptionIds,
    resetCredits: id === 'codex',
  });
};
harden(setupDirectSubscription);
