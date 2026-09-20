// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { make as makeFacet } from '../src/subscription-share-facet-module.js';
import { make } from '../src/subscription-share-module.js';

const makeNamespace = (initial = {}) => {
  const names = new Map(Object.entries(initial));
  return {
    names,
    powers: Far('powers', {
      has: async name => names.has(name),
      list: async () => [...names.keys()],
      lookup: async name => names.get(name),
      storeValue: async (value, name) => {
        names.set(name, value);
      },
      remove: async name => {
        names.delete(name);
      },
    }),
  };
};

const makeBeneath = () => {
  const revoked = [];
  return {
    revoked,
    subscription: Far('beneath', {
      describe: async () =>
        harden({ providerId: 'codex', models: ['allowed'] }),
      getStatus: async () =>
        harden({ available: true, blockedUntil: '', remainingFraction: 1 }),
      openEndpoint: async spec =>
        Far('inner', {
          request: async () =>
            harden({
              status: 200,
              body: 'ok',
              usage: {
                began: true,
                complete: true,
                usage: { inputTokens: 100, outputTokens: 50 },
              },
            }),
          attestation: async () => harden({ providerOrigin: 'https://x.test' }),
          revoke: async () => {
            revoked.push(spec.sessionId);
          },
        }),
    }),
  };
};

const request = harden({
  method: 'POST',
  path: '/v1/responses',
  body: '{"model":"allowed","max_output_tokens":10}',
});

test('the share’s state lives in its own namespace: a restart keeps the meter and the revocation', async t => {
  const beneath = makeBeneath();
  const space = makeNamespace({
    subscription: beneath.subscription,
    'share-limits': harden({
      createdAt: new Date(Date.now() - 1000).toISOString(),
      budget: { tokens: 10_000, periodSeconds: 86_400 },
    }),
  });
  const kit = await make(space.powers, undefined, {
    env: { SHARE_ID: 'alice' },
  });
  // What is handed out is the kit's share() and nothing else of it.
  const share = await makeFacet(kit);
  // eslint-disable-next-line no-underscore-dangle
  const shareMethods = await E(share).__getMethodNames__();
  t.false(shareMethods.includes('revoke'));
  t.false(shareMethods.includes('share'));
  const endpoint = await E(share).openEndpoint({ sessionId: 's1' });
  await E(endpoint).request(request);
  await new Promise(resolve => setTimeout(resolve, 5));
  t.is((await E(share).getStatus()).budget.spent, 150);
  t.true(
    [...space.names.keys()].some(name => name.startsWith('share-state-v1-')),
  );

  // The daemon restarts. Nothing is refilled: the kept ceiling is the spend.
  const revived = await make(space.powers, undefined, {
    env: { SHARE_ID: 'alice' },
  });
  const spentAfter = (await E(revived).getStatus()).budget.spent;
  t.true(spentAfter >= 150);

  // The grantor rewrites the limits: a write of a value, read at once.
  space.names.set(
    'share-limits',
    harden({ ...space.names.get('share-limits'), models: ['other'] }),
  );
  const again = await E(E(revived).share()).openEndpoint({ sessionId: 's2' });
  await t.throwsAsync(() => E(again).request(request), {
    message: /Model denied/,
  });

  // Revoked, durably; the open endpoint beneath goes with it.
  await E(revived).revoke();
  t.deepEqual(beneath.revoked, ['share-alice-s2']);
  const afterRestart = await make(space.powers, undefined, {
    env: { SHARE_ID: 'alice' },
  });
  t.true((await E(afterRestart).getStatus()).revoked);
  await t.throwsAsync(
    () => E(E(afterRestart).share()).openEndpoint({ sessionId: 's3' }),
    { message: /Provider share revoked/ },
  );
});

test('a share with no id, or nothing bound, fails plainly', async t => {
  await t.throwsAsync(() => make(makeNamespace().powers, undefined, {}), {
    message: /SHARE_ID/,
  });
  const kit = await make(makeNamespace().powers, undefined, {
    env: { SHARE_ID: 'alice' },
  });
  // What a holder is told is bare; the reason is logged where the share is.
  await t.throwsAsync(() => E(E(kit).share()).getStatus(), {
    message: 'Provider share unavailable',
  });
});
