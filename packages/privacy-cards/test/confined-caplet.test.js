// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { make } from '../src/confined-caplet.js';
import { nodeFetch } from '../src/node-fetch.js';
import { makeMockPrivacyApi } from './mock-privacy-api.js';

const API_KEY = 'test-key-do-not-leak';

/**
 * A host-side mediated HTTP capability in the shape the confined
 * caplet documents: bound to the Privacy base URL, injecting the
 * Authorization header on this side of the membrane. This is the
 * endoclaw-oauth idiom; the caplet never sees the key.
 *
 * @param {string} baseUrl
 */
const makePrivacyHttpPower = baseUrl => {
  const base = baseUrl.replace(/\/+$/, '');
  return makeExo(
    'PrivacyHttp',
    M.interface('PrivacyHttp', {}, { defaultGuards: 'passable' }),
    {
      /**
       * @param {string} path
       * @param {{ method?: string, headers?: Record<string, string>,
       *   body?: string }} [options]
       */
      fetch: async (path, { method = 'GET', headers = {}, body } = {}) => {
        const response = await nodeFetch(`${base}${path}`, {
          method,
          headers: {
            ...headers,
            Authorization: `api-key ${API_KEY}`,
          },
          ...(body === undefined ? {} : { body }),
        });
        const text = await response.text();
        return makeExo(
          'PrivacyHttpResponse',
          M.interface('PrivacyHttpResponse', {}, { defaultGuards: 'passable' }),
          {
            status: () => response.status,
            text: () => text,
            json: () => JSON.parse(text),
          },
        );
      },
    },
  );
};

test('the confined caplet issues budgeted cards with no key in reach', async t => {
  const api = await makeMockPrivacyApi({ apiKey: API_KEY });
  t.teardown(() => api.close());

  const httpPower = makePrivacyHttpPower(api.baseUrl);
  const account = make(httpPower, undefined);
  t.true(await account.status());

  const { issuer, control } = account.makeIssuer(
    'agent',
    harden({ budgetCents: 50_000 }),
  );
  const card = await issuer.createCard(harden({ spendLimitCents: 20_000 }));
  t.regex(card.pan, /^\d{16}$/);
  t.is(api.cards.get(card.cardToken).spend_limit_duration, 'FOREVER');
  t.is(issuer.remainingCents(), 30_000);
  await t.throwsAsync(
    () => issuer.createCard(harden({ spendLimitCents: 40_000 })),
    { message: /exceeds the remaining budget/ },
  );

  // Close-and-reclaim works across the mediated transport too.
  api.addTransaction(card.cardToken, {
    amount: -5000,
    result: 'APPROVED',
    status: 'SETTLED',
  });
  t.is(await issuer.closeCard(card.cardToken), 15_000);
  t.is(issuer.remainingCents(), 45_000);

  await control.revoke();
  await t.throwsAsync(() => issuer.createCard(harden({ spendLimitCents: 1 })));
});

test('the confined caplet refuses to start without a powers capability', t => {
  t.throws(() => make(/** @type {any} */ (undefined), undefined), {
    message: /mediated HTTP capability/,
  });
});

test('spend monitors and renewal degrade with clear errors when unpowered', async t => {
  const api = await makeMockPrivacyApi({ apiKey: API_KEY });
  t.teardown(() => api.close());
  const account = make(makePrivacyHttpPower(api.baseUrl), undefined);
  const { control } = account.makeIssuer('a', harden({ budgetCents: 1000 }));
  t.throws(() => control.startSpendMonitor(harden({ intervalMs: 10 })), {
    message: /timer authority/,
  });
  t.throws(
    () =>
      account.makeIssuer(
        'b',
        harden({
          budgetCents: 1000,
          renewal: { amountCents: 100, periodMs: 1000 },
        }),
      ),
    { message: /clock authority/ },
  );
});
