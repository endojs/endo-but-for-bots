// @ts-check
/* eslint-disable import/no-relative-packages */
// The UI controller (m3-interfaces.md 9.1, 9.2; W3.4) against the fake
// GatewayPowers: rebuild, live list, the conversation view, re-attach, rev
// gaps, exactly-once drafts, the addon chain, records kept as received.
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/far';

import { makeController } from '../../ui/src/controller/index.js';
import { DRAFT_PREFIX } from '../../ui/src/controller/drafts.js';
import {
  uiTexts,
  uiTextOf,
} from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { makeFakePowers } from './_m3-fake-powers.js';

/** Let eventual sends and pumps run. */
const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

const makeStorage = () => {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    map,
    /** @param {string} key */
    getItem: key =>
      map.has(key) ? /** @type {string} */ (map.get(key)) : null,
    /** @param {string} key @param {string} value */
    setItem: (key, value) => {
      map.set(key, value);
    },
    /** @param {string} key */
    removeItem: key => {
      map.delete(key);
    },
    /** @param {number} index */
    key: index => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
};

const makeLocks = () => {
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();
  /** @type {string[]} */
  const names = [];
  return {
    names,
    /**
     * @param {string} name
     * @param {() => Promise<any>} callback
     */
    request: (name, callback) => {
      names.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      const run = previous.then(callback, callback);
      tails.set(
        name,
        run.catch(() => {}),
      );
      return run;
    },
  };
};

/**
 * @param {Parameters<typeof makeFakePowers>[0]} fakeOptions
 * @param {Partial<Parameters<typeof makeController>[0]>} [options]
 */
const setup = async (fakeOptions, options = {}) => {
  const fake = makeFakePowers(fakeOptions);
  const storage = makeStorage();
  const locks = makeLocks();
  let id = 0;
  const controller = makeController({
    storage,
    locks,
    now: () => 1_800_000_000_000,
    makeRequestId: () => {
      id += 1;
      return `req${id}`;
    },
    ...options,
  });
  await controller.attach(fake.powers);
  await flush();
  return { ...fake, controller, storage, locks };
};

test('attach rebuilds sessions, presets (describe availability) and backends', async t => {
  const unavailable = {
    describe: async () => ({
      label: 'tools',
      builtIn: false,
      available: false,
      unavailableReason: 'needs an account',
    }),
  };
  const failing = {
    describe: async () => {
      throw Error('preset broke');
    },
  };
  const plain = {
    describe: async () => ({ label: 'chat-only', builtIn: true }),
  };
  const { controller } = await setup({
    sessions: [{ title: 'one' }, { title: 'two', effort: 'high' }],
    presets: [plain, unavailable, failing],
  });
  const state = controller.getState();
  t.is(state.connection, 'open');
  t.deepEqual(
    state.sessions.map(row => [row.key, row.title, row.state, row.effort]),
    [
      ['s1', 'one', 'ready', undefined],
      ['s2', 'two', 'ready', 'high'],
    ],
  );
  t.false('session' in state.sessions[0], 'rows carry no presence');
  t.deepEqual(state.presets, [
    { index: 0, label: 'chat-only', available: true },
    {
      index: 1,
      label: 'tools',
      available: false,
      unavailableReason: 'needs an account',
    },
    {
      index: 2,
      label: '',
      available: false,
      unavailableReason: uiTextOf.statusError('preset broke'),
    },
  ]);
  t.deepEqual(state.backends, [
    { index: 0, label: 'Scripted', kind: 'scripted' },
  ]);
});

test('every listSessions page is read; the list feed inserts, renames and removes', async t => {
  const { controller, control } = await setup({ sessions: 120 });
  t.is(controller.getState().sessions.length, 120);
  t.is(control.callsOf('SessionFactory', 'listSessions').length, 3);
  control.addSession({ title: 'fresh' });
  await flush();
  t.is(controller.getState().sessions.at(-1)?.title, 'fresh');
  control.patchRow('s2', { title: 'renamed' });
  await flush();
  t.is(controller.getState().sessions[1].title, 'renamed');
  control.removeSession('s3');
  await flush();
  t.false(controller.getState().sessions.some(row => row.key === 's3'));
});

