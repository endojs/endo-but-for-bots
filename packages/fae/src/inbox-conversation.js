// @ts-check
/* eslint-disable no-await-in-loop */

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';

/** @import { ConversationTree, ChatMessage } from '../../conversation-tree/types.js' */

const SELECTION_NAME = 'fae-conversation';

/**
 * Restore the standalone inbox driver's branch and admission receipts.
 *
 * The tree owns messages and receipts; this one replaceable petname only
 * selects a branch. Never infer the head from timestamps or sibling order.
 * An admitted message remains admitted even if its turn never completed.
 *
 * @param {object} options
 * @param {any} options.powers
 * @param {ConversationTree} options.tree
 * @param {string} options.prompt
 */
export const restoreInboxConversation = async ({ powers, tree, prompt }) => {
  const nodes = await tree.getNodes();
  /** @type {Set<bigint>} */
  const admittedNumbers = new Set();
  // Include unselected and orphaned nodes: a node write may have committed
  // before a selection write failed. Dropping its receipt would admit replay.
  for (const node of nodes) {
    const { inboundNumber } = node.metadata;
    if (inboundNumber !== undefined) {
      (typeof inboundNumber === 'bigint' && inboundNumber >= 0n) ||
        Fail`Invalid inbox admission receipt`;
      admittedNumbers.add(inboundNumber);
    }
  }

  /** @type {{ rootId: string, leafId: string, turnActive: boolean }} */
  let selection;
  let publicationFailed = false;
  const publish = async (rootId, leafId, turnActive) => {
    const next = harden({ rootId, leafId, turnActive });
    await E(powers).storeValue(next, [SELECTION_NAME]);
    selection = next;
  };
  if (await E(powers).has(SELECTION_NAME)) {
    const stored = await E(powers).lookup(SELECTION_NAME);
    (stored &&
      typeof stored.rootId === 'string' &&
      typeof stored.leafId === 'string' &&
      typeof stored.turnActive === 'boolean' &&
      Object.keys(stored).length === 3) ||
      Fail`Invalid inbox conversation selection`;
    selection = stored;
    !selection.turnActive ||
      Fail`Interrupted inbox turn requires explicit administration`;
  } else {
    // No compatibility inference: a pre-selection tree or interrupted initial
    // creation must be explicitly retired, not silently replayed from a root.
    nodes.length === 0 || Fail`Inbox conversation has no retained selection`;
    const root = await tree.addNode(null, [
      { role: 'system', content: prompt },
    ]);
    await publish(root.id, root.id, false);
  }

  /**
   * Validate ancestry instead of getPath's permissive missing-node truncation.
   * @param {string} leafId
   */
  const getChain = async leafId => {
    await null;
    const chain = [];
    const ancestors = new Set();
    let current = leafId;
    while (current !== null) {
      !ancestors.has(current) || Fail`Cyclic inbox conversation branch`;
      ancestors.add(current);
      const node = await tree.getNode(current);
      node !== null || Fail`Missing inbox conversation node`;
      chain.push(node);
      current = node.parentId;
    }
    chain.reverse();
    return chain;
  };
  const selectedChain = await getChain(selection.leafId);
  selectedChain[0]?.id === selection.rootId ||
    Fail`Inbox conversation selection has the wrong root`;
  if (selectedChain[0].messages[0]?.content !== prompt) {
    const root = await tree.addNode(null, [
      { role: 'system', content: prompt },
    ]);
    await publish(root.id, root.id, false);
  }

  return harden({
    hasAdmission: number => admittedNumbers.has(number),
    getLeafId: () => selection.leafId,
    async beginTurn() {
      !selection.turnActive || Fail`Inbox turn already active`;
      await publish(selection.rootId, selection.leafId, true);
    },
    async finishTurn() {
      await null;
      !publicationFailed || Fail`Inbox publication failed; turn remains fenced`;
      if (selection.turnActive) {
        await publish(selection.rootId, selection.leafId, false);
      }
    },
    async parentForReply(replyTo) {
      await null;
      if (typeof replyTo === 'string' && (await tree.getNode(replyTo))) {
        const chain = await getChain(replyTo);
        if (chain[0].id === selection.rootId) return replyTo;
      }
      return selection.leafId;
    },
    /**
     * @param {string} leafId
     * @returns {Promise<ChatMessage[]>}
     */
    async getContext(leafId) {
      const chain = await getChain(leafId);
      chain[0].id === selection.rootId ||
        Fail`Inbox context has the wrong root`;
      return chain.flatMap(node => node.messages);
    },
    /**
     * Publish a node before selecting it. A failed pointer write fences the
     * caller; the immutable node still retains its receipt/evidence.
     * @param {string} parentId
     * @param {ChatMessage[]} messages
     * @param {Record<string, unknown>} [metadata]
     */
    async append(parentId, messages, metadata = {}) {
      await null;
      try {
        const chain = await getChain(parentId);
        chain[0].id === selection.rootId ||
          Fail`Inbox append has the wrong root`;
        const node = await tree.addNode(parentId, messages, metadata);
        if (typeof metadata.inboundNumber === 'bigint') {
          admittedNumbers.add(metadata.inboundNumber);
        }
        await publish(selection.rootId, node.id, selection.turnActive);
        return node;
      } catch (error) {
        publicationFailed = true;
        throw error;
      }
    },
    async recordClaimedReply(number) {
      // Receipt-only roots do not select or modify an active inference branch.
      await tree.addNode(null, [], { inboundNumber: number });
      admittedNumbers.add(number);
    },
  });
};
harden(restoreInboxConversation);
