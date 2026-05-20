// @ts-nocheck - Component test with happy-dom
/* global globalThis */

/**
 * Tests for the chat-edit-message-ui design affordances rendered by
 * inbox-component.js:
 *  - data-sent and data-editable dataset attributes on outgoing
 *    envelopes (the focus-mode handler and any external consumer
 *    consult these instead of reaching into the inner classlist).
 *  - The hover pencil button alongside the dismiss x on outgoing
 *    settled messages.
 *  - The hover pencil button is suppressed on incoming messages and
 *    on mid-stream (`done: false`) outgoing messages.
 *  - Click on the pencil dispatches a chat:edit-message CustomEvent
 *    carrying the message number, which the chat-bar listens for.
 */

import 'ses';
import '@endo/eventual-send/shim.js';

import test from 'ava';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { createDOM, tick } from '../helpers/dom-setup.js';
import { inboxComponent } from '../../inbox-component.js';

const { document: testDocument } = createDOM();

/**
 * Build a mock powers object that yields one package message.
 *
 * @param {object} opts
 * @param {string} opts.selfId
 * @param {object} opts.message
 */
const makePackagePowers = ({ selfId, message }) => {
  return makePackagePowersFromList({ selfId, messages: [message] });
};

/**
 * Build a mock powers object that yields multiple package messages
 * in order, then blocks.  The inbox uses this to drive the swap-on-
 * edit path: emit the original envelope, let the DOM settle, then
 * emit the second envelope carrying the same `number` but a revised
 * body so the inbox sees the re-emission `editMessage` causes.
 *
 * @param {object} opts
 * @param {string} opts.selfId
 * @param {Array<object>} opts.messages
 */
const makePackagePowersFromList = ({ selfId, messages }) => {
  const powers = Far('MockPowers', {
    locate(...path) {
      if (path.length === 1 && path[0] === '@self') {
        return `endo://localhost/?id=${selfId}&type=handle`;
      }
      return undefined;
    },

    async reverseLocate(_locator) {
      return [];
    },

    followMessages() {
      let i = 0;
      return Far('MessageIterator', {
        next() {
          if (i < messages.length) {
            const value = messages[i];
            i += 1;
            return Promise.resolve({ value, done: false });
          }
          return new Promise(() => {});
        },
      });
    },

    dismiss(_n) {
      return Promise.resolve();
    },
  });
  return powers;
};

const createInboxDOM = () => {
  testDocument.body.innerHTML = '';
  const $parent = testDocument.createElement('div');
  $parent.id = 'inbox';
  $parent.scrollTo = () => {};
  Object.defineProperty($parent, 'scrollTop', { value: 0, writable: true });
  Object.defineProperty($parent, 'scrollHeight', { value: 100 });
  Object.defineProperty($parent, 'clientHeight', { value: 100 });
  testDocument.body.appendChild($parent);
  const $end = testDocument.createElement('div');
  $end.id = 'inbox-end';
  $parent.appendChild($end);
  return { $parent, $end };
};

const stubRAF = () => {
  globalThis.requestAnimationFrame = fn => {
    fn(0);
    return 0;
  };
};

const SELF_LOCATOR = 'endo://localhost/?id=self-id&type=handle';
const PEER_LOCATOR = 'endo://localhost/?id=peer-id&type=handle';

const makePackageMessage = (overrides = {}) => {
  const dismissedKit = makePromiseKit();
  return {
    type: 'package',
    number: 5n,
    date: new Date().toISOString(),
    from: SELF_LOCATOR,
    to: PEER_LOCATOR,
    messageId: '5',
    strings: ['hello'],
    names: [],
    ids: [],
    dismissed: dismissedKit.promise,
    done: true,
    ...overrides,
  };
};

test('outgoing settled message gets data-sent and data-editable plus pencil button', async t => {
  const { $parent, $end } = createInboxDOM();
  const message = makePackageMessage();
  const powers = makePackagePowers({ selfId: 'self-id', message });
  stubRAF();

  inboxComponent($parent, $end, powers, { showValue: () => {} });
  await tick(50);

  const $env = $parent.querySelector('.message-envelope[data-number="5"]');
  t.truthy($env);
  t.is($env.dataset.sent, 'true');
  t.is($env.dataset.editable, 'true');
  t.truthy($env.querySelector('.edit-button'));
});

test('incoming message has no data-sent and no pencil button', async t => {
  const { $parent, $end } = createInboxDOM();
  const message = makePackageMessage({ from: PEER_LOCATOR, to: SELF_LOCATOR });
  const powers = makePackagePowers({ selfId: 'self-id', message });
  stubRAF();

  inboxComponent($parent, $end, powers, { showValue: () => {} });
  await tick(50);

  const $env = $parent.querySelector('.message-envelope[data-number="5"]');
  t.truthy($env);
  t.is($env.dataset.sent, undefined);
  t.is($env.dataset.editable, undefined);
  t.is($env.querySelector('.edit-button'), null);
});

