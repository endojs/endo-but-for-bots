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

/**
 * A queried element that must be there, so an assertion about it fails on what
 * it says rather than on a null dereference.
 *
 * @param {Element | null} element
 * @param {string} what
 * @returns {Element}
 */
const must = (element, what) => {
  if (!element) throw Error(`Missing ${what}`);
  return element;
};

/**
 * @param {Element} parent
 * @param {string} selector
 * @returns {HTMLTextAreaElement}
 */
const textareaIn = (parent, selector) =>
  /** @type {HTMLTextAreaElement} */ (
    must(parent.querySelector(selector), selector)
  );

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
  // Scoped to the compose bar's own input: a queued message being edited puts
  // another textarea earlier in the document.
  const send = async text => {
    const input = textareaIn(parent, 'textarea.floot-input');
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
  const buttonLabelled = label =>
    [...parent.querySelectorAll('button')].find(
      candidate => candidate.textContent.trim() === label,
    );
  const click = label => {
    const button = buttonLabelled(label);
    if (!button) throw Error(`Missing "${label}" button`);
    button.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  };
  return {
    parent,
    turns,
    deleted,
    cancelledTurns,
    makeTurn,
    buttonLabelled,
    click,
    // Rewrite the queued message currently open for editing. `save()` closes
    // over the draft of the render that installed it, so Enter must come from a
    // render that has already seen the input event. `tick` is not a budget bet
    // here: Preact schedules re-renders on a microtask, which always drains
    // before a timer, so one macrotask boundary is enough by construction.
    retype: async text => {
      const input = textareaIn(parent, 'textarea.floot-pending-input');
      input.value = text;
      input.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
      await tick();
      input.dispatchEvent(
        new testWindow.KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
        }),
      );
    },
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

test.serial('idle conversations display workflow readiness mail', async t => {
  const { parent, turns, setHistoryReader } = await setup(t);
  t.timeout(10_000);
  setHistoryReader(() =>
    harden([
      {
        role: 'user',
        content: 'Your design is ready at commit abc123.',
        meta: { mail: { from: 'workflow', messageNumber: '7' } },
      },
    ]),
  );
  await waitForDOM(
    () => parent.textContent.includes('Your design is ready at commit abc123.'),
    10,
    5000,
  );
  t.is(turns.length, 0, 'refreshing mail does not start a UI turn');
});

test.serial(
  'a delayed mail refresh cannot overwrite a new daemon-owned turn',
  async t => {
    const { parent, turns, send, setHistoryReader } = await setup(t);
    t.timeout(10_000);
    let refreshStarted = false;
    let release = () => {};
    const history = new Promise(resolve => {
      release = () =>
        resolve(harden([{ role: 'assistant', content: 'stale mail history' }]));
    });
    t.teardown(release);
    setHistoryReader(() => {
      refreshStarted = true;
      return history;
    });
    await waitForDOM(() => refreshStarted, 10, 5000);
    await send('Keep this active design discussion');
    await waitFor(() => turns.length === 1);
    release();
    await tick(30);
    t.true(parent.textContent.includes('Keep this active design discussion'));
    t.false(parent.textContent.includes('stale mail history'));
    t.truthy(parent.querySelector('[aria-label="Stop"]'));
  },
);

// ── Queued submissions ───────────────────────────────────────────────────────

test.serial(
  'a message sent mid-turn stays visible while it waits its turn',
  async t => {
    const { parent, turns, send, buttonLabelled } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await send('second question');
    await waitFor(() => parent.querySelector('.floot-msg-row.pending'));
    t.true(
      parent.textContent.includes('second question'),
      'the queued message renders in the transcript rather than vanishing',
    );
    // Position and muting carry "not sent yet"; a badge on every queued line
    // would just be noise.
    t.false(
      parent.textContent.includes('Pending'),
      'no badge: position and muting carry it',
    );
    for (const label of ['Send now', 'Edit', 'Delete']) {
      t.truthy(buttonLabelled(label), `offers ${label}`);
    }
    t.is(turns.length, 1, 'it has not started its own turn yet');

    // Finish the first turn; the queued message hands off to the turn it starts
    // and stays visible across the swap.
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    t.is(turns[1].text, 'second question');
    t.true(parent.textContent.includes('second question'));
    await waitFor(() => !parent.querySelector('.floot-msg-row.pending'));
    t.falsy(
      buttonLabelled('Send now'),
      'a running message is no longer queued',
    );
  },
);

