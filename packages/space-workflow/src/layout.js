// @ts-check

/**
 * Deterministic layered layout over `renderGraph`'s flattened graph
 * model.
 *
 * Charts are small (tens of states), so a longest-path layering with
 * stable in-layer ordering suffices — no external layout dependency,
 * and the same input always yields the same picture. Nested and region
 * states participate flat, named by their path ids.
 */

import harden from '@endo/harden';

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

/**
 * @param {{ nodes: Array<{ id: string }>, edges: Array<{ from: string, to: string }> }} graph
 * @param {string} initial - the chart's top-level initial state id
 * @returns {{ positions: Record<string, { x: number, y: number, layer: number }>, width: number, height: number }}
 */
export const layoutGraph = (graph, initial) => {
  const { nodes, edges } = graph;
  /** @type {Map<string, number>} */
  const layers = new Map();
  layers.set(initial, 0);
  // Longest-path layering by relaxation; loop edges (back to an earlier
  // layer) are left as-is, which draws them as return arcs.
  const relax = () => {
    for (let pass = 0; pass < nodes.length; pass += 1) {
      let changed = false;
      for (const edge of edges) {
        const from = layers.get(edge.from);
        if (from !== undefined) {
          const proposed = from + 1;
          const existing = layers.get(edge.to);
          if (existing === undefined) {
            layers.set(edge.to, proposed);
            changed = true;
          } else if (proposed > existing && proposed < nodes.length) {
            // Only deepen if the target is not an ancestor (loop guard:
            // a node never moves past the node count).
            const isLoop = edgeReaches(edges, edge.to, edge.from, nodes.length);
            if (!isLoop) {
              layers.set(edge.to, proposed);
              changed = true;
            }
          }
        }
      }
      if (!changed) {
        break;
      }
    }
  };
  relax();
  // Nested and region members have no incoming top-level edge; seed the
  // stragglers beside their parent (or at the end) and relax again so
  // their internal transitions still spread left-to-right.
  const maxLayer = Math.max(0, ...layers.values());
  for (const node of nodes) {
    if (!layers.has(node.id)) {
      const parentId = node.id.includes('/')
        ? node.id.slice(0, node.id.lastIndexOf('/')).replace(/\/#[^/]+$/, '')
        : undefined;
      const parentLayer =
        parentId !== undefined ? layers.get(parentId) : undefined;
      layers.set(
        node.id,
        parentLayer !== undefined ? parentLayer : maxLayer + 1,
      );
    }
  }
  relax();

  /** @type {Map<number, string[]>} */
  const byLayer = new Map();
  for (const node of nodes) {
    const layer = /** @type {number} */ (layers.get(node.id));
    const row = byLayer.get(layer) ?? [];
    row.push(node.id);
    byLayer.set(layer, row);
  }

  // In-layer ordering. Insertion order is whatever `renderGraph` happened to
  // emit, which puts a state's successors wherever they fall and makes edges
  // cross for no reason. Sort each layer by the average position of its
  // neighbours in the adjacent layer (the barycentre heuristic), sweeping
  // forwards then backwards a few times. Ties keep the previous order, so the
  // result is still deterministic for a given chart.
  const orderedLayers = [...byLayer.keys()].sort((a, b) => a - b);
  /** @type {Map<string, number>} */
  const slot = new Map();
  const reslot = () => {
    for (const layer of orderedLayers) {
      const row = /** @type {string[]} */ (byLayer.get(layer));
      row.forEach((id, i) => slot.set(id, i));
    }
  };
  reslot();
  /**
   * @param {string} id
   * @param {boolean} forward - look at the layer before (true) or after
   * @returns {number | undefined}
   */
  const barycentre = (id, forward) => {
    const neighbours = [];
    for (const edge of edges) {
      const other = forward
        ? edge.to === id && edge.from !== id && edge.from
        : edge.from === id && edge.to !== id && edge.to;
      if (!other) continue;
      const otherLayer = layers.get(other);
      const ownLayer = layers.get(id);
      if (otherLayer === undefined || ownLayer === undefined) continue;
      if (forward ? otherLayer >= ownLayer : otherLayer <= ownLayer) continue;
      const at = slot.get(other);
      if (at !== undefined) neighbours.push(at);
    }
    if (neighbours.length === 0) return undefined;
    return neighbours.reduce((sum, n) => sum + n, 0) / neighbours.length;
  };
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const forward = sweep % 2 === 0;
    const order = forward ? orderedLayers : [...orderedLayers].reverse();
    for (const layer of order) {
      const row = /** @type {string[]} */ (byLayer.get(layer));
      const keyed = row.map((id, i) => ({
        id,
        i,
        b: barycentre(id, forward),
      }));
      keyed.sort((a, b) => {
        // Nodes with no neighbour on that side keep their place.
        if (a.b === undefined && b.b === undefined) return a.i - b.i;
        if (a.b === undefined) return -1;
        if (b.b === undefined) return 1;
        return a.b === b.b ? a.i - b.i : a.b - b.b;
      });
      byLayer.set(
        layer,
        keyed.map(entry => entry.id),
      );
      reslot();
    }
  }

  // Room to route around: NODE_WIDTH is 150 and NODE_HEIGHT 40 in the view, so
  // these leave a 70px channel between columns and 36px between rows for edges
  // and their labels.
  const layerWidth = 220;
  const rowHeight = 76;
  /** @type {Record<string, { x: number, y: number, layer: number }>} */
  const positions = {};
  let height = 0;
  for (const [layer, row] of byLayer) {
    row.forEach((id, i) => {
      positions[id] = harden({
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
