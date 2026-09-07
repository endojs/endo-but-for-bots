// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

/** @import { ExecutionContext } from 'ava' */
import { Far } from '@endo/pass-style';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

import { flootComponent } from '../../floot-component.js';
import {
  createDOM,
  tick,
  waitFor as waitForDOM,
} from '../helpers/dom-setup.js';

const dom = createDOM();
// Happy DOM implements the browser APIs exercised here; its declaration types
// carry implementation-specific symbols, so adapt only at the harness boundary.
const testWindow = /** @type {Window & typeof globalThis} */ (
  /** @type {unknown} */ (dom.window)
);
const testDocument = /** @type {Document} */ (
  /** @type {unknown} */ (dom.document)
);
globalThis.MutationObserver = testWindow.MutationObserver;
globalThis.requestAnimationFrame = fn => testWindow.setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
testWindow.confirm = () => true;
const waitFor = predicate => waitForDOM(predicate, 10, 2000);

/** @param {ExecutionContext} t
 * @param {number} [count]
 * @param {boolean} [recover]
 */
const setup = async (t, count = 2, recover = false) => {
  t.timeout(5000);
  const parent = testDocument.createElement('div');
  testDocument.body.appendChild(parent);
  /** @type {Array<{ id: string, title: string, createdAt: number }>} */
  let sessions = Array.from({ length: count }, (value, index) => ({
    id: `s${index}`,
    title: `Session ${index}`,
    createdAt: count - index,
  }));
  /** @type {Array<{ id: string, text: string, channel: ReturnType<typeof makeBufferedReader>, ref: object }>} */
  const turns = [];
  const deleted = [];
  let nextId = count;
  const makeTurn = (id, text) => {
    const channel = makeBufferedReader();
    const status = () =>
      harden({
        messages: [],
        streamingText: recover ? 'already running' : '',
        phase: 'thinking',
        usage: null,
        error: null,
        done: channel.isClosed(),
      });
    const ref = Far('TestFlootTurn', {
      watch: () => channel.reader,
      getStatus: status,
      cancel: () => undefined,
    });
    turns.push({ id, text, channel, ref });
    channel.push(harden({ type: 'snapshot', status: status() }));
    return ref;
  };
  if (recover) makeTurn('s0', 'submitted before reload');
  /** @type {() => any} */
  let readHistory = () => harden([]);
  const facet = id =>
    Far('TestFlootSession', {
      getInfo: () => harden(sessions.find(session => session.id === id)),
      getHistory: () => readHistory(),
      getCurrentTurn: () => {
        const turn = turns.find(
          candidate => candidate.id === id && !candidate.channel.isClosed(),
        );
        return turn ? harden({ input: turn.text, turn: turn.ref }) : null;
      },
      getUsage: () => harden({ inputTokens: 0, outputTokens: 0, turns: 0 }),
      startTurn: text => makeTurn(id, text),
    });
  const factory = Far('TestFlootFactory', {
    listSessions: () => harden(sessions.map(session => ({ ...session }))),
    listPresets: () => harden([]),
    listModels: () => harden([]),
    getSession: id => facet(id),
    renameSession: () => undefined,
    deleteSession: id => {
      deleted.push(id);
      sessions = sessions.filter(session => session.id !== id);
      // Deliberately leave the turn open: UI cleanup must not depend on how
      // quickly the daemon shuts down a backend, or whether deletion succeeds.
    },
    createSession: () => {
      const id = `s${nextId}`;
      nextId += 1;
      sessions.push({ id, title: `Session ${id}`, createdAt: nextId });
      return facet(id);
    },
  });
  const cleanup = flootComponent(parent, factory, [], () => {}, [], []);
  t.teardown(() => {
    cleanup();
    for (const { channel } of turns) channel.push(harden({ type: 'end' }));
    parent.remove();
  });
  await waitFor(
    () => parent.querySelectorAll('.floot-session-item').length === count,
  );
  // Wait for Preact's mount subscription before sending input.
  await tick(50);
  const send = async text => {
    const input = parent.querySelector('textarea');
    if (!input) throw Error('Missing compose input');
    input.value = text;
    input.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    await tick();
    input.dispatchEvent(
      new testWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  };
  const remove = index =>
    parent
      .querySelectorAll('button[aria-label="Delete"]')
      [index].dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  return {
    parent,
    turns,
    deleted,
    send,
    remove,
    setHistoryReader: (/** @type {() => any} */ reader) => {
      readHistory = reader;
    },
  };
};

test.serial(
  'deleting the active session releases submissions before the old turn ends',
  async t => {
    const { parent, turns, deleted, send, remove } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    remove(0);
    await waitFor(() => deleted.length === 1);
    await send('second');
    await waitFor(() => turns.length === 2);
    t.is(turns[1].id, 's1');
    t.is(turns[1].text, 'second');
    turns[0].channel.push(harden({ type: 'abort', reason: 'old turn failed' }));
    await tick(30);
    t.false(parent.textContent.includes('old turn failed'));
    t.truthy(
      parent.querySelector('[aria-label="Stop"]'),
      'late completion does not clear the new turn',
    );
    turns[1].channel.push(harden({ type: 'end' }));
    await waitFor(() => parent.querySelector('[aria-label="Send"]'));
    parent
      .querySelector('button[aria-label="New session"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(
      () => parent.querySelectorAll('.floot-session-item').length === 2,
    );
    parent
      .querySelectorAll('div.floot-session-item')[1]
      .dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() =>
      parent
        .querySelector('.floot-session-item.active')
        ?.textContent.includes('Session 1'),
    );
    t.pass();
  },
);

