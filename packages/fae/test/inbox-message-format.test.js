// @ts-check

/**
 * Unit tests for the inbox message formatter. These tests exercise the pure
 * logic without a running daemon — the kind probe is stubbed.
 *
 *   yarn test test/inbox-message-format.test.js
 */

import '@endo/init/debug.js';

import test from 'ava';

import { buildInboxMessageContent } from '../src/inbox-message-format.js';

/**
 * @param {Record<string, 'tool' | 'value' | 'unknown'>} kindsById
 * @returns {(id: string | undefined) => Promise<'tool' | 'value' | 'unknown'>}
 */
const stubProbe = kindsById => async id => {
  if (!id) return 'unknown';
  return kindsById[id] || 'unknown';
};

test('package message interleaves strings with @-edge-names', async t => {
  const content = await buildInboxMessageContent(
    {
      number: 1,
      type: 'package',
      strings: ['use ', ' ', ' to read ', ''],
      names: ['read-file', 'list-dir', 'mount'],
      ids: ['id-rf', 'id-ld', 'id-m'],
    },
    stubProbe({ 'id-rf': 'tool', 'id-ld': 'tool', 'id-m': 'value' }),
  );
  t.true(
    content.startsWith(
      '[Inbox message #1] use @read-file @list-dir to read @mount',
    ),
    'prose preserves interleaved @-references',
  );
});

test('tool attachments get an adoptTool call with the correct messageNumber', async t => {
  const content = await buildInboxMessageContent(
    {
      number: 7,
      type: 'package',
      strings: ['', ''],
      names: ['read-file'],
      ids: ['id-rf'],
    },
    stubProbe({ 'id-rf': 'tool' }),
  );
  t.true(content.includes('Attached references'));
  t.true(
    content.includes(
      'adoptTool(messageNumber=7, edgeName="read-file", toolName="read-file")',
    ),
  );
  t.false(
    content.includes('adopt(messageNumber=7'),
    'tool kind should not suggest plain adopt',
  );
});

test('value attachments get an adopt call (not adoptTool)', async t => {
  const content = await buildInboxMessageContent(
    {
      number: 7,
      type: 'package',
      strings: ['', ''],
      names: ['mount'],
      ids: ['id-m'],
    },
    stubProbe({ 'id-m': 'value' }),
  );
  t.true(
    content.includes(
      'adopt(messageNumber=7, edgeName="mount", petName="mount")',
    ),
  );
  t.false(
    content.includes('adoptTool(messageNumber=7'),
    'value kind should not suggest adoptTool',
  );
});

test('unknown kind suggests trying both adoption tools', async t => {
  const content = await buildInboxMessageContent(
    {
      number: 3,
      type: 'package',
      strings: ['here is ', ''],
      names: ['mystery'],
      ids: ['id-mystery'],
    },
    stubProbe({}),
  );
  t.true(content.includes('mystery (kind=unknown)'));
  t.true(
    content.includes(
      'try adoptTool for capabilities or adopt for plain values',
    ),
  );
});

test('missing id for an attachment falls back to unknown kind without throwing', async t => {
  const content = await buildInboxMessageContent(
    {
      number: 4,
      type: 'package',
      strings: ['', ''],
      names: ['no-id'],
      ids: [],
    },
    stubProbe({}),
  );
  t.true(content.includes('no-id (kind=unknown)'));
});

test('package with zero attachments omits the attachment block entirely', async t => {
  const content = await buildInboxMessageContent(
    {
      number: 2,
      type: 'package',
      strings: ['hi fae'],
      names: [],
      ids: [],
    },
    stubProbe({}),
  );
  t.is(
    content,
    '[Inbox message #2] hi fae\n\nUse reply(messageNumber: 2, ...) to respond to this message.',
  );
});

test('non-package message renders a placeholder body and reply hint', async t => {
  const content = await buildInboxMessageContent(
    {
      number: 5,
      type: 'request',
    },
    stubProbe({}),
  );
  t.is(
    content,
    '[Inbox message #5] (request message)\n\nUse reply(messageNumber: 5, ...) to respond to this message.',
  );
});

test('every formatted message ends with the reply hint', async t => {
  const content = await buildInboxMessageContent(
    {
      number: 9,
      type: 'package',
      strings: ['look at ', ''],
      names: ['thing'],
      ids: ['id-t'],
    },
    stubProbe({ 'id-t': 'value' }),
  );
  t.true(
    content.endsWith(
      'Use reply(messageNumber: 9, ...) to respond to this message.',
    ),
  );
});
