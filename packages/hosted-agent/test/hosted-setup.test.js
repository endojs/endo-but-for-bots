// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Far } from '@endo/far';
import { PINNED_IMAGE_REFERENCE_PATTERN } from '@endo/sandbox/policy.js';
import { makeAccountId } from '../src/account-bindings.js';

import {
  assertNoRuntimeLeftovers,
  assertRuntimePlacement,
  mintWithPowersPath,
  prepareRuntimeEnv,
  providePrivateDirectory,
  provideDelegatedRunner,
  provideSubscriptionShare,
  publishAccountOracle,
  publishBrokerSubscription,
  republishDelegatedRunners,
  readProvisionedEnvironment,
  readSliceImageReference,
  resolveFuturePath,
  resolvePinnedImageRef,
} from '../src/hosted-setup.js';

const key = (...parts) => JSON.stringify(parts.flat());

/** @param {string} p */
// eslint-disable-next-line no-bitwise
const modeOf = async p => (await stat(p)).mode & 0o777;

/** @param {import('ava').ExecutionContext} t */
const makeTmp = async t => {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'hosted-setup-')),
  );
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const makeFakeHost = () => {
  const bindings = new Map();
  const formulas = new Map();
  const environments = new Map();
  /** @type {any[]} */
  const calls = [];
  const seed = (namePath, id, specifier, env) => {
    bindings.set(key(...namePath), id);
    formulas.set(id, {
      type: 'make-unconfined',
      properties: { specifier: { kind: 'literal', value: specifier } },
    });
    environments.set(id, env);
  };
  const host = harden({
    async identify(...parts) {
      return bindings.get(key(...parts));
    },
    async has(...parts) {
      return bindings.has(key(...parts));
    },
    async diagnostics() {
      return harden({ getFormula: async id => formulas.get(id) });
    },
    async getFormulaEnvironment(id) {
      return environments.get(id);
    },
    async copy(from, to) {
      calls.push(['copy', from, to]);
      bindings.set(key(...to), bindings.get(key(...from)));
    },
    async remove(...parts) {
      calls.push(['remove', parts]);
      bindings.delete(key(...parts));
    },
    async makeUnconfined(worker, specifier, options) {
      calls.push(['mint', worker, specifier, options]);
      bindings.set(key(options.resultName), `minted-${specifier}`);
    },
  });
  return { host, seed, bindings, calls, formulas };
};

