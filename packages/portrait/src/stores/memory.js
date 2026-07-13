// @ts-check

/**
 * In-memory portrait store, generational: every save (full graph or
 * delta) appends a generation, mirroring Goblins' memory store, so
 * tests and future time-travel tooling can replay history. Reads
 * always reflect the latest committed generation.
 */

import harden from '@endo/harden';
import { Fail, q } from '@endo/errors';

/**
 * @import { PortraitStore, StoredGraph, StoredDelta, StoredPortrait } from '../types.js'
 */

/**
 * Apply a delta over a graph, returning the merged graph.
 *
 * @param {StoredGraph | undefined} graph
 * @param {StoredDelta} delta
 * @returns {StoredGraph}
 */
export const mergeDelta = (graph, delta) => {
  graph !== undefined ||
    Fail`cannot apply a portrait delta before any full graph`;
  const g = /** @type {StoredGraph} */ (graph);
  return harden({
    ...g,
    portraits: { ...g.portraits, ...delta.portraits },
    bindings: delta.bindings ? { ...delta.bindings } : g.bindings,
  });
};
harden(mergeDelta);

/**
 * @typedef {(
 *   | { type: 'graph', graph: StoredGraph }
 *   | { type: 'delta', delta: StoredDelta }
 * )} Generation
 */

/**
 * @returns {PortraitStore & {
 *   getGenerations: () => Generation[],
 *   graphAtGeneration: (n: number) => StoredGraph | undefined,
 * }}
 */
export const makeMemoryPortraitStore = () => {
  /** @type {Generation[]} */
  const generations = [];
  /** @type {StoredGraph | undefined} */
  let current;

  /** @param {number} n */
  const graphAtGeneration = n => {
    (Number.isSafeInteger(n) && n >= 0 && n < generations.length) ||
      Fail`no generation ${q(n)}`;
    /** @type {StoredGraph | undefined} */
    let graph;
    for (let i = 0; i <= n; i += 1) {
      const generation = generations[i];
      if (generation.type === 'graph') {
        graph = generation.graph;
      } else {
        graph = mergeDelta(graph, generation.delta);
      }
    }
    return graph;
  };

  return harden({
    graphAndSlots: async () => current,
    /** @param {number} slot */
    objectPortrait: async slot =>
      current === undefined
        ? undefined
        : /** @type {StoredPortrait | undefined} */ (
            current.portraits[String(slot)]
          ),
    /** @param {StoredGraph} graph */
    saveGraph: async graph => {
      generations.push(harden({ type: 'graph', graph }));
      current = graph;
    },
    /** @param {StoredDelta} delta */
    saveDelta: async delta => {
      const merged = mergeDelta(current, delta);
      generations.push(harden({ type: 'delta', delta }));
      current = merged;
    },
    close: async () => {},
    getGenerations: () => harden([...generations]),
    graphAtGeneration,
  });
};
harden(makeMemoryPortraitStore);
