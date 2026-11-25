// @ts-check
/* eslint-disable import/no-relative-packages */
// Adding a subscription to an existing pool on a state provisioned at
// OLD_REVISION, whose subscriptions manager is pinned (no addMember, no
// addPoolMember, no checkCredential; a pool's members are its spec's):
// the current adapter and UI against that revision's own
// durable-subscriptions.js and guest/lib copies (`_old-manager.js`), a
// real Secrets store under H/tmp and fake credentials only. The adapter
// keeps the addition (`pool-additions.js`, m4-interfaces.md 3.5): format
// checked first, idempotent, one credential once per pool, only active
// members counted, back after a restart, gone when the manager retires
// the member; the UI reaches it through Accounts. No network, no
// supervisor.
import '../unit/_m1a-prelude.js';

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import test from '@endo/ses-ava/test.js';

import { subscriptionLimits } from '../../guest/lib/subscription-limits.js';
import {
  subscriptionTextOf,
  subscriptionTexts,
} from '../../guest/lib/subscription-texts.js';
import { subscriptionDefaults } from '../../config/subscription-defaults.js';
import { makeCredentialAccess } from '../../resources/agent-host/impl/secrets/credential-access.js';
import { makeSubscriptions } from '../../resources/agent-host/impl/subscriptions/index.js';
import { loadPoolAdditions } from '../../resources/agent-host/impl/subscriptions/pool-additions.js';
import { makeController } from '../../ui/src/controller/index.js';
import { mount } from '../../ui/src/shell/index.js';
import { feature as accountFeatures } from '../../ui/src/accounts/feature.js';
import { addMemberTexts } from '../../ui/src/accounts/AddMember.js';
import { makeFakePowers, makeTestDom } from '../unit/_m3-fake-powers.js';
import { runEffectsPromptly } from '../unit/_m4-ui-fakes.js';
import { importOldManager, OLD_REVISION } from './_old-manager.js';
import { makeStoreDirs, openStore, storedCredential } from './_m4-renewal.js';
import { timers } from './_m2-w21b-round.js';

const { E, Far } = /** @type {any} */ (globalThis);

const HOUR = 3_600_000;
/**
 * A placeholder token, joined at run time (never key-shaped).
 * @param {string} tag
 */
const tokenOf = tag => ['fake', 'old', 'manager', tag].join('-');
/**
 * A stored-form Codex credential of fake tokens.
 * @param {string} tag
 */
const codexValue = tag =>
  storedCredential({
    provider: 'codex',
    accessToken: tokenOf(`access-${tag}`),
    refreshToken: tokenOf(`refresh-${tag}`),
    expiresAtMs: Date.now() + HOUR,
    accountId: `acct-${tag}`,
  });

const flush = async (rounds = 30) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * The old manager part wired as the old `durable.js` wires it (Secrets
 * records, sink with `resolveSecrets`, SecretsAdmin with its M4 methods),
 * over the current adapter's ops; one codex pool "ChatGPT" whose spec
 * holds "ChatGPT Account 1".
 * @param {import('ava').ExecutionContext} t
 */
