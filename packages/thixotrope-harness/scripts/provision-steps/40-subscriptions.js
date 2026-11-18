// @ts-check
/**
 * M4's provisioning step (W4.6, m4-interfaces.md 14 H-8), a registered step
 * file (`scripts/provision-steps.js` header): `subscriptions` makes the
 * members and pools of `options.subscriptions` through
 * `SecretsAdmin.subscriptions()` and adds missing pools to the backends;
 * skipped without `options.subscriptions`.
 */
import { E } from '@endo/far';

import { names } from '../provision-steps.js';

/**
 * The `PoolSpec` fields a provisioning entry may set besides its kind,
 * label and members (`interfaces-m4.js` `PoolSpec`).
 */
const POOL_SPEC_FIELDS = harden([
  'modelId',
  'contextLength',
  'maxOutputTokens',
  'timeoutMs',
  'cacheLifetimeMs',
  'baseUrl',
  'tokenUrl',
  'usageUrl',
  'logPath',
]);

/**
 * Every Secret of the Secrets manager by label (the provisioning boundary,
 * F.2 c: the options file names Secrets by label). A label held by two
 * Secrets is refused rather than guessed.
 * @param {any} secretsAdmin
 * @returns {Promise<Map<string, any>>}
 */
export const secretsByLabel = async secretsAdmin => {
  /** @type {Map<string, any>} */
  const byLabel = new Map();
  /** @type {Set<string>} */
  const twice = new Set();
  /** @type {string | undefined} */
  let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop -- pages follow each other
    const page = await E(secretsAdmin).list(
      ...(cursor === undefined ? [] : [cursor]),
    );
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    const infos = await Promise.all(
      page.secrets.map((/** @type {any} */ secret) => E(secret).describe()),
    );
    page.secrets.forEach(
      (/** @type {any} */ secret, /** @type {number} */ i) => {
        const { label } = infos[i];
        if (byLabel.has(label)) twice.add(label);
        byLabel.set(label, secret);
      },
    );
    cursor = page.next;
  } while (cursor !== undefined);
  for (const label of twice) byLabel.delete(label);
  return byLabel;
};

/** @type {import('../provision-steps.js').ProvisionStep[]} */
export const steps = harden([
  {
    // M4 W4.6 (m4-interfaces.md 14, H-8; a registered step file since INT-M4): subscription pools from the
    // options' `subscriptions: [{ kind, label, members: [{ label, provider,
    // secretLabel, weight? }], ...PoolSpec fields }]`. Each Secret is found
    // by label; `makeMember` and `makePool` are idempotent (R8-31), so a
    // second run changes nothing; pools missing from the backends are
    // added. No secret value is ever written here (R8-38).
    name: 'subscriptions',
    run: async ({ client, options }) => {
      /** @type {any[]} */
      const wanted = /** @type {any} */ (options).subscriptions ?? [];
      if (wanted.length === 0) return { skipped: true };
      const admin = await client.call('lookup', names.agentHost);
      const secretsAdmin = await E(admin).getSecrets();
      const subscriptions = await E(secretsAdmin).subscriptions();
      const byLabel = await secretsByLabel(secretsAdmin);
      /** @type {any[]} */
      const pools = [];
      for (const pool of wanted) {
        /** @type {any[]} */
        const members = [];
        for (const member of pool.members) {
          const secret = byLabel.get(member.secretLabel);
          if (secret === undefined)
            throw Error(
              `No single Secret labelled ${JSON.stringify(member.secretLabel)}`,
            );
          members.push(
            // eslint-disable-next-line no-await-in-loop -- idempotent, in order
            await E(subscriptions).makeMember(
              harden({
                provider: member.provider,
                label: member.label,
                credential: secret,
                ...(member.weight === undefined
                  ? {}
                  : { weight: member.weight }),
              }),
            ),
          );
        }
        /** @type {Record<string, any>} */
        const spec = { kind: pool.kind, label: pool.label, members };
        for (const field of POOL_SPEC_FIELDS)
          if (pool[field] !== undefined) spec[field] = pool[field];
        // eslint-disable-next-line no-await-in-loop -- idempotent, in order
        pools.push(await E(subscriptions).makePool(harden(spec)));
      }
      const harness = await client.call('lookup', names.harness);
      const factory = await E(E(harness).getOperator()).getFactory();
      /** @type {any[]} */
      const current = await E(factory).listBackends();
      const missing = pools.filter(pool => !current.includes(pool));
      if (missing.length === 0)
        return { skipped: true, detail: { pools: pools.length } };
      await E(harness).configure(
        harden({ backends: [...current, ...missing] }),
      );
      return {
        skipped: false,
        detail: { pools: pools.length, added: missing.length },
      };
    },
  },
]);
