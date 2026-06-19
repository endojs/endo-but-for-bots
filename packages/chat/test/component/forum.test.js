// @ts-nocheck - Component test with happy-dom
/* global globalThis */
/* eslint-disable no-underscore-dangle */

import '@endo/init/debug.js';

import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import test from 'ava';
import { Far } from '@endo/far';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { createDOM, tick } from '../helpers/dom-setup.js';

// forum-component composes channel-utils, which imports `colorize` from
// `@endo/monaco-wrapper` (for syntax-coloring markdown code fences). Monaco
// cannot run under happy-dom and `monaco-editor` is not installed in this
// workspace, so — exactly as define-form.test.js does — redirect the
// monaco-wrapper specifier to test/helpers/monaco-wrapper-stub.js via a Node
// loader registered BEFORE forum-component is dynamically imported. The stub's
// `colorize` is the identity function, which is all the forum's message bodies
// need here.

const here = dirname(fileURLToPath(import.meta.url));
const stubUrl = pathToFileURL(
  resolvePath(here, '../helpers/monaco-wrapper-stub.js'),
).href;

register(
  new URL(
    `data:text/javascript,${encodeURIComponent(`
      const stubUrl = ${JSON.stringify(stubUrl)};
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === '@endo/monaco-wrapper' || specifier.endsWith('/monaco-wrapper.js') || specifier === './monaco-wrapper.js') {
          return { url: stubUrl, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
    `)}`,
  ),
);

// Dynamically imported AFTER the loader is registered so channel-utils'
// `import { colorize } from '@endo/monaco-wrapper'` resolves to the stub.
const { forumComponent } = await import('../../forum-component.js');

const { document: testDocument, cleanup: cleanupDOM } = createDOM();

// Globals the component expects.
if (!globalThis.CSS) {
  globalThis.CSS = { escape: s => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
}
// renderConfined renders through Preact; some of its idioms defer with
// requestAnimationFrame. dom-setup stubs setTimeout but not rAF; provide a
// setTimeout-backed shim, as a real browser would.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = fn => globalThis.setTimeout(() => fn(0), 0);
  globalThis.cancelAnimationFrame = id => globalThis.clearTimeout(id);
}

/**
 * Poll until `predicate()` is true (or a timeout elapses, in which case the
 * caller's assertion reports the real difference). Preact effect flushes and
 * the controller's re-renders are async on slower CI runners, so a fixed delay
 * races; polling the actual condition is robust (mirrors the other component
 * tests' `waitFor`).
 *
 * @param {() => boolean} predicate
 * @param {{ timeout?: number, step?: number }} [opts]
 */
const waitFor = async (predicate, { timeout = 3000, step = 20 } = {}) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) return;
    // eslint-disable-next-line no-await-in-loop
    await tick(step);
  }
};

/**
 * Create a controllable mock channel: messages are pushed manually via
 * pushMessage() and consumed by the component's for-await-of loop. No real
 * powers are involved.
 *
 * @param {object} [opts]
 * @param {string} [opts.name]
 */
const makeMockChannel = ({ name = 'test-forum' } = {}) => {
  const members = new Map();
  /** @type {unknown[]} */
  const messageQueue = [];
  /** @type {Array<(msg: unknown) => void>} */
  const waitingResolvers = [];
  const posted = [];

  const pushMessage = msg => {
    if (waitingResolvers.length > 0) {
      const resolve = waitingResolvers.shift();
      resolve(msg);
    } else {
      messageQueue.push(msg);
    }
  };

  const messagesIterator = Far('MessagesIterator', {
    next() {
      if (messageQueue.length > 0) {
        return Promise.resolve({ value: messageQueue.shift(), done: false });
      }
      return new Promise(resolve => {
        waitingResolvers.push(msg => resolve({ value: msg, done: false }));
      });
    },
    return() {
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err) {
      return Promise.reject(err);
    },
  });

  const channel = Far('MockChannel', {
    getProposedName() {
      return name;
    },
    getMember(memberId) {
      return members.get(memberId);
    },
    getMembers() {
      return [...members.entries()].map(([id, info]) => ({
        memberId: id,
        ...info,
      }));
    },
    followMessages() {
      return readerFromIterator(messagesIterator);
    },
    post(strings, names, ids, replyTo, edgeNames, replyType) {
      posted.push({ strings, names, ids, replyTo, replyType });
      return undefined;
    },
  });

  return { channel, pushMessage, members, posted };
};

/**
 * @param {number} number
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.memberId]
 * @param {number|string} [opts.replyTo]
 * @param {string} [opts.replyType]
 */
