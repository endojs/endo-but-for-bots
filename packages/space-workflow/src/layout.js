// @ts-check

/**
 * Deterministic layered layout over `renderGraph`'s flattened graph
 * model.
 *
 * Charts are small (tens of states), so a longest-path layering with
 * stable in-layer ordering suffices — no external layout dependency,
 * and the same input always yields the same picture. Nested and region
 * states participate flat, named by their path ids.
 *
 * An edge that spans more than one column is ROUTED rather than drawn as
 * a chord: it gets a dummy node in each column it passes through, those
 * dummies take part in the in-layer ordering like any other node, and
 * the edge is returned as a polyline through them. This is what keeps a
 * long edge out of the middle of an unrelated state — the compensation
 * edges in the deploy charts all converge on one late state, and as
 * chords they crossed most of the diagram.
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
 * @returns {{ positions: Record<string, { x: number, y: number, layer: number }>, routes: Record<number, Array<{ x: number, y: number }>>, width: number, height: number }}
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

  // Dummy nodes for multi-column edges. Each gets a slot in every column it
  // crosses, so the ordering below moves it out of the way of real states just
  // as it would any other node, and the edge is drawn through those slots
  // instead of straight over whatever lies between. Backward edges are left
  // alone: there are few of them and they arc under the band in the view.
  /** @type {Map<number, string[]>} */
  const routeIds = new Map();
  // Parallel transitions between the same pair share one lane: three ways of
  // getting from `build` to `unpinning` are three labels along one path, not
  // three paths. Without this the deploy charts grow a lane per transition and
  // the diagram becomes mostly empty vertical space.
  /** @type {Map<string, string[]>} */
  const laneByPair = new Map();
  edges.forEach((edge, index) => {
    const fromLayer = layers.get(edge.from);
    const toLayer = layers.get(edge.to);
    if (fromLayer === undefined || toLayer === undefined) return;
    if (toLayer <= fromLayer + 1) return;
    const pair = `${edge.from}\u0000${edge.to}`;
    let ids = laneByPair.get(pair);
    if (ids === undefined) {
      ids = [];
      for (let layer = fromLayer + 1; layer < toLayer; layer += 1) {
        const id = `~route/${laneByPair.size}/${layer}`;
        layers.set(id, layer);
        const row = byLayer.get(layer) ?? [];
        row.push(id);
        byLayer.set(layer, row);
        ids.push(id);
      }
      laneByPair.set(pair, ids);
    }
    routeIds.set(index, ids);
  });
  // The ordering sweeps below need each dummy chained to its own route so it
  // follows the edge rather than drifting. Built as a COPY: `graph.edges` comes
  // from the caller (hardened, in production) and is not ours to extend.
  const orderingEdges = [...edges];
  for (const [pair, ids] of laneByPair) {
    const [from, to] = pair.split('\u0000');
    const chain = [from, ...ids, to];
    for (let i = 0; i < chain.length - 1; i += 1) {
      orderingEdges.push({ from: chain[i], to: chain[i + 1] });
    }
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
    for (const edge of orderingEdges) {
      const other = forward
        ? edge.to === id && edge.from !== id && edge.from
        : edge.from === id && edge.to !== id && edge.to;
      const otherLayer = other ? layers.get(other) : undefined;
      const ownLayer = layers.get(id);
      // Only a neighbour on the side this sweep reads from contributes:
      // a forward sweep averages the layer before, a backward one the layer
      // after. Anything on the same or the wrong side is not a constraint.
      const contributes =
        otherLayer !== undefined &&
        ownLayer !== undefined &&
        (forward ? otherLayer < ownLayer : otherLayer > ownLayer);
      if (other && contributes) {
        const at = slot.get(other);
        if (at !== undefined) neighbours.push(at);
      }
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
  // Polyline for each routed edge. Two points per column crossed — the lane's
  // entry and exit — so the line runs HORIZONTALLY across a column at its
  // lane's height and does all its climbing in the gutters between columns.
  // A single mid-column point instead lets the approach cut diagonally through
  // the box of whatever sits in that column, which is the crossing this is
  // meant to remove. The view adds the endpoints on the node borders.
  const nodeWidth = 150;
  /** @type {Record<number, Array<{ x: number, y: number }>>} */
  const routes = {};
  for (const [index, ids] of routeIds) {
    const points = [];
    for (const id of ids) {
      const at = positions[id];
      points.push(harden({ x: at.x, y: at.y + 20 }));
      points.push(harden({ x: at.x + nodeWidth, y: at.y + 20 }));
    }
    routes[index] = harden(points);
  }

  const width = 40 + (Math.max(0, ...byLayer.keys()) + 1) * layerWidth;
  return harden({
    positions: harden(positions),
    routes: harden(routes),
    width,
    height,
  });
};
harden(layoutGraph);