test.serial('Send now cuts the running turn short', async t => {
  const { parent, turns, cancelledTurns, send, click } = await setup(t);
  await send('first');
  await waitFor(() => turns.length === 1);
  await send('jump the queue');
  await waitFor(() => parent.querySelector('.floot-msg-row.pending'));
  click('Send now');
  await waitFor(() => cancelledTurns.length === 1);
  t.is(cancelledTurns[0], turns[0].ref, 'the turn ahead of it is cancelled');
  // A turn the user stopped ends cleanly, so its queued message runs next.
  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => turns.length === 2);
  t.is(turns[1].text, 'jump the queue');
});

test.serial(
  'only the message at the head of the queue can jump it',
  async t => {
    const { parent, turns, cancelledTurns, send, buttonLabelled } =
      await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await send('queued A');
    await send('queued B');
    await waitFor(
      () => parent.querySelectorAll('.floot-msg-row.pending').length === 2,
    );
    // Every entry runs the message it was scheduled with, so a "Send now" on B
    // would cancel the turn in front of A — throwing away that reply — and
    // still leave B waiting. The control belongs to the head alone.
    t.is(
      parent.querySelectorAll('button.floot-pending-action').length,
      2 * 2 + 1,
      'Edit and Delete on both, Send now on the head only',
    );
    t.truthy(buttonLabelled('Send now'));
    t.is(
      buttonLabelled('Send now')
        ?.closest('.floot-msg-row')
        ?.textContent.includes('queued A'),
      true,
      'the head is the one that offers it',
    );

    buttonLabelled('Send now')?.dispatchEvent(
      new testWindow.Event('click', { bubbles: true }),
    );
    await waitFor(() => cancelledTurns.length === 1);
    t.is(cancelledTurns[0], turns[0].ref);
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    t.is(turns[1].text, 'queued A', 'the head runs, in order');
  },
);

test.serial('editing a queued message is what actually runs', async t => {
  const { parent, turns, send, click, retype } = await setup(t);
  await send('first');
  await waitFor(() => turns.length === 1);
  await send('original wording');
  await waitFor(() => parent.querySelector('.floot-msg-row.pending'));
  click('Edit');
  await waitFor(() => parent.querySelector('textarea.floot-pending-input'));
  await retype('rewritten before it ran');
  await waitFor(() => parent.textContent.includes('rewritten before it ran'));
  t.false(parent.textContent.includes('original wording'));
  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => turns.length === 2);
  t.is(
    turns[1].text,
    'rewritten before it ran',
    'the turn runs the edit, not the text that was typed',
  );
});

test.serial(
  'an empty edit keeps the queued message rather than dropping it',
  async t => {
    const { parent, turns, send, click, retype } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await send('do not lose me');
    await waitFor(() => parent.querySelector('.floot-msg-row.pending'));
    click('Edit');
    await waitFor(() => parent.querySelector('textarea.floot-pending-input'));
    // Deleting has its own button; losing a message by clearing the box would
    // be a surprising way to lose one.
    await retype('   ');
    await waitFor(() => !parent.querySelector('textarea.floot-pending-input'));
    t.true(parent.textContent.includes('do not lose me'));
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    t.is(turns[1].text, 'do not lose me');
  },
);

test.serial('deleting a queued message skips its turn entirely', async t => {
  const { parent, turns, send, click } = await setup(t);
  await send('first');
  await waitFor(() => turns.length === 1);
  await send('never mind');
  await waitFor(() => parent.querySelector('.floot-msg-row.pending'));
  click('Delete');
  await waitFor(() => !parent.querySelector('.floot-msg-row.pending'));
  t.false(parent.textContent.includes('never mind'));
  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => parent.querySelector('[aria-label="Send"]'));
  t.is(
    turns.length,
    1,
    'the scheduled chain entry finds nothing and skips its turn',
  );
  // Dropping one must not poison the queue for what comes after it.
  await send('but this one runs');
  await waitFor(() => turns.length === 2);
  t.is(turns[1].text, 'but this one runs');
});

// ── Agent actions ────────────────────────────────────────────────────────────

