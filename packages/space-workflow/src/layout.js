// @ts-check

/**
 * Deterministic layered layout over `renderDefinition`'s graph model.
 *
 * Definitions are small (tens of states), so a longest-path layering
 * with stable in-layer ordering suffices — no external layout
 * dependency, and the same input always yields the same picture.
 */

import harden from '@endo/harden';

/**
 * @param {{ nodes: Array<{ name: string, final?: string, effects: string[] }>, edges: Array<{ from: string, to: string, on: string, guarded: boolean }> }} graph
 * @param {string} initial
 * @returns {{ positions: Record<string, { x: number, y: number, layer: number }>, width: number, height: number }}
 */
export const layoutGraph = (graph, initial) => {
  const { nodes, edges } = graph;
  /** @type {Map<string, number>} */
  const layers = new Map();
  layers.set(initial, 0);
  // Longest-path layering by relaxation; loop edges (back to an earlier
  // layer) are left as-is, which draws them as return arcs.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const from = layers.get(edge.from);
      if (from === undefined) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const proposed = from + 1;
      const existing = layers.get(edge.to);
      if (existing === undefined) {
        layers.set(edge.to, proposed);
        changed = true;
      } else if (proposed > existing && proposed < nodes.length) {
        // Only deepen if the target is not an ancestor (loop guard: a
        // node never moves past the node count).
        const isLoop = edgeReaches(edges, edge.to, edge.from, nodes.length);
        if (!isLoop) {
          layers.set(edge.to, proposed);
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }
  // Unreached nodes park in a final layer.
  const maxLayer = Math.max(0, ...layers.values());
  for (const node of nodes) {
    if (!layers.has(node.name)) {
      layers.set(node.name, maxLayer + 1);
    }
  }

  /** @type {Map<number, string[]>} */
  const byLayer = new Map();
  for (const node of nodes) {
    const layer = /** @type {number} */ (layers.get(node.name));
    const row = byLayer.get(layer) ?? [];
    row.push(node.name);
    byLayer.set(layer, row);
  }

  const layerWidth = 180;
  const rowHeight = 64;
  /** @type {Record<string, { x: number, y: number, layer: number }>} */
  const positions = {};
  let height = 0;
  for (const [layer, row] of byLayer) {
    row.forEach((name, i) => {
      positions[name] = harden({
        x: 20 + layer * layerWidth,
        y: 20 + i * rowHeight,
        layer,
      });
    });
    height = Math.max(height, 20 + row.length * rowHeight);
  }
  const width = 40 + (Math.max(0, ...byLayer.keys()) + 1) * layerWidth;
  return harden({ positions: harden(positions), width, height });
};
harden(layoutGraph);

/**
 * @param {Array<{ from: string, to: string }>} edges
 * @param {string} from
 * @param {string} to
 * @param {number} budget
 * @returns {boolean} whether `to` is reachable from `from`
 */
const edgeReaches = (edges, from, to, budget) => {
  const seen = new Set([from]);
  const queue = [from];
  let steps = 0;
  while (queue.length > 0 && steps < budget * budget) {
    steps += 1;
    const current = /** @type {string} */ (queue.shift());
    if (current === to) {
      return true;
    }
    for (const edge of edges) {
      if (edge.from === current && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return false;
};