const setup = async t => {
  const { manager } = await importOldManager();
  const dirs = makeStoreDirs('old-manager');
  t.teardown(dirs.done);
  const store = openStore(dirs.files);
  /** @type {WeakMap<any, { key: string, label: string, description: string }>} */
  const secretRecords = new WeakMap();
  /** @type {any[]} */
  let secretList = [];
  let serial = 0;
  /** Every value a Secret was given (none may appear anywhere else). */
  /** @type {string[]} */
  const values = [];
  /**
   * @param {string} label
   * @param {string} value
   */
  const makeSecret = async (label, value) => {
    serial += 1;
    const key = `k${serial}`;
    await store.create(key, label, 'subscription credential');
    await store.replace(key, value);
    values.push(value);
    const secret = Far('Secret', {});
    secretRecords.set(
      secret,
      harden({ key, label, description: 'subscription credential' }),
    );
    secretList = [...secretList, secret];
    return secret;
  };
  let clock = Date.now();
  /** @type {any} */
  let adapter;
  const ops = Far('AgentHostOps', {
    credentials: () => {
      if (adapter === undefined) throw Error('adapter unavailable');
      return adapter.credentialOps;
    },
  });
  const part = manager.makeSubscriptionsPart({
    withOps: async (/** @type {any} */ fn) => fn(ops),
    whenBound: async () => {
      throw Error('no session hosts here');
    },
    archiveKeyOf: () => null,
    secretRecords,
    secretList: () => secretList,
  });
  const sink = Far('AgentHostSink', {
    ...part.sinkMethods,
    /** @param {any[]} secrets */
    resolveSecrets: secrets =>
      harden(secrets.map(secret => secretRecords.get(secret)?.key ?? null)),
  });
  const secretsAdmin = Far('SecretsAdmin', { ...part.secretsAdminMethods });
  const operator = Far('Operator', { getSecrets: () => secretsAdmin });
  /** @type {any} */
  let operatorNow = operator;
  /** No network: every provider read fails as unreachable. */
  const fetch = async () => {
    throw Error('no network in this test');
  };
  /** @type {(error: unknown) => void} */
  let onError = () => {};
  /**
   * A new adapter incarnation over the same state directory.
   * @param {{ additionsHoldMs?: number }} [options]
   */
  const start = ({ additionsHoldMs = 0 } = {}) => {
    adapter = makeSubscriptions({
      sink: () => sink,
      secrets: {
        credentialFor: (/** @type {string} */ key) =>
          makeCredentialAccess({ store, key }),
        store,
      },
      stateDir: () => dirs.stateDir,
      timers,
      now: () => clock,
      fetch: /** @type {any} */ (fetch),
      settings: subscriptionDefaults,
      // F: only `getSecrets()`, never the whole Operator.
      getSecrets: () =>
        operatorNow === undefined ? undefined : E(operatorNow).getSecrets(),
      additionsHoldMs,
      onError: error => onError(error),
    });
    return adapter;
  };
  start();
  t.teardown(() => adapter.close());
  const { admin } = part;
  const s1 = await makeSecret('ChatGPT login 1', codexValue('1'));
  const m1 = admin.makeMember(
    harden({ provider: 'codex', label: 'ChatGPT Account 1', credential: s1 }),
  );
  const spec = harden({ kind: 'codex-pool', label: 'ChatGPT', members: [m1] });
  const backend = admin.makePool(spec);
  /** What the pool serves now (the adapter's loaded members). */
  const served = async () =>
    (await adapter.pool(backend, spec)).members.map(
      (/** @type {any} */ entry) => entry.label,
    );
  /** The adapter's accounts view of the pool. */
  const viewed = async () => {
    const accounts = await E(admin).accounts();
    const pool = await E(accounts).forBackend(backend);
    return pool.members.map((/** @type {any} */ entry) => entry.label);
  };
  const additionsFile = () =>
    readFileSync(
      join(dirs.stateDir, 'agent-host', 'subscriptions', 'pool-additions.json'),
      'utf8',
    );
  return {
    admin,
    part,
    m1,
    spec,
    backend,
    operator,
    secretsAdmin,
    makeSecret,
    values,
    served,
    viewed,
    additionsFile,
    start,
    get adapter() {
      return adapter;
    },
    /** @param {any} value */
    setOperator: value => {
      operatorNow = value;
    },
    /** @param {number} ms */
    advance: ms => {
      clock += ms;
    },
    /** @param {(error: unknown) => void} fn */
    setOnError: fn => {
      onError = fn;
    },
    dirs,
    store,
    secretRecords,
    s1,
  };
};

test(`the fixture is the manager of ${OLD_REVISION}: no addMember, addPoolMember or checkCredential`, async t => {
  const s = await setup(t);
  // eslint-disable-next-line no-underscore-dangle -- the Endo introspection method
  const names = await E(s.admin).__getMethodNames__();
  for (const name of ['addMember', 'addPoolMember', 'checkCredential'])
    t.false(names.includes(name), name);
  t.true(names.includes('makeMember'));
  // eslint-disable-next-line no-underscore-dangle -- the Endo introspection method
  const accountsNames = await E(
    await E(s.admin).accounts(),
  ).__getMethodNames__();
  for (const name of ['addMember', 'checkCredential', 'poolMembers'])
    t.true(accountsNames.includes(name), `the adapter's Accounts has ${name}`);
});

