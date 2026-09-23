// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeBackendCatalog,
  normalizeBackendCatalog,
  normalizeBrokerCatalog,
  recordedPinAnswers,
  revisedPin,
} from '../src/backend-catalog.js';

/**
 * @param {string} id
 * @param {Partial<{ efforts: string[], effort: string | null, isDefault: boolean }>} [options]
 */
const model = (id, { efforts = [], effort = null, isDefault = false } = {}) =>
  harden({
    id,
    title: `Title ${id}`,
    description: '',
    default: isDefault,
    defaultReasoningEffort: effort,
    reasoningEfforts: efforts,
  });

/** @param {string} subscriptionId @param {any[]} models @param {string} [state] */
const account = (subscriptionId, models, state = 'current') =>
  harden({
    subscriptionId,
    state,
    observedAt: state === 'current' || state === 'stale' ? 1 : null,
    models,
  });

test('a catalog is every account the broker holds, labelled, with its models projected by the runtime', async t => {
  const catalog = makeBackendCatalog({
    label: 'Test',
    readCatalog: async subscriptionId =>
      harden({
        accounts: [
          account('work', [
            model('a', { efforts: ['low', 'high'], effort: 'low' }),
            model('skip'),
          ]),
          account('lane', [model('b')]),
          account('quiet', [], 'unsupported'),
        ].filter(
          entry =>
            subscriptionId === undefined ||
            entry.subscriptionId === subscriptionId,
        ),
      }),
    listSubscriptions: async () => [
      { id: 'work', label: 'Work' },
      { id: 'lane', label: 'Lane', pinnedOnly: true },
    ],
    // The runtime spells routes its own way and offers no efforts; one
    // provider model it cannot drive is left out.
    project: entry =>
      entry.id === 'skip'
        ? undefined
        : {
            ...entry,
            id: `runtime/${entry.id}`,
            reasoningEfforts: [],
            defaultReasoningEffort: null,
          },
  });
  t.deepEqual(await catalog.catalog(), {
    accounts: [
      {
        subscriptionId: 'work',
        label: 'Work',
        state: 'current',
        observedAt: 1,
        models: [{ ...model('a'), id: 'runtime/a' }],
      },
      {
        subscriptionId: 'lane',
        label: 'Lane',
        pinnedOnly: true,
        state: 'current',
        observedAt: 1,
        models: [{ ...model('b'), id: 'runtime/b' }],
      },
      {
        subscriptionId: 'quiet',
        state: 'unsupported',
        observedAt: null,
        models: [],
      },
    ],
  });
  t.deepEqual(
    (await catalog.catalog('lane')).accounts.map(entry => entry.subscriptionId),
    ['lane'],
  );
  await t.throwsAsync(() => catalog.catalog('bad id'), {
    message: /Invalid "Test" subscription/,
  });
});

test('a broker that cannot be asked is every declared account unavailable, never an empty success', async t => {
  const catalog = makeBackendCatalog({
    label: 'Test',
    readCatalog: async () => {
      throw Error('broker closed');
    },
    listSubscriptions: async () => [{ id: 'work', label: 'Work' }],
  });
  t.deepEqual(await catalog.catalog(), {
    accounts: [
      {
        subscriptionId: 'work',
        label: 'Work',
        state: 'unavailable',
        observedAt: null,
        models: [],
      },
    ],
  });
  const single = makeBackendCatalog({
    label: 'Test',
    readCatalog: async () => harden({ accounts: 'nonsense' }),
  });
  t.deepEqual(await single.catalog(), {
    accounts: [
      {
        subscriptionId: 'default',
        state: 'unavailable',
        observedAt: null,
        models: [],
      },
    ],
  });
  await t.throwsAsync(() => single.resolve({ model: 'a' }), {
    message: /"Test" model catalog is unavailable/,
  });
});

