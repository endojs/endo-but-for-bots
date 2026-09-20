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
  publishAccountOracle,
  publishBrokerSubscription,
} from '@endo/hosted-agent/hosted-setup.js';
import { provideManagedRenewableCredentials } from '@endo/hosted-agent/managed-renewable-credentials.js';
import { normalizeSubscriptionSet } from '@endo/hosted-agent/subscription-pool.js';
import {
  containsPath,
  readMounterEnv,
  readNativeProfile,
  readRecordedPath,
} from '@endo/hosted-agent/session-plan.js';
import { join } from 'node:path';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from '@endo/hosted-agent/current-specifier.js';
import { deriveCodexOwnerId } from './setup-host.js';
import { normalizeCodexModelDescriptor } from './src/codex-models.js';
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
 * The namespace a broker over several subscriptions takes as its powers: a
 * guest of the operator's, tucked under the adapter's directory. It keeps its
 * identity across runs, so the broker over it is retained like any other.
 *
 * @param {any} host
 */
const provideBrokerPowers = async host => {
  const powersPath = [SANDBOX_DIR, 'broker-powers'];
  const handlePath = [SANDBOX_DIR, 'broker-powers-handle'];
  const handleName = `${SANDBOX_DIR}.broker-powers-handle`;
  const powersName = `${SANDBOX_DIR}.broker-powers`;
  if (!(await E(host).has(...powersPath))) {
    for (const stray of [handleName, powersName]) {
      // eslint-disable-next-line no-await-in-loop
      if (await E(host).has(stray)) await E(host).remove(stray);
    }
    await E(host).provideGuest(handleName, { agentName: powersName });
    await E(host).move([handleName], handlePath);
    await E(host).move([powersName], powersPath);
  }
  return E(host).lookup(powersPath);
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
  /**
   * Import one subscription's credential as a managed renewable formula and
   * read the account it names.
   *
   * @param {string[]} namePath
   * @param {string} credsName
   * @param {string | undefined} declaredAccount
   */
  const provideSubscriptionCredential = async (
    namePath,
    credsName,
    declaredAccount,
  ) => {
    await provideManagedRenewableCredentials(host, {
      namePath,
      secretPath: ['secrets', credsName],
      label: 'Codex',
    });
    const credential = await E(host).lookup(namePath);
    let stored;
    try {
      stored = JSON.parse(
        globalThis.atob(
          (await E(credential).readBase64WithGeneration()).base64,
        ),
      );
    } catch {
      throw Fail`Invalid Codex subscription credential`;
    }
    stored?.version === 'BrokerOAuthStateV1' ||
      Fail`Import the normalized Codex subscription credential before setup`;
    return assertSubscriptionAccount(
      declaredAccount || stored.accountId,
      stored,
    );
  };

  // Several subscriptions, declared by the operator as
  // `[{ id, label?, weight?, credsName, accountRef? }]`, or, for a member
  // that is somebody else's subscription handed over as a share,
  // `[{ id, label?, weight?, shareName }]`, where `shareName` is the pet name
  // the operator stored that share under. The broker's powers
  // are then a namespace holding the set and each member's credential, not
  // one credential, so switching an existing deployment to it is a deliberate
  // retirement of its broker, like any other change of what the broker holds.
  let declaredSubscriptions;
  if (env.ENDO_CODEX_SUBSCRIPTIONS) {
    try {
      declaredSubscriptions = JSON.parse(env.ENDO_CODEX_SUBSCRIPTIONS);
    } catch {
      // Not the parser's message, which quotes what it choked on.
      throw Fail`ENDO_CODEX_SUBSCRIPTIONS is not JSON`;
    }
  }
  declaredSubscriptions === undefined ||
    (Array.isArray(declaredSubscriptions) &&
      declaredSubscriptions.length > 0) ||
    Fail`ENDO_CODEX_SUBSCRIPTIONS must be a nonempty list`;
  const pooled = declaredSubscriptions !== undefined;
  const brokerPowersPath = pooled
    ? [SANDBOX_DIR, 'broker-powers']
    : [SANDBOX_DIR, 'credential'];
  let accountRef;
  /** @type {string[] | undefined} */
  let subscriptionIds;
  // Before anything is minted: a broker retained over one credential cannot
  // become a broker over a namespace in place. Refused here, and not by the
  // retained-service check further down, so that the refusal leaves no
  // credential formulas, guest or stored set behind it.
  if (
    pooled &&
    (await E(host).has(SANDBOX_DIR, 'broker-service')) &&
    !(await E(host).has(...brokerPowersPath))
  ) {
    throw Fail`The retained Codex broker holds one credential. Declaring several subscriptions changes what it holds: retire it deliberately first. Its sessions are bound to that account and do not carry over.`;
  }
  if (pooled) {
    // What the set said before this run, to refuse an account change under
    // an id that already exists.
    const priorAccounts = new Map();
    if (await E(host).has(...brokerPowersPath)) {
      const priorPowers = await E(host).lookup(brokerPowersPath);
      if (await E(priorPowers).has('subscriptions')) {
        const prior = await E(priorPowers).lookup('subscriptions');
        for (const member of prior?.members ?? []) {
          priorAccounts.set(member.id, member.accountRef);
        }
      }
    }
    const members = [];
    /** @type {Map<string, string>} wrapped member's name to the share's locator */
    const shareLocators = new Map();
    for (const declared of declaredSubscriptions) {
      if (
        declared !== null &&
        typeof declared === 'object' &&
        declared.shareName !== undefined
      ) {
        // Somebody else's subscription: no credential of ours, no account.
        const {
          shareName,
          credsName: none,
          accountRef: noAccount,
          ...rest
        } = declared;
        (typeof shareName === 'string' &&
          /^[a-z0-9][a-z0-9-]{0,127}$/.test(shareName) &&
          none === undefined &&
          noAccount === undefined) ||
          Fail`A Codex subscription held as a share names only its shareName`;
        const [member] = normalizeSubscriptionSet({ members: [rest] }).members;
        // eslint-disable-next-line no-await-in-loop
        (await E(host).has(shareName)) ||
          Fail`Codex subscription ${member.id} names a share that is not there`;
        !priorAccounts.has(member.id) ||
          priorAccounts.get(member.id) === undefined ||
          Fail`Codex subscription ${member.id} is bound to an account; add the share under a new id`;
        // Never the operator's choice, like a secret's name.
        const subscriptionName = `share-${member.id}`;
        // eslint-disable-next-line no-await-in-loop
        shareLocators.set(subscriptionName, await E(host).locate(shareName));
        members.push({
          id: member.id,
          label: member.label,
          weight: member.weight,
          subscriptionName,
        });
        // eslint-disable-next-line no-continue
        continue;
      }
      (declared !== null &&
        typeof declared === 'object' &&
        typeof declared.credsName === 'string' &&
        declared.credsName !== '') ||
        Fail`Every Codex subscription needs an id and a credsName`;
      const {
        credsName: memberCreds,
        accountRef: declaredAccount,
        ...rest
      } = declared;
      // Validated as the broker will validate it, before anything is minted.
      const [member] = normalizeSubscriptionSet({ members: [rest] }).members;
      // eslint-disable-next-line no-await-in-loop
      const memberAccount = await provideSubscriptionCredential(
        [SANDBOX_DIR, `credential-${member.id}`],
        memberCreds,
        declaredAccount,
      );
      // A subscription's account is its identity. A different account under
      // an id that exists is a different subscription: add it under a new
      // id. (The running broker would otherwise keep a credential bound to
      // the old account and refuse every grant, and after a restart the same
      // name would silently spend another account.)
      !priorAccounts.has(member.id) ||
        priorAccounts.get(member.id) === memberAccount ||
        Fail`Codex subscription ${member.id} is bound to another account; add the new account under a new id`;
      members.push({
        ...member,
        // Never the operator's choice: the namespace also holds the set and
        // the pool's state, and a secret must not take one of their names.
        secretName: `secret-${member.id}`,
        accountRef: memberAccount,
      });
    }
    const set = normalizeSubscriptionSet(
      {
        members,
        ...(env.ENDO_CODEX_CACHE_LIFETIME_SECONDS
          ? {
              cacheLifetimeSeconds: Number(
                env.ENDO_CODEX_CACHE_LIFETIME_SECONDS,
              ),
            }
          : {}),
      },
      { requireAccountRef: true },
    );
    const powers = await provideBrokerPowers(host);
    for (const member of set.members) {
      if ('subscriptionName' in member) {
        // eslint-disable-next-line no-await-in-loop
        await E(powers).storeLocator(
          member.subscriptionName,
          /** @type {string} */ (shareLocators.get(member.subscriptionName)),
        );
      } else {
        // eslint-disable-next-line no-await-in-loop
        await E(powers).storeLocator(
          member.secretName,
          // eslint-disable-next-line no-await-in-loop
          await E(host).locate(SANDBOX_DIR, `credential-${member.id}`),
        );
      }
    }
    // The set is a stored value: adding a subscription is this write and a
    // credential, and the broker reads it again for the next session. Stored
    // over the old one, never removed first: setup runs at every start, which
    // is also when sessions are restored and the broker reads this.
    await E(powers).storeValue(set, 'subscriptions');
    accountRef = 'pool';
    subscriptionIds = set.members.map(member => member.id);
  } else {
    accountRef = await provideSubscriptionCredential(
      [SANDBOX_DIR, 'credential'],
      env.ENDO_CODEX_CREDS_NAME || 'codex-subscription-auth',
      env.ENDO_CODEX_ACCOUNT_REF,
    );
  }
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
  await publishAccountOracle(host, {
    label: 'Codex',
    dir: SANDBOX_DIR,
    providerId: 'codex',
    flootDir,
    backendId: 'codex',
    ...(subscriptionIds === undefined ? {} : { subscriptionIds }),
    // ChatGPT plans bank rate-limit resets; an operator redeems them here.
    resetCredits: true,
  });
  // The broker as a Subscription, which shares are made over
  // (`provideSubscriptionShare`); re-minted here so they follow a new broker.
  await publishBrokerSubscription(host, { label: 'Codex', dir: SANDBOX_DIR });
  console.log(
    'Hosted Codex ready: common scoped sandbox, retained subscription broker, daemon-owned sessions.',
  );
};
harden(main);
