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

test('reply collapse distinguishes completion and package shape', t => {
  const shared = harden(['Shared reply.']);
  const first = message({ number: 1n, messageId: 'first', strings: shared });
  const sharedReplay = message({
    number: 2n,
    messageId: 'shared-replay',
    strings: shared,
  });
  const notDone = message({
    number: 3n,
    messageId: 'not-done',
    strings: shared,
    done: false,
  });
  const noNames = message({
    number: 4n,
    messageId: 'no-names',
    strings: shared,
    names: undefined,
  });
  const moreIds = message({
    number: 5n,
    messageId: 'more-ids',
    strings: shared,
    ids: ['id'],
  });
  const notPackage = message({
    number: 6n,
    messageId: 'not-package',
    type: 'request',
  });
  const notPackageTwin = message({
    number: 7n,
    messageId: 'not-package-twin',
    type: 'request',
  });

  t.deepEqual(
    collapseRepublishedReplies([
      first,
      sharedReplay,
      notDone,
      noNames,
      moreIds,
      notPackage,
      notPackageTwin,
    ]),
    [first, notDone, noNames, moreIds, notPackage, notPackageTwin],
  );
});