test('"ChatGPT Account 2" joins the existing ChatGPT pool: format checked first, idempotent, the manager spec untouched, no secret value kept', async t => {
  const s = await setup(t);
  const accounts = await E(s.admin).accounts();
  t.deepEqual(await s.served(), ['ChatGPT Account 1']);
  const s2 = await s.makeSecret('ChatGPT login 2', codexValue('2'));
  t.deepEqual(await E(accounts).checkCredential(s.backend, s2), { ok: true });

  const member = await E(accounts).addMember(
    s.backend,
    harden({ label: 'ChatGPT Account 2', credential: s2 }),
  );
  t.is(
    (await E(member).describe()).label,
    'ChatGPT Account 2',
    'a PoolMember the old manager made',
  );
  t.true(s.admin.listMembers().members.includes(member));
  t.deepEqual(
    s.admin.describePool(s.backend).members,
    [s.m1],
    "the manager's spec is what it was",
  );
  t.deepEqual(await s.served(), ['ChatGPT Account 1', 'ChatGPT Account 2']);
  t.deepEqual(await s.viewed(), ['ChatGPT Account 1', 'ChatGPT Account 2']);
  t.deepEqual(await E(accounts).poolMembers(s.backend), [s.m1, member]);

  // The kept addition: store keys, labels and creation serials (the
  // pool's identity, D), never a value.
  const kept = JSON.parse(s.additionsFile());
  t.is(kept.format, 'thixotrope-harness-pool-additions-2');
  t.deepEqual(kept.pools, [
    {
      kind: 'codex-pool',
      label: 'ChatGPT',
      specKeys: ['k1'],
      specSerials: [1],
      members: [
        { key: 'k2', label: 'ChatGPT Account 2', provider: 'codex', serial: 2 },
      ],
    },
  ]);
  for (const value of s.values) {
    t.false(s.additionsFile().includes(value));
    t.false(s.additionsFile().includes(JSON.parse(value).accessToken));
  }

  // A retry answers the same member and makes nothing.
  const membersBefore = s.admin.listMembers().members.length;
  t.is(
    await E(accounts).addMember(
      s.backend,
      harden({ label: 'ChatGPT Account 2', credential: s2 }),
    ),
    member,
  );
  t.is(s.admin.listMembers().members.length, membersBefore);
  t.deepEqual(await s.served(), ['ChatGPT Account 1', 'ChatGPT Account 2']);

  // Another Secret under the label, or this Secret under another label.
  const s3 = await s.makeSecret('ChatGPT login 3', codexValue('3'));
  await t.throwsAsync(
    E(accounts).addMember(
      s.backend,
      harden({ label: 'ChatGPT Account 2', credential: s3 }),
    ),
    { message: subscriptionTexts.memberConflict },
  );
  await t.throwsAsync(
    E(accounts).addMember(
      s.backend,
      harden({ label: 'ChatGPT twice', credential: s2 }),
    ),
    { message: subscriptionTexts.memberConflict },
  );

  // A malformed value and one of the other provider: refused before
  // anything is made, in plain words, no value named.
  const bad = await s.makeSecret('not a login', 'not json');
  const claude = await s.makeSecret(
    'claude login',
    storedCredential({
      provider: 'claude',
      accessToken: tokenOf('claude'),
      expiresAtMs: Date.now() + HOUR,
    }),
  );
  for (const [secret, code] of [
    [bad, 'INVALID'],
    [claude, 'WRONG_PROVIDER'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(
      E(accounts).addMember(
        s.backend,
        harden({ label: `refused ${code}`, credential: secret }),
      ),
      { message: subscriptionTextOf.credentialCheckFailed(code) },
    );
    for (const value of s.values)
      t.false(String(error?.message).includes(value));
  }
  t.is(s.admin.listMembers().members.length, membersBefore, 'nothing made');
});

test('a restarted adapter serves the addition again once it can reach the manager; nothing is made to find it', async t => {
  const s = await setup(t);
  const accounts = await E(s.admin).accounts();
  const s2 = await s.makeSecret('ChatGPT login 2', codexValue('2'));
  const member = await E(accounts).addMember(
    s.backend,
    harden({ label: 'ChatGPT Account 2', credential: s2 }),
  );
  await s.adapter.close();
  const membersBefore = s.admin.listMembers().members.length;

  // Before the gateway's first bind there is no operator: spec members only.
  s.setOperator(undefined);
  s.start();
  t.deepEqual(await s.served(), ['ChatGPT Account 1']);
  s.setOperator(s.operator);
  t.deepEqual(
    await s.served(),
    ['ChatGPT Account 1'],
    'asked again only after the retry interval',
  );
  s.advance(10_000);
  t.deepEqual(await s.served(), ['ChatGPT Account 1', 'ChatGPT Account 2']);
  const entry = (await s.adapter.pool(s.backend, s.spec)).members[1];
  t.is(entry.member, member, 'the same PoolMember');
  t.is(entry.key, 'k2');
  t.is(s.admin.listMembers().members.length, membersBefore);

  // A fresh incarnation with the operator from the start: at once.
  await s.adapter.close();
  s.start();
  t.deepEqual(await s.viewed(), ['ChatGPT Account 1', 'ChatGPT Account 2']);
});

test('retiring the added member in the manager takes it out of the pool; only active members count towards maxPoolMembers', async t => {
  const s = await setup(t);
  const accounts = await E(s.admin).accounts();
  const s2 = await s.makeSecret('ChatGPT login 2', codexValue('2'));
  const first = await E(accounts).addMember(
    s.backend,
    harden({ label: 'ChatGPT Account 2', credential: s2 }),
  );
  t.deepEqual(await s.served(), ['ChatGPT Account 1', 'ChatGPT Account 2']);
  // The old PoolMember.retire announces poolsChanged to the adapter.
  await E(first).retire();
  t.deepEqual(await s.served(), ['ChatGPT Account 1']);
  t.deepEqual(await s.viewed(), ['ChatGPT Account 1']);
  await s.adapter.additions.settled();
  t.deepEqual(JSON.parse(s.additionsFile()).pools, [], 'the addition ended');

  // Added again: a new member (the retired one stays retired).
  const again = await E(accounts).addMember(
    s.backend,
    harden({ label: 'ChatGPT Account 2', credential: s2 }),
  );
  t.not(again, first);
  t.deepEqual(await s.served(), ['ChatGPT Account 1', 'ChatGPT Account 2']);

  // Fill the pool: spec 1 + additions up to maxPoolMembers.
  const room = subscriptionLimits.maxPoolMembers - 2;
  /** @type {any[]} */
  const added = [];
  for (let i = 0; i < room; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const secret = await s.makeSecret(`fill ${i}`, codexValue(`fill-${i}`));
    added.push(
      // eslint-disable-next-line no-await-in-loop
      await E(accounts).addMember(
        s.backend,
        harden({ label: `fill ${i}`, credential: secret }),
      ),
    );
  }
  t.is((await s.served()).length, subscriptionLimits.maxPoolMembers);
  const extra = await s.makeSecret('one more', codexValue('more'));
  await t.throwsAsync(
    E(accounts).addMember(
      s.backend,
      harden({ label: 'one more', credential: extra }),
    ),
    { message: subscriptionTexts.poolFull },
  );
  await E(added[0]).retire();
  await E(accounts).addMember(
    s.backend,
    harden({ label: 'one more', credential: extra }),
  );
  t.is((await s.served()).length, subscriptionLimits.maxPoolMembers);
});

test.serial(
  'the Subscriptions page adds "ChatGPT Account 2" through the adapter over the old manager',
  async t => {
    const s = await setup(t);
    const s2 = await s.makeSecret('ChatGPT login 2', codexValue('2'));
    runEffectsPromptly();
    const dom = makeTestDom();
    const features = [...accountFeatures];
    const { powers } = makeFakePowers({
      sessions: [{ key: 's-pool' }],
      operatorMethods: { getSecrets: () => s.secretsAdmin },
    });
    const controller = makeController({
      storage: undefined,
      locks: {
        request: (/** @type {any} */ _name, /** @type {any} */ callback) =>
          callback(),
      },
      features,
    });
    const shell = mount({
      root: dom.root,
      controller,
      features,
      window: dom.window,
      schedule: (/** @type {() => void} */ fn) => fn(),
    });
    t.teardown(async () => {
      shell.unmount();
      await dom.close();
    });
    await controller.attach(powers);
    await flush();
    controller.openPanel('accounts');
    await flush();
    const $ = (/** @type {string} */ selector) =>
      dom.document.querySelector(selector);
    const click = async (/** @type {any} */ element) => {
      element.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      );
      await flush();
    };
    t.is($('[data-note="manager-predates-add"]'), null, 'no predates note');
    const open = $('[data-action="add-subscription"]');
    t.truthy(open);
    await click(open);
    const form = () => $('.m4-add-member.open');
    t.true(form().textContent.includes(addMemberTexts.provider('codex')));
    const select = form().querySelector('select[name="secret"]');
    const option = [...select.querySelectorAll('option')].find(o =>
      o.textContent.startsWith('ChatGPT login 2'),
    );
    select.value = option.value;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    const input = form().querySelector('input[name="label"]');
    input.value = 'ChatGPT Account 2';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await flush();
    await click(form().querySelector('[data-action="check-credential"]'));
    t.is(
      form().querySelector('[data-check]').textContent,
      subscriptionTexts.credentialReady,
    );
    await click(form().querySelector('[data-action="add-member"]'));
    // The add answers after the pool's refresh (the first usage read,
    // unreachable here).
    for (let i = 0; i < 200 && form() !== null; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 25));
      // eslint-disable-next-line no-await-in-loop
      await flush(5);
    }
    t.true(
      $('.m4-add-member').textContent.includes(addMemberTexts.added),
      `added: ${$('.m4-add-member')?.textContent}`,
    );
    const labels = await s.served();
    t.deepEqual(labels, ['ChatGPT Account 1', 'ChatGPT Account 2']);
    t.true(
      $('[data-panel="accounts"] .m4-subscriptions').textContent.includes(
        'ChatGPT Account 2',
      ),
      'the pool shows the new member',
    );
    const added = (await s.adapter.pool(s.backend, s.spec)).members[1];
    t.is(added.key, 'k2', 'the chosen Secret, by object');
    t.true(s.admin.listMembers().members.includes(added.member));
    t.deepEqual(s.admin.describePool(s.backend).members, [s.m1]);
    t.truthy(s2);
    for (const value of s.values)
      t.false(dom.document.body.innerHTML.includes(value), 'no secret content');
  },
);

