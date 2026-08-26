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

// The view draws a node as a 150x40 box at each position, and a routed edge as
// a polyline through `routes`. This is the property the routing exists for.
const NODE_WIDTH = 150;
const NODE_HEIGHT = 40;

/**
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @param {{x: number, y: number}} box
 */
const segmentEntersBox = (a, b, box) => {
  for (let step = 0; step <= 40; step += 1) {
    const x = a.x + (b.x - a.x) * (step / 40);
    const y = a.y + (b.y - a.y) * (step / 40);
    if (
      x > box.x &&
      x < box.x + NODE_WIDTH &&
      y > box.y &&
      y < box.y + NODE_HEIGHT
    ) {
      return true;
    }
  }
  return false;
};

test('a routed edge never passes through an unrelated state', t => {
  // The deploy charts' shape: several states converge on one late compensation
  // state, so their edges span most of the diagram. Drawn as straight chords
  // they crossed whatever sat in between.
  const graph = {
    nodes: [
      { id: 'pin' },
      { id: 'prebuild' },
      { id: 'build' },
      { id: 'await-approval' },
      { id: 'apply' },
      { id: 'verify' },
      { id: 'unpinning' },
      { id: 'done' },
    ],
    edges: [
      { from: 'pin', to: 'prebuild' },
      { from: 'prebuild', to: 'build' },
      { from: 'build', to: 'await-approval' },
      { from: 'await-approval', to: 'apply' },
      { from: 'apply', to: 'verify' },
      { from: 'verify', to: 'done' },
      { from: 'prebuild', to: 'unpinning' },
      { from: 'build', to: 'unpinning' },
      { from: 'await-approval', to: 'unpinning' },
    ],
  };
  const { positions, routes } = layoutGraph(graph, 'pin');
  const routed = Object.keys(routes);
  t.true(routed.length > 0, 'the long edges are routed, not drawn as chords');

  for (const index of routed) {
    const edge = graph.edges[index];
    const points = [
      {
        x: positions[edge.from].x + NODE_WIDTH,
        y: positions[edge.from].y + NODE_HEIGHT / 2,
      },
      ...routes[index],
      { x: positions[edge.to].x, y: positions[edge.to].y + NODE_HEIGHT / 2 },
    ];
    for (let i = 1; i < points.length; i += 1) {
      for (const node of graph.nodes) {
        if (node.id === edge.from || node.id === edge.to) continue;
        t.false(
          segmentEntersBox(points[i - 1], points[i], positions[node.id]),
          `${edge.from} -> ${edge.to} must not cross ${node.id}`,
        );
      }
    }
  }
});

test('parallel transitions share one lane', t => {
  // Three ways from `build` to `unpinning` are three labels along one path, not
  // three paths; a lane each turns the diagram into empty vertical space.
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'a', to: 'd', type: 'one' },
      { from: 'a', to: 'd', type: 'two' },
      { from: 'a', to: 'd', type: 'three' },
    ],
  };
  const { routes } = layoutGraph(graph, 'a');
  const lanes = new Set(Object.values(routes).map(route => JSON.stringify(route)));
  t.is(Object.keys(routes).length, 3, 'all three are routed');
  t.is(lanes.size, 1, 'and they share a single lane');
});

test('layout does not mutate the graph it is given', t => {
  // `renderGraph`'s output is hardened in production; routing adds edges for
  // its own ordering and must do that on a copy.
  const edges = harden([
    harden({ from: 'a', to: 'b' }),
    harden({ from: 'b', to: 'c' }),
    harden({ from: 'a', to: 'c' }),
  ]);
  const graph = harden({
    nodes: harden([harden({ id: 'a' }), harden({ id: 'b' }), harden({ id: 'c' })]),
    edges,
  });
  t.notThrows(() => layoutGraph(graph, 'a'));
  t.is(edges.length, 3, 'the caller keeps its own edges');
});
