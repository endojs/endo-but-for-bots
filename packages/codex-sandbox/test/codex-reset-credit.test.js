// @ts-check
import '@endo/init';

import test from 'ava';

import {
  makeCodexResetRedeem,
  outcomeFromCodexConsume,
} from '../src/codex-reset-credit.js';

const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e';
const credential = {
  current: async () => ({ state: { accessToken: 'tok' } }),
};

test('the outcome is read from the top-level words, in either spelling, and nothing else', t => {
  t.is(
    outcomeFromCodexConsume({ outcome: 'reset', windows_reset: [] }),
    'reset',
  );
  t.is(
    outcomeFromCodexConsume({ status: 'nothing_to_reset' }),
    'nothingToReset',
  );
  t.is(outcomeFromCodexConsume({ result: 'no_credit' }), 'noCredit');
  t.is(outcomeFromCodexConsume({ code: 'alreadyRedeemed' }), 'alreadyRedeemed');
  t.is(outcomeFromCodexConsume({ outcome: 'reset', status: 'reset' }), 'reset');
  t.is(
    outcomeFromCodexConsume({ outcome: 'reset', status: 'no_credit' }),
    undefined,
  );
  // A string elsewhere that happens to spell an outcome is not the answer.
  t.is(outcomeFromCodexConsume({ type: 'reset', window: 'reset' }), undefined);
  t.is(outcomeFromCodexConsume({ nested: { outcome: 'reset' } }), undefined);
  t.is(outcomeFromCodexConsume({ outcome: 'constructor' }), undefined);
  t.is(outcomeFromCodexConsume(null), undefined);
  t.is(outcomeFromCodexConsume('reset'), undefined);
});

test('the redeem posts the key and the credit to the consume endpoint only', async t => {
  const requests = [];
  const redeem = makeCodexResetRedeem({
    credential,
    accountRef: 'acct_1',
    fetch: /** @type {any} */ (
      async (url, init) => {
        requests.push({ url, init });
        return new Response(
          JSON.stringify({ outcome: 'reset', windows_reset: ['primary'] }),
          { status: 200 },
        );
      }
    ),
  });
  t.deepEqual(await redeem({ idempotencyKey: KEY, creditId: 'credit-1' }), {
    outcome: 'reset',
  });
  t.is(requests.length, 1);
  t.is(
    requests[0].url,
    'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
  );
  t.is(requests[0].init.method, 'POST');
  t.is(requests[0].init.redirect, 'error');
  t.is(requests[0].init.headers.authorization, 'Bearer tok');
  t.is(requests[0].init.headers['chatgpt-account-id'], 'acct_1');
  t.deepEqual(JSON.parse(requests[0].init.body), {
    redeem_request_id: KEY,
    credit_id: 'credit-1',
    credit_type: 'usage_limit',
  });
  await redeem({ idempotencyKey: KEY });
  t.false('credit_id' in JSON.parse(requests[1].init.body));
});

test('a client error is a refusal; anything else unknown is thrown without upstream words', async t => {
  /**
   * @param {number} status @param {string} [body]
   * @param body
   */
  const against = (status, body = 'secret upstream wording') =>
    makeCodexResetRedeem({
      credential,
      accountRef: 'acct_1',
      fetch: /** @type {any} */ (async () => new Response(body, { status })),
    });
  for (const status of [400, 401, 403, 404, 422]) {
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await against(status)({ idempotencyKey: KEY }), {
      outcome: 'refused',
      status,
    });
  }
  // Not answers: the request may have been acted on, or may yet be.
  for (const status of [408, 409, 429, 500, 502, 503]) {
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(() =>
      against(status)({ idempotencyKey: KEY }),
    );
    t.false(error.message.includes('secret upstream wording'));
    t.true(error.message.includes(`${status}`));
  }
  const unknown = await t.throwsAsync(() =>
    against(
      200,
      JSON.stringify({ outcome: 'something new' }),
    )({
      idempotencyKey: KEY,
    }),
  );
  t.regex(unknown.message, /not understood/);
  t.false(unknown.message.includes('something new'));

  const lost = makeCodexResetRedeem({
    credential,
    accountRef: 'acct_1',
    fetch: /** @type {any} */ (
      async () => {
        throw Error('connect ECONNRESET with Bearer tok');
      }
    ),
  });
  const error = await t.throwsAsync(() => lost({ idempotencyKey: KEY }));
  t.is(error.message, 'Codex reset redeem got no answer');

  // A credential that cannot be had means nothing was sent.
  let fetched = 0;
  const unsendable = makeCodexResetRedeem({
    credential: {
      current: async () => {
        throw Error('Subscription renewal refused');
      },
    },
    accountRef: 'acct_1',
    fetch: /** @type {any} */ (
      async () => {
        fetched += 1;
        return new Response('{}', { status: 200 });
      }
    ),
  });
  t.deepEqual(await unsendable({ idempotencyKey: KEY }), {
    outcome: 'notSent',
  });
  t.is(fetched, 0);
  t.throws(() =>
    makeCodexResetRedeem({
      credential,
      accountRef: 'bad account',
      fetch: globalThis.fetch,
    }),
  );
});
