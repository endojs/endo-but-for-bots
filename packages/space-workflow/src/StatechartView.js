// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { renderDefinition } from '@endo/workflow/src/graph.js';

import { layoutGraph } from './layout.js';

/** @import { VNode } from 'preact' */

const NODE_WIDTH = 150;
const NODE_HEIGHT = 40;

const FINAL_CLASSES = harden({
  succeeded: 'wf-node-succeeded',
  failed: 'wf-node-failed',
  abandoned: 'wf-node-abandoned',
  aborted: 'wf-node-aborted',
});

/**
 * The definition rendered as an SVG statechart with live overlays: the
 * active state highlighted (scrubbed state solid, live state ghosted
 * while scrubbing), pending effects as pulsing borders with ages.
 *
 * @param {{
 *   definition: any,
 *   activeState: string | undefined,
 *   liveState: string | undefined,
 *   pending: Record<string, { as: string }>,
 * }} props
 * @returns {VNode}
 */
export const StatechartView = ({
  definition,
  activeState,
  liveState,
  pending,
}) => {
  const graph = renderDefinition(definition);
  const { positions, width, height } = layoutGraph(graph, definition.initial);
  const pendingCount = Object.keys(pending ?? {}).length;

  return h(
    'svg',
    {
      class: 'wf-statechart',
      viewBox: `0 0 ${width} ${Math.max(height, 120)}`,
      role: 'img',
      'aria-label': `Statechart for ${definition.name}`,
    },
    [
      ...graph.edges.map(edge => {
        const from = positions[edge.from];
        const to = positions[edge.to];
        if (from === undefined || to === undefined) {
          return null;
        }
        const x1 = from.x + NODE_WIDTH;
        const y1 = from.y + NODE_HEIGHT / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_HEIGHT / 2;
        const backward = to.layer <= from.layer;
        const midY = backward ? Math.max(y1, y2) + NODE_HEIGHT : (y1 + y2) / 2;
        return h('g', { key: `${edge.from}-${edge.to}-${edge.on}` }, [
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
            edge.guarded ? `${edge.on} ✓?` : edge.on,
          ),
        ]);
      }),
      ...graph.nodes.map(node => {
        const position = positions[node.name];
        if (position === undefined) {
          return null;
        }
        const classes = ['wf-node'];
        if (node.final !== undefined) {
          classes.push(FINAL_CLASSES[node.final] ?? 'wf-node-final');
        }
        if (node.name === activeState) {
          classes.push('wf-node-active');
        }
        if (node.name === liveState && liveState !== activeState) {
          classes.push('wf-node-ghost');
        }
        if (node.name === activeState && pendingCount > 0) {
          classes.push('wf-node-busy');
        }
        return h('g', { key: node.name }, [
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
          node.effects.length > 0
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
