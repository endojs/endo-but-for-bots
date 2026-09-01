// @ts-nocheck - Component test with happy-dom
/* eslint-disable no-empty-function */

import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { createDOM, waitFor } from '../helpers/dom-setup.js';
import { flootComponent } from '../../floot-component.js';

const { window: testWindow, document: testDocument } = createDOM();

// renderConfined defers some effect/menu idioms with requestAnimationFrame;
// dom-setup stubs setTimeout but not rAF, so provide a setTimeout-backed shim.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = fn =>
    globalThis.setTimeout(() => fn(0), 0);
  globalThis.cancelAnimationFrame = id => globalThis.clearTimeout(id);
}
// The host wrapper owns a sticky-scroll MutationObserver on the mount node.
if (!globalThis.MutationObserver && testWindow.MutationObserver) {
  globalThis.MutationObserver = testWindow.MutationObserver;
}

/**
 * Mock Floot factory with one session. Each startTurn() returns a FlootTurn
 * whose watch() stream the test drives event by event.
 */
const makeMockFactory = ({ catalog = false } = {}) => {
  const turns = [];
  const history = [];
  const creations = [];
  const makeSessionFacet = (id, info = {}) =>
    Far(`FlootSession-${id}`, {
      async getInfo() {
        return {
          id,
          title: info.title || 'Chat one',
          createdAt: 1,
          presetId: info.presetId || 'general',
          runtime: info.runtime || '',
          model: info.model || '',
          thinking: info.thinking || '',
        };
      },
      startTurn(input) {
        const { push, reader } = makeBufferedReader();
        turns.push({ input, push });
        return Far('FlootTurn', {
          watch: () => reader,
          async getStatus() {
            return {
              phase: 'thinking',
              streamingText: '',
              messages: [],
              done: false,
              error: null,
              usage: null,
            };
          },
          async cancel() {},
          async whenFinished() {},
        });
      },
      async getHistory() {
        return harden([...history]);
      },
      async getUsage() {
        return { inputTokens: 0, outputTokens: 0, turns: 0 };
      },
    });
  const factory = Far('FlootFactory', {
    async listSessions() {
      return [
        {
          id: 's1',
          title: 'Chat one',
          createdAt: 1,
          presetId: 'general',
          runtime: '',
          model: '',
        },
      ];
    },
    async listPresets() {
      return catalog
        ? [
            {
              id: 'general',
              title: 'General',
              description: 'General assistant',
            },
          ]
        : [];
    },
    async listModels() {
      return catalog
        ? [
            {
              id: 'claude-sonnet',
              title: 'Claude Sonnet',
              runtimes: ['claude-cli'],
              defaultFor: ['claude-cli'],
            },
            {
              id: 'gpt-sol',
              title: 'GPT Sol',
              runtimes: ['codex-cli'],
              defaultFor: ['codex-cli'],
            },
            {
              id: 'gpt-terra',
              title: 'GPT Terra',
              runtimes: ['codex-cli'],
              defaultFor: [],
            },
          ]
        : [];
    },
    async listRuntimes() {
      return catalog
        ? [
            { id: 'claude-cli', title: 'Claude Code', default: true },
            { id: 'codex-cli', title: 'Codex' },
          ]
        : [];
    },
    async listThinkingOptions() {
      return catalog
        ? [
            {
              id: 'auto',
              title: 'Auto',
              default: true,
              runtimes: ['claude-cli', 'codex-cli'],
            },
            {
              id: 'none',
              title: 'None',
              runtimes: ['codex-cli'],
            },
            {
              id: 'xhigh',
              title: 'Extra high',
              runtimes: ['claude-cli', 'codex-cli'],
            },
          ]
        : [];
    },
    async createSession(title, presetId, model, runtime, thinking) {
      creations.push({ title, presetId, model, runtime, thinking });
      return makeSessionFacet('s2', {
        title,
        presetId,
        model,
        runtime,
        thinking,
      });
    },
    async getSession(id) {
      return makeSessionFacet(id);
    },
    async renameSession() {},
    async deleteSession() {},
  });
  const rootPowers = Far('MockRootPowers', {
    async lookup(name) {
      if (name !== 'floot-factory') throw Error(`missing ${name}`);
      return factory;
    },
  });
  return { rootPowers, turns, history, creations };
};

