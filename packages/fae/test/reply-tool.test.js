// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { makeReplyTool } from '../src/tool-makers.js';

test('reply tool rejects empty reply content', async t => {
  const replyTool = makeReplyTool(
    harden({
      async reply() {
        t.fail('reply should not be sent for empty content');
      },
    }),
  );

  await t.throwsAsync(replyTool.execute({ messageNumber: 1 }), {
    message: 'strings must include at least one non-empty reply part',
  });
  await t.throwsAsync(replyTool.execute({ messageNumber: 1, strings: [''] }), {
    message: 'strings must include at least one non-empty reply part',
  });
});

test('reply tool sends non-empty reply content', async t => {
  /** @type {unknown[]} */
  const calls = [];
  const replyTool = makeReplyTool(
    harden({
      async reply(...args) {
        calls.push(args);
      },
    }),
  );

  await replyTool.execute({ messageNumber: 3, strings: ['ack'] });

  t.deepEqual(calls, [[3n, ['ack'], [], []]]);
});
