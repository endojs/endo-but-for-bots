// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { admitsModels } from './admits-models.js';

import {
  DEFAULT_CATALOG_LIFETIME_MS,
  DEFAULT_CATALOG_MAX_AGE_MS,
  makeModelCatalogOwner,
  normalizeCatalogObservation,
} from '../src/model-catalog.js';

/** @param {string[]} ids */
const listing = ids =>
  harden({
    observedAt: 5,
    models: ids.map(id => ({
      id,
      title: id,
      description: '',
      default: false,
      defaultReasoningEffort: null,
      reasoningEfforts: [],
    })),
  });

const LIFETIME = 1000;

test('descriptor output metadata is optional positive uint32 without a context relation', t => {
  const base = listing(['route']).models[0];
  for (const output of [1, 4096, 0xffff_ffff]) {
    const normalized = normalizeCatalogObservation({
      observedAt: 5,
      models: [{ ...base, contextLength: 1, maxOutputTokens: output }],
    });
    t.is(normalized.models[0].maxOutputTokens, output);
  }
  t.false(
    Object.hasOwn(
      normalizeCatalogObservation(listing(['route'])).models[0],
      'maxOutputTokens',
    ),
  );
  t.false(
    Object.hasOwn(
      normalizeCatalogObservation({
        observedAt: 5,
        models: [{ ...base, maxOutputTokens: null }],
      }).models[0],
      'maxOutputTokens',
    ),
  );
  for (const output of [0, -1, 1.5, '4096', 0x1_0000_0000]) {
    t.throws(() =>
      normalizeCatalogObservation({
        observedAt: 5,
        models: [{ ...base, maxOutputTokens: output }],
      }),
    );
  }
});
const MAX_AGE = 10_000;
const RETRY = 100;

/**
 * A scripted provider: each read takes the next answer, a listing or an
 * Error, and can be held until released.
 *
 * @param {Array<string[] | Error>} answers
 */
const scripted = answers => {
  let clock = 0;
  const reads = [];
  /** @type {Array<() => void>} */
  const held = [];
  let hold = false;
  const owner = makeModelCatalogOwner({
    read: async () => {
      reads.push(clock);
      if (hold) {
        await new Promise(resolve => {
          held.push(() => resolve(undefined));
        });
      }
      const next = answers.shift();
      if (next === undefined) throw Error('script exhausted');
      if (next instanceof Error) throw next;
      return listing(next);
    },
    now: () => clock,
    lifetimeMs: LIFETIME,
    maxAgeMs: MAX_AGE,
    retryMs: RETRY,
  });
  return {
    owner,
    reads,
    advance: (/** @type {number} */ ms) => {
      clock += ms;
    },
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      for (const resolve of held.splice(0)) resolve();
    },
  };
};

test('an account without discovery admits nothing and says so', async t => {
  const owner = makeModelCatalogOwner({ read: undefined });
  t.deepEqual(await owner.snapshot(), {
    state: 'unsupported',
    observedAt: null,
    models: [],
  });
  t.false(await owner.admits('anything'));
  t.deepEqual(owner.peek().state, 'unsupported');
  t.is(DEFAULT_CATALOG_LIFETIME_MS, 15 * 60_000);
  t.is(DEFAULT_CATALOG_MAX_AGE_MS, 24 * 60 * 60_000);
});

test('a read is current for its lifetime and shared by everybody who asks meanwhile', async t => {
  const f = scripted([['a', 'b'], ['a']]);
  f.hold();
  const first = f.owner.snapshot();
  const admitted = f.owner.admits('b');
  const refused = f.owner.admits('c');
  await null;
  t.deepEqual(f.reads, [0], 'one read in flight answers all three');
  f.release();
  t.like(await first, { state: 'current', observedAt: 5 });
  t.is((await first).models.length, 2);
  t.true(await admitted);
  t.false(await refused);
  f.advance(LIFETIME - 1);
  t.is((await f.owner.snapshot()).state, 'current');
  t.true(await f.owner.admits('b'));
  t.deepEqual(f.reads, [0], 'nothing was read again within the lifetime');
  // Past the lifetime a snapshot reads again and shows the provider's
  // current answer, which no longer lists `b`.
  f.advance(1);
  t.deepEqual(
    (await f.owner.snapshot()).models.map(model => model.id),
    ['a'],
  );
  t.deepEqual(f.reads, [0, LIFETIME]);
  t.false(await f.owner.admits('b'));
});

