// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import { make } from '../agent.js';
import { applyTranscript } from '../src/session-watch.js';

/**
 * A factory over an in-memory host with one hosted session, `one`, whose
 * backend replies with whatever the test pushes into `backendEvents`.
 */
const makeWorld = () => {
  const inbox = makeBufferedReader();
  /** @type {Array<ReturnType<typeof makeBufferedReader>>} */
  const runs = [];
  const store = new Map();
  store.set('user', harden({}));
  const guest = Far('TestGuest', {
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
    followMessages: () => inbox.reader,
  });
  const backend = Far('TestBackend', {
    describe: () =>
      harden({
        id: 'test',
        title: 'Test',
        kind: 'hosted',
        continuity: 'explicit',
        toolOwnership: 'endo',
      }),
    create: async () =>
      harden({
        run: Far('TestRun', {
          send: () => {
            const events = makeBufferedReader();
            runs.push(events);
            return events.reader;
          },
          interrupt: () => undefined,
          acknowledge: () => undefined,
        }),
        admin: Far('TestAdmin', { terminate: () => undefined }),
      }),
    destroy: () => undefined,
  });
  /** @type {Map<string, unknown>} */
  const hostStore = new Map();
  hostStore.set(
    'floot-sessions',
    harden([
      {
        id: 'one',
        title: 'One',
        createdAt: 1,
        presetId: 'general',
        lifecycle: 'ready',
        backendId: 'test',
        modelId: 'm',
      },
    ]),
  );
  hostStore.set('codex-backend', backend);
  const host = Far('TestHost', {
    list: () => harden([...hostStore.keys()]),
    has: name => hostStore.has(name),
    lookup: name => hostStore.get(name),
    provideGuest: (_name, { agentName }) => {
      hostStore.set(agentName, guest);
    },
    storeValue: (value, name) => {
      hostStore.set(name, value);
    },
    remove: name => {
      hostStore.delete(name);
    },
  });
  const factory = make(host);
  const nextRun = async () => {
    for (let tries = 0; runs.length === 0 && tries < 2000; tries += 1) {
      // eslint-disable-next-line no-await-in-loop
      await null;
    }
    const run = runs.shift();
    if (!run) throw Error('the backend was never asked to run a turn');
    return run;
  };
  return { factory, inbox, nextRun, hostStore };
};

/** @param {AsyncIterator<any>} view */
const next = async view => (await view.next()).value;
/**
 * Read events until one of `type` arrives; the others are returned too.
 *
 * @param {AsyncIterator<any>} view
 * @param {string} type
 */
const until = async (view, type) => {
  const seen = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const event = await next(view);
    seen.push(event);
    if (event.type === type) return { event, seen };
  }
};

test('a session view hears a turn start, the transcript it leaves, and then its end', async t => {
  t.timeout(10_000);
  const { factory, inbox, nextRun } = makeWorld();
  t.teardown(async () => {
    inbox.close();
    await E(factory).deleteSession('one');
  });
  const session = await E(factory).getSession('one');
  const view = iterateReader(await E(session).watch());
  const snapshot = await next(view);
  t.is(snapshot.type, 'snapshot');
  t.is(snapshot.turn, null);
  t.deepEqual(snapshot.transcript.append, []);
  t.deepEqual(snapshot.execution, { state: 'running', supported: true });
  let held = applyTranscript(null, snapshot.transcript);

  const turn = await E(session).startTurn('hello');
  const started = await until(view, 'turn');
  t.is(started.event.turn.input, 'hello');
  t.is(started.event.turn.turn, turn, 'the very turn, to watch or cancel');
  t.false('history' in started.event.turn, 'no promise rides the event');

  const run = await nextRun();
  run.push(harden({ type: 'text-delta', text: 'hello back' }));
  run.push(harden({ type: 'end', checkpoint: 'committed' }));

  // Transcript first, then the turn reported gone: the reply never blinks out.
  const ended = await until(view, 'turn');
  t.is(ended.event.turn, null);
  const transcriptEvents = ended.seen.filter(e => e.type === 'transcript');
  t.true(transcriptEvents.length >= 1);
  for (const event of transcriptEvents) {
    held = applyTranscript(held || null, event);
    t.truthy(held, 'every transcript event follows from the last');
  }
  t.deepEqual(held?.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hello back' },
  ]);
  t.deepEqual(
    held?.messages,
    await E(session).getHistory(),
    'what the subscription built is what getHistory reports',
  );
  t.true(
    ended.seen.some(e => e.type === 'journal'),
    'a view showing turn records is told to re-read them',
  );
  await view.return();
});

test('a running turn is absent from the subscribed transcript', async t => {
  t.timeout(10_000);
  const { factory, inbox, nextRun } = makeWorld();
  t.teardown(async () => {
    inbox.close();
    await E(factory).deleteSession('one');
  });
  const session = await E(factory).getSession('one');
  const turn = await E(session).startTurn('in flight');
  const run = await nextRun();
  // getHistory narrates the running turn; a view would show it twice.
  /** @type {unknown[]} */
  const narrated = await E(session).getHistory();
  t.not(narrated.length, 0);
  const view = iterateReader(await E(session).watch());
  const snapshot = await next(view);
  t.deepEqual(snapshot.transcript.append, []);
  t.is(snapshot.turn.turn, turn);
  run.push(harden({ type: 'end', checkpoint: 'committed' }));
  await E(turn).whenFinished();
  await view.return();
});

