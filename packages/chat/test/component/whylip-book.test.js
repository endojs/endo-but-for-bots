// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { renderConfined, unmount } from '@endo/preact-container/renderer';
import { h } from 'preact';

// Integration tests exercise the private hook, renderer, and durable session.
/* eslint-disable import/no-relative-packages */
import { makeBookSession } from '../../../space-whylip/src/book-session.js';
import { SceneCanvas } from '../../../space-whylip/src/SceneCanvas.js';
import { useBook } from '../../../space-whylip/src/hooks/useBook.js';
/* eslint-enable import/no-relative-packages */
import { createDOM, waitFor } from '../helpers/dom-setup.js';

const { document: testDocument, window: testWindow } = createDOM();

const makeSource =
  words => `({h}, {state, update, act}) => h('section', {key:'book'},
  h('input', {key:'name', id:'name', value:state.name || '', onInput:event => update({name:event.target.value})}),
  h('p', {key:'narrative'}, ${JSON.stringify(words)}),
  h('button', {key:'choice', onClick:() => { update({path:'river'}); act('choose-path', {path:'river'}); }}, 'Take the river'))`;

/** @param {import('ava').ExecutionContext} t */
const makeHarness = async t => {
  /** @type {Map<string, any>} */
  const values = new Map();
  /** @type {Promise<void> | undefined} */
  let storageGate;
  /** @type {(() => void) | undefined} */
  let releaseStorage;
  const storage = Far('WhylipIntegrationStorage', {
    list: async () => harden([...values.keys()]),
    lookup: async name => values.get(name),
    storeValue: async (value, name) => {
      await storageGate;
      values.set(name, value);
    },
  });
  const book = await makeBookSession(storage, 'test-book');
  await E(book).initialize(
    makeSource('The lantern waits.'),
    harden({ name: 'Ada' }),
  );
  let subscriptions = 0;
  let mailSubscriptions = 0;
  let sendFails = false;
  /** @type {any[]} */
  const sent = [];
  /** @type {Promise<void> | undefined} */
  let locateGate;
  /** @type {(() => void) | undefined} */
  let releaseLocate;
  let locateStarted = false;
  const observed = Far('ObservedBook', {
    initialize: (source, state) => E(book).initialize(source, state),
    getSnapshot: () => E(book).getSnapshot(),
    updateState: patch => E(book).updateState(patch),
    act: (name, detail) => E(book).act(name, detail),
    pendingEvents: () => E(book).pendingEvents(),
    ackEvent: id => E(book).ackEvent(id),
    retryEvent: id => E(book).retryEvent(id),
    finishEvent: (id, narration) => E(book).finishEvent(id, narration),
    recordMessage: (role, text, id) => E(book).recordMessage(role, text, id),
    followChanges: async () => {
      const reader = await E(book).followChanges();
      subscriptions += 1;
      let closed = false;
      return Far('ObservedBookReader', {
        stream: syn => E(reader).stream(syn),
        cancel: () => {
          if (!closed) {
            closed = true;
            subscriptions -= 1;
          }
          return E(reader).cancel();
        },
      });
    },
  });
  const agent = Far('TestStoryteller', {
    storeLocator: async () => {
      locateStarted = true;
      await locateGate;
    },
    locate: () => 'agent-id',
  });
  const powers = Far('TestBookProfile', {
    has: name => name === 'book',
    lookup: name => (name === 'book' ? observed : agent),
    locate: () => 'book-locator',
    listMessages: () => harden([]),
    followMessages: () => {
      mailSubscriptions += 1;
      return Far('EmptyMailbox', {
        stream: () =>
          Promise.resolve(harden({ value: undefined, promise: null })),
      });
    },
    send: async (recipient, strings) => {
      sent.push({ recipient, strings });
      if (sendFails) throw Error('Storyteller is temporarily offline');
      return `sent-${sent.length}`;
    },
  });
  const parent = testDocument.createElement('div');
  testDocument.body.appendChild(parent);
  /** @type {any} */
  let view;
  /** @type {string[]} */
  const renderedNames = [];
  const Probe = () => {
    view = useBook(powers);
    renderedNames.push(view.state.name || '');
    return h(SceneCanvas, {
      source: view.source,
      state: view.state,
      onState: view.updateState,
      onAction: view.act,
    });
  };
  const mount = () => renderConfined(h(Probe, {}), parent);
  const dispose = () => unmount(parent);
  t.teardown(() => {
    releaseStorage?.();
    releaseLocate?.();
    dispose();
    parent.remove();
  });
  return {
    book,
    parent,
    sent,
    renderedNames,
    mount,
    dispose,
    getView: () => view,
    persisted: () => values.get('test-book'),
    subscriptions: () => subscriptions,
    mailSubscriptions: () => mailSubscriptions,
    locateStarted: () => locateStarted,
    failSending: () => {
      sendFails = true;
    },
    recoverSending: () => {
      sendFails = false;
    },
    holdStorage: () => {
      storageGate = new Promise(resolve => {
        releaseStorage = resolve;
      });
    },
    releaseStorage: () => {
      releaseStorage?.();
      storageGate = undefined;
    },
    holdLocate: () => {
      locateGate = new Promise(resolve => {
        releaseLocate = resolve;
      });
    },
    releaseLocate: () => {
      releaseLocate?.();
      locateGate = undefined;
    },
  };
};

