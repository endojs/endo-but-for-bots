// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { Far } from '@endo/far';

import { make } from '../agent.js';

/**
 * A factory over an in-memory host with one hosted backend, which records the
 * spec of every session it is asked to create: `spec.systemPrompt` is the
 * prompt a hosted model actually runs under.
 *
 * @param {{
 *   promptEnvironment?: object,
 *   subscriptions?: object[],
 *   listing?: (subscriptionId: string) => Array<string | { id: string, title: string }>,
 * }} [options]
 */
const makeWorld = ({ promptEnvironment, subscriptions, listing } = {}) => {
  // What the backend declares now; an operator can change it under a session.
  let declared = subscriptions;
  // Whether the backend's accounts can be read now.
  const knobs = { catalogDown: false };
  /** @type {Array<ReturnType<typeof makeBufferedReader>>} */
  const inboxes = [];
  /** @type {Array<Record<string, any>>} */
  const specs = [];
  /**
   * What the model does during its next turn: an Endo tool may only be called
   * from inside one.
   *
   * @type {((toolSet: any) => Promise<void>) | undefined}
   */
  let duringNextTurn;
  const makeGuest = () => {
    const store = new Map([['user', harden({})]]);
    return Far('PromptGuest', {
      has: name => store.has(name),
      lookup: name => store.get(name),
      storeValue: (value, name) => {
        store.set(name, value);
      },
      remove: name => {
        store.delete(name);
      },
      list: prefix => harden(prefix === 'tools' ? [] : [...store.keys()]),
      locate: () => 'test-locator',
      followMessages: () => {
        const inbox = makeBufferedReader();
        inboxes.push(inbox);
        return inbox.reader;
      },
    });
  };
  const backend = Far('PromptBackend', {
    describe: () =>
      harden({
        id: 'test',
        title: 'Test',
        kind: 'hosted',
        continuity: 'explicit',
        toolOwnership: 'endo',
        ...(promptEnvironment ? { promptEnvironment } : {}),
        ...(declared ? { providerId: 'test', subscriptions: declared } : {}),
      }),
    // Each declared subscription is an account that lists the one model,
    // or what `listing` says it lists.
    modelCatalog: subscriptionId => {
      if (knobs.catalogDown) throw Error('provider catalog down');
      return harden({
        accounts: (declared ?? [{ id: 'default' }])
          .filter(
            entry =>
              subscriptionId === undefined || entry.id === subscriptionId,
          )
          .map(entry => ({
            subscriptionId: entry.id,
            state: 'current',
            observedAt: 1,
            models: (listing ? listing(entry.id) : ['m']).map(entry => {
              const { id, title } =
                typeof entry === 'string'
                  ? { id: entry, title: `Model ${entry}` }
                  : entry;
              return {
                id,
                title,
                description: '',
                default: id === 'm',
                defaultReasoningEffort: null,
                reasoningEfforts: [],
              };
            }),
          })),
      });
    },
    create: async (spec, toolSet) => {
      specs.push(spec);
      return harden({
        run: Far('PromptRun', {
          send: async () => {
            const events = makeBufferedReader();
            const act = duringNextTurn;
            duringNextTurn = undefined;
            if (act) await act(toolSet);
            events.push({ type: 'text-delta', text: 'ok' });
            events.push({ type: 'end' });
            return events.reader;
          },
          interrupt: () => undefined,
          acknowledge: () => undefined,
        }),
        admin: Far('PromptAdmin', { terminate: () => undefined }),
      });
    },
    destroy: () => undefined,
    stop: () => undefined,
  });
  /** @type {Map<string, unknown>} */
  const hostStore = new Map([['codex-backend', backend]]);
  const host = Far('PromptHost', {
    list: () => harden([...hostStore.keys()]),
    has: name => hostStore.has(name),
    lookup: name => hostStore.get(name),
    locate: name => `locator:${name}`,
    copy: () => undefined,
    provideGuest: (_name, { agentName }) => {
      hostStore.set(agentName, makeGuest());
    },
    storeValue: (value, name) => {
      hostStore.set(name, value);
    },
    remove: name => {
      hostStore.delete(name);
    },
  });
  const factory = make(host);
  /**
   * The prompt the backend was given for a session, once a turn has run.
   * @param session
   */
  const promptOf = async session => {
    const { id } = await E(session).getInfo();
    const turn = await E(session).startTurn('hello');
    await E(turn).whenFinished();
    const spec = specs.find(candidate => candidate.sessionId === id);
    if (!spec) throw Error(`the backend never created session ${id}`);
    return `${spec.systemPrompt}`;
  };
  const close = async () => {
    for (const { id } of await E(factory).listSessions()) {
      // eslint-disable-next-line no-await-in-loop
      await E(factory)
        .deleteSession(id)
        .catch(() => undefined);
    }
    for (const inbox of inboxes) inbox.close();
  };
  return {
    factory,
    knobs,
    declare: next => {
      declared = next;
    },
    /** The daemon restarts: a new factory over what the old one stored. */
    restart: () => make(host),
    hostStore,
    specs,
    promptOf,
    close,
    duringNextTurn: act => {
      duringNextTurn = act;
    },
  };
};

