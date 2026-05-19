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
      let delivered = false;
      return Far('MessageIterator', {
        next() {
          if (!delivered) {
            delivered = true;
            return Promise.resolve({ value: message, done: false });
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