/**
 * An Operator whose `SecretsAdmin` and `SubscriptionsAdmin` override some
 * methods of the old manager's (a failure, a later manager's methods).
 * @param {any} s the setup
 * @param {{ secrets?: Record<string, Function>, subscriptions?: Record<string, Function> }} overrides
 */
const operatorWith = (s, { secrets = {}, subscriptions = {} }) => {
  /** @type {Record<string, Function>} */
  const delegated = {};
  // eslint-disable-next-line no-underscore-dangle -- the Endo introspection method
  for (const name of s.admin.__getMethodNames__())
    if (typeof name === 'string' && !name.startsWith('__'))
      delegated[name] = (/** @type {any[]} */ ...args) =>
        E(s.admin)[name](...args);
  const subscriptionsAdmin = Far('SubscriptionsAdmin', {
    ...delegated,
    ...subscriptions,
  });
  const secretsAdmin = Far('SecretsAdmin', {
    ...s.part.secretsAdminMethods,
    subscriptions: () => subscriptionsAdmin,
    ...secrets,
  });
  return Far('Operator', { getSecrets: () => secretsAdmin });
};

/**
 * Add "ChatGPT Account 2" through the adapter, then stop it.
 * @param {any} s
 */
const addSecond = async s => {
  const accounts = await E(s.admin).accounts();
  const s2 = await s.makeSecret('ChatGPT login 2', codexValue('2'));
  const member = await E(accounts).addMember(
    s.backend,
    harden({ label: 'ChatGPT Account 2', credential: s2 }),
  );
  await s.adapter.close();
  return { s2, member };
};