test('a closed list subscription reloads the list and subscribes again', async t => {
  const { controller, control } = await setup({ sessions: 2 });
  control.closeSubscriptions(undefined);
  await flush();
  t.is(control.callsOf('Live', 'subscribeList').length, 2);
  t.is(control.callsOf('SessionFactory', 'listSessions').length, 2);
  control.addSession({ title: 'after' });
  await flush();
  t.is(controller.getState().sessions.length, 3);
});

test('selectSession opens the view; a sent message streams and settles', async t => {
  const { controller, control } = await setup({
    sessions: [{ turns: 3 }],
    script: [{ chunks: ['Hel', 'lo'], final: 'Hello' }],
  });
  await controller.selectSession('s1');
  await flush();
  let view = controller.getState().view;
  t.truthy(view);
  if (!view) return;
  t.is(view.messages.length, 3);
  t.deepEqual(
    view.messages.map(entry => entry.record.input),
    ['message 1', 'message 2', 'message 3'],
  );
  t.is(view.earlier, 'none');
  controller.setInput('hi there');
  const receipt = await controller.send('hi there');
  t.is(receipt.state, 'started');
  await flush();
  view = controller.getState().view;
  if (!view) return;
  t.true(view.busy);
  t.is(view.input.text, '', 'the input is cleared on the receipt');
  control.delta('s1', 'Hel');
  control.delta('s1', 'lo');
  await flush();
  t.is(controller.getState().view?.streamingText, 'Hello');
  control.finish('s1', { final: 'Hello' });
  await flush();
  view = controller.getState().view;
  if (!view) return;
  t.false(view.busy);
  t.is(view.current?.state, 'completed');
  const last = view.messages.at(-1);
  t.is(last?.state, 'completed');
  t.is(last?.record.type, 'turn-start', 'a live turn keeps its live record');
  t.deepEqual(last?.fold?.messages, [{ role: 'assistant', text: 'Hello' }]);
  t.is(view.usage.turns, 4);
  // M3-FIX (acceptance 8): the settled turn's records are re-read, so a
  // long reply's staged text can be expanded without a reload.
  await flush();
  const settled = controller.getState().view?.messages.at(-1);
  t.true(
    (settled?.records ?? []).some(
      (/** @type {any} */ record) => record.kind === 'turn-settled',
    ),
  );
  t.is(settled?.record.type, 'turn-start', 'the live record is kept');
  t.truthy(settled?.fold, 'and the fold');
});

test('re-attach: a reconnect rebuilds the view, the running turn and Stop', async t => {
  const fake = makeFakePowers({
    sessions: [{ turns: 1, running: 'long job' }],
  });
  const controller = makeController({
    storage: makeStorage(),
    locks: makeLocks(),
  });
  await controller.attach(fake.powers);
  await controller.selectSession('s1');
  await flush();
  fake.control.delta('s1', 'part one ');
  await flush();
  t.is(controller.getState().view?.streamingText, 'part one ');
  controller.setInput('unsent words', 3);
  // the socket drops; the connection layer reports it, then attaches again
  controller.setConnection('reconnecting');
  t.is(controller.getState().connection, 'reconnecting');
  fake.control.delta('s1', 'part two');
  await controller.attach(fake.powers);
  await flush();
  const view = controller.getState().view;
  t.is(controller.getState().connection, 'open');
  t.is(controller.getState().activeKey, 's1');
  t.is(
    view?.streamingText,
    'part one part two',
    'the snapshot carries the fold',
  );
  t.true(view?.busy);
  t.deepEqual(view?.input, { text: 'unsent words', caret: 3 });
  t.is(fake.control.callsOf('Session', 'getCurrentTurn').length, 2);
  await controller.stop();
  t.is(fake.control.callsOf('Turn', 'cancel').length, 1);
  await flush();
  t.is(controller.getState().view?.current?.state, 'cancelled');
});

test('a rev gap re-watches; a closed batch re-watches and subscribes again', async t => {
  const { controller, control } = await setup({ sessions: [{}] });
  await controller.selectSession('s1');
  await flush();
  const watches = () => control.callsOf('Session', 'watch').length;
  t.is(watches(), 1);
  control.skipRev('s1');
  control.setHold('s1', { reason: 'restart', message: 'held after restart' });
  await flush();
  t.is(watches(), 2);
  t.is(controller.getState().view?.hold?.reason, 'restart');
  control.closeSubscriptions('s1');
  await flush();
  t.is(watches(), 3);
  t.is(control.callsOf('Live', 'subscribe').length, 2);
  t.is(control.subscriberCount('s1'), 1);
});

