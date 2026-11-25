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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

import { subscriptionLimits } from '../../guest/lib/subscription-limits.js';
import {
  subscriptionTextOf,
  subscriptionTexts,
} from '../../guest/lib/subscription-texts.js';
import { subscriptionDefaults } from '../../config/subscription-defaults.js';
import { makeCredentialAccess } from '../../resources/agent-host/impl/secrets/credential-access.js';
import { makeSubscriptions } from '../../resources/agent-host/impl/subscriptions/index.js';
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
  /** A new adapter incarnation over the same state directory. */
  const start = () => {
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
      currentOperator: () => operatorNow,
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

  // The kept addition: store keys and labels, never a value.
  const kept = JSON.parse(s.additionsFile());
  t.deepEqual(kept.pools, [
    {
      kind: 'codex-pool',
      label: 'ChatGPT',
      specKeys: ['k1'],
      members: [{ key: 'k2', label: 'ChatGPT Account 2', provider: 'codex' }],
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
