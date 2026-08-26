// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { renderGraph } from '@endo/workflow/src/graph.js';

import { layoutGraph } from './layout.js';

/** @import { VNode } from 'preact' */

const NODE_WIDTH = 150;
const NODE_HEIGHT = 40;
// Backward edges arc under the node band. Forward edges that span more than one
// column are ROUTED by the layout, through a lane of its own in each column
// they cross, so they never pass over an unrelated state.
const ARC_MARGIN = 64;

/**
 * A smooth path through a list of points, with horizontal control handles so it
 * reads as a flowing line rather than a dogleg.
 *
 * @param {Array<{ x: number, y: number }>} points
 * @returns {string}
 */
const smoothPath = points => {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const handle = Math.max(20, (b.x - a.x) / 2);
    d += ` C ${a.x + handle} ${a.y}, ${b.x - handle} ${b.y}, ${b.x} ${b.y}`;
  }
  return d;
};

/**
 * The ids of every active node in a run configuration: the top-level
 * state, nested children, and live parallel regions, named by the same
 * `/`-joined paths `renderGraph` uses.
 *
 * @param {any} configuration
 * @param {string} [prefix]
 * @param {string[]} [into]
 * @returns {string[]}
 */
export const activeIdsOf = (configuration, prefix = '', into = []) => {
  if (configuration === undefined || configuration === null) {
    return into;
  }
  const id =
    prefix === '' ? configuration.state : `${prefix}/${configuration.state}`;
  into.push(id);
  if (configuration.child !== undefined) {
    activeIdsOf(configuration.child, id, into);
  } else if (Array.isArray(configuration.regions)) {
    configuration.regions.forEach((region, i) => {
      if (!region.done) {
        activeIdsOf(region.config, `${id}/#${i}`, into);
      }
    });
  }
  return into;
};
harden(activeIdsOf);

/**
 * The chart rendered as an SVG statechart with live overlays: the
 * active path highlighted (scrubbed state solid, live state ghosted
 * while scrubbing), and nodes with pending effects pulsing.
 *
 * @param {{
 *   chart: any,
 *   configuration: any,
 *   liveConfiguration: any,
 *   outcome: string | undefined,
 *   pending: Array<{ effectId: string, path: string[] }>,
 * }} props
 * @returns {VNode}
 */
export const StatechartView = ({
  chart,
  configuration,
  liveConfiguration,
  outcome,
  pending,
}) => {
  const graph = renderGraph(chart);
  const { positions, routes, width, height } = layoutGraph(
    graph,
    chart.initial,
  );
  // `$eachParam` regions render once under a `#each` segment while the
  // runtime configuration and effect paths carry real indices (`#0`,
  // `#1`, …); fold runtime ids onto the drawn node when no literal node
  // matches, so overlays land on the representative region.
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const normalize = id =>
    nodeIds.has(id) ? id : id.replace(/#[0-9]+/g, '#each');
  const active = new Set(activeIdsOf(configuration).map(normalize));
  const live = new Set(activeIdsOf(liveConfiguration).map(normalize));
  const busy = new Set(
    (pending ?? []).map(record => normalize((record.path ?? []).join('/'))),
  );

  const bandHeight = Math.max(height, 120);
  const drawn = graph.edges.filter(edge => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    return from !== undefined && to !== undefined && !edge.internal;
  });
  const hasUnder = drawn.some(edge => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    return to.layer <= from.layer;
  });
  const top = 0;
  const viewHeight = bandHeight + (hasUnder ? ARC_MARGIN : 0);
  // Parallel transitions share a routed lane, so their labels would land on the
  // same point; stagger them down the lane instead.
  /** @type {Map<string, number>} */
  const parallelSeen = new Map();

  return h(
    'svg',
    {
      class: 'wf-statechart',
      viewBox: `0 ${top} ${width} ${viewHeight}`,
      role: 'img',
      'aria-label': `Statechart for ${chart.name}`,
    },
    [
      ...graph.edges.map((edge, edgeIndex) => {
        const from = positions[edge.from];
        const to = positions[edge.to];
        if (from === undefined || to === undefined || edge.internal) {
          return null;
        }
        const x1 = from.x + NODE_WIDTH;
        const y1 = from.y + NODE_HEIGHT / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_HEIGHT / 2;
        const backward = to.layer <= from.layer;
        const route = routes[edgeIndex];
        let d;
        let labelX = (x1 + x2) / 2;
        let labelY;
        if (backward) {
          const under = bandHeight + ARC_MARGIN / 2;
          d = `M ${x1} ${y1} C ${x1 + 40} ${under}, ${x2 - 40} ${under}, ${x2} ${y2}`;
          labelY = under - 4;
        } else if (route !== undefined && route.length > 0) {
          d = smoothPath([{ x: x1, y: y1 }, ...route, { x: x2, y: y2 }]);
          // Along the lane, staggered so parallel transitions stay readable.
          const pair = `${edge.from}\u0000${edge.to}`;
          const nth = parallelSeen.get(pair) ?? 0;
          parallelSeen.set(pair, nth + 1);
          const at = route[Math.min(nth, route.length - 1)];
          labelX = at.x;
          labelY = at.y - 6 - (nth >= route.length ? (nth + 1) * 12 : 0);
        } else {
          d = `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
          labelY = (y1 + y2) / 2 - 4;
        }
        return h(
          'g',
          { key: `${edge.from}-${edge.to}-${edge.type}-${edge.index}` },
          [
            h('path', {
              class: backward
                ? 'wf-edge wf-edge-back'
                : `wf-edge${route !== undefined ? ' wf-edge-routed' : ''}`,
              d,
            }),
            h(
              'text',
              {
                class: 'wf-edge-label',
                x: labelX,
                y: labelY,
              },
              edge.guarded ? `${edge.type} ✓?` : edge.type,
            ),
          ],
        );
      }),
      ...graph.nodes.map(node => {
        const position = positions[node.id];
        if (position === undefined) {
          return null;
        }
        const classes = ['wf-node'];
        if (node.kind === 'final') {
          classes.push('wf-node-final');
          if (active.has(node.id) && outcome !== undefined) {
            classes.push(`wf-node-${outcome}`);
          }
        }
        if (active.has(node.id)) {
          classes.push('wf-node-active');
        }
        if (live.has(node.id) && !active.has(node.id)) {
          classes.push('wf-node-ghost');
        }
        if (busy.has(node.id)) {
          classes.push('wf-node-busy');
        }
        return h('g', { key: node.id }, [
          h('rect', {
            class: classes.join(' '),
            x: position.x,
            y: position.y,
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            rx: 8,
          }),
          h(
            'text',
            {
              class: 'wf-node-label',
              x: position.x + NODE_WIDTH / 2,
              y: position.y + 18,
            },
            node.name,
          ),
          /** @type {number} */ (node.effects.length) > 0
            ? h(
                'text',
                {
                  class: 'wf-node-effects',
                  x: position.x + NODE_WIDTH / 2,
                  y: position.y + 32,
                },
                node.effects.join(', '),
              )
            : null,
        ]);
      }),
    ],
  );
};
harden(StatechartView);