test('a new pin is admitted by the accounts the session may be served from, with the model’s own efforts', async t => {
  const catalog = makeBackendCatalog({
    label: 'Test',
    readCatalog: async subscriptionId =>
      harden({
        accounts: [
          account('work', [
            model('a', {
              efforts: ['low', 'high'],
              effort: 'high',
              isDefault: true,
            }),
          ]),
          account('home', [model('b')], 'stale'),
          account('lane', [model('c')]),
          account('down', [], 'unavailable'),
        ].filter(
          entry =>
            subscriptionId === undefined ||
            entry.subscriptionId === subscriptionId,
        ),
      }),
    listSubscriptions: async () => [
      { id: 'work', label: 'Work' },
      { id: 'home', label: 'Home' },
      { id: 'lane', label: 'Lane', pinnedOnly: true },
      { id: 'down', label: 'Down' },
    ],
  });
  // `auto`: an effort left empty is the model's default; a stale account
  // still lists what it was seen to have; a lane set aside does not count.
  t.deepEqual(await catalog.resolve({ model: 'a', reasoningEffort: '' }), {
    model: 'a',
    reasoningEffort: 'high',
  });
  t.deepEqual(await catalog.resolve({ model: 'a', reasoningEffort: 'low' }), {
    model: 'a',
    reasoningEffort: 'low',
  });
  t.deepEqual(await catalog.resolve({ model: 'b', subscription: 'auto' }), {
    model: 'b',
  });
  await t.throwsAsync(() => catalog.resolve({ model: 'c' }), {
    message: /Unknown "Test" model "c"/,
  });
  t.deepEqual(await catalog.resolve({ model: 'c', subscription: 'lane' }), {
    model: 'c',
  });
  // No model named: the one the provider marks as its default.
  t.deepEqual(await catalog.resolve({}), {
    model: 'a',
    reasoningEffort: 'high',
  });
  // A pinned subscription is asked and no other, and says why it refuses.
  await t.throwsAsync(
    () => catalog.resolve({ model: 'a', subscription: 'home' }),
    {
      message: /Unknown "Test" model "a"/,
    },
  );
  await t.throwsAsync(
    () => catalog.resolve({ model: 'a', subscription: 'down' }),
    {
      message: /"Test" model catalog is unavailable/,
    },
  );
  await t.throwsAsync(
    () => catalog.resolve({ model: 'a', subscription: 'nobody' }),
    {
      message: /Unknown "Test" subscription/,
    },
  );
  await t.throwsAsync(
    () => catalog.resolve({ model: 'a', reasoningEffort: 'ultra' }),
    {
      message: /Unsupported "Test" reasoning effort "ultra" for "a"/,
    },
  );
  await t.throwsAsync(
    () => catalog.resolve({ model: 'b', reasoningEffort: 'low' }),
    {
      message: /Unsupported "Test" reasoning effort/,
    },
  );
  await t.throwsAsync(() => catalog.resolve({ model: 'x'.repeat(257) }), {
    message: /bounded string/,
  });
});

test('a recorded pin answers a reopen that names it, or nothing; anything else is a new pin', t => {
  const recorded = { model: 'a', reasoningEffort: 'high' };
  t.true(recordedPinAnswers(recorded, {}));
  t.true(recordedPinAnswers(recorded, { model: '', reasoningEffort: '' }));
  t.true(recordedPinAnswers(recorded, { model: 'a', reasoningEffort: 'high' }));
  t.false(recordedPinAnswers(recorded, { model: 'b' }));
  t.false(recordedPinAnswers(recorded, { reasoningEffort: 'low' }));
  // A record that pins nothing answers a reopen that asks for nothing: the
  // session keeps running as it was, and nobody picks a model for it now.
  t.true(recordedPinAnswers({}, {}));
  t.false(recordedPinAnswers({}, { model: 'a' }));
  t.true(recordedPinAnswers({ model: 'a' }, { model: 'a' }));
  t.false(recordedPinAnswers({ model: 'a' }, { reasoningEffort: 'low' }));
});

test('what a broker answers is validated before a backend believes it', t => {
  t.throws(() => normalizeBrokerCatalog({}), {
    message: /Invalid broker model catalog/,
  });
  t.throws(() => normalizeBrokerCatalog({ accounts: [account('a b', [])] }), {
    message: /Invalid broker model catalog account/,
  });
  t.throws(
    () => normalizeBrokerCatalog({ accounts: [account('a', [], 'fresh')] }),
    { message: /Invalid broker model catalog account/ },
  );
  t.throws(
    () =>
      normalizeBrokerCatalog({
        accounts: [account('a', []), account('a', [])],
      }),
    { message: /Duplicate account/ },
  );
  t.throws(
    () =>
      normalizeBrokerCatalog({
        accounts: [account('a', [model('m'), model('m')])],
      }),
    { message: /Duplicate model/ },
  );
  t.deepEqual(normalizeBrokerCatalog({ accounts: [] }), []);
});

test('a request that names no model gets the provider’s marked default, and is refused when it marks none', async t => {
  const unmarked = makeBackendCatalog({
    label: 'Test',
    readCatalog: async () =>
      harden({ accounts: [account('default', [model('a'), model('b')])] }),
  });
  // Nobody picks "the first listed" for a session.
  for (const request of [{}, { model: '' }, { reasoningEffort: '' }]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => unmarked.resolve(request), {
      message: /No "Test" model named, and the account marks no default/,
    });
  }
  t.deepEqual(await unmarked.resolve({ model: 'b' }), { model: 'b' });
});