const hosted = harden({ backendId: 'test', modelId: 'm' });
const subscriptions = harden([
  { id: 'work', label: 'Work Pro' },
  { id: 'home', label: 'Home Plus' },
]);

test('a session pinned to a subscription says so, and the backend is told', async t => {
  t.timeout(10_000);
  const world = makeWorld({ subscriptions });
  t.teardown(world.close);
  const backends = await E(world.factory).listBackends();
  const described = backends.find(backend => backend.id === 'test');
  t.is(described.providerId, 'test');
  t.deepEqual(described.subscriptions, subscriptions);

  const pinned = await E(world.factory).createSession({
    ...hosted,
    subscription: 'home',
  });
  t.is((await E(pinned).getInfo()).subscription, 'home');
  await world.promptOf(pinned);
  const { id } = await E(pinned).getInfo();
  t.is(world.specs.find(spec => spec.sessionId === id).subscription, 'home');
  const listed = (await E(world.factory).listSessions()).find(
    session => session.id === id,
  );
  t.is(listed.subscription, 'home');
});

test('auto is the default, and a backend is never sent a field it did not ask for', async t => {
  t.timeout(10_000);
  const world = makeWorld({ subscriptions });
  t.teardown(world.close);
  for (const options of [hosted, { ...hosted, subscription: 'auto' }]) {
    // eslint-disable-next-line no-await-in-loop
    const session = await E(world.factory).createSession(options);
    // eslint-disable-next-line no-await-in-loop
    t.is((await E(session).getInfo()).subscription, 'auto');
    // eslint-disable-next-line no-await-in-loop
    await world.promptOf(session);
    // eslint-disable-next-line no-await-in-loop
    const { id } = await E(session).getInfo();
    t.false('subscription' in world.specs.find(spec => spec.sessionId === id));
  }
});

test('a subscription the backend does not declare is refused at creation', async t => {
  t.timeout(10_000);
  const withSet = makeWorld({ subscriptions });
  t.teardown(withSet.close);
  await t.throwsAsync(
    E(withSet.factory).createSession({ ...hosted, subscription: 'spare' }),
    { message: /Unknown subscription "spare" for backend "test"/ },
  );
  // A backend over one credential declares none.
  const single = makeWorld();
  t.teardown(single.close);
  await t.throwsAsync(
    E(single.factory).createSession({ ...hosted, subscription: 'work' }),
    { message: /Unknown subscription "work"/ },
  );
  t.is((await E(withSet.factory).listSessions()).length, 0);
});