/**
 * The pool's note in the current incarnation's accounts view.
 * @param {any} s
 */
const noteOf = async s =>
  (await E(s.adapter.accounts.accounts).forBackend(s.backend)).additionsNote;

test('B: a transient failure at restart keeps the addition pending with a code; it is served once the failure passes', async t => {
  const s = await setup(t);
  const { member } = await addSecond(s);
  /** @type {string[]} */
  const errors = [];
  s.setOnError((/** @type {any} */ error) => errors.push(error.message));

  for (const [overrides, code] of /** @type {const} */ ([
    [
      { secrets: { catalog: () => Promise.reject(Error('busy')) } },
      'CATALOG_FAILED',
    ],
    [
      { subscriptions: { makeMember: () => Promise.reject(Error('busy')) } },
      'MAKE_FAILED',
    ],
    [
      { subscriptions: { listMembers: () => Promise.reject(Error('busy')) } },
      'LIST_FAILED',
    ],
  ])) {
    s.setOperator(operatorWith(s, overrides));
    s.start();
    // One incarnation after another, in order.
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await s.served(), ['ChatGPT Account 1'], code);
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await noteOf(s), { code, unrestored: 1 }, code);
    t.true(
      errors.some(text => text.includes(`could not be restored: ${code}`)),
      code,
    );
    t.true(s.additionsFile().includes('ChatGPT Account 2'), `${code}: kept`);
    // eslint-disable-next-line no-await-in-loop
    await s.adapter.close();
  }

  // The failure passed: the same member, nothing made.
  s.setOperator(s.operator);
  s.start();
  t.deepEqual(await s.served(), ['ChatGPT Account 1', 'ChatGPT Account 2']);
  t.is((await s.adapter.pool(s.backend, s.spec)).members[1].member, member);
  t.is(await noteOf(s), undefined);

  // Within one incarnation: a failure, then the retry after 5 s.
  await s.adapter.close();
  let failing = true;
  s.setOperator(
    operatorWith(s, {
      subscriptions: {
        makeMember: (/** @type {any} */ request) =>
          failing ? Promise.reject(Error('busy')) : s.admin.makeMember(request),
      },
    }),
  );
  s.start();
  t.deepEqual(await s.served(), ['ChatGPT Account 1']);
  failing = false;
  t.deepEqual(await s.served(), ['ChatGPT Account 1'], 'not before 5 s');
  s.advance(6000);
  t.deepEqual(await s.served(), ['ChatGPT Account 1', 'ChatGPT Account 2']);
  t.is(await noteOf(s), undefined);
});

