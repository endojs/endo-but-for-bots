// @ts-check

/**
 * Definition rendering: the pure graph model the Chat space lays out,
 * and a Mermaid `stateDiagram-v2` emitter so a definition can be
 * reviewed as a picture in any markdown surface before it ever runs.
 */

import harden from '@endo/harden';

import { normalizeHandlers } from './definition.js';

/** @import { WorkflowDefinition } from './types.js' */

/**
 * @param {WorkflowDefinition} definition
 * @returns {{ nodes: Array<{ name: string, final?: string, effects: string[] }>, edges: Array<{ from: string, to: string, on: string, guarded: boolean }> }}
 */
export const renderDefinition = definition => {
  /** @type {Array<{ name: string, final?: string, effects: string[] }>} */
  const nodes = [];
  /** @type {Array<{ from: string, to: string, on: string, guarded: boolean }>} */
  const edges = [];
  for (const [name, state] of Object.entries(definition.states)) {
    nodes.push(
      harden({
        name,
        ...(state.final === undefined ? {} : { final: state.final }),
        effects: harden(
          (state.entry ?? []).map(effect => `${effect.effect}:${effect.as}`),
        ),
      }),
    );
    for (const [type, candidates] of normalizeHandlers(state.on)) {
      for (const transition of candidates) {
        edges.push(
          harden({
            from: name,
            to: transition.target,
            on: type,
            guarded: transition.guard !== undefined,
          }),
        );
      }
    }
    if (state.after !== undefined) {
      edges.push(
        harden({
          from: name,
          to: state.after.target,
          on: `timeout ${state.after.ms}ms`,
          guarded: false,
        }),
      );
    }
    if (state.onError !== undefined) {
      edges.push(
        harden({
          from: name,
          to: state.onError,
          on: 'onError',
          guarded: false,
        }),
      );
    }
  }
  return harden({ nodes: harden(nodes), edges: harden(edges) });
};
harden(renderDefinition);

/** @param {string} name */
const mermaidId = name => name.replaceAll(/[^\w]/gu, '_');

/**
 * @param {WorkflowDefinition} definition
 * @returns {string} a Mermaid `stateDiagram-v2` document
 */
export const renderMermaid = definition => {
  const { nodes, edges } = renderDefinition(definition);
  const lines = ['stateDiagram-v2'];
  lines.push(`    [*] --> ${mermaidId(definition.initial)}`);
  for (const node of nodes) {
    if (node.effects.length > 0) {
      lines.push(
        `    ${mermaidId(node.name)} : ${node.name} (${node.effects.join(', ')})`,
      );
    } else if (mermaidId(node.name) !== node.name) {
      lines.push(`    ${mermaidId(node.name)} : ${node.name}`);
    }
    if (node.final !== undefined) {
      lines.push(`    ${mermaidId(node.name)} --> [*] : ${node.final}`);
    }
  }
  for (const edge of edges) {
    const label = edge.guarded ? `${edge.on} [guard]` : edge.on;
    lines.push(
      `    ${mermaidId(edge.from)} --> ${mermaidId(edge.to)} : ${label}`,
    );
  }
  return `${lines.join('\n')}\n`;
};
harden(renderMermaid);