test.serial("a turn's tool calls collapse into one group", async t => {
  const { parent, turns, send } = await setup(t);
  await send('run some tools');
  await waitFor(() => turns.length === 1);
  const { channel } = turns[0];
  channel.push(
    harden({
      type: 'tool_call',
      id: 'a',
      name: 'exec',
      args: JSON.stringify({ code: 'const x = 1;' }),
    }),
  );
  channel.push(harden({ type: 'tool_result', id: 'a', result: '1' }));
  channel.push(
    harden({ type: 'tool_call', id: 'b', name: 'exec', args: '{"code":"2"}' }),
  );
  channel.push(harden({ type: 'tool_result', id: 'b', result: '2' }));
  channel.push(
    harden({ type: 'tool_call', id: 'c', name: 'list', args: '{}' }),
  );
  channel.push(harden({ type: 'tool_result', id: 'c', result: '[]' }));
  await waitFor(() => parent.querySelector('.floot-actions'));

  t.is(
    parent.querySelectorAll('.floot-actions').length,
    1,
    'one group for the run between two replies',
  );
  const head = must(
    parent.querySelector('.floot-actions-head'),
    'action group header',
  );
  t.true(head.textContent.includes('3 actions'));
  t.true(head.textContent.includes('exec ×2, list'));
  t.is(head.getAttribute('aria-expanded'), 'false', 'closed by default');
  t.is(
    parent.querySelectorAll('.floot-action').length,
    0,
    'the raw JSON stays out of the way until asked for',
  );

  head.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  await waitFor(() => parent.querySelectorAll('.floot-action').length === 3);
  // Each action is one entry pairing its call with its result, still collapsed.
  t.is(
    must(parent.querySelector('.floot-action-name'), 'action name').textContent,
    'exec',
  );
  t.falsy(parent.querySelector('.floot-action-body'));

  must(
    parent.querySelector('.floot-action-head'),
    'action header',
  ).dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  await waitFor(() => parent.querySelector('.floot-action-body'));
  const body = must(
    parent.querySelector('.floot-action-body'),
    'expanded action body',
  );
  t.true(body.textContent.includes('javascript'), 'exec unwraps to its source');
  t.true(body.textContent.includes('const x = 1;'));
  t.truthy(
    body.querySelector('.floot-tok-keyword'),
    'the JavaScript is syntax-highlighted',
  );
});

// ── Screen wake lock ─────────────────────────────────────────────────────────

/**
 * Install a `navigator.wakeLock` stand-in for the duration of one test. The
 * component reads `globalThis.navigator?.wakeLock` afresh on every apply, and
 * `navigator` stays configurable after lockdown, so this is what lets the
 * wiring be exercised at all: under plain Node the API is absent and every
 * request short-circuits.
 *
 * @param {ExecutionContext} t
 * @param {number} [latencyMs] how long `request()` takes to resolve
 */
const stubWakeLock = (t, latencyMs = 0) => {
  const sentinels = [];
  const wakeLock = {
    request: () =>
      new Promise(resolve => {
        const sentinel = {
          released: false,
          release: () => {
            sentinel.released = true;
            return Promise.resolve();
          },
          addEventListener: () => {},
        };
        sentinels.push(sentinel);
        testWindow.setTimeout(() => resolve(sentinel), latencyMs);
      }),
  };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { wakeLock },
    configurable: true,
  });
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete (/** @type {any} */ (globalThis).navigator);
  });
  return {
    sentinels,
    get held() {
      return sentinels.filter(sentinel => !sentinel.released);
    },
  };
};

test.serial('a busy turn holds exactly one screen lock', async t => {
  // The lock is driven by `notify()`, which fires many times per turn. Each
  // surplus request would be a lock held by the platform that this component
  // can no longer reach, which is the battery bug the policy exists to avoid.
  const lock = stubWakeLock(t, 5);
  const { parent, turns, send } = await setup(t);
  t.deepEqual(lock.held, [], 'an idle session holds nothing');

  await send('keep the screen on');
  await waitFor(() => turns.length === 1);
  turns[0].channel.push(harden({ type: 'delta', text: 'thinking' }));
  turns[0].channel.push(harden({ type: 'delta', text: ' out' }));
  turns[0].channel.push(harden({ type: 'delta', text: ' loud' }));
  await waitFor(() => parent.textContent.includes('thinking out loud'));
  await waitFor(() => lock.held.length === 1);
  t.is(lock.sentinels.length, 1, 'one request for one busy stretch');

  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => parent.querySelector('[aria-label="Send"]'));
  await waitFor(() => lock.held.length === 0);
  t.pass();
});

test.serial('unmounting releases the screen lock', async t => {
  const lock = stubWakeLock(t);
  const { turns, send, remount } = await setup(t);
  await send('still running when we leave');
  await waitFor(() => turns.length === 1);
  await waitFor(() => lock.held.length === 1);
  // `remount` disposes the old component; the turn keeps running in the
  // background, but this view has no business holding the screen for it.
  remount();
  await waitFor(() => lock.held.length === 0);
  t.pass();
});