test('B, D: a definite answer drops the entry: the member retired, its Secret gone, or remade while the adapter was away', async t => {
  // The Secret is gone from a complete catalogue.
  {
    const s = await setup(t);
    const { s2 } = await addSecond(s);
    s.setOperator(
      operatorWith(s, {
        secrets: {
          catalog: async (/** @type {any} */ cursor) => {
            const page = await s.part.secretsAdminMethods.catalog(cursor);
            return harden({
              ...page,
              entries: page.entries.filter(
                (/** @type {any} */ entry) => entry.secret !== s2,
              ),
            });
          },
        },
      }),
    );
    s.start();
    t.deepEqual(await s.served(), ['ChatGPT Account 1']);
    await s.adapter.additions.settled();
    t.deepEqual(JSON.parse(s.additionsFile()).pools, [], 'the Secret is gone');
  }
  // The member was retired and remade (same label and Secret) while the
  // adapter was away: a new member the person did not add to the pool.
  {
    const s = await setup(t);
    const { s2, member } = await addSecond(s);
    await E(member).retire();
    const remade = s.admin.makeMember(
      harden({ provider: 'codex', label: 'ChatGPT Account 2', credential: s2 }),
    );
    t.not(remade, member);
    s.start();
    t.deepEqual(await s.served(), ['ChatGPT Account 1']);
    await s.adapter.additions.settled();
    t.deepEqual(JSON.parse(s.additionsFile()).pools, [], 'remade');
  }
});