test('outgoing not-done (streaming) message is not editable per Design Decision 2', async t => {
  // Per chat-edit-message-ui Design Decision 2: the streaming sender
  // owns the message during a streaming session, and manual edits
  // race the agent's own edits.  The pencil is suppressed and `e` is
  // a no-op until the message settles.
  const { $parent, $end } = createInboxDOM();
  const message = makePackageMessage({ done: false });
  const powers = makePackagePowers({ selfId: 'self-id', message });
  stubRAF();

  inboxComponent($parent, $end, powers, { showValue: () => {} });
  await tick(50);

  const $env = $parent.querySelector('.message-envelope[data-number="5"]');
  t.truthy($env);
  // data-sent is still true (it reflects authorship), but data-editable
  // and the pencil are not.
  t.is($env.dataset.sent, 'true');
  t.is($env.dataset.editable, undefined);
  t.is($env.querySelector('.edit-button'), null);
});

test('pencil click dispatches chat:edit-message with the message number', async t => {
  const { $parent, $end } = createInboxDOM();
  const message = makePackageMessage({ number: 7n });
  const powers = makePackagePowers({ selfId: 'self-id', message });
  stubRAF();

  /** @type {Array<unknown>} */
  const events = [];
  const listener = ev => {
    events.push(ev.detail);
  };
  testDocument.addEventListener('chat:edit-message', listener);
  t.teardown(() => {
    testDocument.removeEventListener('chat:edit-message', listener);
  });

  inboxComponent($parent, $end, powers, { showValue: () => {} });
  await tick(50);

  const $edit = $parent.querySelector('.edit-button');
  t.truthy($edit);
  $edit.click();

  t.is(events.length, 1);
  t.is(events[0].number, 7n);
});

// Per chat-edit-message-ui design § Surfacing edit history: a
// re-emission of `followMessages` for the same `number` indicates the
// sender has edited the message.  The inbox swaps the existing
// envelope in place rather than appending a duplicate.  The added
// envelope carries an "edited <timestamp>" caption inside the
// timestamp tooltip.  This test exercises the load-bearing path the
// PR adds in inbox-component.js (the prior-envelope lookup, the
// caption insertion, and the replaceWith swap).
test('re-emission of a package message swaps the envelope in place rather than appending', async t => {
  const { $parent, $end } = createInboxDOM();
  const original = makePackageMessage({
    number: 11n,
    strings: ['hello'],
  });
  const edited = makePackageMessage({
    number: 11n,
    strings: ['hello, world'],
    date: new Date(Date.now() + 1000).toISOString(),
  });
  const powers = makePackagePowersFromList({
    selfId: 'self-id',
    messages: [original, edited],
  });
  stubRAF();

  inboxComponent($parent, $end, powers, { showValue: () => {} });
  await tick(50);

  const $envelopes = $parent.querySelectorAll(
    '.message-envelope[data-number="11"]',
  );
  t.is($envelopes.length, 1, 'edit must not append a duplicate envelope');
  const $edited = $envelopes[0];
  // The edited caption is materialized inside the timestamp tooltip
  // so a reader of the conversation knows the body changed without
  // having to open the (deferred) revision panel.
  const $caption = $edited.querySelector('.timestamp-edited');
  t.truthy($caption, 'edited envelope carries timestamp-edited caption');
  t.true(
    /^ edited /.test($caption.innerText),
    `caption text "${$caption.innerText}" begins with " edited "`,
  );
});

// Per chat-edit-message-ui design § Interaction with focus chains:
// the focused envelope stays focused across an edit, so the
// keyboard user's place in the conversation does not move when their
// own edit re-emits.  This pins the load-bearing branch that copies
// the `focused` class across the swap.
test('focus state survives a swap-on-edit', async t => {
  const { $parent, $end } = createInboxDOM();
  const original = makePackageMessage({
    number: 13n,
    strings: ['draft'],
  });
  const edited = makePackageMessage({
    number: 13n,
    strings: ['final'],
    date: new Date(Date.now() + 1000).toISOString(),
  });
  const powers = makePackagePowersFromList({
    selfId: 'self-id',
    messages: [original, edited],
  });
  stubRAF();

  inboxComponent($parent, $end, powers, { showValue: () => {} });
  // After the first emission, mark the original envelope focused so
  // the second emission's swap path has to preserve the class.  The
  // tick split here is the synchronization point between emissions:
  // it lets the iterator step through both messages with a moment
  // for the DOM mutation in between.
  await tick(10);
  const $first = $parent.querySelector('.message-envelope[data-number="13"]');
  t.truthy($first);
  $first.classList.add('focused');
  await tick(60);

  const $envelopes = $parent.querySelectorAll(
    '.message-envelope[data-number="13"]',
  );
  t.is($envelopes.length, 1);
  t.true(
    $envelopes[0].classList.contains('focused'),
    'edited envelope keeps focused class across the swap',
  );
});
