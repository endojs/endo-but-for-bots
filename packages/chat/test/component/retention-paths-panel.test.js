// @ts-nocheck - Component test with happy-dom

/* global globalThis */

import '@endo/init/debug.js';

import test from 'ava';
import { h } from 'preact';
import { renderConfined } from '@endo/preact-container/renderer';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import {
  RetentionPathsView,
  applyRetentionDelta,
  pathKey,
} from '@endo/spaces-util/retention-paths.js';
import { retentionPathsComponent } from '@endo/spaces-util/retention-paths-panel.js';

import { createDOM, tick } from '../helpers/dom-setup.js';

const { document: testDocument } = createDOM();

// renderConfined defers reconciliation with requestAnimationFrame; dom-setup
// stubs setTimeout but not rAF, so provide a setTimeout-backed shim as a real
// browser would.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = fn =>
    globalThis.setTimeout(() => fn(0), 0);
  globalThis.cancelAnimationFrame = id => globalThis.clearTimeout(id);
}

/**
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

// ── Fixtures ──────────────────────────────────────────────────────────────
// A RetentionPath is LEAF-FIRST: index 0 is the target value, the last segment
// is a GC root. Each non-root segment carries the edge labels INTO it from its
// upstream `referencedBy` group. These mirror the design's CLI example: a local
// pet-store pin path and a cross-peer retention path to the same `shared-file`.

// endo (root) →pins  pins (pet-store) "shared-file"  shared-file (eval).
const pinPath = harden([
  {
    groupMembers: ['eval-shared-file'],
    formulaTypes: ['eval'],
    referencedBy: 'petstore-pins',
    labels: ['pet:shared-file'],
  },
  {
    groupMembers: ['petstore-pins'],
    formulaTypes: ['pet-store'],
    referencedBy: 'endo-root',
    labels: ['pins'],
  },
  {
    groupMembers: ['endo-root'],
    formulaTypes: ['endo'],
    type: 'root',
  },
]);

// known-peers-store (root) →peer  bob (peer) retention  shared-file (eval).
const peerPath = harden([
  {
    groupMembers: ['eval-shared-file'],
    formulaTypes: ['eval'],
    referencedBy: 'peer-bob',
    labels: ['retention'],
  },
  {
    groupMembers: ['peer-bob'],
    formulaTypes: ['peer'],
    referencedBy: 'known-peers-store',
    labels: ['peer'],
  },
  {
    groupMembers: ['known-peers-store'],
    formulaTypes: ['known-peers-store'],
    type: 'root',
  },
]);

/**
 * Render `RetentionPathsView` through the confined renderer into a fresh node.
 *
 * @param {object} props
 */
const renderView = async props => {
  const $container = testDocument.createElement('div');
  testDocument.body.appendChild($container);
  renderConfined(h(RetentionPathsView, props), $container);
  await waitFor(() => !!$container.querySelector('.retention-paths-body'));
  return $container;
};

test.serial(
  'snapshot render: a single pin path shows segments and notation',
  async t => {
    const $c = await renderView({ state: 'ready', paths: [pinPath] });

    const blocks = $c.querySelectorAll('.retention-path-block');
    t.is(blocks.length, 1, 'one path block');

    const heading = $c.querySelector('.retention-path-heading');
    t.is(
      heading.textContent,
      'Path 1 (rooted at endo)',
      'heading names the root',
    );

    // Pet edge renders as a chip with the bold pet name + the parent store label.
    const petName = $c.querySelector('.retention-path-petname');
    t.is(petName.textContent, 'shared-file', 'bold pet name');
    t.truthy(
      $c.querySelector('.retention-path-petstore'),
      'pet chip carries the parent store label',
    );

    // Field edge renders as a grey arrow.
    const field = $c.querySelector('.retention-path-fieldedge');
    t.is(field.textContent, '→pins', 'field edge arrow');

    // Root and leaf are marked.
    t.truthy($c.querySelector('.retention-path-rootbadge'), 'root badge');
    t.truthy(
      $c.querySelector('.retention-path-segment-leaf'),
      'leaf highlighted',
    );
  },
);

test.serial(
  'multi-path render: cross-peer retention edge is tagged',
  async t => {
    const $c = await renderView({ state: 'ready', paths: [pinPath, peerPath] });

    t.is(
      $c.querySelectorAll('.retention-path-block').length,
      2,
      'two path blocks',
    );
    const tag = $c.querySelector('.retention-path-tag-retention');
    t.truthy(tag, 'cross-peer retention edge renders a retention tag');
    t.is(tag.textContent, 'retention');
  },
);

test.serial(
  'single-path render: exactly one block, no retention tag',
  async t => {
    const $c = await renderView({ state: 'ready', paths: [pinPath] });
    t.is($c.querySelectorAll('.retention-path-block').length, 1);
    t.falsy($c.querySelector('.retention-path-tag-retention'));
  },
);

