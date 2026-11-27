// @ts-check
/* eslint-disable import/no-relative-packages */
// "Add account" and "Sign in again" in the Subscriptions panel
// (ui/src/accounts/SignIn.js): component tests in happy-dom with M3's fake
// powers, the M4 fakes and a scripted `SubscriptionSignIn` in
// `GatewayPowers.extras`. The page offers a provider, a default label and
// the provider's pool (or a new one), shows Claude's numbered steps with the
// authorization link and a paste field, ChatGPT's device page and one-time
// code, finishes by itself when the service says so, shows refusals in
// plain words with "Start again", and offers "Sign in again" on a member's
// row with that member's presence.
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import { makeController } from '../../ui/src/controller/index.js';
import { mount } from '../../ui/src/shell/index.js';
import { feature as accountFeatures } from '../../ui/src/accounts/feature.js';
import { defaultLabel, signInTexts } from '../../ui/src/accounts/SignIn.js';
import { subscriptionSignInLabel } from '../../resources/agent-host/impl/gateway/protocol.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';
import {
  makeFakeAccounts,
  makeFakeSecrets,
  memberAccount,
  openAccountsPanel,
  runEffectsPromptly,
} from './_m4-ui-fakes.js';

const flush = async (rounds = 20) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * A scripted `SubscriptionSignIn`: each `begin`/`beginAgain` makes a
 * `PendingSignIn` whose description the test moves with `advance`.
 */
const makeFakeSignIn = () => {
  /** @type {any[][]} */
  const calls = [];
  /** @type {any[]} */
  const pendings = [];
  /**
   * @param {'claude' | 'codex'} provider
   * @param {string} label
   * @param {boolean} again
   */
  const makePending = (provider, label, again) => {
    let view = harden({
      rev: 1,
      provider,
      label,
      again,
      state: provider === 'claude' ? 'waiting' : 'starting',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      ...(provider === 'claude'
        ? { authorizeUrl: 'https://claude.com/cai/oauth/authorize?state=s1' }
        : {}),
    });
    /** @type {Set<() => void>} */
    const waiters = new Set();
    /** @param {Record<string, unknown>} next */
    const advance = next => {
      view = harden({ ...view, ...next, rev: view.rev + 1 });
      for (const wake of [...waiters]) wake();
    };
    const pending = Far('PendingSignIn', {
      describe: () => view,
      wait: (/** @type {number} */ rev) =>
        rev !== view.rev
          ? view
          : new Promise(resolve => {
              const wake = () => {
                waiters.delete(wake);
                resolve(view);
              };
              waiters.add(wake);
            }),
      complete: (/** @type {string} */ pasted) => {
        calls.push(['complete', pasted]);
        if (pasted !== 'thecode#s1')
          throw Error(
            'That code belongs to another sign-in. Paste the code from the page this sign-in opened, or start again.',
          );
        advance({
          state: 'done',
          result: { generation: 1, created: again ? 'replaced' : 'member' },
        });
        return view;
      },
      useLoginFile: (/** @type {string} */ text) => {
        calls.push(['useLoginFile', text.length]);
        advance({ state: 'done', result: { generation: 1, created: 'pool' } });
        return view;
      },
      cancel: () => {
        calls.push(['cancel', label]);
        if (!['done', 'failed', 'expired', 'cancelled'].includes(view.state))
          advance({ state: 'cancelled' });
        return view;
      },
    });
    pendings.push({ pending, advance, view: () => view });
    return pending;
  };
  const service = Far('SubscriptionSignIn', {
    begin: (
      /** @type {'claude' | 'codex'} */ provider,
      /** @type {string} */ label,
      /** @type {any} */ pool,
    ) => {
      calls.push(['begin', provider, label, pool]);
      return makePending(provider, label, false);
    },
    beginAgain: (/** @type {any} */ pool, /** @type {any} */ member) => {
      calls.push(['beginAgain', pool, member]);
      return makePending('claude', 'first', true);
    },
  });
  return { service, calls, pendings };
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ pools?: boolean, service?: boolean, width?: number }} [options]
 */