test('a provisioned storage owner must capture the expected provider identity', async t => {
  const { host, seed, formulas } = makeFakeHost();
  seed(['adapter', 'storage'], 'storage-id', 'file:///storage.js', {});
  const options = {
    label: 'Adapter',
    namePath: ['adapter', 'storage'],
    expectedSpecifier: 'file:///storage.js',
    expectedPowersIdentifier: 'state-id',
  };
  const formula = formulas.get('storage-id');
  for (const powers of [
    undefined,
    { kind: 'literal', value: 'state-id' },
    { kind: 'reference', identifier: 'other-id' },
  ]) {
    formulas.set('storage-id', {
      ...formula,
      properties: { ...formula.properties, powers },
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(readProvisionedEnvironment(host, options), {
      message: /storage owner must use the selected state provider/,
    });
  }
  formulas.set('storage-id', {
    ...formula,
    properties: {
      ...formula.properties,
      powers: { kind: 'reference', identifier: 'state-id' },
    },
  });
  t.deepEqual(await readProvisionedEnvironment(host, options), {
    identifier: 'storage-id',
    env: {},
  });
});

test('a provisioned formula is read by its verified entrypoint and named by its last segment', async t => {
  const { host, seed } = makeFakeHost();
  seed(['adapter', 'service'], 'service-id', 'file:///service.js', {
    SETTING: 'value',
  });
  t.deepEqual(
    await readProvisionedEnvironment(host, {
      label: 'Adapter',
      namePath: ['adapter', 'service'],
      expectedSpecifier: 'file:///service.js',
    }),
    { identifier: 'service-id', env: { SETTING: 'value' } },
  );
  await t.throwsAsync(
    readProvisionedEnvironment(host, {
      label: 'Adapter',
      namePath: ['adapter', 'missing'],
      expectedSpecifier: 'file:///service.js',
    }),
    { message: /Cannot identify Adapter "missing"/ },
  );
  await t.throwsAsync(
    readProvisionedEnvironment(host, {
      label: 'Adapter',
      namePath: ['adapter', 'service'],
      expectedSpecifier: 'file:///other.js',
    }),
    {
      message:
        /Adapter service has an unsupported entrypoint\. Retire the old runtime/,
    },
  );
});

test('future paths resolve through existing ancestors and refuse dangling links', async t => {
  const tmp = await makeTmp(t);
  t.is(
    await resolveFuturePath(path.join(tmp, 'future', 'root')),
    path.join(tmp, 'future', 'root'),
  );
  const alias = path.join(tmp, 'alias');
  await symlink(tmp, alias);
  t.is(
    await resolveFuturePath(path.join(alias, 'future')),
    path.join(tmp, 'future'),
    'an existing link is canonicalized',
  );
  await symlink(path.join(tmp, 'nowhere'), path.join(tmp, 'dangling'));
  await t.throwsAsync(
    resolveFuturePath(path.join(tmp, 'dangling', 'child'), 'Adapter'),
    { message: /Adapter storage path has an unresolved symlink/ },
  );
});

test('runtime placement requires a private directory disjoint from every guest root', async t => {
  const tmp = await makeTmp(t);
  const runtime = path.join(tmp, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const roots = {
    workspaceDir: path.join(tmp, 'ws'),
    stateDir: path.join(tmp, 'state'),
  };
  t.is(await assertRuntimePlacement(runtime, roots), runtime);
  await t.throwsAsync(
    assertRuntimePlacement(
      runtime,
      { ...roots, mcpDir: path.join(runtime, 'mcp') },
      'Adapter',
    ),
    { message: /disjoint from Adapter guest storage roots/ },
  );
  await t.throwsAsync(
    assertRuntimePlacement(runtime, { bad: 'relative' }, 'Adapter'),
    {
      message: /Adapter storage roots must be absolute/,
    },
  );
  await chmod(runtime, 0o755);
  await t.throwsAsync(assertRuntimePlacement(runtime, roots), {
    message: /must be private/,
  });
  await chmod(runtime, 0o700);
  const env = await prepareRuntimeEnv(
    {
      ENDO_SANDBOX_RUNTIME_DIR: runtime,
      ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
      ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
    },
    'owner-a',
    roots,
  );
  t.deepEqual(env, {
    ENDO_SANDBOX_RUNTIME_DIR: runtime,
    ENDO_SANDBOX_OWNER_ID: 'owner-a',
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
  });
});

test('runtime leftovers under the label are refused, never removed; other labels are not judged', async t => {
  const tmp = await makeTmp(t);
  await assertNoRuntimeLeftovers(tmp, 'owner-a');
  await symlink('endo-sandbox-owner-v1-stale', path.join(tmp, 'owner-a.owner'));
  await t.throwsAsync(assertNoRuntimeLeftovers(tmp, 'owner-a'), {
    message: /still holds .*owner-a\.owner": the native runtime would claim it/,
  });
  await rm(path.join(tmp, 'owner-a.owner'));
  await mkdir(path.join(tmp, 'owner-a.files'));
  await t.throwsAsync(assertNoRuntimeLeftovers(tmp, 'owner-a'), {
    message: /owner-a\.files"/,
  });
  await assertNoRuntimeLeftovers(tmp, 'owner-b');
});

test('a private directory is created or adopted, never followed through a link', async t => {
  const tmp = await makeTmp(t);
  const fresh = path.join(tmp, 'fresh');
  await providePrivateDirectory('SETTING', fresh);
  t.is(await modeOf(fresh), 0o700);
  await chmod(fresh, 0o755);
  await providePrivateDirectory('SETTING', fresh);
  t.is(await modeOf(fresh), 0o700, 'a loose mode is tightened');
  await symlink(fresh, path.join(tmp, 'link'));
  await t.throwsAsync(
    providePrivateDirectory('SETTING', path.join(tmp, 'link')),
    {
      message: /SETTING must not be a symlink/,
    },
  );
});

test('a caplet minted with powers by path aliases the capability only for the mint', async t => {
  const { host, seed, bindings, calls } = makeFakeHost();
  seed(['adapter', 'provider'], 'provider-id', 'file:///provider.js', {});
  await mintWithPowersPath(host, {
    powersPath: ['adapter', 'provider'],
    temporary: 'adapter.provider-powers',
    specifier: 'file:///owner.js',
    resultName: ['adapter', 'owner'],
    env: { ROOT: '/srv' },
  });
  t.deepEqual(
    calls.map(call => call[0]),
    ['copy', 'mint', 'remove'],
  );
  t.is(calls[1][3].powersName, 'adapter.provider-powers');
  t.false(bindings.has(key('adapter.provider-powers')), 'the alias is gone');
  t.true(bindings.has(key('adapter', 'owner')));
});

test('slice image references are checked without Podman and pinned through it', async t => {
  t.deepEqual(readSliceImageReference('oci:localhost/x:latest'), {
    image: 'localhost/x:latest',
  });
  const digest = `sha256:${'a'.repeat(64)}`;
  t.deepEqual(readSliceImageReference(`localhost/x@${digest}`), {
    image: `localhost/x@${digest}`,
    imageDigest: digest,
  });
  t.throws(() => readSliceImageReference('oci:-rm', 'Adapter'), {
    message: /Invalid Adapter sandbox image "-rm"/,
  });
  t.throws(
    () => readSliceImageReference('oci:localhost/x@sha256:zzz', 'Adapter'),
    {
      message: /Adapter sandbox image digest is invalid/,
    },
  );
  /** @type {string[][]} */
  const inspected = [];
  const exec = async (file, args) => {
    inspected.push([file, ...args]);
    return { stdout: `${digest}\n` };
  };
  // The tag names where the image was FOUND; the digest is the pin. Keeping
  // both produces `name:tag@digest`, which Podman accepts and the native
  // runtime refuses, so a resolver that called it pinned sent every session to
  // "Native profile requires a pinned OCI image".
  t.deepEqual(await resolvePinnedImageRef('oci:localhost/x:latest', exec), {
    imageRef: `localhost/x@${digest}`,
    imageDigest: digest,
  });
  t.true(
    PINNED_IMAGE_REFERENCE_PATTERN.test(`localhost/x@${digest}`),
    'what this resolver returns is what the runtime accepts',
  );
  t.false(PINNED_IMAGE_REFERENCE_PATTERN.test(`localhost/x:latest@${digest}`));
  // The tag is still what Podman is asked about.
  t.deepEqual(inspected, [
    [
      'podman',
      'image',
      'inspect',
      '--format',
      '{{.Digest}}',
      'localhost/x:latest',
    ],
  ]);
  // A registry port is not a tag: the colon before the last slash stays.
  t.deepEqual(
    await resolvePinnedImageRef('oci:registry.example:5000/x:v2', exec),
    { imageRef: `registry.example:5000/x@${digest}`, imageDigest: digest },
  );
  t.deepEqual(
    await resolvePinnedImageRef('oci:registry.example:5000/x', exec),
    { imageRef: `registry.example:5000/x@${digest}`, imageDigest: digest },
  );
  t.deepEqual(await resolvePinnedImageRef(`oci:localhost/x@${digest}`, exec), {
    imageRef: `localhost/x@${digest}`,
    imageDigest: digest,
  });
  // A pin the operator wrote with the tag still on it is refused at setup.
  await t.throwsAsync(
    resolvePinnedImageRef(`oci:localhost/x:v1@${digest}`, exec),
    { message: /native runtime will accept/ },
  );
  t.is(inspected.length, 3, 'a pinned reference is not resolved again');
  await t.throwsAsync(
    resolvePinnedImageRef(
      'oci:localhost/x:latest',
      async () => ({ stdout: 'nope\n' }),
      'Adapter',
    ),
    { message: /Cannot resolve a digest for Adapter sandbox image/ },
  );
});

/**
 * A host agent that records names as a flat map of joined paths.
 * @param {Record<string, any>} initial
 */
const makeNamingHost = initial => {
  const names = new Map(Object.entries(initial));
  const guests = new Map();
  const made = [];
  const identities = new WeakMap();
  const joined = namePath =>
    (Array.isArray(namePath) ? namePath : [namePath]).join('/');
  const identity = value =>
    typeof value === 'string' ? value : identities.get(value);
  for (const name of [...names.keys()].filter(entry =>
    entry.endsWith('/controller-profile'),
  )) {
    const profile = Far('profile', {
      has: async (...parts) => names.has(`${name}/${joined(parts.flat())}`),
      makeDirectory: async parts => {
        names.set(`${name}/${joined(parts)}`, Far('directory', {}));
      },
      storeValue: async (value, parts) => {
        names.set(`${name}/${joined(parts)}`, value);
      },
    });
    identities.set(profile, `profile:${name}`);
    names.set(name, profile);
  }
  const host = Far('host', {
    has: async (...namePath) => names.has(joined(namePath)),
    identify: async (...namePath) => identity(names.get(joined(namePath))),
    locate: async (...namePath) =>
      `locator:${identity(names.get(joined(namePath)))}`,
    remove: async (...namePath) => {
      names.delete(joined(namePath));
    },
    provideGuest: async (handleName, { agentName }) => {
      const stored = new Map();
      const guest = Far('guest', {
        storeLocator: async (name, locator) => {
          stored.set(name, locator);
        },
        storeValue: async (value, name) => {
          stored.set(name, value);
        },
        has: async name => stored.has(name),
        lookup: async name => stored.get(name),
      });
      identities.set(guest, `guest:${agentName}`);
      guests.set(agentName, stored);
      names.set(handleName, `handle:${agentName}`);
      names.set(agentName, guest);
    },
    lookup: async namePath => names.get(joined(namePath)),
    list: async (...namePath) => {
      const prefix = `${joined(namePath)}/`;
      return [...names.keys()]
        .filter(name => name.startsWith(prefix))
        .map(name => name.slice(prefix.length))
        .filter(name => !name.includes('/'));
    },
    makeUnconfined: async (_worker, specifier, options) => {
      made.push({
        specifier,
        ...options,
        powers: names.get(joined(options.powersName)),
      });
      const formula = Far(`formula-${made.length}`, {});
      identities.set(formula, `formula-${made.length}`);
      names.set(joined(options.resultName), formula);
    },
    move: async (from, to) => {
      names.set(joined(to), names.get(joined(from)));
      names.delete(joined(from));
    },
    copy: async (from, to) => {
      names.set(joined(to), names.get(joined(from)));
    },
  });
  return {
    host,
    names,
    guests,
    made,
    publication: source =>
      names.get(`floot/controller-profile/account-bindings/${source}`),
  };
};

test('an account oracle is made once, keeps its identity, and follows a re-minted broker', async t => {
  const world = makeNamingHost({
    'codex-sandbox/broker-service': 'broker-1',
    'floot/controller-profile': 'profile',
  });
  const options = {
    label: 'Codex',
    dir: 'codex-sandbox',
    providerId: 'codex',
    accountAuthority: 'shared-account',
    flootDir: 'floot',
    backendId: 'codex',
  };
  await publishAccountOracle(world.host, options);
  const oracles = () =>
    world.made.filter(made =>
      made.specifier.endsWith('/account-oracle-module.js'),
    );
  const sources = () =>
    world.made.filter(made =>
      made.specifier.endsWith('/account-source-module.js'),
    );
  t.is(oracles().length, 1);
  t.deepEqual(oracles()[0].resultName, ['codex-sandbox', 'account-oracle']);
  t.deepEqual(oracles()[0].env, { ACCOUNT_PROVIDER_ID: 'codex' });
  // The source formula's powers are the broker service; the oracle's
  // namespace holds that source and never the broker.
  t.is(sources().length, 1);
  t.is(sources()[0].powers, 'broker-1');
  const powers = world.guests.get('codex-sandbox.account-oracle-powers');
  t.deepEqual([...powers.keys()], ['account-source']);
  // The names used while making it are tucked under the adapter's directory.
  t.false(world.names.has('codex-sandbox.account-oracle-powers'));
  t.false(world.names.has('codex-sandbox.account-source-powers'));
  t.true(world.names.has('codex-sandbox/account-oracle-powers'));
  const original = world.publication('codex-sandbox').accounts[0];
  t.is(original.oracle, world.names.get('codex-sandbox/account-oracle'));
  t.is(
    original.accountId,
    makeAccountId({ providerId: 'codex', accountAuthority: 'shared-account' }),
  );
  t.deepEqual(original.uses, [{ backendId: 'codex' }]);
  t.false(world.names.has('floot/controller-profile/codex-account'));

  // A deploy re-mints the broker. The oracle is not made again; the source
  // is, over the new broker, and the name inside the namespace moves to it.
  const before = powers.get('account-source');
  world.names.set('codex-sandbox/broker-service', 'broker-2');
  await publishAccountOracle(world.host, options);
  t.is(oracles().length, 1);
  t.is(sources().length, 2);
  t.is(sources()[1].powers, 'broker-2');
  t.not(powers.get('account-source'), before);
  t.is(
    world.publication('codex-sandbox').accounts[0].accountId,
    original.accountId,
  );
  t.is(world.publication('codex-sandbox').accounts[0].oracle, original.oracle);
});

test('an oracle that cannot be provided is reported and does not fail setup', async t => {
  const world = makeNamingHost({});
  await t.notThrowsAsync(() =>
    publishAccountOracle(world.host, {
      label: 'Codex',
      dir: 'codex-sandbox',
      providerId: 'codex',
      accountAuthority: 'shared-account',
      flootDir: 'floot',
      backendId: 'codex',
    }),
  );
  t.is(world.made.length, 0);
});

test('explicit account authority and member identity survive different runtime observers', async t => {
  const world = makeNamingHost({
    'runtime-one/broker-service': 'broker-one',
    'runtime-two/broker-service': 'broker-two',
    'floot/controller-profile': 'profile',
  });
  const common = {
    label: 'Shared provider account',
    providerId: 'anthropic',
    accountAuthority: 'declared-pool',
    flootDir: 'floot',
    subscriptionIds: ['primary', 'secondary'],
  };
  await publishAccountOracle(world.host, {
    ...common,
    dir: 'runtime-one',
    backendId: 'claude',
  });
  await publishAccountOracle(world.host, {
    ...common,
    dir: 'runtime-two',
    backendId: 'opencode',
  });
  const first = world.publication('runtime-one').accounts;
  const second = world.publication('runtime-two').accounts;
  for (const [index, subscriptionId] of common.subscriptionIds.entries()) {
    t.is(
      first[index].accountId,
      makeAccountId({
        providerId: common.providerId,
        accountAuthority: common.accountAuthority,
        subscriptionId,
      }),
    );
    t.is(first[index].accountId, second[index].accountId);
    t.not(first[index].oracle, second[index].oracle);
    t.deepEqual(first[index].uses, [{ backendId: 'claude', subscriptionId }]);
    t.deepEqual(second[index].uses, [
      { backendId: 'opencode', subscriptionId },
    ]);
  }
  t.not(first[0].accountId, first[1].accountId);
  await publishAccountOracle(world.host, {
    ...common,
    dir: 'runtime-two',
    backendId: 'opencode',
    accountAuthority: 'other-declared-pool',
  });
  t.not(
    first[0].accountId,
    world.publication('runtime-two').accounts[0].accountId,
  );
});

test('a failed pool member preparation leaves discovery unavailable, never partially republished', async t => {
  const world = makeNamingHost({
    'codex-sandbox/broker-service': 'broker-1',
    'floot/controller-profile': 'profile',
  });
  const options = {
    label: 'Codex',
    dir: 'codex-sandbox',
    providerId: 'codex',
    accountAuthority: 'shared-account',
    flootDir: 'floot',
    backendId: 'codex',
    subscriptionIds: ['work', 'home', 'spare'],
    resetCredits: true,
  };
  await publishAccountOracle(world.host, options);
  const original = world.publication('codex-sandbox');
  t.true(original.accounts.every(account => account.admin !== undefined));
  t.deepEqual(
    original.accounts.map(account => account.uses),
    [
      [{ backendId: 'codex', subscriptionId: 'work' }],
      [{ backendId: 'codex', subscriptionId: 'home' }],
      [{ backendId: 'codex', subscriptionId: 'spare' }],
    ],
  );
  t.deepEqual(
    original.accounts.map(account => account.label),
    ['work', 'home', 'spare'],
  );
  const preparedBefore = world.made.length;
  // The second member's oracle cannot be made.
  const failing = harden({
    ...world.host,
    makeUnconfined: async (worker, specifier, mintOptions) => {
      t.deepEqual(world.publication('codex-sandbox'), {
        version: 1,
        accounts: [],
        unavailable: true,
      });
      if (`${mintOptions.resultName}`.includes('account-source-home')) {
        throw Error('worker unavailable');
      }
      return world.host.makeUnconfined(worker, specifier, mintOptions);
    },
  });
  await publishAccountOracle(failing, options);
  t.deepEqual(world.publication('codex-sandbox'), {
    version: 1,
    accounts: [],
    unavailable: true,
  });
  // Preparation can update existing owners, but cannot publish a partial list.
  const sources = world.made
    .slice(preparedBefore)
    .filter(made => made.specifier.endsWith('/account-source-module.js'));
  t.deepEqual(
    sources.map(made => made.env),
    [{ ACCOUNT_SUBSCRIPTION_ID: 'work' }],
  );
  t.true(world.names.has('codex-sandbox/account-oracle-work'));
});

test('failed discovery invalidation prevents account owner rebinding', async t => {
  const world = makeNamingHost({
    'codex-sandbox/broker-service': 'broker-1',
    'floot/controller-profile': 'profile',
  });
  const options = {
    label: 'Codex',
    dir: 'codex-sandbox',
    providerId: 'codex',
    accountAuthority: 'shared-account',
    flootDir: 'floot',
    backendId: 'codex',
    resetCredits: true,
  };
  await publishAccountOracle(world.host, options);
  const original = world.publication('codex-sandbox');
  const minted = world.made.length;
  const source = world.names.get('codex-sandbox/account-source');
  const profile = world.names.get('floot/controller-profile');
  world.names.set(
    'floot/controller-profile',
    Far('unwritable profile', {
      ...profile,
      storeValue: async () => {
        throw Error('Cannot publish invalidation');
      },
    }),
  );
  await publishAccountOracle(world.host, options);
  t.is(world.publication('codex-sandbox'), original);
  t.is(world.made.length, minted);
  t.is(world.names.get('codex-sandbox/account-source'), source);
});

test('a subscription admin is made once, holds only the redeemer and the source, and keeps its store across a re-minted broker', async t => {
  const world = makeNamingHost({
    'codex-sandbox/broker-service': 'broker-1',
    'floot/controller-profile': 'profile',
  });
  const options = {
    label: 'Codex',
    dir: 'codex-sandbox',
    providerId: 'codex',
    accountAuthority: 'shared-account',
    flootDir: 'floot',
    backendId: 'codex',
    resetCredits: true,
  };
  await publishAccountOracle(world.host, options);
  const of = suffix =>
    world.made.filter(made => made.specifier.endsWith(suffix));
  t.is(of('/subscription-admin-module.js').length, 1);
  t.deepEqual(of('/subscription-admin-module.js')[0].resultName, [
    'codex-sandbox',
    'subscription-admin',
  ]);
  // The redeemer formula's powers are the broker service; the admin's
  // namespace holds that redeemer and the account source, never the broker.
  t.is(of('/reset-redeemer-module.js').length, 1);
  t.is(of('/reset-redeemer-module.js')[0].powers, 'broker-1');
  const powers = world.guests.get('codex-sandbox.subscription-admin-powers');
  t.deepEqual([...powers.keys()].sort(), ['account-source', 'reset-redeemer']);
  t.is(
    powers.get('account-source'),
    world.guests
      .get('codex-sandbox.account-oracle-powers')
      .get('account-source'),
  );
  t.false(world.names.has('codex-sandbox.subscription-admin-powers'));
  t.false(world.names.has('codex-sandbox.reset-redeemer-powers'));
  t.true(world.names.has('codex-sandbox/subscription-admin-powers'));
  const original = world.publication('codex-sandbox').accounts[0];
  t.is(original.admin, world.names.get('codex-sandbox/subscription-admin'));
  t.is(
    original.adminId,
    await world.host.identify('codex-sandbox', 'subscription-admin'),
  );
  t.false(world.names.has('floot/controller-profile/codex-admin'));

  // A deploy re-mints the broker: the admin, and so its stored intent, stays;
  // the redeemer is minted again and the names inside the namespace move.
  const before = powers.get('reset-redeemer');
  world.names.set('codex-sandbox/broker-service', 'broker-2');
  await publishAccountOracle(world.host, options);
  t.is(of('/subscription-admin-module.js').length, 1);
  t.is(of('/reset-redeemer-module.js').length, 2);
  t.is(of('/reset-redeemer-module.js')[1].powers, 'broker-2');
  t.not(powers.get('reset-redeemer'), before);
  t.is(
    world.publication('codex-sandbox').accounts[0].adminId,
    original.adminId,
  );
  t.is(world.publication('codex-sandbox').accounts[0].admin, original.admin);
});

test('no admin is provided unless asked, nor for a broker with no redeemer; several subscriptions get one each', async t => {
  const plain = makeNamingHost({
    'claude-sandbox/broker-service': 'broker-1',
    'floot/controller-profile': 'profile',
  });
  await publishAccountOracle(plain.host, {
    label: 'Claude',
    dir: 'claude-sandbox',
    providerId: 'anthropic',
    accountAuthority: 'shared-account',
    flootDir: 'floot',
    backendId: 'claude',
  });
  t.false(
    Object.hasOwn(plain.publication('claude-sandbox').accounts[0], 'admin'),
  );
  t.false(
    plain.made.some(made =>
      made.specifier.endsWith('/reset-redeemer-module.js'),
    ),
  );

  const none = makeNamingHost({
    'codex-sandbox/broker-service': 'broker-1',
    'floot/controller-profile': 'profile',
  });
  const options = {
    label: 'Codex',
    dir: 'codex-sandbox',
    providerId: 'codex',
    accountAuthority: 'shared-account',
    flootDir: 'floot',
    backendId: 'codex',
    resetCredits: true,
  };
  await publishAccountOracle(none.host, options);
  const original = none.publication('codex-sandbox');
  t.truthy(original.accounts[0].admin);
  // The replacement broker's resetRedeemer() now answers undefined.
  const without = harden({
    ...none.host,
    makeUnconfined: async (worker, specifier, mintOptions) => {
      await none.host.makeUnconfined(worker, specifier, mintOptions);
      if (specifier.endsWith('/reset-redeemer-module.js')) {
        none.names.set(mintOptions.resultName.join('/'), undefined);
      }
    },
  });
  await publishAccountOracle(without, options);
  const replacement = none.publication('codex-sandbox');
  t.not(replacement, original);
  t.is(replacement.accounts[0].oracle, original.accounts[0].oracle);
  // A binding from when this broker did redeem is withdrawn: Floot must not
  // offer a button over an admin whose redeemer is gone.
  t.false(Object.hasOwn(replacement.accounts[0], 'admin'));
  t.false(Object.hasOwn(replacement.accounts[0], 'adminId'));
  t.false(none.names.has('codex-sandbox/reset-redeemer'));
  t.true(none.names.has('codex-sandbox/subscription-admin'));

  const pooled = makeNamingHost({
    'codex-sandbox/broker-service': 'broker-1',
    'floot/controller-profile': 'profile',
  });
  await publishAccountOracle(pooled.host, {
    label: 'Codex',
    dir: 'codex-sandbox',
    providerId: 'codex',
    accountAuthority: 'shared-account',
    flootDir: 'floot',
    backendId: 'codex',
    subscriptionIds: ['work', 'home'],
    resetCredits: true,
  });
  const published = pooled.publication('codex-sandbox').accounts;
  t.is(published.length, 2);
  for (const [index, member] of ['work', 'home'].entries()) {
    t.is(
      published[index].admin,
      pooled.names.get(`codex-sandbox/subscription-admin-${member}`),
    );
    t.deepEqual(published[index].uses, [
      { backendId: 'codex', subscriptionId: member },
    ]);
  }
  t.deepEqual(
    pooled.made
      .filter(made => made.specifier.endsWith('/reset-redeemer-module.js'))
      .map(made => made.env),
    [{ ACCOUNT_SUBSCRIPTION_ID: 'work' }, { ACCOUNT_SUBSCRIPTION_ID: 'home' }],
  );
});

test('a rejected redeemer leaves no name and refuses a partial discovery publication', async t => {
  const world = makeNamingHost({
    'codex-sandbox/broker-service': 'broker-1',
    'floot/controller-profile': 'profile',
  });
  // As the daemon does: the name is written, then the value's rejection
  // (the broker has no such method) is what the mint answers.
  const old = harden({
    ...world.host,
    makeUnconfined: async (worker, specifier, options) => {
      await world.host.makeUnconfined(worker, specifier, options);
      if (specifier.endsWith('/reset-redeemer-module.js')) {
        throw Error('target has no method "resetRedeemer"');
      }
    },
  });
  await t.notThrowsAsync(() =>
    publishAccountOracle(old, {
      label: 'Codex',
      dir: 'codex-sandbox',
      providerId: 'codex',
      accountAuthority: 'shared-account',
      flootDir: 'floot',
      backendId: 'codex',
      resetCredits: true,
    }),
  );
  t.deepEqual(world.publication('codex-sandbox'), {
    version: 1,
    accounts: [],
    unavailable: true,
  });
  t.true(world.names.has('codex-sandbox/account-oracle'));
  t.false(world.names.has('codex-sandbox/reset-redeemer'));
  t.false(world.names.has('codex-sandbox.reset-redeemer-powers'));
  t.false(world.names.has('codex-sandbox/subscription-admin'));
  t.false(world.names.has('floot/controller-profile/codex-admin'));
});

test('a share is a namespace, a kit and the name that is handed out; made once, its limits rewritten, and it follows a re-minted broker', async t => {
  const world = makeNamingHost({ 'codex-sandbox/broker-service': 'broker-1' });
  const dir = { label: 'Codex', dir: 'codex-sandbox' };
  // No subscription yet: a share has nothing to be made over.
  await t.throwsAsync(
    () =>
      provideSubscriptionShare(world.host, {
        ...dir,
        shareId: 'alice',
        limits: {},
      }),
    { message: /needs the subscription/ },
  );
  await publishBrokerSubscription(world.host, dir);
  const of = suffix =>
    world.made.filter(made => made.specifier.endsWith(suffix));
  t.is(of('/subscription-module.js')[0].powers, 'broker-1');
  t.false(world.names.has('codex-sandbox.subscription-powers'));

  const result = await provideSubscriptionShare(world.host, {
    ...dir,
    shareId: 'alice',
    limits: { budget: { tokens: 1_000_000, periodSeconds: 86_400 } },
    now: () => '2026-09-20T00:00:00.000Z',
  });
  t.deepEqual(result, {
    sharePath: ['codex-sandbox', 'share-alice'],
    kitPath: ['codex-sandbox', 'share-alice-kit'],
    created: true,
  });
  const powers = world.guests.get('codex-sandbox.share-alice-powers');
  t.deepEqual([...powers.keys()].sort(), ['share-limits', 'subscription']);
  t.deepEqual(powers.get('share-limits'), {
    createdAt: '2026-09-20T00:00:00.000Z',
    budget: { tokens: 1_000_000, periodSeconds: 86_400 },
  });
  // The kit's powers are the namespace; the share's are the kit, and only it.
  const kit = of('/subscription-share-module.js')[0];
  t.deepEqual(kit.env, { SHARE_ID: 'alice' });
  t.deepEqual(kit.resultName, ['codex-sandbox', 'share-alice-kit']);
  const facet = of('/subscription-share-facet-module.js')[0];
  t.is(facet.powers, world.names.get('codex-sandbox/share-alice-kit'));
  t.deepEqual(facet.resultName, ['codex-sandbox', 'share-alice']);
  t.false(world.names.has('codex-sandbox.share-alice-powers'));
  t.false(world.names.has('codex-sandbox.share-alice-kit-powers'));
  t.true(world.names.has('codex-sandbox/share-alice-powers'));

  // Again, with other limits: a write of a value. Nothing is minted, and
  // the anchor of the budget's periods does not move.
  const mintsBefore = world.made.length;
  const again = await provideSubscriptionShare(world.host, {
    ...dir,
    shareId: 'alice',
    limits: { budget: { tokens: 5000, periodSeconds: 3600 }, reserve: 0.2 },
    now: () => '2026-12-31T00:00:00.000Z',
  });
  t.false(again.created);
  t.is(world.made.length, mintsBefore);
  t.deepEqual(powers.get('share-limits'), {
    createdAt: '2026-09-20T00:00:00.000Z',
    budget: { tokens: 5000, periodSeconds: 3600 },
    reserve: 0.2,
  });

  // A deploy re-mints the broker: the share is not made again, and the name
  // inside its namespace moves to the new broker's subscription.
  const before = powers.get('subscription');
  world.names.set('codex-sandbox/broker-service', 'broker-2');
  await publishBrokerSubscription(world.host, dir);
  t.is(of('/subscription-module.js')[1].powers, 'broker-2');
  t.not(powers.get('subscription'), before);
  t.is(of('/subscription-share-module.js').length, 1);

  // Bad ids and bad limits are refused before anything is made.
  for (const shareId of ['bad id', 'x-kit', 'powers', '']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() =>
      provideSubscriptionShare(world.host, { ...dir, shareId, limits: {} }),
    );
  }
  await t.throwsAsync(() =>
    provideSubscriptionShare(world.host, {
      ...dir,
      shareId: 'bob',
      limits: { reserve: 2 },
    }),
  );
  await t.throwsAsync(
    () => provideSubscriptionShare(world.host, { ...dir, shareId: 'bob' }),
    { message: /needs limits/ },
  );
  t.false(world.names.has('codex-sandbox/share-bob-kit'));
});

test('a share narrowed from somebody else’s is not re-pointed at this adapter’s broker', async t => {
  const world = makeNamingHost({
    'codex-sandbox/broker-service': 'broker-1',
    'from-carol': 'carols-share',
  });
  const dir = { label: 'Codex', dir: 'codex-sandbox' };
  await publishBrokerSubscription(world.host, dir);
  await provideSubscriptionShare(world.host, {
    ...dir,
    shareId: 'narrow',
    limits: { models: ['allowed'] },
    subscriptionPath: ['from-carol'],
  });
  const powers = world.guests.get('codex-sandbox.share-narrow-powers');
  t.is(powers.get('subscription'), 'locator:carols-share');
  await publishBrokerSubscription(world.host, dir);
  t.is(powers.get('subscription'), 'locator:carols-share');
});

test('a broker with no subscription to offer is reported, and leaves no name', async t => {
  const world = makeNamingHost({ 'codex-sandbox/broker-service': 'broker-1' });
  const old = harden({
    ...world.host,
    makeUnconfined: async (worker, specifier, options) => {
      await world.host.makeUnconfined(worker, specifier, options);
      throw Error('target has no method "subscription"');
    },
  });
  await t.notThrowsAsync(() =>
    publishBrokerSubscription(old, { label: 'Codex', dir: 'codex-sandbox' }),
  );
  t.false(world.names.has('codex-sandbox/subscription'));
  t.false(world.names.has('codex-sandbox.subscription-powers'));
});

test('a share whose kit is gone is made again over the namespace it had, not beside it', async t => {
  const world = makeNamingHost({ 'codex-sandbox/broker-service': 'broker-1' });
  const dir = { label: 'Codex', dir: 'codex-sandbox' };
  await publishBrokerSubscription(world.host, dir);
  await provideSubscriptionShare(world.host, {
    ...dir,
    shareId: 'alice',
    limits: { budget: { tokens: 1000, periodSeconds: 3600 } },
    now: () => '2026-09-20T00:00:00.000Z',
  });
  const namespace = world.names.get('codex-sandbox/share-alice-powers');
  // The kit and the name handed out are lost; the namespace (the limits,
  // the meter, the revocation) is still there.
  world.names.delete('codex-sandbox/share-alice-kit');
  world.names.delete('codex-sandbox/share-alice');
  const again = await provideSubscriptionShare(world.host, {
    ...dir,
    shareId: 'alice',
  });
  t.true(again.created);
  const kits = world.made.filter(made =>
    made.specifier.endsWith('/subscription-share-module.js'),
  );
  t.is(kits.length, 2);
  t.is(kits[1].powers, namespace, 'over the same namespace');
  t.deepEqual(kits[1].env, { SHARE_ID: 'alice' });
  t.is(world.names.get('codex-sandbox/share-alice-powers'), namespace);
  // Nothing was left at the top level.
  t.deepEqual(
    [...world.names.keys()].filter(name => name.startsWith('codex-sandbox.')),
    [],
  );
  t.true(world.names.has('codex-sandbox/share-alice'));
});

test('a kit is not made twice over one namespace while the share is still handed out', async t => {
  const world = makeNamingHost({ 'codex-sandbox/broker-service': 'broker-1' });
  const dir = { label: 'Codex', dir: 'codex-sandbox' };
  await publishBrokerSubscription(world.host, dir);
  await provideSubscriptionShare(world.host, {
    ...dir,
    shareId: 'alice',
    limits: { budget: { tokens: 1000, periodSeconds: 3600 } },
  });
  // Only the kit's name is lost. The share that was handed out still runs
  // the old kit, its meter and its writes.
  world.names.delete('codex-sandbox/share-alice-kit');
  const mints = world.made.length;
  await t.throwsAsync(
    () => provideSubscriptionShare(world.host, { ...dir, shareId: 'alice' }),
    { message: /still handed out/ },
  );
  t.is(world.made.length, mints);
});

/**
 * A pooled broker's namespace, with one lane set aside and one account.
 * @param world
 */
const withPool = world => {
  const stored = new Map([
    [
      'subscriptions',
      {
        members: [
          { id: 'own', label: 'Own', weight: 1, secretName: 'secret-own' },
          {
            id: 'lane-alice',
            label: 'Alice',
            weight: 1,
            subscriptionName: 'share-lane-alice',
            pinnedOnly: true,
          },
          {
            id: 'open-share',
            label: 'Open',
            weight: 1,
            subscriptionName: 'share-open',
          },
        ],
      },
    ],
  ]);
  world.names.set(
    'codex-sandbox/broker-powers',
    Far('broker powers', {
      has: async name => stored.has(name),
      lookup: async name => stored.get(name),
    }),
  );
};

test('a delegated runner is a namespace, a kit and the name that is handed out, and follows a re-minted backend', async t => {
  const world = makeNamingHost({ 'codex-sandbox/backend': 'backend-1' });
  withPool(world);
  const dir = { label: 'Codex', dir: 'codex-sandbox' };
  const limits = {
    subscription: 'lane-alice',
    maxSessions: 2,
    storage: 'unbounded',
  };
  // Refused before anything is made: no limits, no storage decision, an id
  // with the separator in it, and a subscription that is not a lane.
  await t.throwsAsync(
    () => provideDelegatedRunner(world.host, { ...dir, runnerId: 'alice' }),
    { message: /needs limits/ },
  );
  await t.throwsAsync(() =>
    provideDelegatedRunner(world.host, {
      ...dir,
      runnerId: 'alice',
      limits: { subscription: 'lane-alice', maxSessions: 2 },
    }),
  );
  for (const runnerId of ['alice-2', 'kit', 'bad id']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() =>
      provideDelegatedRunner(world.host, { ...dir, runnerId, limits }),
    );
  }
  for (const subscription of ['own', 'open-share', 'nobody']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        provideDelegatedRunner(world.host, {
          ...dir,
          runnerId: 'alice',
          limits: { ...limits, subscription },
        }),
      { message: /must spend a lane set aside/ },
    );
  }
  t.is(world.made.length, 0);

  const result = await provideDelegatedRunner(world.host, {
    ...dir,
    runnerId: 'alice',
    limits,
  });
  t.deepEqual(result, {
    runnerPath: ['codex-sandbox', 'runner-alice'],
    kitPath: ['codex-sandbox', 'runner-alice-kit'],
    created: true,
  });
  const powers = world.guests.get('codex-sandbox.runner-alice-powers');
  t.deepEqual([...powers.keys()].sort(), ['backend', 'runner-limits']);
  t.is(powers.get('backend'), 'locator:backend-1');
  t.deepEqual(powers.get('runner-limits'), {
    subscription: 'lane-alice',
    maxSessions: 2,
    networkPolicies: ['off'],
    storage: 'unbounded',
  });
  const of = suffix =>
    world.made.filter(made => made.specifier.endsWith(suffix));
  t.deepEqual(of('/delegated-runner-module.js')[0].env, { RUNNER_ID: 'alice' });
  // What is handed out has the kit for its powers, and only the kit.
  t.is(
    of('/delegated-runner-facet-module.js')[0].powers,
    world.names.get('codex-sandbox/runner-alice-kit'),
  );
  t.deepEqual(
    [...world.names.keys()].filter(name => name.startsWith('codex-sandbox.')),
    [],
  );

  // A deploy mints the backend again: the runner is not made again.
  world.names.set('codex-sandbox/backend', 'backend-2');
  await republishDelegatedRunners(world.host, dir);
  t.is(powers.get('backend'), 'locator:backend-2');
  t.is(of('/delegated-runner-module.js').length, 1);

  // Again, with other limits: a write of a value.
  const again = await provideDelegatedRunner(world.host, {
    ...dir,
    runnerId: 'alice',
    limits: { ...limits, maxSessions: 5 },
  });
  t.false(again.created);
  t.is(powers.get('runner-limits').maxSessions, 5);
  t.is(of('/delegated-runner-module.js').length, 1);

  // Lending an account whole takes the operator's explicit word.
  const whole = await provideDelegatedRunner(world.host, {
    ...dir,
    runnerId: 'trusted',
    limits: { ...limits, subscription: 'own' },
    unmetered: true,
  });
  t.true(whole.created);
});
