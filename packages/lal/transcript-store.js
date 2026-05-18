// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop, @jessie.js/safe-await-separator */

import { E } from '@endo/eventual-send';

/** @import { FarRef } from '@endo/eventual-send' */
/** @import { GuestPowers, ChatMessage, TranscriptNode } from './agent.types.js' */

/**
 * @typedef {object} WalkSuccess
 * @property {true} ok
 * @property {TranscriptNode[]} chain - Nodes ordered root-to-leaf.
 *
 * @typedef {object} WalkFailure
 * @property {false} ok
 * @property {'missing-node'} reason
 * @property {string} brokenAt - The messageId whose node could not be resolved.
 * @property {string} leafMessageId - The leaf the walk started from.
 *
 * @typedef {WalkSuccess | WalkFailure} WalkResult
 */

/**
 * Build the durable pet-store key for a transcript node keyed by messageId.
 *
 * Exported so callers (the agent module, tests, future cleanup tools) can
 * derive the same key without re-deriving the convention.
 *
 * @param {string} messageId
 * @returns {string}
 */
export const transcriptPetName = messageId => `transcript-${messageId}`;
harden(transcriptPetName);

/**
 * Create a durable transcript-node store backed by Endo pet-store entries.
 *
 * Phase 1 of the lal-transcript-memory-management design.
 * Each transcript node is persisted under `transcript-<messageId>` via
 * `E(powers).storeValue(...)` so that the conversation chain survives
 * inbox-message dismissal and a cold restart of the agent.
 *
 * The in-memory `Map` is a write-through cache.
 * Durable storage is the source of truth: `getNode` falls back to
 * `E(powers).lookup(petName)` on a cache miss so that a freshly
 * re-instantiated store still resolves nodes that an earlier instance
 * persisted.
 *
 * @param {FarRef<GuestPowers>} powers - The guest powers facet that backs
 *   the durable pet store (`has`, `lookup`, `storeValue`).
 * @returns {{
 *   getNode: (messageId: string) => Promise<TranscriptNode | undefined>,
 *   putNode: (node: TranscriptNode) => Promise<void>,
 *   putAlias: (aliasId: string, node: TranscriptNode) => Promise<void>,
 *   hasNode: (messageId: string) => Promise<boolean>,
 *   walkParents: (leafMessageId: string) => Promise<WalkResult>,
 *   assembleTranscript: (leafMessageId: string) => Promise<ChatMessage[]>,
 *   assembleTranscriptStrict: (leafMessageId: string) => Promise<ChatMessage[]>,
 * }}
 */