test('the session list says what each session is doing', async t => {
  t.timeout(10_000);
  const { factory, inbox, nextRun } = makeWorld();
  t.teardown(async () => {
    inbox.close();
    await E(factory)
      .deleteSession('one')
      .catch(() => undefined);
  });
  const list = iterateReader(await E(factory).watchSessions());
  const snapshot = await next(list);
  t.is(snapshot.type, 'snapshot');
  t.is(snapshot.sessions.length, 1);
  t.is(snapshot.sessions[0].id, 'one');
  t.is(snapshot.sessions[0].backendId, 'test');
  t.is(snapshot.sessions[0].modelId, 'm');
  t.is(snapshot.sessions[0].activity, 'passive');

  const session = await E(factory).getSession('one');
  const turn = await E(session).startTurn('hello');
  t.is((await until(list, 'session')).event.session.activity, 'working');
  const run = await nextRun();
  run.push(harden({ type: 'abort', reason: 'backend fell over' }));
  await E(turn).whenFinished();
  // A failed turn leaves the circle on error; it does not pass through passive.
  const after = await until(list, 'session');
  t.is(after.event.session.activity, 'error');

  await E(factory).renameSession('one', 'Renamed');
  t.is((await until(list, 'session')).event.session.title, 'Renamed');

  await E(factory).deleteSession('one');
  const removed = await until(list, 'removed');
  t.is(removed.event.id, 'one');
  await list.return();
});

test('deleting a session ends its views', async t => {
  t.timeout(10_000);
  const { factory, inbox } = makeWorld();
  t.teardown(() => inbox.close());
  const session = await E(factory).getSession('one');
  const view = iterateReader(await E(session).watch());
  await next(view);
  await E(factory).deleteSession('one');
  t.is((await until(view, 'end')).event.type, 'end');
});

test('a turn already in flight is in the snapshot, not in a later event', async t => {
  t.timeout(10_000);
  const { factory, inbox, nextRun } = makeWorld();
  t.teardown(async () => {
    inbox.close();
    await E(factory).deleteSession('one');
  });
  const session = await E(factory).getSession('one');
  // Subscribe and start back to back, as a client would on Send.
  const opening = E(session).watch();
  const turn = await E(session).startTurn('hello');
  const view = iterateReader(await opening);
  const snapshot = await next(view);
  // `startTurn` is delivered synchronously and `watch` reads the slot last,
  // so the turn is already there; a client must look in the snapshot rather
  // than wait for a "turn" event that will not come.
  t.is(snapshot.turn?.turn, turn);
  const run = await nextRun();
  run.push(harden({ type: 'end', checkpoint: 'committed' }));
  t.is((await until(view, 'turn')).event.turn, null);
  await view.return();
});

test('two viewers of one session hear the same things', async t => {
  t.timeout(10_000);
  const { factory, inbox, nextRun } = makeWorld();
  t.teardown(async () => {
    inbox.close();
    await E(factory).deleteSession('one');
  });
  const session = await E(factory).getSession('one');
  const a = iterateReader(await E(session).watch());
  const b = iterateReader(await E(await E(factory).getSession('one')).watch());
  await next(a);
  await next(b);
  const turn = await E(session).startTurn('hello');
  t.is((await until(a, 'turn')).event.turn.turn, turn);
  t.is((await until(b, 'turn')).event.turn.turn, turn);
  const run = await nextRun();
  run.push(harden({ type: 'text-delta', text: 'hi' }));
  run.push(harden({ type: 'end', checkpoint: 'committed' }));
  const fromA = (await until(a, 'transcript')).event;
  const fromB = (await until(b, 'transcript')).event;
  t.deepEqual(fromA, fromB);
  // One leaving does not disturb the other.
  await a.return();
  t.is((await until(b, 'turn')).event.turn, null);
  await b.return();
});

test('a session being made or removed is working, not in error', async t => {
  t.timeout(10_000);
  const { factory, inbox, hostStore } = makeWorld();
  t.teardown(() => inbox.close());
  const registry = /** @type {any[]} */ (hostStore.get('floot-sessions'));
  hostStore.set(
    'floot-sessions',
    harden([
      ...registry,
      { id: 'pinned', title: 'P', createdAt: 2, model: 'vendor/m' },
      { id: 'unpinned', title: 'U', createdAt: 3 },
    ]),
  );
  hostStore.set(
    'llm-provider',
    harden({ provider: 'openrouter', model: 'configured/model' }),
  );
  const sessions = await E(factory).listSessions();
  const byId = Object.fromEntries(sessions.map(entry => [entry.id, entry]));
  t.is(byId.pinned.effectiveModelId, 'vendor/m');
  t.is(byId.one.effectiveModelId, 'm');
  // An unpinned provider session runs what the factory is configured with.
  t.is(byId.unpinned.modelId, '');
  t.is(byId.unpinned.effectiveModelId, 'configured/model');
});
