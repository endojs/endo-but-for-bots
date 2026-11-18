// @ts-check
// M4 W4.6: the `subscriptions` provisioning step (scripts/provision-steps/40-subscriptions.js,
// H-8; designs/m4-interfaces.md 14) against a fake control client with the
// manager's shapes: Secrets found by label, members and pools made through
// `SubscriptionsAdmin` (idempotent there, R8-31), pools added to the
// backends once, no secret value written (R8-38). Acceptance 16 runs the
// step against a real manager (W4.8). No supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { steps } from '../../scripts/provision-steps/40-subscriptions.js';

const { Far } = /** @type {any} */ (globalThis);

const step = steps.find(entry => entry.name === 'subscriptions');

/** A fake manager: Secrets by label, idempotent makeMember/makePool. */
const makeFakeHost = () => {
  /** @type {string[]} */
  const calls = [];
  const secrets = new Map(
    ['cred a', 'cred b', 'twice', 'twice'].map((label, i) => [
      Far('Secret', {
        describe: () =>
          harden({
            label,
            description: '',
            generation: 1,
            state: 'active',
            bytes: 10,
          }),
        // A provisioning step must never write a value.
      }),
      `${label}#${i}`,
    ]),
  );
  /** @type {Map<string, any>} */
  const members = new Map();
  /** @type {Map<string, { spec: any, pool: any }>} */
  const pools = new Map();
  const subscriptions = Far('SubscriptionsAdmin', {
    makeMember: (/** @type {any} */ request) => {
      calls.push(`makeMember ${request.label}`);
      if (!members.has(request.label))
        members.set(request.label, Far('PoolMember', {}));
      return members.get(request.label);
    },
    makePool: (/** @type {any} */ spec) => {
      calls.push(`makePool ${spec.label}`);
      if (!pools.has(spec.label))
        pools.set(spec.label, { spec, pool: Far('Backend', {}) });
      return /** @type {any} */ (pools.get(spec.label)).pool;
    },
  });
  const all = [...secrets.keys()];
  const secretsAdmin = Far('SecretsAdmin', {
    // Two pages of two, as the manager pages its list.
    list: (/** @type {string | undefined} */ cursor) =>
      cursor === undefined
        ? harden({ secrets: all.slice(0, 2), next: '2' })
        : harden({ secrets: all.slice(2) }),
    subscriptions: () => subscriptions,
  });
  /** @type {any[]} */
  let backends = [Far('Backend', {})];
  const factory = Far('SessionFactory', {
    listBackends: () => harden([...backends]),
  });
  const harness = Far('HarnessRoot', {
    getOperator: () => Far('Operator', { getFactory: () => factory }),
    configure: (/** @type {any} */ settings) => {
      calls.push(`configure ${settings.backends.length}`);
      backends = [...settings.backends];
      return harden({});
    },
  });
  const admin = Far('AgentHostAdmin', { getSecrets: () => secretsAdmin });
  const client = harden({
    call: async (/** @type {string} */ op, /** @type {string} */ name) => {
      if (op !== 'lookup') return undefined;
      if (name === 'agentHostAdmin') return admin;
      if (name === 'harness') return harness;
      return undefined;
    },
  });
  return { client, calls, pools, backends: () => backends };
};

const options = harden({
  sessionEntry: 'unused',
  subscriptions: [
    {
      kind: 'claude-pool',
      label: 'claude pool',
      members: [
        { label: 'a', provider: 'claude', secretLabel: 'cred a' },
        { label: 'b', provider: 'claude', secretLabel: 'cred b', weight: 2 },
      ],
      contextLength: 100_000,
      baseUrl: 'http://127.0.0.1:1',
      unknownField: 'dropped',
    },
  ],
});

test('the subscriptions step makes members and the pool, adds it to the backends, and is a no-op the second time', async t => {
  if (step === undefined) throw Error('no subscriptions step');
  const host = makeFakeHost();
  const first = await step.run(
    /** @type {any} */ ({ client: host.client, options }),
  );
  t.false(first.skipped);
  t.deepEqual(first.detail, { pools: 1, added: 1 });
  const made = host.pools.get('claude pool');
  t.deepEqual(Object.keys(made?.spec ?? {}).sort(), [
    'baseUrl',
    'contextLength',
    'kind',
    'label',
    'members',
  ]);
  t.is(made?.spec.members.length, 2);
  t.is(host.backends().length, 2);
  const second = await step.run(
    /** @type {any} */ ({ client: host.client, options }),
  );
  t.true(second.skipped);
  t.is(host.calls.filter(c => c.startsWith('configure')).length, 1);
  t.is(host.backends().length, 2);
});

test('the subscriptions step refuses an unknown or ambiguous Secret label and skips with no pools', async t => {
  if (step === undefined) throw Error('no subscriptions step');
  const host = makeFakeHost();
  const bad = (/** @type {string} */ secretLabel) =>
    harden({
      sessionEntry: 'unused',
      subscriptions: [
        {
          kind: 'claude-pool',
          label: 'p',
          members: [{ label: 'a', provider: 'claude', secretLabel }],
        },
      ],
    });
  await t.throwsAsync(
    step.run(/** @type {any} */ ({ client: host.client, options: bad('x') })),
    { message: /No single Secret labelled "x"/ },
  );
  await t.throwsAsync(
    step.run(
      /** @type {any} */ ({ client: host.client, options: bad('twice') }),
    ),
    { message: /No single Secret labelled "twice"/ },
  );
  const none = await step.run(
    /** @type {any} */ ({
      client: host.client,
      options: { sessionEntry: 'unused' },
    }),
  );
  t.true(none.skipped);
  t.deepEqual(host.calls, []);
});