test('records and events are kept as received (unknown fields reach renderers)', async t => {
  const { controller, control } = await setup({ sessions: [{}] });
  await controller.selectSession('s1');
  await flush();
  control.publish('s1', [
    {
      type: 'turn-start',
      turnId: 'tx',
      input: 'with chips',
      at: 1_800_000_000_500,
      attachments: [{ label: 'file' }],
    },
  ]);
  await flush();
  const entry = controller.getState().view?.messages.at(-1);
  t.is(entry?.turnId, 'tx');
  t.deepEqual(entry?.record.attachments, [{ label: 'file' }]);
});

test('exactly once: draft first, kept on a rejection, request id reused, cleared on receipt', async t => {
  const { controller, control, storage, locks } = await setup({
    sessions: [{}],
  });
  await controller.selectSession('s1');
  await flush();
  control.failNext('Composer', 'submit', Error('link down'));
  controller.setInput('first try');
  await controller.send('first try');
  let view = controller.getState().view;
  t.is(view?.sendError, uiTextOf.statusError('link down'));
  t.is(view?.input.text, 'first try', 'the composer text is left as it was');
  const saved = JSON.parse(storage.map.get(`${DRAFT_PREFIX}s1`) ?? '{}');
  t.deepEqual(saved, {
    sessionKey: 's1',
    text: 'first try',
    requestId: 'req1',
  });
  t.deepEqual(locks.names, ['familiar.send:s1']);
  controller.setInput('first try, edited');
  t.is(controller.getState().view?.sendError, undefined, 'an edit clears it');
  await controller.send('first try, edited');
  const submits = control.callsOf('Composer', 'submit');
  t.is(submits.length, 2);
  t.is(submits[1][4], 'req1', 'the unspent request id is reused');
  t.is(submits[1][3], 'first try, edited');
  t.false(storage.map.has(`${DRAFT_PREFIX}s1`));
  view = controller.getState().view;
  t.is(view?.sendError, undefined);
  await controller.send('second');
  t.is(control.callsOf('Composer', 'submit')[2][4], 'req2');
});

test('after a reconnect a saved draft is resent only when it has no receipt', async t => {
  const fake = makeFakePowers({ sessions: [{}, {}] });
  const storage = makeStorage();
  storage.setItem(
    `${DRAFT_PREFIX}s1`,
    JSON.stringify({
      sessionKey: 's1',
      text: 'lost on the wire',
      requestId: 'rq-a',
    }),
  );
  // s2's message reached the daemon before the connection dropped
  await E(fake.powers.composer).submit(
    fake.control.session('s2'),
    'landed',
    'rq-b',
  );
  storage.setItem(
    `${DRAFT_PREFIX}s2`,
    JSON.stringify({ sessionKey: 's2', text: 'landed', requestId: 'rq-b' }),
  );
  /** @type {any[]} */
  const seen = [];
  const addon = {
    id: 'probe',
    slot: 'composer.addon',
    component: () => null,
    /** @param {any} request */
    send: request => {
      seen.push([request.text, request.requestId, request.resend]);
      return undefined;
    },
  };
  const controller = makeController({
    storage,
    locks: makeLocks(),
    features: [addon],
  });
  await controller.attach(fake.powers);
  await flush();
  t.deepEqual(seen, [['lost on the wire', 'rq-a', true]]);
  t.deepEqual(
    fake.control
      .callsOf('Session', 'getSubmissionReceipt')
      .map(call => call[2]),
    ['rq-a', 'rq-b'],
  );
  const submits = fake.control.callsOf('Composer', 'submit');
  t.is(submits.length, 2, 'one resend, none for the draft with a receipt');
  t.is(submits[1][4], 'rq-a');
  t.is(storage.length, 0);
});

