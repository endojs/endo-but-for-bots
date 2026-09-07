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
const setup = async (
  t,
  count = 2,
  recover = false,
  baseline = Promise.resolve(harden([])),
) => {
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
  const cancelledTurns = [];
  let currentOverride;
  let nextId = count;
  let failCreation = false;
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
      cancel: () => {
        cancelledTurns.push(ref);
      },
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
        if (currentOverride) return currentOverride();
        const turn = turns.find(
          candidate => candidate.id === id && !candidate.channel.isClosed(),
        );
        return turn
          ? harden({ input: turn.text, turn: turn.ref, history: baseline })
          : null;
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
      if (failCreation) throw Error('creation unavailable');
      const id = `s${nextId}`;
      nextId += 1;
      sessions.push({ id, title: `Session ${id}`, createdAt: nextId });
      return facet(id);
    },
  });
  let cleanup = flootComponent(parent, factory, [], () => {}, [], []);
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
    cancelledTurns,
    makeTurn,
    setCurrent: reader => {
      currentOverride = reader;
    },
    send,
    remove,
    setCreationFailure: value => {
      failCreation = value;
    },
    mountSibling: () => {
      const sibling = testDocument.createElement('div');
      testDocument.body.appendChild(sibling);
      const dispose = flootComponent(sibling, factory, [], () => {}, [], []);
      t.teardown(() => {
        dispose();
        sibling.remove();
      });
      return sibling;
    },
    remount: () => {
      cleanup();
      cleanup = flootComponent(parent, factory, [], () => {}, [], []);
    },
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

test.serial(
  'session creation failure does not poison later submissions',
  async t => {
    const { parent, turns, send, remove, setCreationFailure } = await setup(
      t,
      1,
    );
    remove(0);
    setCreationFailure(true);
    await send('first attempt');
    await waitFor(() => parent.textContent.includes('creation unavailable'));
    setCreationFailure(false);
    await send('retry');
    await waitFor(() => turns.length === 1);
    t.is(turns[0].text, 'retry');
  },
);

test.serial('remount restores the prompt for a cached live turn', async t => {
  const { parent, turns, send, remount } = await setup(t);
  await send('keep this prompt visible');
  await waitFor(() => turns.length === 1);
  remount();
  await waitFor(() => parent.querySelector('[aria-label="Stop"]'));
  t.true(parent.textContent.includes('keep this prompt visible'));
});

test.serial(
  'recovery uses the turn baseline while committed output awaits teardown',
  async t => {
    const { parent, turns, send, remount, setHistoryReader } = await setup(t);
    await send('one prompt');
    await waitFor(() => turns.length === 1);
    turns[0].channel.push(harden({ type: 'delta', text: 'one answer' }));
    await waitFor(() => parent.textContent.includes('one answer'));
    setHistoryReader(() =>
      harden([
        { role: 'user', content: 'one prompt' },
        { role: 'assistant', content: 'one answer' },
      ]),
    );
    remount();
    await waitFor(() => parent.querySelector('[aria-label="Stop"]'));
    t.is(parent.textContent.split('one prompt').length - 1, 1);
    t.is(parent.textContent.split('one answer').length - 1, 1);
  },
);

test.serial(
  'queued recovery permits Stop before its history baseline resolves',
  async t => {
    let resolveHistory = history => {};
    const baseline = new Promise(resolve => {
      resolveHistory = resolve;
    });
    t.teardown(() => resolveHistory(harden([])));
    const { parent, turns, cancelledTurns } = await setup(t, 2, true, baseline);
    await waitFor(() => parent.querySelector('[aria-label="Stop"]'));
    parent
      .querySelector('[aria-label="Stop"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => cancelledTurns.length === 1);
    t.is(cancelledTurns[0], turns[0].ref);
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => parent.querySelector('[aria-label="Send"]'));
    resolveHistory(
      harden([{ role: 'user', content: 'late baseline must not overwrite' }]),
    );
    await tick(30);
    t.false(parent.textContent.includes('late baseline must not overwrite'));
  },
);