test('a reopen that changes a pin keeps the recorded model unless it names another', t => {
  const recorded = { model: 'a', reasoningEffort: 'high' };
  // An effort changed on its own is asked for against the recorded model.
  t.deepEqual(revisedPin(recorded, { reasoningEffort: 'low' }), {
    model: 'a',
    reasoningEffort: 'low',
  });
  t.deepEqual(revisedPin(recorded, { model: '', reasoningEffort: 'low' }), {
    model: 'a',
    reasoningEffort: 'low',
  });
  // A named model wins, with what it was asked with and nothing else.
  t.deepEqual(revisedPin(recorded, { model: 'b' }), { model: 'b' });
  // No record, or a record that pins nothing: the request as it came.
  t.deepEqual(revisedPin(undefined, { reasoningEffort: 'low' }), {
    reasoningEffort: 'low',
  });
  t.deepEqual(revisedPin({}, { model: '' }), { model: '' });
  t.deepEqual(revisedPin(recorded, { subscription: 'work' }), {
    model: 'a',
    subscription: 'work',
  });
});

test('a pin to an account the broker does not declare is refused as unknown, not reported as an outage', async t => {
  const catalog = makeBackendCatalog({
    label: 'Test',
    readCatalog: async () => {
      throw Error('broker closed');
    },
    listSubscriptions: async () => [{ id: 'work', label: 'Work' }],
  });
  await t.throwsAsync(() => catalog.catalog('nobody'), {
    message: /Unknown "Test" subscription/,
  });
  await t.throwsAsync(
    () => catalog.resolve({ model: 'a', subscription: 'nobody' }),
    {
      message: /Unknown "Test" subscription/,
    },
  );
  // A declared one that cannot be read is the outage it is.
  await t.throwsAsync(
    () => catalog.resolve({ model: 'a', subscription: 'work' }),
    {
      message: /"Test" model catalog is unavailable/,
    },
  );
  // Over one credential the only account is `default`.
  const single = makeBackendCatalog({
    label: 'Test',
    readCatalog: async () =>
      harden({ accounts: [account('default', [model('a')])] }),
  });
  await t.throwsAsync(() => single.catalog('work'), {
    message: /Unknown "Test" subscription/,
  });
  t.deepEqual(await single.resolve({ model: 'a', subscription: 'default' }), {
    model: 'a',
  });
  // When the broker cannot say what it declares, the read decides.
  const unlisted = makeBackendCatalog({
    label: 'Test',
    readCatalog: async subscriptionId =>
      harden({ accounts: [account(subscriptionId ?? 'work', [model('a')])] }),
    listSubscriptions: async () => {
      throw Error('broker busy');
    },
  });
  t.deepEqual(await unlisted.resolve({ model: 'a', subscription: 'work' }), {
    model: 'a',
  });
});

test('a model the runtime cannot spell is left out; the rest of the account’s list stands', async t => {
  const catalog = makeBackendCatalog({
    label: 'Test',
    readCatalog: async () =>
      harden({ accounts: [account('default', [model('a'), model('odd+id')])] }),
    project: entry => {
      if (entry.id.includes('+')) throw Error('unroutable');
      return entry;
    },
  });
  t.deepEqual(
    (await catalog.catalog()).accounts.map(entry =>
      entry.models.map(m => m.id),
    ),
    [['a']],
  );
  await t.throwsAsync(() => catalog.resolve({ model: 'odd+id' }), {
    message: /Unknown "Test" model "odd\+id"/,
  });
  // A projection whose answer is not a descriptor is left out the same way.
  const broken = makeBackendCatalog({
    label: 'Test',
    readCatalog: async () =>
      harden({ accounts: [account('default', [model('a'), model('b')])] }),
    project: entry => (entry.id === 'b' ? { id: 'b' } : entry),
  });
  t.deepEqual(
    (await broken.catalog()).accounts.map(entry => entry.models.map(m => m.id)),
    [['a']],
  );
});

test('what a session is offered is its own account’s list: the pinned one’s, or the union of those not set aside', async t => {
  const catalog = makeBackendCatalog({
    label: 'Test',
    readCatalog: async subscriptionId =>
      harden({
        accounts: [
          account('work', [model('a'), model('shared')]),
          account('home', [model('b'), model('shared')], 'stale'),
          account('lane', [model('c')]),
          account('down', [], 'unavailable'),
        ].filter(
          entry =>
            subscriptionId === undefined ||
            entry.subscriptionId === subscriptionId,
        ),
      }),
    listSubscriptions: async () => [
      { id: 'work', label: 'Work' },
      { id: 'home', label: 'Home' },
      { id: 'lane', label: 'Lane', pinnedOnly: true },
      { id: 'down', label: 'Down' },
    ],
  });
  const ids = async subscription =>
    (await catalog.offered(subscription)).map(entry => entry.id);
  t.deepEqual(await ids(), ['a', 'shared', 'b']);
  t.deepEqual(await ids('auto'), ['a', 'shared', 'b']);
  t.deepEqual(await ids('home'), ['b', 'shared']);
  // A lane lists to the session pinned to it, and to no other.
  t.deepEqual(await ids('lane'), ['c']);
  t.deepEqual(await ids('down'), []);
  await t.throwsAsync(() => ids('nobody'), {
    message: /Unknown "Test" subscription/,
  });
});