test('addon chain: first send wins, undefined passes, a rejection keeps the draft', async t => {
  /** @type {string[]} */
  const order = [];
  const passing = {
    id: 'a',
    slot: 'composer.addon',
    order: 1,
    component: () => null,
    send: () => {
      order.push('a');
      return undefined;
    },
  };
  let mode = 'answer';
  const sending = {
    id: 'b',
    slot: 'composer.addon',
    order: 2,
    component: () => null,
    /** @param {any} request */
    send: request => {
      order.push('b');
      if (mode === 'reject') return Promise.reject(Error('chip lost'));
      return E(request.context.powers.composer).submit(
        request.session,
        `[b] ${request.text}`,
        request.requestId,
      );
    },
  };
  const never = {
    id: 'c',
    slot: 'composer.addon',
    order: 3,
    component: () => null,
    send: () => {
      order.push('c');
      return Promise.resolve({});
    },
  };
  const { controller, control, storage } = await setup(
    { sessions: [{}] },
    { features: [never, sending, passing] },
  );
  await controller.selectSession('s1');
  await flush();
  await controller.send('hello');
  t.deepEqual(order, ['a', 'b']);
  t.is(control.callsOf('Composer', 'submit')[0][3], '[b] hello');
  mode = 'reject';
  controller.setInput('again');
  await controller.send('again');
  t.is(
    controller.getState().view?.sendError,
    uiTextOf.statusError('chip lost'),
  );
  t.true(storage.map.has(`${DRAFT_PREFIX}s1`));
  t.is(controller.getState().view?.input.text, 'again');
});

test('without Web Locks the composer is blocked and send refuses', async t => {
  const fake = makeFakePowers({ sessions: [{}] });
  const controller = makeController({ storage: makeStorage() });
  await controller.attach(fake.powers);
  await controller.selectSession('s1');
  await flush();
  t.is(controller.getState().view?.blocked, uiTexts.noWebLocks);
  await controller.send('x');
  t.is(controller.getState().view?.sendError, uiTexts.noWebLocks);
  t.is(fake.control.callsOf('Composer', 'submit').length, 0);
});

test('an unresolved outcome-unknown turn blocks sending; acknowledgement unblocks (A-5)', async t => {
  const { controller, control } = await setup({
    sessions: [{ turns: 2, lastState: 'outcome-unknown' }],
  });
  await controller.selectSession('s1');
  await flush();
  t.is(controller.getState().view?.blocked, uiTexts.turnInterrupted);
  const turnId = controller.getState().view?.current?.turnId ?? '';
  await controller.resolveTurn(turnId, 'checked by hand');
  await flush();
  t.is(control.callsOf('Turn', 'resolve').length, 1);
  t.is(controller.getState().view?.blocked, undefined);
  t.is(
    controller.getState().view?.messages.at(-1)?.resolution,
    'checked by hand',
  );
});

test('queue rows: Send now on the head cancels the running turn; edit and delete', async t => {
  const { controller, control } = await setup({
    sessions: [{ running: 'busy' }],
  });
  await controller.selectSession('s1');
  await flush();
  await controller.send('queued one');
  await controller.send('queued two');
  await flush();
  const pending = controller.getState().view?.pending ?? [];
  t.is(pending.length, 2);
  await controller.editPending(pending[1].key, 'queued two, edited');
  await flush();
  t.deepEqual(control.pendingTexts('s1'), ['queued one', 'queued two, edited']);
  await controller.cancelPending(pending[1].key);
  await flush();
  t.deepEqual(control.pendingTexts('s1'), ['queued one']);
  await controller.sendPendingNow(pending[0].key);
  await flush();
  t.is(control.callsOf('QueueEntry', 'sendNow').length, 1);
  t.is(control.callsOf('Turn', 'cancel').length, 1);
  t.is(controller.getState().view?.messages.at(-1)?.record.input, 'queued one');
});

test('Load earlier pages the session back across the archive, every turn once', async t => {
  const { controller } = await setup({
    sessions: [{ turns: 12, archived: 5 }],
    pageTurns: 4,
  });
  await controller.selectSession('s1');
  await flush();
  let guard = 0;
  while (controller.getState().view?.earlier === 'more' && guard < 20) {
    guard += 1;
    // eslint-disable-next-line no-await-in-loop
    await controller.loadEarlier();
  }
  const view = controller.getState().view;
  t.is(view?.earlier, 'none');
  const inputs = view?.messages.map(entry => entry.record.input);
  t.deepEqual(
    inputs,
    Array.from({ length: 12 }, (_, i) => `message ${i + 1}`),
  );
  t.true(view?.messages[0].sealed);
  t.is(view?.messages[0].turn, undefined, 'archived turns have no Turn');
});