test.serial('empty state: no retaining paths reads as unretained', async t => {
  const $c = await renderView({ state: 'ready', paths: [] });
  const empty = $c.querySelector('.retention-paths-empty');
  t.truthy(empty, 'empty state shown');
  t.regex(empty.textContent, /unretained/);
  t.is($c.querySelectorAll('.retention-path-block').length, 0);
});

test.serial(
  'delta engine: a coalesced added/removed delta folds in place',
  t => {
    // First the snapshot, then a delta that swaps the pin path for the peer path.
    let set = applyRetentionDelta(new Map(), harden({ snapshot: [pinPath] }));
    t.deepEqual([...set.keys()], [pathKey(pinPath)], 'snapshot seeds the set');

    set = applyRetentionDelta(
      set,
      harden({ added: [peerPath], removed: [pinPath] }),
    );
    t.deepEqual(
      [...set.keys()],
      [pathKey(peerPath)],
      'removed path drops out, added path folds in',
    );

    // An add of an already-present path is idempotent (same key, no duplicate).
    const again = applyRetentionDelta(set, harden({ added: [peerPath] }));
    t.is(again.size, 1, 'duplicate add does not grow the set');
  },
);

// A test-driven reader: an async generator whose deltas the test pushes, with a
// `finally` that records release. `readerFromIterator` wraps it so `iterateReader`
// inside the panel drives it through the real reader protocol (no CapTP).
const makeDeltaReader = () => {
  const state = { released: false };
  /** @type {RetentionPathDelta[]} */
  const queue = [];
  let resolveNext = null;
  let ended = false;
  const wake = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };
  const push = delta => {
    queue.push(delta);
    wake();
  };
  const end = () => {
    ended = true;
    wake();
  };
  async function* gen() {
    try {
      for (;;) {
        while (queue.length === 0 && !ended) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => {
            resolveNext = resolve;
          });
        }
        if (queue.length === 0 && ended) return undefined;
        yield queue.shift();
      }
    } finally {
      state.released = true;
    }
  }
  return { reader: readerFromIterator(gen()), push, end, state };
};

test.serial(
  'panel: subscribes, renders reactively, and releases on close',
  async t => {
    const $parent = testDocument.createElement('div');
    testDocument.body.appendChild($parent);

    const driver = makeDeltaReader();
    const powers = harden({
      // The descriptor carries an explicit locator, so resolution is trivial and
      // never touches locate/reverseIdentify.
      followRetentionPaths: _locator => driver.reader,
    });

    const panel = retentionPathsComponent($parent, powers);
    t.teardown(() => panel.dispose());

    panel.showPaths({
      locator: 'endo://node/0?type=eval',
      label: '@shared-file',
    });

    // The frame is revealed and a loading state renders immediately.
    const $frame = $parent.querySelector('.retention-paths-frame');
    t.is($frame.dataset.show, 'true', 'panel revealed');

    // First delta is the snapshot: one pin path renders reactively.
    driver.push(harden({ snapshot: [pinPath] }));
    await waitFor(() => !!$parent.querySelector('.retention-path-block'));
    t.is(
      $parent.querySelectorAll('.retention-path-block').length,
      1,
      'snapshot rendered one path',
    );

    // A subsequent delta adds the peer path: the list grows in place.
    driver.push(harden({ added: [peerPath], removed: [] }));
    await waitFor(
      () => $parent.querySelectorAll('.retention-path-block').length === 2,
    );
    t.is(
      $parent.querySelectorAll('.retention-path-block').length,
      2,
      'delta added a second path reactively',
    );

    // Closing the panel drops the far reference. As the design specifies, the
    // producer generator returns "on the next poll": a generator suspended
    // awaiting its change signal processes the consumer's `return()` when it next
    // wakes. Model that next poll, then assert the generator's `finally` ran.
    panel.dismissPaths();
    t.is($frame.dataset.show, 'false', 'panel hidden');
    driver.push(harden({ added: [], removed: [] }));
    await waitFor(() => driver.state.released);
    t.true(driver.state.released, 'subscription released on close');

    // Dismiss unmounts the panel body, and the post-dismiss delta is suppressed
    // (disposed loop), so nothing renders back into the hidden panel.
    t.is(
      $parent.querySelectorAll('.retention-path-block').length,
      0,
      'panel body unmounted on dismiss; no late render',
    );
  },
);

test.serial(
  'panel: a value with no resolvable locator shows the unsupported state',
  async t => {
    const $parent = testDocument.createElement('div');
    testDocument.body.appendChild($parent);

    const powers = harden({
      locate: async () => undefined,
      reverseIdentify: async () => harden([]),
      followRetentionPaths: () => {
        throw new Error('should not subscribe without a locator');
      },
    });

    const panel = retentionPathsComponent($parent, powers);
    t.teardown(() => panel.dispose());

    // An ephemeral value: only an id, which reverse-identifies to no names.
    panel.showPaths({ id: 'eval-ephemeral' });
    await waitFor(() => !!$parent.querySelector('.retention-paths-empty'));
    t.truthy(
      $parent.querySelector('.retention-paths-empty'),
      'unsupported/empty state for an unlocatable value',
    );
  },
);