export const makeTranscriptStore = powers => {
  /** @type {Map<string, TranscriptNode>} */
  const nodeCache = new Map();

  /**
   * Look up a transcript node, loading from durable storage if needed.
   *
   * Cache hits return the in-memory mutable working copy.
   * On a cache miss, fall back to the durable pet store; the stored value
   * is hardened, so we make a mutable copy before caching it so callers
   * can keep extending the node's `messages` array within a turn.
   *
   * @param {string} messageId
   * @returns {Promise<TranscriptNode | undefined>}
   */
  const getNode = async messageId => {
    const cached = nodeCache.get(messageId);
    if (cached !== undefined) return cached;

    const petName = transcriptPetName(messageId);
    try {
      if (await E(powers).has(petName)) {
        const stored = /** @type {TranscriptNode} */ (
          await E(powers).lookup(petName)
        );
        // The stored node is hardened; make a mutable working copy.
        const mutable = { ...stored, messages: [...stored.messages] };
        nodeCache.set(messageId, mutable);
        return mutable;
      }
    } catch {
      // Storage lookup failed; treat as missing.
    }
    return undefined;
  };

  /**
   * Store a transcript node both in cache and durable storage.
   *
   * The cache entry stays mutable so the agent can keep appending messages
   * to the same node within a turn.
   * A hardened snapshot of the node's current state is persisted, so each
   * `putNode` commits the latest accumulated state to durable storage.
   *
   * @param {TranscriptNode} node
   * @returns {Promise<void>}
   */
  const putNode = async node => {
    nodeCache.set(node.messageId, node);
    const petName = transcriptPetName(node.messageId);
    try {
      // Harden a snapshot for storage; the working node stays mutable.
      await E(powers).storeValue(
        harden({ ...node, messages: [...node.messages] }),
        petName,
      );
    } catch (error) {
      console.error(
        `[transcript] Failed to persist node ${node.messageId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  /**
   * Record an alias under a second messageId that resolves to the same
   * transcript node.
   *
   * Used when the agent observes its own outbound message and wants any
   * future inbound reply (whose `replyTo` is the outbound `messageId`) to
   * find the same conversation chain.
   *
   * @param {string} aliasId - The messageId that should map to `node`.
   * @param {TranscriptNode} node - The destination node.
   * @returns {Promise<void>}
   */
  const putAlias = async (aliasId, node) => {
    nodeCache.set(aliasId, node);
    const petName = transcriptPetName(aliasId);
    try {
      await E(powers).storeValue(
        harden({ ...node, messages: [...node.messages] }),
        petName,
      );
    } catch (error) {
      console.error(
        `[transcript] Failed to alias ${aliasId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  /**
   * Cheap existence check: is there a transcript node persisted (or
   * cached) for `messageId`?
   *
   * @param {string} messageId
   * @returns {Promise<boolean>}
   */
  const hasNode = async messageId => {
    if (nodeCache.has(messageId)) return true;
    try {
      return await E(powers).has(transcriptPetName(messageId));
    } catch {
      return false;
    }
  };

  /**
   * Walk the parent chain from `leafMessageId` to the root.
   *
   * Returns a result discriminated by `ok`.
   * On success, `chain` is the ordered list of nodes from root to leaf.
   * On failure (a missing intermediate node), `brokenAt` is the messageId
   * that could not be resolved.
   *
   * @param {string} leafMessageId
   * @returns {Promise<WalkResult>}
   */
  const walkParents = async leafMessageId => {
    /** @type {TranscriptNode[]} */
    const chain = [];
    /** @type {string | null} */
    let current = leafMessageId;
    while (current !== null) {
      const node = await getNode(current);
      if (node === undefined) {
        return harden({
          ok: false,
          reason: 'missing-node',
          brokenAt: current,
          leafMessageId,
        });
      }
      chain.push(node);
      current = node.parentMessageId;
    }
    chain.reverse();
    return harden({ ok: true, chain });
  };

  /**
   * Assemble the full LLM transcript by walking from leaf to root.
   *
   * Tolerant of broken chains: on a missing node, returns whatever was
   * collected up to that point (root-side prefix may be truncated).
   * Preserves the pre-Phase-1 surface so existing call sites in
   * `agent.js` are unchanged.
   *
   * @param {string} leafMessageId
   * @returns {Promise<ChatMessage[]>}
   */
  const assembleTranscript = async leafMessageId => {
    /** @type {ChatMessage[][]} */
    const segments = [];
    /** @type {string | null} */
    let current = leafMessageId;
    while (current !== null) {
      const node = await getNode(current);
      if (node === undefined) break;
      segments.push(node.messages);
      current = node.parentMessageId;
    }
    segments.reverse();
    return segments.flat();
  };

  /**
   * Assemble the full transcript, throwing on any missing intermediate
   * node.
   *
   * The design's "Reliable Assembly" section calls for the agent to
   * report broken chains rather than producing a partial transcript.
   * Tests use this strict form to detect orphans without ambiguity.
   *
   * @param {string} leafMessageId
   * @returns {Promise<ChatMessage[]>}
   */
  const assembleTranscriptStrict = async leafMessageId => {
    const result = await walkParents(leafMessageId);
    if (!result.ok) {
      throw new Error(
        `Broken transcript chain: missing node ${result.brokenAt} ` +
          `(walking from ${result.leafMessageId})`,
      );
    }
    return result.chain.flatMap(node => node.messages);
  };

  return harden({
    getNode,
    putNode,
    putAlias,
    hasNode,
    walkParents,
    assembleTranscript,
    assembleTranscriptStrict,
  });
};
harden(makeTranscriptStore);
