// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { make } from '../src/account-oracle-module.js';
import { makeAccountReadingSource } from '../src/account-source.js';

/**
 * A namespace like the guest a formula gets as its powers.
 * @param initial
 */
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

const reading = usedPercent =>
  harden({
    rateLimits: {
      windows: [
        {
          windowId: 'secondary',
          title: 'Weekly window',
          usedPercent,
          resetsAt: '2030-01-01T00:00:00.000Z',
        },
      ],
      limitReached: false,
    },
  });

test('an oracle bound to a broker’s account source answers from it, pushed', async t => {
  const account = makeAccountReadingSource();
  const space = makeNamespace({ 'account-source': account.source });
  const oracle = await make(space.powers, undefined, {
    env: { ACCOUNT_PROVIDER_ID: 'codex' },
  });
  t.is((await E(oracle).getPlan()).providerId, 'codex');
  const reader = iterateReader(E(oracle).watch());
  t.is((await reader.next()).value.rateLimits.source, 'unavailable');
  account.accept(reading(55));
  const next = (await reader.next()).value;
  t.is(next.rateLimits.windows[0].usedPercent, 55);
  await reader.return(undefined);
  await new Promise(resolve => setTimeout(resolve, 0));
  // The reading is journalled in the oracle's own namespace.
  t.true(
    [...space.names.keys()].some(name => name.startsWith('account-snapshot-')),
  );

  // A second incarnation over the same namespace, with a broker that has
  // served nothing, remembers it.
  const quiet = makeAccountReadingSource();
  space.names.set('account-source', quiet.source);
  const revived = await make(space.powers, undefined, {
    env: { ACCOUNT_PROVIDER_ID: 'codex' },
  });
  const limits = await E(revived).getRateLimits();
  t.is(limits.source, 'remembered');
  t.is(limits.windows[0].usedPercent, 55);
});

test('a source with only observe() is read and never asked for more', async t => {
  const calls = [];
  const source = Far('legacy source', {
    observe: async () => {
      calls.push('observe');
      return reading(12);
    },
  });
  const oracle = await make(makeNamespace({ 'account-source': source }).powers);
  t.is((await E(oracle).getRateLimits()).windows[0].usedPercent, 12);
  await E(oracle).refresh();
  t.deepEqual([...new Set(calls)], ['observe']);
});

test('with nothing bound the oracle says so, and does not throw', async t => {
  const oracle = await make(makeNamespace().powers);
  t.is((await E(oracle).getRateLimits()).source, 'unavailable');
  await E(oracle).refresh();
  const reader = iterateReader(E(oracle).watch());
  t.is((await reader.next()).value.plan.source, 'unavailable');
  await reader.return(undefined);
});

test('a source that does not resolve is no source, not a failure', async t => {
  // What a source formula minted over a broker from before it had an account
  // source looks like from here: the name is there and the lookup rejects.
  const names = new Map([['account-source', 'broken']]);
  const powers = Far('powers', {
    has: async name => names.has(name),
    list: async () => [...names.keys()],
    lookup: async () => {
      throw Error('target has no method "accountSource"');
    },
    storeValue: async () => {},
    remove: async () => {},
  });
  const oracle = await make(powers);
  t.is((await E(oracle).getRateLimits()).source, 'unavailable');
  await t.notThrowsAsync(() => E(oracle).refresh());
});