test('C: an unparsable additions file is reported, moved aside under a dated name, and refuses adds; the pool shows a note', async t => {
  const s = await setup(t);
  await addSecond(s);
  const file = join(
    s.dirs.stateDir,
    'agent-host',
    'subscriptions',
    'pool-additions.json',
  );
  writeFileSync(
    file,
    '{"format":"thixotrope-harness-pool-additions-2","pools":[{',
  );
  /** @type {string[]} */
  const errors = [];
  s.setOnError((/** @type {any} */ error) => errors.push(error.message));
  s.start();
  t.deepEqual(await s.served(), ['ChatGPT Account 1']);
  t.deepEqual(await noteOf(s), { code: 'FILE_CORRUPT' });
  t.true(errors.some(text => text.includes('FILE_CORRUPT')));
  await s.adapter.additions.settled();
  const dir = dirname(file);
  const aside = readdirSync(dir).filter(name => name.endsWith('.unreadable'));
  t.is(aside.length, 1);
  t.regex(aside[0], /^pool-additions\.json\.\d{4}-\d\d-\d\dT/);
  t.true(
    readFileSync(join(dir, aside[0]), 'utf8').endsWith('[{'),
    'kept as it was',
  );
  t.false(existsSync(file), 'never rewritten');
  const accounts = s.adapter.accounts.accounts;
  const s3 = await s.makeSecret('ChatGPT login 3', codexValue('3'));
  await t.throwsAsync(
    E(accounts).addMember(
      s.backend,
      harden({ label: 'ChatGPT Account 3', credential: s3 }),
    ),
    { message: subscriptionTexts.additionsUnreadable },
  );
  t.false(existsSync(file), 'a refused add writes nothing');

  // Unparsable entries of every kind: all or nothing.
  for (const text of [
    '[]',
    '{"format":"other","pools":[]}',
    '{"format":"thixotrope-harness-pool-additions-2","pools":[{"kind":"codex-pool","label":"ChatGPT","specKeys":["k1"],"members":[{"key":"k2","label":"A","provider":"codex"},{"key":"k2","label":"B","provider":"codex"}]}]}',
    '{"format":"thixotrope-harness-pool-additions-2","pools":[{"kind":"codex-pool","label":"ChatGPT","specKeys":["k1"],"members":[{"key":"k2","label":"A","provider":"gemini"}]}]}',
  ]) {
    writeFileSync(file, text);
    t.deepEqual(loadPoolAdditions(file), { problem: 'CORRUPT' }, text);
  }
  rmSync(file);
  t.deepEqual(loadPoolAdditions(file), { pools: [] }, 'no file');
  mkdirSync(file);
  t.deepEqual(loadPoolAdditions(file), { problem: 'IO' }, 'unreadable');
  rmSync(file, { recursive: true });
  writeFileSync(
    file,
    '{"format":"thixotrope-harness-pool-additions-1","pools":[{"kind":"codex-pool","label":"ChatGPT","specKeys":["k1"],"members":[{"key":"k2","label":"A","provider":"codex"}]}]}',
  );
  t.like(
    loadPoolAdditions(file),
    { pools: [{ label: 'ChatGPT' }] },
    'format 1 is still read',
  );
});

test('D: a pool remade over remade members inherits nothing; an unlisted pool does not count towards maxPools', async t => {
  const s = await setup(t);
  await addSecond(s);
  // While the adapter is away: the pool and its spec member retired and
  // remade under the same labels and Secret (another pool).
  s.admin.retirePool(s.backend);
  await E(s.m1).retire();
  const m1again = s.admin.makeMember(
    harden({ provider: 'codex', label: 'ChatGPT Account 1', credential: s.s1 }),
  );
  const spec2 = harden({
    kind: 'codex-pool',
    label: 'ChatGPT',
    members: [m1again],
  });
  const backend2 = s.admin.makePool(spec2);
  s.start();
  const pool2 = await s.adapter.pool(backend2, spec2);
  t.deepEqual(
    pool2.members.map((/** @type {any} */ entry) => entry.label),
    ['ChatGPT Account 1'],
  );
  await s.adapter.additions.settled();
  t.deepEqual(
    JSON.parse(s.additionsFile()).pools,
    [],
    'dropped, not inherited',
  );
});

