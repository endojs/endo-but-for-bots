// @ts-check

import { E } from '@endo/eventual-send';
import harden from '@endo/harden';

/** @import { ConversationNode, TreeBackend } from '../types.js' */

const CT_PREFIX = 'ct-';

/**
 * Backend that persists conversation nodes in the Endo daemon's petname
 * store via `E(powers).storeValue` / `E(powers).lookup`.
 *
 * Nodes are stored under petnames `ct-<nodeId>`.
 *
 * Reads are served from a lazily-built in-memory index. The naive approach —
 * `list()` + a `lookup()` per `ct-` node on *every* `getChildren` — is O(N)
 * round trips per call, and walking a conversation of depth D (as floot's
 * getOrCreateLeaf / getPath do, calling getChildren/getNode at each level)
 * turned session load into O(N·D) sequential CapTP round trips — the "slow
 * session loading" symptom. Instead we load every node ONCE (one `list()` plus
 * a single parallel `Promise.all` of lookups) into a Map, then answer all reads
 * locally, and keep the Map coherent as `putNode` appends. This assumes a
 * single writer per backing petstore (floot's model: one session = one guest =
 * one backend instance), so nodes added elsewhere aren't observed until a fresh
 * backend loads; `getNode` still falls back to a direct lookup on a miss.
 *
 * @param {object} powers - Endo guest/host powers with storeValue / lookup / list
 * @returns {TreeBackend}
 */
export const makeEndoPetstoreBackend = powers => {
  /**
   * id -> node, in petstore (insertion) order. `undefined` until first loaded;
   * `Map` iteration order then mirrors `list()` order, and `putNode` appends
   * new ids last — so `getChildren` returns siblings newest-last, exactly as
   * the previous list()-driven implementation did (floot relies on this to pick
   * the deepest/newest branch).
   *
   * @type {Map<string, ConversationNode> | undefined}
   */
  let index;
  /** @type {Promise<Map<string, ConversationNode>> | undefined} */
  let loadP;

  const load = () => {
    if (index) return Promise.resolve(index);
    if (!loadP) {
      loadP = (async () => {
        const allNames = /** @type {string[]} */ (await E(powers).list());
        const ctNames = allNames.filter(name => name.startsWith(CT_PREFIX));
        // One parallel batch instead of a per-node round-trip chain.
        const nodes = await Promise.all(
          ctNames.map(name =>
            E(powers)
              .lookup(name)
              .then(
                node => /** @type {ConversationNode} */ (node),
                () => null,
              ),
          ),
        );
        /** @type {Map<string, ConversationNode>} */
        const map = new Map();
        for (const node of nodes) {
          if (node && typeof node.id === 'string') {
            map.set(node.id, node);
          }
        }
        index = map;
        return map;
      })().catch(error => {
        // Let a later call retry from scratch rather than caching the failure.
        loadP = undefined;
        throw error;
      });
    }
    return loadP;
  };

  /** @type {TreeBackend} */
  const backend = {
    async putNode(node) {
      const petName = `${CT_PREFIX}${node.id}`;
      await E(powers).storeValue(harden(node), [petName]);
      // Keep the loaded index coherent (append-last preserves sibling order).
      if (index) {
        index.set(node.id, node);
      }
    },

    async getNode(id) {
      const map = await load();
      const cached = map.get(id);
      if (cached !== undefined) {
        return cached;
      }
      // Not in the snapshot (e.g. written by another backend since we loaded).
      // Fall back to a direct lookup and cache the result.
      try {
        const node = /** @type {ConversationNode} */ (
          await E(powers).lookup(`${CT_PREFIX}${id}`)
        );
        if (node && typeof node.id === 'string') {
          map.set(node.id, node);
          return node;
        }
        return null;
      } catch {
        return null;
      }
    },

    async getChildren(parentId) {
      const map = await load();
      /** @type {ConversationNode[]} */
      const children = [];
      for (const node of map.values()) {
        if (node.parentId === parentId) {
          children.push(node);
        }
      }
      return children;
    },

    async getRoots() {
      return backend.getChildren(null);
    },
  };

  return harden(backend);
};
harden(makeEndoPetstoreBackend);