test.serial(
  'daemon completion retires a stale cache before loading canonical history',
  async t => {
    const { parent, turns, send, remount, setCurrent, setHistoryReader } =
      await setup(t);
    await send('saved prompt');
    await waitFor(() => turns.length === 1);
    turns[0].channel.push(harden({ type: 'delta', text: 'saved answer' }));
    await waitFor(() => parent.textContent.includes('saved answer'));
    setCurrent(() => null);
    setHistoryReader(() =>
      harden([
        { role: 'user', content: 'saved prompt' },
        { role: 'assistant', content: 'saved answer' },
      ]),
    );
    remount();
    await waitFor(
      () =>
        parent.querySelector('[aria-label="Send"]') &&
        parent.textContent.includes('saved answer'),
    );
    t.is(parent.textContent.split('saved answer').length - 1, 1);
    t.is(parent.textContent.split('saved prompt').length - 1, 1);
  },
);

test.serial(
  'daemon turn identity replaces an older observation for the same session',
  async t => {
    const {
      parent,
      turns,
      send,
      remount,
      setCurrent,
      makeTurn,
      cancelledTurns,
    } = await setup(t);
    await send('older prompt');
    await waitFor(() => turns.length === 1);
    const replacement = makeTurn('s0', 'replacement prompt');
    setCurrent(() =>
      harden({
        input: 'replacement prompt',
        turn: replacement,
        history: Promise.resolve(harden([])),
      }),
    );
    remount();
    await waitFor(() => parent.textContent.includes('replacement prompt'));
    t.false(parent.textContent.includes('older prompt'));
    parent
      .querySelector('[aria-label="Stop"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => cancelledTurns.length === 1);
    t.is(cancelledTurns[0], replacement);
  },
);

test.serial(
  'retiring a shared observation reconciles every mounted view',
  async t => {
    const { parent, turns, send, setCurrent, setHistoryReader, mountSibling } =
      await setup(t);
    await send('shared prompt');
    await waitFor(() => turns.length === 1);
    turns[0].channel.push(harden({ type: 'delta', text: 'shared answer' }));
    await waitFor(() => parent.textContent.includes('shared answer'));
    setCurrent(() => null);
    setHistoryReader(() =>
      harden([
        { role: 'user', content: 'shared prompt' },
        { role: 'assistant', content: 'shared answer' },
      ]),
    );
    const sibling = mountSibling();
    await waitFor(() => sibling.textContent.includes('shared answer'));
    await waitFor(
      () =>
        parent.textContent.includes('shared answer') &&
        parent.querySelector('[aria-label="Send"]'),
    );
    t.is(parent.textContent.split('shared answer').length - 1, 1);
    t.is(sibling.textContent.split('shared answer').length - 1, 1);
  },
);

test.serial(
  'a superseded mounted view can cancel the replacement turn',
  async t => {
    const {
      parent,
      turns,
      send,
      setCurrent,
      makeTurn,
      mountSibling,
      cancelledTurns,
    } = await setup(t);
    await send('old shared prompt');
    await waitFor(() => turns.length === 1);
    await send('queued after replacement');
    const replacement = makeTurn('s0', 'new shared prompt');
    setCurrent(() =>
      harden({
        input: 'new shared prompt',
        turn: replacement,
        history: Promise.resolve(harden([])),
      }),
    );
    const sibling = mountSibling();
    await waitFor(() => sibling.textContent.includes('new shared prompt'));
    await waitFor(() => parent.textContent.includes('new shared prompt'));
    parent
      .querySelector('[aria-label="Stop"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => cancelledTurns.length === 1);
    t.is(cancelledTurns[0], replacement);
    await tick(30);
    t.is(turns.length, 2, 'queued submission still waits for the replacement');
    turns[1].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 3);
    t.is(turns[2].text, 'queued after replacement');
  },
);