test('what a backend answers is validated before Floot believes it, labels and lanes included', t => {
  const good = {
    accounts: [
      { ...account('work', [model('a')]), label: 'Work', pinnedOnly: false },
      { ...account('lane', [model('b')]), label: 'Lane', pinnedOnly: true },
      account('plain', []),
    ],
  };
  t.deepEqual(
    normalizeBackendCatalog(good).map(
      ({ subscriptionId, label, pinnedOnly }) => ({
        subscriptionId,
        label,
        pinnedOnly,
      }),
    ),
    [
      { subscriptionId: 'work', label: 'Work', pinnedOnly: undefined },
      { subscriptionId: 'lane', label: 'Lane', pinnedOnly: true },
      { subscriptionId: 'plain', label: undefined, pinnedOnly: undefined },
    ],
  );
  t.throws(() => normalizeBackendCatalog({}), {
    message: /Invalid backend model catalog/,
  });
  t.throws(() => normalizeBackendCatalog({ accounts: [null] }), {
    message: /Invalid backend model catalog account/,
  });
  for (const label of ['', 'x'.repeat(129), 7]) {
    t.throws(
      () =>
        normalizeBackendCatalog({ accounts: [{ ...account('a', []), label }] }),
      { message: /Invalid backend model catalog label/ },
    );
  }
  t.throws(
    () =>
      normalizeBackendCatalog({
        accounts: [{ ...account('a', []), pinnedOnly: 'yes' }],
      }),
    { message: /Invalid backend model catalog lane marking/ },
  );
  // The broker's own rules still apply beneath the labels.
  t.throws(
    () =>
      normalizeBackendCatalog({
        accounts: [{ ...account('a b', []), label: 'X' }],
      }),
    { message: /Invalid broker model catalog account/ },
  );
});

test('the read says which accounts are lanes, so an `auto` pin is refused a lane-only model even when the declared set cannot be listed', async t => {
  const catalog = makeBackendCatalog({
    label: 'Test',
    readCatalog: async () =>
      harden({
        accounts: [
          account('work', [model('a')]),
          { ...account('lane', [model('c')]), pinnedOnly: true },
        ],
      }),
    listSubscriptions: async () => {
      throw Error('broker busy');
    },
  });
  t.deepEqual(
    (await catalog.catalog()).accounts.map(entry => [
      entry.subscriptionId,
      entry.pinnedOnly === true,
    ]),
    [
      ['work', false],
      ['lane', true],
    ],
  );
  await t.throwsAsync(() => catalog.resolve({ model: 'c' }), {
    message: /Unknown "Test" model "c"/,
  });
  t.deepEqual(await catalog.resolve({ model: 'c', subscription: 'lane' }), {
    model: 'c',
  });
  t.deepEqual(
    (await catalog.offered()).map(entry => entry.id),
    ['a'],
  );
  // Every account set aside: an automatic session is told so, not that a
  // subscription it never named is unknown.
  const lanes = makeBackendCatalog({
    label: 'Test',
    readCatalog: async () =>
      harden({
        accounts: [{ ...account('lane', [model('c')]), pinnedOnly: true }],
      }),
  });
  await t.throwsAsync(() => lanes.resolve({ model: 'c' }), {
    message: /No "Test" account serves an automatic session/,
  });
  // A lane marking of the wrong shape is refused with the account.
  t.throws(
    () =>
      normalizeBrokerCatalog({
        accounts: [{ ...account('a', []), pinnedOnly: 'yes' }],
      }),
    { message: /Invalid broker model catalog account/ },
  );
});

test('a catalog carries the account authority its broker serves beside the pinnable accounts', async t => {
  const catalog = makeBackendCatalog({
    label: 'Test',
    authority: 'authority-a',
    readCatalog: async () => harden({ accounts: [account('default', [])] }),
  });
  const snapshot = await catalog.catalog();
  t.is(snapshot.authority, 'authority-a');
  t.deepEqual(
    snapshot.accounts.map(entry => entry.subscriptionId),
    ['default'],
  );
  t.throws(
    () =>
      makeBackendCatalog({
        label: 'Test',
        authority: 'not an id',
        readCatalog: async () => harden({ accounts: [] }),
      }),
    { message: /Test account authority must be an id/ },
  );
});