test.serial(
  'deleting a non-active session preserves the running attachment',
  async t => {
    const { parent, turns, send, remove } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    remove(1);
    await tick(30);
    t.truthy(parent.querySelector('[aria-label="Stop"]'));
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => parent.querySelector('[aria-label="Send"]'));
    await send('next');
    await waitFor(() => turns.length === 2);
    t.is(turns[1].id, 's0');
  },
);

test.serial(
  'deleting the last session permits creating a new session by sending',
  async t => {
    const { turns, send, remove } = await setup(t, 1);
    await send('first');
    await waitFor(() => turns.length === 1);
    remove(0);
    await send('new session');
    await waitFor(() => turns.length === 2);
    t.is(turns[1].id, 's1');
  },
);

test.serial('Stop continues observing cancellation failure', async t => {
  const { parent, turns, send } = await setup(t);
  await send('first');
  await waitFor(() => turns.length === 1);
  parent
    .querySelector('button[aria-label="Stop"]')
    ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  turns[0].channel.push(harden({ type: 'phase', phase: 'cancelling' }));
  await tick(30);
  t.truthy(parent.querySelector('[aria-label="Stop"]'));
  turns[0].channel.push(
    harden({ type: 'abort', reason: 'cancellation failed' }),
  );
  await waitFor(() => parent.textContent.includes('cancellation failed'));
  t.truthy(parent.querySelector('[aria-label="Send"]'));
});

test.serial(
  'a fresh view recovers the daemon turn and serializes its next submission',
  async t => {
    const { parent, turns, send } = await setup(t, 2, true);
    await waitFor(() => parent.textContent.includes('already running'));
    t.true(parent.textContent.includes('submitted before reload'));
    t.truthy(parent.querySelector('[aria-label="Stop"]'));
    await send('after recovered turn');
    await tick(30);
    t.is(turns.length, 1);
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    t.is(turns[1].text, 'after recovered turn');
  },
);

test.serial(
  'queued input for a deleted session is never sent to its replacement',
  async t => {
    const { turns, send, remove } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await send('queued for the deleted session');
    remove(0);
    await send('for the replacement');
    await waitFor(() => turns.length === 2);
    t.deepEqual(
      turns.map(({ id, text }) => ({ id, text })),
      [
        { id: 's0', text: 'first' },
        { id: 's1', text: 'for the replacement' },
      ],
    );
  },
);

test.serial(
  'factories with identical session IDs have independent observation caches',
  async t => {
    const first = await setup(t);
    await first.send('first factory');
    await waitFor(() => first.turns.length === 1);
    const second = await setup(t);
    t.truthy(second.parent.querySelector('[aria-label="Send"]'));
    await second.send('second factory');
    await waitFor(() => second.turns.length === 1);
    t.is(first.turns.length, 1);
    t.is(second.turns[0].text, 'second factory');
  },
);

test.serial(
  'a delayed completed-turn history response cannot erase a new submission',
  async t => {
    const { parent, turns, send, setHistoryReader } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    let release = () => {};
    const history = new Promise(resolve => {
      release = () =>
        resolve(
          harden([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'first answer' },
          ]),
        );
    });
    t.teardown(release);
    setHistoryReader(() => history);
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => parent.querySelector('[aria-label="Send"]'));
    await send('do not erase this input');
    await waitFor(() => turns.length === 2);
    release();
    await tick(30);
    t.true(parent.textContent.includes('do not erase this input'));
  },
);
