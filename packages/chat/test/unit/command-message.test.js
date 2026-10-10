// @ts-nocheck - happy-dom document

import '@endo/init/debug.js';

import test from 'ava';
import { h, render } from 'preact';
import {
  COMMAND_FAILURE_ICON,
  COMMAND_PENDING_ICON,
  COMMAND_SUCCESS_ICON,
  CommandCard,
  formatCommandText,
} from '@endo/space-chat';
import { createDOM } from '../helpers/dom-setup.js';

const { document: testDocument } = createDOM();

/**
 * Render a command card into a detached container and return the card
 * element.
 *
 * @param {object} message
 */
const renderCommandCard = message => {
  const $container = testDocument.createElement('div');
  render(h(CommandCard, { message }), $container);
  return $container.firstElementChild;
};

test('formatCommandText joins argument values in order', t => {
  t.is(
    formatCommandText('adopt', {
      messageNumber: '3',
      edgeName: 'gift',
      petName: 'my/gift',
    }),
    'adopt 3 gift my/gift',
  );
});

test('formatCommandText omits argument keys', t => {
  t.is(formatCommandText('dismiss', { messageNumber: '7' }), 'dismiss 7');
});

test('formatCommandText renders a bare command without args', t => {
  t.is(formatCommandText('dismiss', undefined), 'dismiss');
  t.is(formatCommandText('dismiss', {}), 'dismiss');
});

test('formatCommandText stringifies non-string values', t => {
  t.is(formatCommandText('resolve', { n: 1, ok: true }), 'resolve 1 true');
});

test('CommandCard renders a pending command card', t => {
  const $card = renderCommandCard({
    type: 'command',
    commandName: 'send',
    args: { to: 'alice', text: 'hello there' },
  });
  t.is($card.className, 'command-message');
  t.is($card.children.length, 2);
  const $icon = $card.querySelector('.command-icon');
  const $text = $card.querySelector('.command-text');
  t.is($icon.textContent, COMMAND_PENDING_ICON);
  t.is($text.textContent, 'send alice hello there');
});

test('CommandCard renders a successful result card', t => {
  const $card = renderCommandCard({
    type: 'command-result',
    success: true,
    summary: 'adopted as gift',
  });
  t.is($card.className, 'command-message success');
  t.is($card.querySelector('.command-icon').textContent, COMMAND_SUCCESS_ICON);
  t.is($card.querySelector('.command-text').textContent, 'adopted as gift');
});

test('CommandCard renders a failed result card', t => {
  const $card = renderCommandCard({
    type: 'command-result',
    success: false,
    summary: 'No formula exists for the pet name "nope"',
  });
  t.is($card.className, 'command-message error');
  t.is($card.querySelector('.command-icon').textContent, COMMAND_FAILURE_ICON);
  t.is(
    $card.querySelector('.command-text').textContent,
    'No formula exists for the pet name "nope"',
  );
});

test('CommandCard tolerates a missing summary', t => {
  const $card = renderCommandCard({
    type: 'command-result',
    success: true,
  });
  t.is($card.querySelector('.command-text').textContent, '');
});

test('CommandCard does not interpret markup in arguments', t => {
  const $card = renderCommandCard({
    type: 'command',
    commandName: 'send',
    args: { to: 'alice', text: '<img src=x onerror=alert(1)>' },
  });
  t.is($card.querySelector('img'), null);
  t.is(
    $card.querySelector('.command-text').textContent,
    'send alice <img src=x onerror=alert(1)>',
  );
});