const mountFloot = (t, options = {}) => {
  const $parent = testDocument.createElement('div');
  testDocument.body.appendChild($parent);
  const { rootPowers, turns, history, creations } = makeMockFactory(options);
  const cleanup = flootComponent(
    $parent,
    rootPowers,
    ['floot-factory'],
    () => {},
  );
  t.teardown(() => {
    cleanup();
    $parent.remove();
  });
  const bodyText = () => testDocument.body.textContent || '';
  const composer = () => $parent.querySelector('.floot-input');
  // Loaded once the session list has landed (the sidebar shows the session);
  // sends before that would try to create a session the mock doesn't support.
  const loaded = () =>
    composer() && $parent.querySelector('.floot-session-item');
  const send = text => {
    const $input = composer();
    $input.value = text;
    $input.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    $input.dispatchEvent(
      new testWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  };
  return {
    $parent,
    turns,
    history,
    creations,
    bodyText,
    composer,
    loaded,
    send,
  };
};

test.serial('new sessions filter models and thinking by runtime', async t => {
  const { $parent, creations, loaded } = mountFloot(t, { catalog: true });
  await waitFor(() => loaded());

  $parent
    .querySelector('.floot-new-btn')
    .dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  await waitFor(() => $parent.querySelector('.floot-modal'));

  const selects = () => [...$parent.querySelectorAll('.floot-model-select')];
  t.deepEqual(
    [...selects()[0].options].map(option => option.value),
    ['claude-sonnet'],
  );
  t.deepEqual(
    [...selects()[1].options].map(option => option.value),
    ['auto', 'xhigh'],
  );

  const codexButton = [
    ...$parent.querySelectorAll('.floot-runtime-option'),
  ].find(button => button.textContent === 'Codex');
  codexButton.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  await waitFor(() => selects()[0].value === 'gpt-sol');
  t.deepEqual(
    [...selects()[0].options].map(option => option.value),
    ['gpt-sol', 'gpt-terra'],
  );
  t.deepEqual(
    [...selects()[1].options].map(option => option.value),
    ['auto', 'none', 'xhigh'],
  );

  selects()[0].value = 'gpt-terra';
  selects()[0].dispatchEvent(new testWindow.Event('input', { bubbles: true }));
  selects()[1].value = 'xhigh';
  selects()[1].dispatchEvent(new testWindow.Event('input', { bubbles: true }));
  await new Promise(resolve => globalThis.setTimeout(resolve, 0));
  $parent
    .querySelector('.floot-preset-card')
    .dispatchEvent(new testWindow.Event('click', { bubbles: true }));

  await waitFor(() => creations.length === 1);
  t.deepEqual(creations[0], {
    title: 'New chat',
    presetId: 'general',
    model: 'gpt-terra',
    runtime: 'codex-cli',
    thinking: 'xhigh',
  });
});

test.serial(
  'a message sent while a turn streams stays visible while queued',
  async t => {
    const { turns, history, bodyText, composer, loaded, send } = mountFloot(t);
    await waitFor(() => loaded());

    send('first question');
    await waitFor(() => turns.length === 1);
    turns[0].push({ type: 'delta', text: 'thinking about it' });
    await waitFor(() => bodyText().includes('thinking about it'));

    // Send a second message while the first turn is still streaming. It
    // queues behind the running turn — but it must stay visible: previously
    // the compose box was cleared immediately while the optimistic transcript
    // push only happened once the queued turn started, so the message
    // vanished until the prior turn finished.
    send('second question');
    await waitFor(() => bodyText().includes('second question'));
    t.is(turns.length, 1, 'the second turn has not started yet');
    t.is(composer().value, '', 'the compose box cleared on send');
    t.true(
      bodyText().includes('second question'),
      'the queued message renders in the transcript',
    );
    // Queued messages read as pending by position and muting, not by a label.
    t.false(
      bodyText().includes('Pending'),
      'no badge: the styling and position carry it',
    );
    t.true(
      bodyText().includes('Send now'),
      'the queued message offers to jump the queue',
    );
    t.true(
      bodyText().includes('Edit') && bodyText().includes('Delete'),
      'a queued message can be rewritten or dropped before it runs',
    );

    // Finish the first turn; the queued message starts its own turn and stays
    // visible through the handoff (queued placeholder → session transcript).
    history.push(
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer one' },
    );
    turns[0].push({ type: 'final', text: 'answer one' });
    turns[0].push({ type: 'end' });
    await waitFor(() => turns.length === 2);
    t.is(turns[1].input, 'second question');
    t.true(bodyText().includes('second question'));

    // Finish the second turn and let the component settle.
    history.push(
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'answer two' },
    );
    turns[1].push({ type: 'final', text: 'answer two' });
    turns[1].push({ type: 'end' });
    await waitFor(() => bodyText().includes('answer two'));
    t.true(bodyText().includes('second question'));
  },
);

test.serial('deleting the streamed session mid-turn is refused', async t => {
  const { $parent, turns, history, bodyText, loaded, send } = mountFloot(t);
  await waitFor(() => loaded());
  // Any confirm dialog would auto-accept — the guard must refuse before it.
  testWindow.confirm = () => true;

  send('long task');
  await waitFor(() => turns.length === 1);
  turns[0].push({ type: 'delta', text: 'working on the long task' });
  await waitFor(() => bodyText().includes('working on the long task'));

  // The active session's delete button (second row button of the active item).
  const $item = $parent.querySelector('.floot-session-item.active');
  t.truthy($item, 'the active session renders in the sidebar');
  const $delete = [...$item.querySelectorAll('.floot-row-btn')].at(-1);
  $delete.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  await waitFor(() => true);

  // Refused: deleting the session being streamed would reassign the active
  // session mid-turn and previously stranded the component busy forever (the
  // turn's terminal event was filtered by the session guard).
  t.truthy(
    $parent.querySelector('.floot-session-item.active'),
    'the streamed session is still there',
  );

  // The turn still completes normally afterward.
  history.push(
    { role: 'user', content: 'long task' },
    { role: 'assistant', content: 'done with it' },
  );
  turns[0].push({ type: 'final', text: 'done with it' });
  turns[0].push({ type: 'end' });
  await waitFor(() => bodyText().includes('done with it'));
  t.pass();
});
