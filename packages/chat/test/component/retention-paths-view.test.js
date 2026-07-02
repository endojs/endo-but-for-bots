// @ts-nocheck - Component test with happy-dom

/* global globalThis */

import '@endo/init/debug.js';

import test from 'ava';
import { h } from 'preact';
import { renderConfined } from '@endo/preact-container/renderer';
import {
  RetentionPathsView,
  sortRetentionPaths,
  retentionPathKey,
} from '@endo/spaces-util/retention-paths-view.js';
import { FormulaView } from '@endo/spaces-util/formula-view.js';

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
 * Poll until `predicate()` is true (or a timeout elapses, in which case the
 * caller's assertion reports the real difference).
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
 * Mount a vnode through the confined renderer and wait for it to appear.
 *
 * @param {import('preact').VNode} vnode
 * @param {string} appearSelector
 */
const renderInto = async (vnode, appearSelector) => {
  const $container = testDocument.createElement('div');
  testDocument.body.appendChild($container);
  renderConfined(vnode, $container);
  await waitFor(() => !!$container.querySelector(appearSelector));
  return $container;
};

// A two-hop pet-store path: endo (root) →pins  pins (pet-store)
// "shared-file"  shared-file (eval). Segments are delivered leaf-to-root,
// exactly as `EndoHost.listRetentionPaths` returns them (#284).
const petStorePath = [
  {
    groupMembers: ['shared-file-id'],
    formulaTypes: ['eval'],
    referencedBy: 'pins-id',
    labels: ['pet:shared-file'],
  },
  {
    groupMembers: ['pins-id'],
    formulaTypes: ['pet-store'],
    referencedBy: 'endo-id',
    labels: ['pins'],
  },
  { groupMembers: ['endo-id'], type: 'root', formulaTypes: ['endo'] },
];

// A cross-peer retention path: known-peers-store (root) →peer  bob (peer)
// →retention  shared-file (eval). Longer than the pet-store path, so it
// must sort *after* it.
const peerPath = [
  {
    groupMembers: ['shared-file-id'],
    formulaTypes: ['eval'],
    referencedBy: 'bob-id',
    labels: ['retention'],
  },
  {
    groupMembers: ['bob-id'],
    formulaTypes: ['peer'],
    referencedBy: 'known-peers-id',
    labels: ['peer'],
  },
  {
    groupMembers: ['extra-id'],
    formulaTypes: ['handle'],
    referencedBy: 'known-peers-id',
    labels: ['handle'],
  },
  {
    groupMembers: ['known-peers-id'],
    type: 'root',
    formulaTypes: ['pet-store'],
  },
];

test.serial('multiple paths render as a counted, sorted table', async t => {
  const $c = await renderInto(
    h(RetentionPathsView, { paths: [peerPath, petStorePath], state: 'ready' }),
    '.retention-paths-list',
  );

  // The heading shows the path count.
  const $count = $c.querySelector('.retention-paths-count');
  t.is($count.textContent, '2', 'count badge reflects path total');

  const $rows = [...$c.querySelectorAll('.retention-path')];
  t.is($rows.length, 2, 'one row per path');

  // Shortest path first: the 3-segment pet-store path sorts before the
  // 4-segment peer path even though it was passed second.
  t.regex($rows[0].textContent, /shared-file/);
  t.is(
    $rows[0].querySelectorAll('.retention-path-segment').length,
    3,
    'first row is the shorter (pet-store) path',
  );
  t.is(
    $rows[1].querySelectorAll('.retention-path-segment').length,
    4,
    'second row is the longer (peer) path',
  );

  // The root segment is marked; the target (leaf) segment is highlighted.
  const $firstRoot = $rows[0].querySelector('.retention-path-segment-root');
  t.regex($firstRoot.textContent, /endo-id/);
  t.regex($firstRoot.textContent, /\(root\)/);
  const $firstTarget = $rows[0].querySelector('.retention-path-segment-target');
  t.regex($firstTarget.textContent, /shared-file-id/);
  t.regex($firstTarget.textContent, /\(eval\)/);

  // Pet-store edges render as quoted names; field edges render as →field.
  const $petEdge = $rows[0].querySelector('.retention-path-edge-pet');
  t.is($petEdge.textContent, '"shared-file"');
  const $fieldEdges = [
    ...$rows[0].querySelectorAll('.retention-path-edge-field'),
  ].map(el => el.textContent);
  t.true($fieldEdges.includes('→pins'), 'field edge renders with arrow');
});

test.serial('a single path renders one row with count 1', async t => {
  const $c = await renderInto(
    h(RetentionPathsView, { paths: [petStorePath], state: 'ready' }),
    '.retention-paths-list',
  );
  t.is($c.querySelector('.retention-paths-count').textContent, '1');
  t.is($c.querySelectorAll('.retention-path').length, 1);
  // Banner names the root.
  t.regex(
    $c.querySelector('.retention-path-banner').textContent,
    /rooted at endo-id/,
  );
});

test.serial('the empty state reads as unretained, with no count', async t => {
  const $c = await renderInto(
    h(RetentionPathsView, { paths: [], state: 'ready' }),
    '.retention-paths-message',
  );
  t.falsy(
    $c.querySelector('.retention-paths-count'),
    'no count badge when there are no paths',
  );
  t.falsy($c.querySelector('.retention-path'), 'no path rows');
  t.regex(
    $c.querySelector('.retention-paths-message').textContent,
    /unretained/,
  );
});

test.serial('the loading state shows a loading message', async t => {
  const $c = await renderInto(
    h(RetentionPathsView, { state: 'loading' }),
    '.retention-paths-message',
  );
  t.regex($c.querySelector('.retention-paths-message').textContent, /Loading/);
  t.falsy($c.querySelector('.retention-path'));
});

test.serial('the error state surfaces the error message', async t => {
  const $c = await renderInto(
    h(RetentionPathsView, { state: 'error', error: 'daemon unreachable' }),
    '.retention-paths-message',
  );
  t.regex(
    $c.querySelector('.retention-paths-message').textContent,
    /daemon unreachable/,
  );
});

test.serial(
  'FormulaView embeds the table when retention props are supplied',
  async t => {
    const record = {
      type: 'eval',
      number: 'eval-1',
      properties: { source: { kind: 'literal', value: 'noop' } },
    };
    const $c = await renderInto(
      h(FormulaView, {
        record,
        onNavigateReference: () => {},
        retentionPaths: [petStorePath],
        retentionPathsState: 'ready',
      }),
      '.retention-paths',
    );
    // The base property view still renders alongside the new table.
    t.truthy($c.querySelector('.formula-view-property-list'));
    t.is($c.querySelectorAll('.retention-path').length, 1);
  },
);

test.serial(
  'FormulaView omits the table when no retention props are supplied',
  async t => {
    const record = {
      type: 'eval',
      number: 'eval-2',
      properties: { source: { kind: 'literal', value: 'noop' } },
    };
    const $c = await renderInto(
      h(FormulaView, { record, onNavigateReference: () => {} }),
      '.formula-view-property-list',
    );
    t.falsy(
      $c.querySelector('.retention-paths'),
      'no retention section without the props',
    );
  },
);

test('sortRetentionPaths orders shortest-first without mutating input', t => {
  const input = [peerPath, petStorePath];
  const sorted = sortRetentionPaths(input);
  t.is(sorted[0].length, 3, 'shortest path first');
  t.is(sorted[1].length, 4);
  t.deepEqual(input, [peerPath, petStorePath], 'input array is not mutated');
});

test('retentionPathKey is stable and distinguishes distinct paths', t => {
  t.is(retentionPathKey(petStorePath), retentionPathKey(petStorePath));
  t.not(retentionPathKey(petStorePath), retentionPathKey(peerPath));
});