const setup = async (t, { pools = true, service = true, width = 390 } = {}) => {
  runEffectsPromptly();
  const dom = makeTestDom({ width });
  const poolBackend = Far('Backend', {});
  const firstMember = Far('PoolMember', {
    describe: () =>
      harden({
        label: 'first',
        provider: 'claude',
        weight: 1,
        state: 'active',
      }),
  });
  const shown = pools
    ? [
        harden({
          backend: poolBackend,
          kind: 'claude-pool',
          label: 'team-claude',
          selection: 'auto',
          members: [
            memberAccount({ label: 'first', state: 'unusable' }),
            memberAccount({ label: 'Claude Account 1' }),
          ],
        }),
      ]
    : [];
  const accounts = makeFakeAccounts({ pools: shown });
  const secrets = makeFakeSecrets({
    accounts: accounts.accounts,
    poolBackends: pools ? [poolBackend] : [],
  });
  accounts.withManager({
    describePool: () => harden({ members: [firstMember] }),
  });
  const signIn = makeFakeSignIn();
  const features = [...accountFeatures];
  const { powers } = makeFakePowers({
    sessions: [],
    operatorMethods: { getSecrets: () => secrets.getSecrets() },
    extras: service
      ? [{ label: subscriptionSignInLabel, service: signIn.service }]
      : [],
  });
  const controller = makeController({
    storage: undefined,
    locks: { request: (_name, callback) => callback() },
    features,
  });
  const shell = mount({
    root: dom.root,
    controller,
    features,
    window: dom.window,
    schedule: fn => fn(),
  });
  t.teardown(async () => {
    shell.unmount();
    await dom.close();
  });
  await controller.attach(powers);
  await flush();
  openAccountsPanel(controller);
  await flush();
  const $ = (/** @type {string} */ selector) =>
    dom.document.querySelector(selector);
  const $$ = (/** @type {string} */ selector) => [
    ...dom.document.querySelectorAll(selector),
  ];
  const click = async (/** @type {any} */ element) => {
    element.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true }),
    );
    await flush();
  };
  /**
   * @param {any} element
   * @param {string} value
   */
  const type = async (element, value) => {
    element.value = value;
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await flush();
  };
  const submit = async (/** @type {any} */ form) => {
    form.dispatchEvent(
      new dom.window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
  };
  return {
    dom,
    accounts,
    secrets,
    signIn,
    poolBackend,
    firstMember,
    $,
    $$,
    click,
    type,
    submit,
  };
};

test.serial('default labels skip the ones in use', t => {
  t.is(defaultLabel('claude', []), 'Claude Account 1');
  t.is(
    defaultLabel('codex', [
      { members: [{ label: 'ChatGPT Account 1' }, { label: 'x' }] },
      { members: [{ label: 'ChatGPT Account 2' }] },
    ]),
    'ChatGPT Account 3',
  );
});

test.serial(
  'Add account with no pools: ChatGPT device code, a new pool, finishes by itself',
  async t => {
    const s = await setup(t, { pools: false });
    const open = s.$('[data-action="add-account"]');
    t.truthy(open, 'offered even with no pool');
    await s.click(open);
    t.true(
      /** @type {any} */ (s.$('input[name="provider"][value="claude"]'))
        .checked,
    );
    t.is(
      /** @type {any} */ (s.$('.m4-add-account input[name="label"]')).value,
      'Claude Account 1',
    );
    await s.click(s.$('input[name="provider"][value="codex"]'));
    t.is(
      /** @type {any} */ (s.$('.m4-add-account input[name="label"]')).value,
      'ChatGPT Account 1',
    );
    t.deepEqual(
      s
        .$$('.m4-add-account select[name="pool"] option')
        .map(o => o.textContent),
      [signInTexts.newPool('ChatGPT subscriptions')],
    );
    await s.submit(s.$('.m4-sign-in-form'));
    t.deepEqual(s.signIn.calls[0], [
      'begin',
      'codex',
      'ChatGPT Account 1',
      undefined,
    ]);
    t.regex(String(s.$('.m4-sign-in-steps')?.textContent), /one-time code/u);
    const [{ advance }] = s.signIn.pendings;
    advance({
      state: 'waiting',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    });
    await flush();
    const link = /** @type {any} */ (s.$('[data-action="open-device"]'));
    t.is(link.getAttribute('href'), 'https://auth.openai.com/codex/device');
    t.is(link.getAttribute('target'), '_blank');
    t.is(link.getAttribute('rel'), 'noopener noreferrer');
    t.is(s.$('[data-user-code]')?.textContent, 'ABCD-1234');
    t.is(s.$$('.m4-sign-in-list > li').length, 4, 'four numbered steps');
    t.regex(
      String(s.$('.m4-sign-in-steps')?.textContent),
      /security settings/u,
    );
    t.truthy(s.$('details.m4-sign-in-fallback'), 'the auth.json fallback');
    const refreshesBefore = s.accounts.callsOf('Accounts.refresh').length;
    advance({ state: 'done', result: { generation: 0, created: 'pool' } });
    await flush();
    t.regex(
      String(s.$('[data-sign-in="done"]')?.textContent),
      /Signed in: ChatGPT Account 1\. The account was added to a new pool/u,
    );
    t.true(
      s.accounts.callsOf('Accounts.refresh').length > refreshesBefore,
      'the pools are read again',
    );
  },
);