test.serial(
  'local input updates immediately while durable writes are pending, without state rollback',
  async t => {
    t.timeout(5000);
    const app = await makeHarness(t);
    app.mount();
    await waitFor(() => app.getView()?.ready);
    const input = app.parent.querySelector('input');
    if (!input) throw Error('Missing input');
    app.holdStorage();
    input.value = 'Ada L';
    input.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    await waitFor(() => app.getView().state.name === 'Ada L');
    t.is(
      app.persisted().state.name,
      'Ada',
      'first update is visible before persistence',
    );
    input.value = 'Ada Lovelace';
    input.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    await waitFor(() => app.getView().state.name === 'Ada Lovelace');
    const marker = app.renderedNames.length;
    app.releaseStorage();
    await waitFor(() => app.persisted().state.name === 'Ada Lovelace');
    await E(app.book).getSnapshot();
    t.true(
      app.renderedNames.slice(marker).every(name => name === 'Ada Lovelace'),
    );
    t.is(app.sent.length, 0, 'typing does not wake the storyteller');
  },
);

test.serial(
  'filesystem source edits reconcile live and reader choices reach the agent with committed state',
  async t => {
    t.timeout(5000);
    const app = await makeHarness(t);
    app.mount();
    await waitFor(() => app.getView()?.ready);
    const input = app.parent.querySelector('input');
    if (!input) throw Error('Missing input');
    input.focus();
    input.setSelectionRange(1, 2);
    await E(await E(app.book).getFiles()).write(
      'scene.js',
      makeSource('The ferryman waves.'),
    );
    await waitFor(() => app.parent.textContent.includes('The ferryman waves.'));
    t.is(app.parent.querySelector('input'), input);
    t.is(testDocument.activeElement, input);
    t.is(input.selectionStart, 1);
    app.parent.querySelector('button')?.click();
    await waitFor(() => app.sent.length === 1);
    const event = JSON.parse(app.sent[0].strings[0].split('\n')[1]);
    t.is(app.sent[0].recipient, 'fae');
    t.is(event.name, 'choose-path');
    t.deepEqual(event.detail, { path: 'river' });
    t.is(
      event.state.path,
      'river',
      'local update commits before the story event',
    );
    await waitFor(() => app.getView().status === 'thinking');
    await E(app.book).finishEvent(event.id, 'Welcome aboard, Ada.');
    await waitFor(() => app.getView().status === 'idle');
    t.true(
      app
        .getView()
        .messages.some(message => message.content === 'Welcome aboard, Ada.'),
    );
    t.deepEqual(await E(app.book).pendingEvents(), []);
    t.is(app.getView().error, null);
  },
);

test.serial(
  'a failed send retains the durable event and retry replays it without duplicating the reader message',
  async t => {
    t.timeout(5000);
    const app = await makeHarness(t);
    app.failSending();
    app.mount();
    await waitFor(() => app.getView()?.ready);
    app.getView().act('message', { text: 'Who lives here?' });
    await waitFor(() => app.getView().error);
    const [pending] = await E(app.book).pendingEvents();
    t.truthy(pending);
    t.is(
      app.persisted().messages.filter(message => message.role === 'user')
        .length,
      1,
    );
    app.recoverSending();
    app.getView().retry();
    await waitFor(() => app.sent.length === 2);
    t.is(JSON.parse(app.sent[1].strings[0].split('\n')[1]).id, pending.id);
    await waitFor(() => app.persisted().pendingEvents.length === 0);
    t.is(
      app.persisted().messages.filter(message => message.role === 'user')
        .length,
      1,
    );
    t.is(app.subscriptions(), 1, 'retry replaces its subscription');
    app.dispose();
    await waitFor(() => app.subscriptions() === 0);
  },
);

test.serial(
  'unmount during capability setup never starts later subscriptions',
  async t => {
    t.timeout(5000);
    const app = await makeHarness(t);
    app.holdLocate();
    app.mount();
    await waitFor(() => app.locateStarted());
    app.dispose();
    await waitFor(() => app.subscriptions() === 0);
    app.releaseLocate();
    // Await another queued remote call after releasing startup's lookup.
    await E(app.book).getSnapshot();
    await E(app.book).getSnapshot();
    t.is(app.mailSubscriptions(), 0);
  },
);

test.serial(
  'provider failure clears busy state and retry uses current reader state without remounting',
  async t => {
    t.timeout(5000);
    const app = await makeHarness(t);
    app.mount();
    await waitFor(() => app.getView()?.ready);
    const input = app.parent.querySelector('input');
    if (!input) throw Error('Missing input');
    input.focus();
    await app.getView().act('choose-path', { path: 'river' });
    await waitFor(() => app.sent.length === 1);
    const original = JSON.parse(app.sent[0].strings[0].split('\n')[1]);
    await E(app.book).failEvent(
      original.id,
      'The storyteller could not connect.',
    );
    await waitFor(() => app.getView().storyFailure);
    t.not(app.getView().status, 'thinking');
    t.is(
      app.getView().storyFailure.reason,
      'The storyteller could not connect.',
    );
    app.getView().updateState({ name: 'Grace' });
    await waitFor(() => app.getView().state.name === 'Grace');
    await app.getView().retryStory(original.id);
    await waitFor(() => app.sent.length === 2);
    const retried = JSON.parse(app.sent[1].strings[0].split('\n')[1]);
    t.not(retried.id, original.id);
    t.is(retried.name, original.name);
    t.deepEqual(retried.detail, original.detail);
    t.is(retried.state.name, 'Grace');
    t.is(app.parent.querySelector('input'), input);
    t.is(testDocument.activeElement, input);
    t.is(app.subscriptions(), 1);
    await E(app.book).finishEvent(original.id, 'Late old response');
    t.deepEqual((await E(app.book).getSnapshot()).activeEventIds, [retried.id]);
    await E(app.book).finishEvent(retried.id, 'The river welcomes Grace.');
    await waitFor(
      () => app.getView().status === 'idle' && !app.getView().storyFailure,
    );
  },
);
