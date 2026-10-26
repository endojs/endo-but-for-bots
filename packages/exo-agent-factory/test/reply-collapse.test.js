// @ts-check

/** @import { InboxMessage } from '../reply-collapse.js' */

import test from '@endo/ses-ava/prepare-endo.js';

import {
  collapseRepublishedReplies,
  makeReplyCollapseFilter,
} from '../reply-collapse.js';

/** @param {Partial<InboxMessage> & { number: bigint }} fields */
const message = fields =>
  harden({
    type: 'package',
    from: 'endo://agent/child',
    to: 'endo://agent/parent',
    replyTo: 'parent-message',
    done: true,
    strings: ['Same reply.'],
    names: [],
    ids: [],
    ...fields,
  });

test('reply collapse retains one byte-identical publication', t => {
  const first = message({ number: 1n, messageId: 'first' });
  const replay = message({ number: 2n, messageId: 'replay' });
  const otherSender = message({
    number: 3n,
    messageId: 'other-sender',
    from: 'endo://agent/sibling',
  });
  const otherParent = message({
    number: 4n,
    messageId: 'other-parent',
    replyTo: 'other-message',
  });
  const otherBytes = message({
    number: 5n,
    messageId: 'other-bytes',
    strings: ['Different reply.'],
  });
  const ordinary = message({
    number: 6n,
    messageId: 'ordinary',
    replyTo: undefined,
  });
  const ordinaryTwin = message({
    number: 7n,
    messageId: 'ordinary-twin',
    replyTo: undefined,
  });

  t.deepEqual(
    collapseRepublishedReplies([
      first,
      replay,
      otherSender,
      otherParent,
      otherBytes,
      ordinary,
      ordinaryTwin,
    ]),
    [first, otherSender, otherParent, otherBytes, ordinary, ordinaryTwin],
  );
});

test('stream filter makes the same first-publication choice', t => {
  const showReply = makeReplyCollapseFilter();
  const first = message({ number: 1n, messageId: 'first' });
  const replay = message({ number: 2n, messageId: 'replay' });
  t.true(showReply(first));
  t.false(showReply(replay));
});
