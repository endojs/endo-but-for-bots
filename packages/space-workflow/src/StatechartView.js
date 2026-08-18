// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { renderGraph } from '@endo/workflow/src/graph.js';

import { layoutGraph } from './layout.js';

/** @import { VNode } from 'preact' */

const NODE_WIDTH = 150;
const NODE_HEIGHT = 40;

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
  const { positions, width, height } = layoutGraph(graph, chart.initial);
  const active = new Set(activeIdsOf(configuration));
  const live = new Set(activeIdsOf(liveConfiguration));
  const busy = new Set(
    (pending ?? []).map(record => (record.path ?? []).join('/')),
  );

  return h(
    'svg',
    {
      class: 'wf-statechart',
      viewBox: `0 0 ${width} ${Math.max(height, 120)}`,
      role: 'img',
      'aria-label': `Statechart for ${chart.name}`,
    },
    [
      ...graph.edges.map(edge => {
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
        const midY = backward ? Math.max(y1, y2) + NODE_HEIGHT : (y1 + y2) / 2;
        return h('g', { key: `${edge.from}-${edge.to}-${edge.type}` }, [
          h('path', {
            class: backward ? 'wf-edge wf-edge-back' : 'wf-edge',
            d: backward
              ? `M ${x1} ${y1} C ${x1 + 40} ${midY}, ${x2 - 40} ${midY}, ${x2} ${y2}`
              : `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`,
          }),
          h(
            'text',
            {
              class: 'wf-edge-label',
              x: (x1 + x2) / 2,
              y: midY - 4,
            },
            edge.guarded ? `${edge.type} ✓?` : edge.type,
          ),
        ]);
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