test('a session pinned to a subscription that was since removed still runs, on the backend’s choice', async t => {
  t.timeout(10_000);
  const world = makeWorld({ subscriptions });
  t.teardown(world.close);
  const pinned = await E(world.factory).createSession({
    ...hosted,
    subscription: 'home',
  });
  const { id } = await E(pinned).getInfo();
  // The operator drops `home`, and the daemon restarts: the session's agent
  // is built again, against a backend that no longer declares its pin.
  world.declare(harden([{ id: 'work', label: 'Work Pro' }]));
  const before = world.specs.length;
  const revived = await E(world.restart()).getSession(id);
  const turn = await E(revived).startTurn('hello');
  await E(turn).whenFinished();
  const rebuilt = world.specs
    .slice(before)
    .filter(spec => spec.sessionId === id);
  t.true(rebuilt.length > 0);
  // The backend would refuse an id it does not declare, and the session would
  // never run again; it is sent nothing, and still says what it was pinned to.
  t.true(rebuilt.every(spec => !('subscription' in spec)));
  t.is((await E(revived).getInfo()).subscription, 'home');
});

test('a hosted pin is admitted by what the session’s account lists now; missing discovery refuses and says so', async t => {
  t.timeout(10_000);
  // `work` lists a model of its own beside the shared one; `home` does not.
  const world = makeWorld({
    subscriptions,
    listing: id => (id === 'work' ? ['m', 'w'] : ['m']),
  });
  t.teardown(world.close);
  const rows = await E(world.factory).listModels('test');
  t.deepEqual(
    rows.map(row => [row.modelId, row.subscriptionIds]),
    [
      ['m', ['work', 'home']],
      ['w', ['work']],
    ],
  );
  // Under `auto`, what any account lists; pinned, only that account's.
  const onWork = await E(world.factory).createSession({
    ...hosted,
    modelId: 'w',
    subscription: 'work',
  });
  t.is((await E(onWork).getInfo()).modelId, 'w');
  const onAny = await E(world.factory).createSession({ ...hosted, modelId: 'w' });
  t.is((await E(onAny).getInfo()).modelId, 'w');
  await t.throwsAsync(
    E(world.factory).createSession({
      ...hosted,
      modelId: 'w',
      subscription: 'home',
    }),
    { message: /Unknown model "w" for backend "test"/ },
  );
  await t.throwsAsync(
    E(world.factory).createSession({ ...hosted, modelId: 'zzz' }),
    { message: /Unknown model "zzz" for backend "test"/ },
  );
  // The backend cannot be read: every account is said to be unavailable,
  // nothing is offered from it, and no pin is admitted — nor any other
  // model put in its place.
  world.knobs.catalogDown = true;
  t.deepEqual(
    (await E(world.factory).listModelCatalogs())
      .filter(catalog => catalog.backendId === 'test')
      .map(catalog =>
        catalog.accounts.map(account => [
          account.subscriptionId,
          account.state,
        ]),
      ),
    [
      [
        ['work', 'unavailable'],
        ['home', 'unavailable'],
      ],
    ],
  );
  t.deepEqual(await E(world.factory).listModels('test'), []);
  await t.throwsAsync(E(world.factory).createSession(hosted), {
    message: /Model catalog unavailable for backend "test"; no model can be admitted now/,
  });
  t.is((await E(world.factory).listSessions()).length, 2);
});

test('a backend’s rows come in the picker’s order: the marked default first, then by title, then by id', async t => {
  t.timeout(10_000);
  // The provider lists in an order of its own; `m` is the one it marks.
  // Titles are not ids: `zeta` is titled first alphabetically, two models
  // share a title and one differs from another only by case.
  const world = makeWorld({
    subscriptions,
    listing: () => [
      { id: 'zeta', title: 'Aardvark' },
      { id: 'beta-2', title: 'Beta' },
      'm',
      { id: 'alpha', title: 'beta' },
      { id: 'beta-1', title: 'Beta' },
    ],
  });
  t.teardown(world.close);
  const rows = await E(world.factory).listModels('test');
  t.deepEqual(
    rows.map(row => row.modelId),
    ['m', 'zeta', 'beta-1', 'beta-2', 'alpha'],
  );
  t.true(rows[0].default);
  // The flattened listing keeps each backend's order, though it marks no
  // hosted row as the default.
  const all = await E(world.factory).listModels();
  t.deepEqual(
    all.filter(row => row.backendId === 'test').map(row => row.modelId),
    ['m', 'zeta', 'beta-1', 'beta-2', 'alpha'],
  );
  t.true(all.every(row => !row.default));
});
