// @ts-check
import '@endo/init/debug.js';

import test from 'ava';

import {
  layoutGraph,
  newestFirst,
  relativeAge,
  NODE_HEIGHT,
  NODE_WIDTH,
} from '@endo/space-workflow';

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
  t.is(relativeAge(null, NOW), '');
  t.is(relativeAge('', NOW), '');
  t.is(relativeAge('not a date', NOW), '');
  t.is(relativeAge(new Date(NaN), NOW), '');
});

test('clock skew does not print a negative age', t => {
  // The daemon's clock can sit marginally ahead of the browser's.
  t.is(relativeAge(new Date(NOW + 30 * SECOND).toISOString(), NOW), 'just now');
});

test('the label never floors to a leading zero', t => {
  // Under a minute there is no whole unit to show. Flooring seconds to minutes
  // anywhere below sixty prints "0m ago", which reads as broken rather than as
  // recent, so the qualitative label has to hold until there is a 1 to show.
  for (const seconds of [44, 45, 50, 59]) {
    t.is(relativeAge(ago(seconds * SECOND), NOW), 'just now', `at ${seconds}s`);
  }
  t.is(relativeAge(ago(MINUTE), NOW), '1m ago');
  t.is(relativeAge(ago(HOUR), NOW), '1h ago');
  t.is(relativeAge(ago(DAY), NOW), '1d ago');
});

test('a timestamp sorts in whatever form it renders', t => {
  // `updatedAt` is untyped on the wire. Whichever forms the label accepts the
  // sort has to accept too: one the sort cannot read is treated as no
  // timestamp at all and sinks to the bottom of a rail that is happily
  // displaying its age.
  const epoch = NOW - 5 * MINUTE;
  for (const updatedAt of [
    new Date(epoch).toISOString(),
    epoch,
    new Date(epoch),
  ]) {
    t.is(relativeAge(updatedAt, NOW), '5m ago');
    t.deepEqual(
      newestFirst([{ runId: 'undated' }, { runId: 'dated', updatedAt }]).map(
        summary => summary.runId,
      ),
      ['dated', 'undated'],
      `${typeof updatedAt} timestamps order`,
    );
  }
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

// A position is the top-left corner of a NODE_WIDTH x NODE_HEIGHT box, and a
// routed edge is a polyline through `routes`. Keeping an unrelated state out of
// that polyline is the property the routing exists for.

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
    // The edge's own endpoints are the two boxes it is allowed to touch.
    const others = graph.nodes.filter(
      node => node.id !== edge.from && node.id !== edge.to,
    );
    for (let i = 1; i < points.length; i += 1) {
      for (const node of others) {
        t.false(
          segmentEntersBox(points[i - 1], points[i], positions[node.id]),
          `${edge.from} -> ${edge.to} must not cross ${node.id}`,
        );
      }
    }
  }
});

test('routing lanes are not reported as states', t => {
  // A lane is a slot in the layout, not a state. A caller drawing a box per
  // entry in `positions` must not find one to draw for a lane.
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'a', to: 'd' },
    ],
  };
  const { positions, routes } = layoutGraph(graph, 'a');
  t.true(Object.keys(routes).length > 0, 'the skipping edge is routed');
  t.deepEqual(
    Object.keys(positions).sort(),
    graph.nodes.map(node => node.id).sort(),
  );
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
  const lanes = new Set(
    Object.values(routes).map(route => JSON.stringify(route)),
  );
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
    nodes: harden([
      harden({ id: 'a' }),
      harden({ id: 'b' }),
      harden({ id: 'c' }),
    ]),
    edges,
  });
  t.notThrows(() => layoutGraph(graph, 'a'));
  t.is(edges.length, 3, 'the caller keeps its own edges');
});
