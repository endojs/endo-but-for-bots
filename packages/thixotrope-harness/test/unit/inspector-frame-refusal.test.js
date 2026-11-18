// @ts-check
// The inspector (guest/exec/inspect.js) when the hub refused an answer for
// size (core CC-027): the guest copy of the hub's text equals the core's
// FRAME_TOO_LARGE export; a granted tool's execute answer or a help()
// answer refused that way answers the model ANSWER_OVER_FRAME_TEXT; an
// error that only quotes the text, or any other error, keeps its old
// outcome.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';
import { FRAME_TOO_LARGE } from '@endo/thixotrope';

/* eslint-disable import/no-relative-packages */
import {
  ANSWER_OVER_FRAME_TEXT,
  HUB_FRAME_TOO_LARGE,
  makeInspector,
} from '../../guest/exec/inspect.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const refused = () => Error(HUB_FRAME_TOO_LARGE);

const inspector = () => {
  const made = makeInspector({
    writers: /** @type {any} */ (Far('BlobWriters', {})),
    content: undefined,
  });
  return {
    /** @param {any} request @returns {Promise<any>} */
    inspect: request => made.inspect(request),
  };
};

test('the guest copy of the hub text equals the core export', t => {
  t.is(HUB_FRAME_TOO_LARGE, FRAME_TOO_LARGE);
});

test('a granted tool answer refused for size answers the frame text', async t => {
  const { inspect } = inspector();
  const tool = Far('Tool', {
    execute: () => Promise.reject(refused()),
  });
  t.deepEqual(
    await inspect(harden({ op: 'toolExecute', target: tool, args: '{}' })),
    { status: 'failed', text: ANSWER_OVER_FRAME_TEXT },
  );
  // Only the exact message: a text that quotes it is an ordinary failure.
  const quoting = Far('Tool', {
    execute: () => Promise.reject(Error(`tool says: ${HUB_FRAME_TOO_LARGE}`)),
  });
  const other = await inspect(
    harden({ op: 'toolExecute', target: quoting, args: '{}' }),
  );
  t.is(other.status, 'failed');
  t.not(other.text, ANSWER_OVER_FRAME_TEXT);
});

test('a help() answer refused for size answers the frame text, with or without a method', async t => {
  const { inspect } = inspector();
  const big = Far('Big', {
    help: () => {
      throw refused();
    },
    read: () => 'x',
  });
  t.deepEqual(await inspect(harden({ op: 'describe', target: big })), {
    status: 'failed',
    text: ANSWER_OVER_FRAME_TEXT,
  });
  t.deepEqual(
    await inspect(harden({ op: 'describe', target: big, method: 'read' })),
    { status: 'failed', text: ANSWER_OVER_FRAME_TEXT },
  );
  // Any other help() failure keeps the methods, documentation unavailable.
  const failing = Far('Failing', {
    help: () => {
      throw Error('no help here');
    },
  });
  const described = await inspect(
    harden({ op: 'describe', target: failing }),
  );
  t.is(described.status, 'ok');
  t.is(JSON.parse(described.text).documentationScope, 'unavailable');
});
