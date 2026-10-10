// @ts-nocheck - browser fixture with mock powers

// Browser-test fixture for the command-message transcript cards.
// Mounts the real inbox component against mock powers that yield a
// fixed set of `command` and `command-result` messages, so the
// Playwright case in browser-test/tests/ can assert real-browser
// rendering and styling without a daemon or gateway.
// See packages/chat/test/browser/README.md.

// Lock down the realm as main.js does: `@endo/preact-container` requires
// `overrideTaming: 'severe'`, which pre-lockdown.js selects before
// `@endo/init` runs `lockdown()` and installs HandledPromise.
import '../../pre-lockdown.js';
import '@endo/init';

import harden from '@endo/harden';
import { Far } from '@endo/far';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { inboxComponent } from '../../inbox-component.js';

const SELF_LOCATOR = 'endo://localhost/?id=host-handle-id&type=handle';
const never = new Promise(() => {});

const selfMessage = fields =>
  harden({
    from: SELF_LOCATOR,
    to: SELF_LOCATOR,
    date: new Date(0).toISOString(),
    names: [],
    ids: [],
    dismissed: never,
    ...fields,
  });

const COMMAND_ID = 'a'.repeat(64);
const FAILED_COMMAND_ID = 'c'.repeat(64);

const messages = [
  selfMessage({
    type: 'command',
    number: 0n,
    messageId: COMMAND_ID,
    commandName: 'adopt',
    args: { messageNumber: '3', edgeName: 'gift', petName: 'my-gift' },
    strings: ['adopt'],
  }),
  selfMessage({
    type: 'command-result',
    number: 1n,
    messageId: 'b'.repeat(64),
    replyTo: COMMAND_ID,
    success: true,
    summary: 'adopted as my-gift',
    strings: ['adopted as my-gift'],
  }),
  selfMessage({
    type: 'command',
    number: 2n,
    messageId: FAILED_COMMAND_ID,
    commandName: 'resolve',
    args: { messageNumber: '4', resolution: 'nope' },
    strings: ['resolve'],
  }),
  selfMessage({
    type: 'command-result',
    number: 3n,
    messageId: 'd'.repeat(64),
    replyTo: FAILED_COMMAND_ID,
    success: false,
    summary: 'No formula exists for the pet name "nope"',
    strings: ['No formula exists for the pet name "nope"'],
  }),
];

let delivered = 0;
const powers = Far('FixturePowers', {
  locate: () => SELF_LOCATOR,
  reverseLocate: async () => ['@self'],
  followMessages: () =>
    readerFromIterator(
      Far('MessageIterator', {
        next: () => {
          if (delivered < messages.length) {
            const value = messages[delivered];
            delivered += 1;
            return Promise.resolve(harden({ value, done: false }));
          }
          return never;
        },
      }),
    ),
  dismiss: async () => {},
});

const $parent = document.getElementById('inbox');
const $end = document.getElementById('inbox-end');
inboxComponent($parent, $end, powers, { showValue: () => {} }).catch(error => {
  document.body.dataset.fixtureError = String(error);
  console.error(error);
});

// The confined view renders asynchronously (pet-name lookups, then a Preact
// flush), so signal readiness once every message has a rendered card.
const readyPoll = setInterval(() => {
  if (
    $parent.querySelectorAll('.command-envelope .command-message').length ===
    messages.length
  ) {
    clearInterval(readyPoll);
    document.body.dataset.fixtureReady = 'true';
  }
}, 20);
