// @ts-check
import '@endo/init/debug.js';

import test from 'ava';

import { newestFirst, relativeAge } from '@endo/space-workflow';
import { layoutGraph } from '@endo/space-workflow';

const NOW = Date.parse('2026-08-26T12:00:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = ms => new Date(NOW - ms).toISOString();

test('the age label keeps scaling past a week', t => {
  t.is(relativeAge(ago(5 * SECOND), NOW), 'just now');
  t.is(relativeAge(ago(2 * MINUTE), NOW), '2m ago');
  t.is(relativeAge(ago(3 * HOUR), NOW), '3h ago');
  t.is(relativeAge(ago(3 * DAY), NOW), '3d ago');
  t.is(relativeAge(ago(10 * DAY), NOW), '1w ago');
  t.is(relativeAge(ago(40 * DAY), NOW), '1mo ago');
  t.is(relativeAge(ago(400 * DAY), NOW), '1y ago');
});

test('a missing or unparseable timestamp renders as nothing', t => {
  t.is(relativeAge(undefined, NOW), '');
  t.is(relativeAge('', NOW), '');
  t.is(relativeAge('not a date', NOW), '');
});

test('clock skew does not print a negative age', t => {
  // The daemon's clock can sit marginally ahead of the browser's.
  t.is(relativeAge(new Date(NOW + 30 * SECOND).toISOString(), NOW), 'just now');
});

test('the rail lists newest first', t => {
  const summaries = [
    { runId: 'older', updatedAt: ago(10 * MINUTE) },
    { runId: 'newest', updatedAt: ago(1 * MINUTE) },
    { runId: 'oldest', updatedAt: ago(3 * DAY) },
  ];
  t.deepEqual(
    newestFirst(summaries).map(summary => summary.runId),
    ['newest', 'older', 'oldest'],
  );
});

test('sorting leaves the input array alone', t => {
  const summaries = [
    { runId: 'a', updatedAt: ago(10 * MINUTE) },
    { runId: 'b', updatedAt: ago(1 * MINUTE) },
  ];
  newestFirst(summaries);
  t.deepEqual(
    summaries.map(summary => summary.runId),
    ['a', 'b'],
    'the caller keeps its own order',
  );
});

test('runs without a timestamp sort below those with one', t => {
  t.deepEqual(
    newestFirst([
      { runId: 'undated', seq: '3' },
      { runId: 'dated', updatedAt: ago(5 * MINUTE) },
    ]).map(summary => summary.runId),
    ['dated', 'undated'],
  );
  t.deepEqual(newestFirst([]), []);
  t.deepEqual(newestFirst(undefined), []);
});

test('layout places every node exactly once, left to right', t => {
  // The endo-release chart's shape: a spine with two compensation edges and a
  // loop back to the start.
  const graph = {
    nodes: [
      { id: 'pin' },
      { id: 'prebuild' },
      { id: 'build' },
      { id: 'await-approval' },
      { id: 'apply' },
      { id: 'unpinning' },
    ],
    edges: [
      { from: 'pin', to: 'prebuild' },
      { from: 'prebuild', to: 'build' },
      { from: 'build', to: 'await-approval' },
      { from: 'await-approval', to: 'apply' },
      { from: 'prebuild', to: 'unpinning' },
      { from: 'await-approval', to: 'unpinning' },
      { from: 'unpinning', to: 'pin' },
    ],
  };
  const { positions, width, height } = layoutGraph(graph, 'pin');

  const seen = new Set();
  for (const node of graph.nodes) {
    const at = positions[node.id];
    t.truthy(at, `${node.id} is placed`);
    const key = `${at.x},${at.y}`;
    t.false(seen.has(key), `${node.id} does not sit on top of another node`);
    seen.add(key);
  }
  t.true(positions.pin.layer < positions.build.layer, 'flows left to right');
  t.true(width > 0 && height > 0);
});

test('the same chart always lays out the same way', t => {
  // The picture is part of how a run is read; it must not shuffle between
  // renders.
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
    ],
  };
  t.deepEqual(layoutGraph(graph, 'a'), layoutGraph(graph, 'a'));
});