test.serial(
  'Add account into the pool (Claude): steps, a wrong paste refused in plain words, then done',
  async t => {
    const s = await setup(t);
    await s.click(s.$('[data-action="add-account"]'));
    t.is(
      /** @type {any} */ (s.$('.m4-add-account input[name="label"]')).value,
      'Claude Account 2',
      'Claude Account 1 is taken',
    );
    t.deepEqual(
      s
        .$$('.m4-add-account select[name="pool"] option')
        .map(o => o.textContent),
      ['team-claude', signInTexts.newPool('Claude subscriptions')],
    );
    await s.submit(s.$('.m4-sign-in-form'));
    t.deepEqual(s.signIn.calls[0], [
      'begin',
      'claude',
      'Claude Account 2',
      s.poolBackend,
    ]);
    const link = /** @type {any} */ (s.$('[data-action="open-authorize"]'));
    t.regex(
      link.getAttribute('href'),
      /^https:\/\/claude\.com\/cai\/oauth\/authorize/u,
    );
    t.is(s.$$('.m4-sign-in-list > li').length, 4);
    const field = /** @type {any} */ (
      s.$('.m4-sign-in-steps input[name="code"]')
    );
    await s.type(field, 'thecode#other');
    await s.submit(field.form);
    t.is(field.value, '', 'the paste is cleared once sent');
    t.regex(
      String(s.$('.m4-sign-in-steps [role="alert"]')?.textContent),
      /belongs to another sign-in/u,
    );
    await s.type(field, 'thecode#s1');
    await s.submit(field.form);
    t.regex(
      String(s.$('[data-sign-in="done"]')?.textContent),
      /Signed in: Claude Account 2\. The account was added to the pool\./u,
    );
  },
);

test.serial(
  'a failed sign-in says why and offers Start again; Cancel cancels a waiting one',
  async t => {
    const s = await setup(t);
    await s.click(s.$('[data-action="add-account"]'));
    await s.submit(s.$('.m4-sign-in-form'));
    s.signIn.pendings[0].advance({
      state: 'expired',
      error: {
        code: 'EXPIRED',
        text: 'This sign-in expired after 15 minutes. Start again.',
      },
    });
    await flush();
    const alert = s.$('[data-sign-in="expired"] [role="alert"]');
    t.is(alert?.getAttribute('data-code'), 'EXPIRED');
    t.regex(String(alert?.textContent), /expired after 15 minutes/u);
    await s.click(s.$('[data-action="restart-sign-in"]'));
    t.truthy(s.$('.m4-sign-in-form'), 'back to the form');
    await s.submit(s.$('.m4-sign-in-form'));
    await s.click(s.$('[data-action="close-sign-in"]'));
    t.deepEqual(
      s.signIn.calls.filter(call => call[0] === 'cancel').length,
      1,
      'the waiting sign-in is cancelled',
    );
    t.truthy(s.$('[data-action="add-account"]'), 'closed');
  },
);

test.serial(
  'Sign in again on a member row passes that member; the credential is replaced',
  async t => {
    const s = await setup(t);
    const again = s
      .$$('[data-action="sign-in-again"]')
      .find(
        b => b.getAttribute('aria-label') === signInTexts.againNamed('first'),
      );
    t.truthy(again);
    t.true(again?.classList.contains('primary'), 'stressed: unusable');
    await s.click(again);
    const [call] = s.signIn.calls;
    t.is(call[0], 'beginAgain');
    t.is(call[1], s.poolBackend);
    t.is(call[2], s.firstMember, 'the member presence, not its label');
    t.regex(
      String(s.$('[data-again="first"] h3')?.textContent),
      /Sign in again: first/u,
    );
    const field = /** @type {any} */ (
      s.$('[data-again="first"] input[name="code"]')
    );
    await s.type(field, 'thecode#s1');
    await s.submit(field.form);
    t.regex(
      String(s.$('[data-again="first"] [data-sign-in="done"]')?.textContent),
      /credential was replaced/u,
    );
  },
);

test.serial('a gateway without the service says so', async t => {
  const s = await setup(t, { service: false });
  await s.click(s.$('[data-action="add-account"]'));
  t.truthy(s.$('[data-note="no-sign-in"]'));
});
