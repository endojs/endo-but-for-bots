// @ts-check
import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import {
  inspectSessionProfile,
  inspectSessionController,
} from './session-consumer.js';
import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './current-specifier.js';
import {
  hasInstallationPath,
  installationPath,
  migrateBackendInstallation,
  provideInstallationDirectory,
} from './installation-path.js';
import {
  mintWithPowersPath,
  publishAccountOracle,
  readProvisionedEnvironment,
} from './hosted-setup.js';

const consumers = harden([
  '@pins',
  'installations',
  'fae',
  'session-consumers',
]);

/** @param {any} host @param {string} directory @param {string} profileId */
export const assertSubscriptionConsumer = async (
  host,
  directory,
  profileId,
) => {
  const path = [...consumers, directory];
  if (!(await hasInstallationPath(host, path))) return false;
  const registration = await E(host).lookup(path);
  if (registration?.profileId !== profileId)
    throw Error('Session subscription consumer identity changed');
  return true;
};
harden(assertSubscriptionConsumer);

/** Record an explicitly configured session host. Keep its identity as data so
 * deleting a factory does not keep its host or capabilities alive.
 * @param {any} host @param {string} directory @param {string} profileId
 * @param {string} specifier
 */
export const registerSubscriptionConsumer = async (
  host,
  directory,
  profileId,
  specifier,
) => {
  if (
    !profileId ||
    (await E(host).identify(directory, 'controller-profile')) !== profileId
  )
    throw Error('Cannot identify session subscription consumer');
  await assertSubscriptionConsumer(host, directory, profileId);
  await E(host).provideDirectory(consumers);
  await E(host).storeValue(harden({ profileId, specifier }), [
    ...consumers,
    directory,
  ]);
};
harden(registerSubscriptionConsumer);

const directConsumers = async (host, flootDir) => {
  const registered = (await hasInstallationPath(host, consumers))
    ? await E(host).list(...consumers)
    : [];
  const profiles = [];
  for (const directory of new Set([flootDir, ...registered])) {
    const path = [directory, 'controller-profile'];
    // A configured Floot may predate registration. Check its original module,
    // powers and mail handle before introducing either subscription or billing.
    // eslint-disable-next-line no-await-in-loop
    if (await hasInstallationPath(host, path)) {
      // eslint-disable-next-line no-await-in-loop
      const profileId = await E(host).identify(...path);
      // eslint-disable-next-line no-await-in-loop
      const registration = registered.includes(directory)
        // eslint-disable-next-line no-await-in-loop
        ? await E(host).lookup([...consumers, directory])
        : undefined;
      if (registration && registration.profileId !== profileId)
        throw Error('Session subscription consumer identity changed');
      const localSpecifier = new URL(
        registration?.specifier?.endsWith('/packages/fae/session-factory.js')
          ? '../../fae/session-factory.js'
          : '../../floot/agent.js',
        import.meta.url,
      ).href;
      // eslint-disable-next-line no-await-in-loop
      const [controllerId, handleId] = await Promise.all([
        E(host).identify(directory, 'controller'),
        E(host).identify(directory, 'controller-handle'),
      ]);
      // eslint-disable-next-line no-await-in-loop
      await inspectSessionProfile(host, profileId, handleId);
      // eslint-disable-next-line no-await-in-loop
      await inspectSessionController(host, controllerId, {
        profileId,
        localSpecifier,
        specifier:
          registration?.specifier ?? toCurrentSpecifier(localSpecifier),
      });
      // eslint-disable-next-line no-await-in-loop
      profiles.push(await E(host).lookupById(profileId));
    }
  }
  return profiles;
};

const wrappers = harden([
  {
    name: 'model-catalog',
    moduleName: 'subscription-model-catalog',
    suffix: 'model-catalog',
  },
  {
    name: 'subscription',
    moduleName: 'subscription-module',
    suffix: 'inference',
  },
]);
const wrapperSpecifier = (moduleName, label) =>
  assertCurrentSpecifier(
    toCurrentSpecifier(new URL(`./${moduleName}.js`, import.meta.url).href),
    label,
  );

/**
 * Introduce an installed pool to the operator's session factory, regardless
 * of setup order. Validate both facets against the same private broker before
 * exposing either. Publish the inference binding last: it advertises the pool.
 * @param {any} host
 * @param {any} profile
 * @param {'codex'|'claude'} id
 */
export const bindInstalledDirectSubscription = async (host, profile, id) => {
  const dir = `${id}-sandbox`;
  const servicePath = installationPath(dir, 'broker-service');
  if (!(await hasInstallationPath(host, servicePath))) return;
  const owner = await E(host).identify(...servicePath);
  if (!owner) throw Error('Cannot identify installed subscription broker');
  const facets = [];
  for (const { name, moduleName, suffix } of wrappers) {
    const path = installationPath(dir, name);
    // A legacy CLI-only or interrupted installation may have a broker alone.
    // Its own installer supplies the missing direct wrapper on the next run.
    // eslint-disable-next-line no-await-in-loop
    if (!(await E(host).has(...path))) return;
    // eslint-disable-next-line no-await-in-loop
    const { identifier } = await readProvisionedEnvironment(host, {
      label: id,
      namePath: path,
      expectedSpecifier: wrapperSpecifier(moduleName, id),
      expectedPowersIdentifier: owner,
    });
    facets.push({ binding: `${id}-${suffix}`, identifier });
  }
  const accounts = installationPath(dir, 'account-bindings');
  if (await E(host).has(...accounts)) {
    if (!(await E(profile).has('account-bindings')))
      await E(profile).makeDirectory(['account-bindings']);
    await E(profile).storeIdentifier(
      ['account-bindings', dir],
      await E(host).identify(...accounts),
    );
  }
  for (const { binding, identifier } of facets) {
    // eslint-disable-next-line no-await-in-loop
    await E(profile).storeIdentifier(binding, identifier);
  }
};
harden(bindInstalledDirectSubscription);

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
  for (const { name, moduleName } of wrappers) {
    const path = installationPath(dir, name);
    const facetSpecifier = wrapperSpecifier(moduleName, label);
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
  }
  const profiles = await directConsumers(host, flootDir);
  await publishAccountOracle(host, {
    label,
    dir,
    providerId,
    flootDir,
    operatorProfiles: profiles,
    accountAuthority,
    backendId: `fae-${id}`,
    subscriptionIds,
    resetCredits: id === 'codex',
  });
  for (const profileHost of profiles) {
    // eslint-disable-next-line no-await-in-loop
    await bindInstalledDirectSubscription(host, profileHost, id);
  }
};
harden(setupDirectSubscription);