const makeMessage = (number, text, opts = {}) => ({
  type: 'package',
  messageId: `msg-${number}`,
  number: BigInt(number),
  date: new Date().toISOString(),
  memberId: opts.memberId || 'member-1',
  strings: [text],
  names: [],
  ids: [],
  ...(opts.replyTo !== undefined ? { replyTo: String(opts.replyTo) } : {}),
  ...(opts.replyType !== undefined ? { replyType: opts.replyType } : {}),
});

/**
 * Mount a fresh forum component exactly as chat.js does:
 * forumComponent($parent, $end, channel, options).
 */
const setup = async () => {
  testDocument.body.innerHTML = '';

  const $parent = testDocument.createElement('div');
  $parent.id = 'messages';
  testDocument.body.appendChild($parent);

  const $end = testDocument.createElement('div');
  $end.id = 'anchor';
  $parent.appendChild($end);

  const { channel, pushMessage, members, posted } = makeMockChannel();
  members.set('member-1', {
    proposedName: 'Alice',
    pedigree: [],
    pedigreeMemberIds: [],
  });
  members.set('member-2', {
    proposedName: 'Bob',
    pedigree: [],
    pedigreeMemberIds: [],
  });

  const replyCallbacks = [];
  const shownValues = [];

  forumComponent($parent, $end, channel, {
    showValue: (...args) => shownValues.push(args),
    personaId: 'test-persona',
    ownMemberId: 'member-1',
    onReply: info => replyCallbacks.push(info),
    onFork: async () => {},
    onShare: () => {},
  }).catch(err => {
    console.error('forumComponent error:', err);
  });

  // Wait for async setup (createChannelState, followMessages).
  await tick(50);

  const push = async (msg, ms = 80) => {
    pushMessage(msg);
    await tick(ms);
  };

  return { $parent, push, replyCallbacks, shownValues, posted };
};

test.afterEach(() => {
  testDocument.body.innerHTML = '';
});

test.after(() => {
  cleanupDOM();
});

// ---- Layout ----

test.serial('forum view is inserted before the scroll anchor', async t => {
  const { $parent, push } = await setup();
  await push(makeMessage(1, 'Hello forum'));
  await waitFor(() => !!$parent.querySelector('.forum-view'));

  const $view = $parent.querySelector('.forum-view');
  const $anchor = $parent.querySelector('#anchor');
  t.truthy($view, 'forum-view should exist');
  t.truthy($anchor, 'anchor should exist');

  const children = [...$parent.childNodes];
  // The dedicated mount holding `.forum-view` must precede the anchor so
  // chat.js's switchChannel cleanup (which clears up to $end) works.
  const viewIdx = children.findIndex(c => c.contains && c.contains($view));
  const anchorIdx = children.indexOf($anchor);
  t.true(
    viewIdx < anchorIdx,
    `forum view (${viewIdx}) should be before anchor (${anchorIdx})`,
  );
});

// ---- Basic rendering ----

test.serial('a root message renders as a forum node', async t => {
  const { $parent, push } = await setup();
  await push(makeMessage(1, 'Root message'));
  await waitFor(() => $parent.querySelectorAll('.forum-node').length === 1);

  const $nodes = $parent.querySelectorAll('.forum-node');
  t.is($nodes.length, 1, 'one forum node');
  t.true($nodes[0].classList.contains('depth-0'), 'root is depth-0');
  t.is($nodes[0].dataset.msgKey, '1', 'data-msg-key preserved');

  // The imperative message host node is re-parented into the node's anchor.
  const $anchor = $nodes[0].querySelector('[data-forum-anchor="1"]');
  t.truthy($anchor, 'node has a forum anchor');
  t.truthy(
    $anchor.querySelector('.message-wrapper'),
    'imperative message host re-parented into the anchor',
  );
  t.true(
    $nodes[0].textContent.includes('Root message'),
    'message body rendered',
  );
});

test.serial('a reply nests as a deeper forum node', async t => {
  const { $parent, push } = await setup();
  await push(makeMessage(1, 'Root'));
  await push(makeMessage(2, 'A reply', { replyTo: 1 }));
  await waitFor(() => $parent.querySelectorAll('.forum-node').length === 2);

  const $nodes = $parent.querySelectorAll('.forum-node');
  t.is($nodes.length, 2, 'root and reply');
  const byKey = Object.fromEntries(
    [...$nodes].map(n => [n.dataset.msgKey, n]),
  );
  t.true(byKey['1'].classList.contains('depth-0'), 'root depth-0');
  t.true(byKey['2'].classList.contains('depth-1'), 'reply depth-1');
});

