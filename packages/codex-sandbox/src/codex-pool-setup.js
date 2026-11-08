// @ts-check
import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { installationPath } from '@endo/hosted-agent/installation-path.js';
import { provideManagedRenewableCredentials } from '@endo/hosted-agent/managed-renewable-credentials.js';
import { normalizeSubscriptionSet } from '@endo/hosted-agent/subscription-pool.js';
import { assertSubscriptionAccount } from './subscription-setup.js';

const SANDBOX_DIR = 'codex-sandbox';

/**
 * The namespace a broker over several subscriptions takes as its powers: a
 * guest of the operator's, tucked under the adapter's directory. It keeps its
 * identity across runs, so the broker over it is retained like any other.
 *
 * @param {any} host
 */
const provideBrokerPowers = async host => {
  const powersPath = installationPath(SANDBOX_DIR, 'broker-powers');
  const handlePath = installationPath(SANDBOX_DIR, 'broker-powers-handle');
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
 * Preserve the subscription identities held by the broker across setup runs.
 * @param {any} host
 * @param {Record<string,string|undefined>} env
 * @param {string} accountAuthority
 */
export const prepareCodexSubscriptions = async (
  host,
  env,
  accountAuthority,
) => {
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
  let accountRef;
  /** @type {string[] | undefined} */
  let subscriptionIds;
  if (pooled) {
    // What the set said before this run, to refuse an account change under
    // an id that already exists.
    const brokerPowersPath = installationPath(SANDBOX_DIR, 'broker-powers');
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
          // A lane set aside for whoever is pinned to it (a delegated
          // runner's sessions): never drained by the operator's own.
          ...('pinnedOnly' in member ? { pinnedOnly: true } : {}),
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
        installationPath(SANDBOX_DIR, `credential-${member.id}`),
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
        id: accountAuthority,
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
          await E(host).locate(
            ...installationPath(SANDBOX_DIR, `credential-${member.id}`),
          ),
        );
      }
    }
    // The set is a stored value: adding a subscription is this write and a
    // credential, and the broker reads it again for the next session. Stored
    // over the old one, never removed first: setup runs at every start, which
    // is also when sessions are restored and the broker reads this.
    await E(powers).storeValue(set, 'subscriptions');
    subscriptionIds = set.members.map(member => member.id);
  } else {
    accountRef = await provideSubscriptionCredential(
      installationPath(SANDBOX_DIR, 'credential'),
      env.ENDO_CODEX_CREDS_NAME || 'codex-subscription-auth',
      env.ENDO_CODEX_ACCOUNT_REF,
    );
  }
  return { accountRef, subscriptionIds };
};
harden(prepareCodexSubscriptions);
