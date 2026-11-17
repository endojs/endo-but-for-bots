// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { normalizeRateLimits } from '../src/account.js';
import {
  makeOpenRouterAccountRead,
  readingFromOpenRouter,
} from '../src/openrouter-account-read.js';

const NOW = Date.parse('2026-09-20T15:30:00.000Z');

test('the key and credits payloads become a reading the oracle accepts', t => {
  const reading = readingFromOpenRouter(
    {
      data: {
        label: 'sk-or-...abc',
        usage: 4.2,
        limit: null,
        limit_remaining: null,
        is_free_tier: false,
        free_model_daily_requests: { used: 37, limit: 1000, remaining: 963 },
      },
    },
    { data: { total_credits: 25, total_usage: 4.2 } },
    NOW,
  );
  t.deepEqual(reading.plan, {
    planId: 'pay-as-you-go',
    title: 'OpenRouter',
    state: 'active',
  });
  t.deepEqual(reading.rateLimits.windows, [
    {
      windowId: 'secondary',
      title: 'Free-model requests today',
      limit: 1000n,
      used: 37n,
      windowSeconds: 86_400,
      resetsAt: '2026-09-21T00:00:00.000Z',
    },
  ]);
  t.deepEqual(reading.rateLimits.credits, {
    balance: '20.8000',
    hasCredits: true,
    unlimited: false,
  });
  const normalized = normalizeRateLimits({
    ...reading.rateLimits,
    observedAt: '2026-09-20T15:30:00.000Z',
    source: 'observed',
  });
  t.is(normalized.windows[0].remaining, 963n);
  t.is(normalized.windows[0].usedFraction, 0.037);
  // The key's label never enters a reading.
  t.false(JSON.stringify(reading, (_k, v) => `${v}`).includes('sk-or'));
});

test('without the credits endpoint the key’s own cap stands; without either, nothing is claimed', t => {
  const capped = readingFromOpenRouter(
    { data: { is_free_tier: true, limit: 10, limit_remaining: 0 } },
    undefined,
    NOW,
  );
  t.is(capped.plan.planId, 'free-tier');
  t.is(capped.rateLimits.credits.balance, '0.0000');
  t.true(capped.rateLimits.limitReached);
  const bare = readingFromOpenRouter({ data: {} }, undefined, NOW);
  t.deepEqual(bare.rateLimits, { windows: [], limitReached: false });
  t.deepEqual(readingFromOpenRouter({}, undefined, NOW), {});
});

test('the read presents the key to openrouter.ai only, and survives a refused credits read', async t => {
  const requests = [];
  const read = makeOpenRouterAccountRead({
    readKey: async () => 'sk-or-test',
    now: () => NOW,
    fetch: /** @type {any} */ (
      async (url, init) => {
        requests.push([url, init.headers.authorization, init.redirect]);
        if (url.endsWith('/credits')) {
          return new Response('forbidden wording', { status: 403 });
        }
        return new Response(
          JSON.stringify({
            data: { is_free_tier: true, limit_remaining: 1.5 },
          }),
        );
      }
    ),
  });
  const reading = await read();
  t.is(reading.rateLimits.credits.balance, '1.5000');
  t.deepEqual(requests, [
    ['https://openrouter.ai/api/v1/key', 'Bearer sk-or-test', 'error'],
    ['https://openrouter.ai/api/v1/credits', 'Bearer sk-or-test', 'error'],
  ]);
  const refused = makeOpenRouterAccountRead({
    readKey: async () => 'sk-or-test',
    fetch: /** @type {any} */ (
      async () => new Response('secret wording', { status: 401 })
    ),
  });
  const error = await t.throwsAsync(() => refused());
  t.false(error.message.includes('secret wording'));
  t.false(error.message.includes('sk-or-test'));
});