test('E: a second adapter process over the same state cannot write the additions until the first lets go; a dead holder is taken over', async t => {
  const s = await setup(t);
  const accounts = s.adapter.accounts.accounts;
  const s2 = await s.makeSecret('ChatGPT login 2', codexValue('2'));
  await E(accounts).addMember(
    s.backend,
    harden({ label: 'ChatGPT Account 2', credential: s2 }),
  );
  const first = s.adapter;
  // The reload's new process starts while the old one still runs.
  const second = s.start();
  const lock = `${join(s.dirs.stateDir, 'agent-host', 'subscriptions', 'pool-additions.json')}.lock`;
  const s3 = await s.makeSecret('ChatGPT login 3', codexValue('3'));
  await t.throwsAsync(
    E(second.accounts.accounts).addMember(
      s.backend,
      harden({ label: 'ChatGPT Account 3', credential: s3 }),
    ),
    { message: subscriptionTexts.additionsLocked },
  );
  t.false(s.additionsFile().includes('Account 3'));
  // The second still serves the kept addition (reading needs no lock).
  t.deepEqual(await s.served(), ['ChatGPT Account 1', 'ChatGPT Account 2']);
  await first.close();
  t.false(existsSync(lock), 'the old process let go');
  await E(second.accounts.accounts).addMember(
    s.backend,
    harden({ label: 'ChatGPT Account 3', credential: s3 }),
  );
  t.true(s.additionsFile().includes('Account 3'));
  await second.close();

  // A lock left by a process that died is taken over.
  writeFileSync(lock, '2147483646 dead');
  s.start();
  const s4 = await s.makeSecret('ChatGPT login 4', codexValue('4'));
  await E(s.adapter.accounts.accounts).addMember(
    s.backend,
    harden({ label: 'ChatGPT Account 4', credential: s4 }),
  );
  t.true(s.additionsFile().includes('Account 4'));
});

test("E: an added member's refusal mark is kept beside it and survives a restart (the pinned manager keeps only its spec members')", async t => {
  const s = await setup(t);
  const { member } = await addSecond(s);
  s.start();
  const pool = await s.adapter.pool(s.backend, s.spec);
  const until = Date.now() + HOUR;
  pool.core.forSession(Far('Session', {})).exhausted(member, until);
  await s.adapter.additions.settled();
  const [kept] = JSON.parse(s.additionsFile()).pools[0].members;
  t.is(kept.mark?.untilMs, until);
  await s.adapter.close();
  s.start();
  const again = await s.adapter.pool(s.backend, s.spec);
  t.is(again.core.marks().get(member)?.untilMs, until, 'restored');
});

test('F: the first selection waits for the kept additions (bounded), and the subscriptions module is given only getSecrets', async t => {
  const s = await setup(t);
  await addSecond(s);
  s.setOperator(undefined);
  s.start({ additionsHoldMs: 5000 });
  const loading = s.served();
  await new Promise(resolve => setTimeout(resolve, 300));
  s.setOperator(s.operator);
  t.deepEqual(await loading, ['ChatGPT Account 1', 'ChatGPT Account 2']);

  // Bounded: no operator at all, the pool serves its spec after the wait.
  await s.adapter.close();
  s.setOperator(undefined);
  s.start({ additionsHoldMs: 300 });
  t.deepEqual(await s.served(), ['ChatGPT Account 1']);
  t.deepEqual(await noteOf(s), { code: 'UNREACHABLE', unrestored: 1 });
});

test('H: on a later manager with addPoolMember the kept additions move into its pool once', async t => {
  const s = await setup(t);
  const { member } = await addSecond(s);
  /** @type {any[][]} */
  const calls = [];
  s.setOperator(
    operatorWith(s, {
      subscriptions: {
        addPoolMember: (/** @type {any[]} */ ...args) => {
          calls.push(args);
        },
      },
    }),
  );
  s.start();
  await s.served();
  await s.adapter.additions.settled();
  t.deepEqual(calls, [[s.backend, member]]);
  t.deepEqual(JSON.parse(s.additionsFile()).pools, [], 'its entry is dropped');
  s.advance(10_000);
  await s.served();
  t.is(calls.length, 1, 'once');
});