test.serial('reply button calls onReply', async t => {
  const { $parent, push, replyCallbacks } = await setup();
  await push(makeMessage(1, 'Reply to me'));
  await waitFor(() => !!$parent.querySelector('.message-action-btn'));

  $parent.querySelector('.message-action-btn').click();
  await tick(20);

  t.is(replyCallbacks.length, 1, 'onReply fired once');
  t.is(replyCallbacks[0].number, 1n, 'references the right message');
  t.is(replyCallbacks[0].preview, 'Reply to me');
});

// ---- Collapse handle ----

test.serial('collapse handle shows reply count and toggles', async t => {
  const { $parent, push } = await setup();
  await push(makeMessage(1, 'Root'));
  await push(makeMessage(2, 'Child', { replyTo: 1 }));
  await waitFor(() => !!$parent.querySelector('.forum-collapse-handle'));

  const $handle = $parent.querySelector('.forum-collapse-handle');
  t.truthy($handle, 'collapse handle exists on a parent node');
  t.true($handle.textContent.includes('1 reply'), 'shows the descendant count');

  // Collapsing hides the child node.
  $handle.click();
  await waitFor(
    () =>
      !![...$parent.querySelectorAll('.forum-node')].find(
        n => n.dataset.msgKey === '1' && n.classList.contains('collapsed'),
      ),
  );
  const $root = [...$parent.querySelectorAll('.forum-node')].find(
    n => n.dataset.msgKey === '1',
  );
  t.true($root.classList.contains('collapsed'), 'root marked collapsed');
  t.falsy(
    [...$parent.querySelectorAll('.forum-node')].find(
      n => n.dataset.msgKey === '2',
    ),
    'collapsed child node is not rendered',
  );

  // Expanding restores it.
  $root.querySelector('.forum-collapse-handle').click();
  await waitFor(
    () =>
      !![...$parent.querySelectorAll('.forum-node')].find(
        n => n.dataset.msgKey === '2',
      ),
  );
  t.truthy(
    [...$parent.querySelectorAll('.forum-node')].find(
      n => n.dataset.msgKey === '2',
    ),
    'child node restored after expand',
  );
});

// ---- Edit attribution ----

test.serial('an edit message adds "edited by" attribution', async t => {
  const { $parent, push } = await setup();
  await push(makeMessage(1, 'Original'));
  await push(
    makeMessage(2, 'Edited text', { replyTo: 1, replyType: 'edit' }),
  );
  await waitFor(() => !!$parent.querySelector('.forum-edited-by'));

  const $edited = $parent.querySelector('.forum-edited-by');
  t.truthy($edited, 'edited-by attribution rendered');
  t.true(
    $edited.textContent.startsWith('edited by'),
    `attribution text, got "${$edited.textContent}"`,
  );

  // The edit is not itself a visible tree node.
  const keys = [...$parent.querySelectorAll('.forum-node')].map(
    n => n.dataset.msgKey,
  );
  t.false(keys.includes('2'), 'edit message is not a tree node');
});

// ---- React system wiring ----

test.serial('each node carries a react button', async t => {
  const { $parent, push } = await setup();
  await push(makeMessage(1, 'React to me'));
  await waitFor(() => !!$parent.querySelector('.react-button'));
  t.truthy(
    $parent.querySelector('.react-button'),
    'react button injected into the message action bar',
  );
});

test.serial('a react message renders a react pill', async t => {
  const { $parent, push } = await setup();
  await push(makeMessage(1, 'Root'));
  await push(
    makeMessage(2, '👍', {
      replyTo: '1',
      replyType: 'react',
      memberId: 'member-2',
    }),
  );
  await waitFor(() => !!$parent.querySelector('.react-pill'));
  t.truthy(
    $parent.querySelector('.react-pill'),
    'react pill rendered for the reacted message',
  );
});

// ---- Teardown ----

test.serial('dispose() unmounts the forum and clears channelAPI work', async t => {
  const { $parent, push } = await setup();
  await push(makeMessage(1, 'Root'));
  await waitFor(() => !!$parent.querySelector('.forum-view'));

  t.truthy($parent.channelAPI, 'channelAPI exposed on $parent');
  t.is($parent.channelAPI.closeThread(), false, 'closeThread() returns false');

  $parent.channelAPI.dispose();
  await tick(20);

  t.falsy(
    $parent.querySelector('.forum-view'),
    'forum view removed after dispose',
  );
});