test('admission answers from what is held and refreshes in the background past the lifetime', async t => {
  const f = scripted([['a'], ['b']]);
  t.true(await f.owner.admits('a'));
  f.advance(LIFETIME);
  f.hold();
  // Answered at once from the observation held, while the provider is asked
  // again behind it; a turn is not held behind the catalog endpoint.
  t.true(await f.owner.admits('a'));
  t.deepEqual(f.reads, [0, LIFETIME]);
  t.is(f.owner.peek().state, 'stale');
  f.release();
  await f.owner.snapshot();
  t.false(await f.owner.admits('a'));
  t.true(await f.owner.admits('b'));
  t.is(f.owner.peek().state, 'current');
});

test('a failed read keeps the last observation as stale until the maximum age, then admits nothing', async t => {
  const f = scripted([
    ['a'],
    Error('provider down'),
    Error('still down'),
    Error('and again'),
  ]);
  t.true(await f.owner.admits('a'));
  f.advance(LIFETIME);
  t.deepEqual(await f.owner.snapshot(), {
    state: 'stale',
    observedAt: 5,
    models: listing(['a']).models,
  });
  // Trusted for admission while stale: the provider's catalog endpoint being
  // down does not stop turns on a model the account was seen to have.
  t.true(await f.owner.admits('a'));
  t.false(await f.owner.admits('b'));
  // Not asked again at once after a failure.
  await f.owner.snapshot();
  t.deepEqual(f.reads, [0, LIFETIME]);
  f.advance(RETRY);
  await f.owner.snapshot();
  t.deepEqual(f.reads, [0, LIFETIME, LIFETIME + RETRY]);
  // Past the maximum age nothing is admitted, however the provider fares.
  f.advance(MAX_AGE);
  t.false(await f.owner.admits('a'));
  t.deepEqual(await f.owner.snapshot(), {
    state: 'unavailable',
    observedAt: null,
    models: [],
  });
});

test('an invalid or oversized provider answer is never adopted', async t => {
  const f = scripted([['a']]);
  await f.owner.snapshot();
  const invalid = makeModelCatalogOwner({
    read: async () =>
      harden({
        observedAt: 1,
        models: [listing(['x']).models[0], listing(['x']).models[0]],
      }),
    now: () => 0,
  });
  t.is((await invalid.snapshot()).state, 'unavailable');
  t.false(await invalid.admits('x'));
  t.throws(() => normalizeCatalogObservation({ observedAt: -1, models: [] }), {
    message: /Invalid provider model catalog/,
  });
  t.throws(
    () =>
      normalizeCatalogObservation({
        observedAt: 1,
        models: Array.from({ length: 4097 }, (_, index) => ({
          ...listing(['m']).models[0],
          id: `m${index}`,
        })),
      }),
    { message: /Invalid provider model catalog/ },
  );
  t.throws(
    () => makeModelCatalogOwner({ read: async () => {}, lifetimeMs: 0 }),
    {
      message: /Invalid model catalog lifetimes/,
    },
  );
  t.throws(
    () =>
      makeModelCatalogOwner({
        read: async () => {},
        lifetimeMs: 10,
        maxAgeMs: 5,
      }),
    { message: /Invalid model catalog lifetimes/ },
  );
});

test('a closed owner admits nothing, reports unavailable, and waits for a read in flight', async t => {
  const f = scripted([['a'], ['a']]);
  t.true(await f.owner.admits('a'));
  f.advance(LIFETIME);
  f.hold();
  const reading = f.owner.snapshot();
  await null;
  let closed = false;
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  await null;
  await null;
  t.false(closed, 'closing waits for the admitted read');
  f.release();
  await closing;
  t.true(closed);
  t.deepEqual(await reading, {
    state: 'unavailable',
    observedAt: null,
    models: [],
  });
  t.false(await f.owner.admits('a'));
  t.deepEqual(f.reads, [0, LIFETIME], 'nothing is read after close');
});

test('a fixed list admits exactly its members, for a test of the grant', async t => {
  const admits = admitsModels(['a', 'b']);
  t.true(await admits('a'));
  t.false(await admits('c'));
});