test('recovery panel pages through History; readContent reads every page', async t => {
  const { controller, control } = await setup({ sessions: [{ turns: 40 }] });
  await controller.selectSession('s1');
  await flush();
  await controller.openRecovery();
  t.is(controller.getState().recovery?.turns.length, 32);
  await controller.moreRecovery();
  t.is(controller.getState().recovery?.turns.length, 40);
  t.is(controller.getState().recovery?.next, undefined);
  const big = 'é'.repeat(300_000);
  const staged = control.stage(big);
  const text = await controller.readContent(staged);
  t.is(text, big);
  t.true(control.callsOf('Content', 'read').length > 20);
});

test('newSession creates with the chosen preset, backend and model, then opens it', async t => {
  const { controller, control } = await setup({ sessions: [] });
  control.addBackend('Other', { models: ['m-a', 'm-b', 'm-c'] });
  await controller.attach(controller.featureContext().powers);
  await flush();
  await controller.refreshModels(1);
  t.deepEqual(
    controller.getState().models.rows.map(row => row.modelId),
    ['m-a', 'm-b', 'm-c'],
  );
  const key = await controller.newSession({
    presetIndex: 0,
    backendIndex: 1,
    modelSelection: 'm-b',
    title: 'planned',
  });
  await flush();
  const [, , options] = control.callsOf('SessionFactory', 'createSession')[0];
  t.is(options.modelId, 'm-b');
  t.is(options.title, 'planned');
  t.true(options.userInitiated);
  t.truthy(options.preset);
  t.truthy(options.backend);
  t.is(controller.getState().activeKey, key);
  t.is(controller.getState().view?.info.title, 'planned');
});

test('replaceInput puts the caret after the inserted text; toggles', async t => {
  const { controller } = await setup({ sessions: [{}] });
  await controller.selectSession('s1');
  await flush();
  controller.setInput('hello @pa world', 8);
  controller.replaceInput(6, 9, '@path/to/file ');
  t.deepEqual(controller.getState().view?.input, {
    text: 'hello @path/to/file  world',
    caret: 20,
  });
  controller.toggleDrawer();
  t.true(controller.getState().drawerOpen);
  await controller.selectSession('s1');
  t.false(
    controller.getState().drawerOpen,
    'choosing a session closes the drawer',
  );
});

test('feature context: extras by label, call reports a failure', async t => {
  const service = { ping: () => 'pong' };
  const { controller } = await setup({
    sessions: [],
    extras: [{ label: 'probe', service }],
  });
  const context = controller.featureContext();
  t.is(context.extra('probe'), service);
  t.is(context.extra('none'), undefined);
  await t.throwsAsync(() =>
    context.call(async () => {
      throw Error('bad call');
    }),
  );
  t.is(controller.getState().status, uiTextOf.statusError('bad call'));
});

test('M3-FIX: preset rows keep description and reasoningEffort (R6-39)', async t => {
  const effortful = {
    describe: async () => ({
      label: 'deep',
      builtIn: false,
      description: 'Thinks hard',
      reasoningEffort: 'high',
    }),
  };
  const { controller } = await setup({ presets: [effortful] });
  t.deepEqual(controller.getState().presets, [
    {
      index: 0,
      label: 'deep',
      available: true,
      description: 'Thinks hard',
      reasoningEffort: 'high',
    },
  ]);
});

test('M3-FIX: a queue action while the view re-opens waits for its watch (acceptance 12)', async t => {
  const { controller, control } = await setup({
    sessions: [{ running: 'busy', pending: ['one', 'two'] }],
  });
  await controller.selectSession('s1');
  await flush();
  const rows = controller.getState().view?.pending ?? [];
  t.is(rows.length, 2);
  // Re-open (as a reconnect rebuild does): entries are unmapped until the
  // new watch() answers, while the old rows are still on screen.
  const reopened = controller.selectSession('s1');
  const sent = controller.sendPendingNow(rows[1].key);
  const edited = controller.editPending(rows[0].key, 'one, edited');
  await Promise.all([reopened, sent, edited]);
  await flush();
  t.is(controller.getState().status, '', 'no "no queued entry" status');
  t.is(control.callsOf('QueueEntry', 'sendNow').length, 1);
  t.true(control.pendingTexts('s1').includes('one, edited'));
  // A key that is not in the new snapshot still fails, after the wait.
  await controller.cancelPending('no-such-key');
  t.regex(controller.getState().status, /no queued entry no-such-key/);
});
