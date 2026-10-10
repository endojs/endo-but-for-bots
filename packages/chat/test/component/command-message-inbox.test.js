// @ts-nocheck - Component test with happy-dom

import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { makePromiseKit } from '@endo/promise-kit';
import { createDOM, tick } from '../helpers/dom-setup.js';
import { inboxComponent } from '../../inbox-component.js';

const { document: testDocument } = createDOM();

// renderConfined defers with requestAnimationFrame; dom-setup stubs setTimeout
// but not rAF, so provide a setTimeout-backed shim as a real browser would.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = fn =>
    globalThis.setTimeout(() => fn(0), 0);
  globalThis.cancelAnimationFrame = id => globalThis.clearTimeout(id);
}

/**
 * Poll until `predicate()` is true (or a timeout elapses), since the
 * confined view renders asynchronously.
 */
const waitFor = async (predicate, { timeout = 3000, step = 20 } = {}) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) return;
    // eslint-disable-next-line no-await-in-loop
    await tick(step);
  }
};

const SELF_ID = 'host-handle-id';
const SELF_LOCATOR = `endo://localhost/?id=${SELF_ID}&type=handle`;

/**
 * Build a mock powers object whose message iterator yields the given
 * messages in order, then blocks.
 *
 * @param {object[]} messages
 */
const makeCommandPowers = messages => {
  /** @type {Array<{method: string, args: unknown[]}>} */
  const calls = [];
  const powers = Far('MockPowers', {
    locate(...path) {
      if (path.length === 1 && path[0] === '@self') {
        return SELF_LOCATOR;
      }
      return undefined;
    },
    async reverseLocate(locator) {
      if (locator.includes(SELF_ID)) return ['@self'];
      return [];
    },
    followMessages() {
      let index = 0;
      return readerFromIterator(
        Far('MessageIterator', {
          next() {
            if (index < messages.length) {
              const value = messages[index];
              index += 1;
              return Promise.resolve({ value, done: false });
            }
            return new Promise(() => {});
          },
        }),
      );
    },
    dismiss(number) {
      calls.push({ method: 'dismiss', args: [number] });
      return Promise.resolve();
    },
  });
  return { powers, calls };
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

/**
 * @param {object} fields
 */
const makeSelfMessage = fields => {
  const dismissedKit = makePromiseKit();
  return {
    message: {
      from: SELF_LOCATOR,
      to: SELF_LOCATOR,
      date: new Date(0).toISOString(),
      names: [],
      ids: [],
      dismissed: dismissedKit.promise,
      ...fields,
    },
    dismiss: () => dismissedKit.resolve(),
  };
};

test.serial(
  'command and command-result messages render as threaded cards',
  async t => {
    const { $parent, $end } = createInboxDOM();

    const command = makeSelfMessage({
      type: 'command',
      number: 4n,
      messageId: 'a'.repeat(64),
      commandName: 'adopt',
      args: { messageNumber: '3', edgeName: 'gift', petName: 'my-gift' },
      strings: ['adopt'],
    });
    const result = makeSelfMessage({
      type: 'command-result',
      number: 5n,
      messageId: 'b'.repeat(64),
      replyTo: 'a'.repeat(64),
      success: true,
      summary: 'adopted as my-gift',
      strings: ['adopted as my-gift'],
    });

    const { powers } = makeCommandPowers([command.message, result.message]);
    inboxComponent($parent, $end, powers, { showValue: () => {} });
    await waitFor(
      () => $parent.querySelectorAll('.command-message').length === 2,
    );

    const $envelopes = $parent.querySelectorAll('.message-envelope');
    t.is($envelopes.length, 2);

    const [$commandEnvelope, $resultEnvelope] = $envelopes;
    t.true($commandEnvelope.classList.contains('command-envelope'));
    t.true($resultEnvelope.classList.contains('command-envelope'));

    // Self-addressed records render on the sent side of the transcript.
    t.truthy($commandEnvelope.querySelector('.message.sent'));
    t.truthy($resultEnvelope.querySelector('.message.sent'));

    // The result is threaded to its command by messageId.
    t.is($commandEnvelope.dataset.messageId, 'a'.repeat(64));
    t.is($resultEnvelope.dataset.replyTo, 'a'.repeat(64));

    const $commandCard = $commandEnvelope.querySelector('.command-message');
    t.is($commandCard.className, 'command-message');
    t.is($commandCard.querySelector('.command-icon').textContent, '◐');
    t.is(
      $commandCard.querySelector('.command-text').textContent,
      'adopt 3 gift my-gift',
    );

    const $resultCard = $resultEnvelope.querySelector('.command-message');
    t.is($resultCard.className, 'command-message success');
    t.is($resultCard.querySelector('.command-icon').textContent, '✓');
    t.is(
      $resultCard.querySelector('.command-text').textContent,
      'adopted as my-gift',
    );
  },
);

test.serial('failed command-result renders an error card', async t => {
  const { $parent, $end } = createInboxDOM();

  const result = makeSelfMessage({
    type: 'command-result',
    number: 1n,
    messageId: 'c'.repeat(64),
    replyTo: 'd'.repeat(64),
    success: false,
    summary: 'No formula exists for the pet name "nope"',
    strings: ['No formula exists for the pet name "nope"'],
  });

  const { powers } = makeCommandPowers([result.message]);
  inboxComponent($parent, $end, powers, { showValue: () => {} });
  await waitFor(() => $parent.querySelector('.command-message'));

  const $card = $parent.querySelector('.command-message');
  t.truthy($card);
  t.is($card.className, 'command-message error');
  t.is($card.querySelector('.command-icon').textContent, '✗');
});

test.serial(
  'command cards keep the dismiss control and leave on dismissal',
  async t => {
    const { $parent, $end } = createInboxDOM();

    const command = makeSelfMessage({
      type: 'command',
      number: 9n,
      messageId: 'e'.repeat(64),
      commandName: 'dismiss',
      args: { messageNumber: '2' },
      strings: ['dismiss'],
    });

    const { powers, calls } = makeCommandPowers([command.message]);
    inboxComponent($parent, $end, powers, { showValue: () => {} });
    await waitFor(() => $parent.querySelector('.dismiss-button'));

    const $dismiss = $parent.querySelector('.dismiss-button');
    t.truthy($dismiss);
    $dismiss.click();
    await tick(20);
    t.deepEqual(
      calls.filter(c => c.method === 'dismiss').map(c => c.args),
      [[9n]],
    );

    command.dismiss();
    await waitFor(() => $parent.querySelector('.command-message') === null);
    t.is($parent.querySelector('.command-message'), null);
  },
);
