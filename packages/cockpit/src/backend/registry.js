// @ts-check
//
// The thread registry: the harness-host's core. It owns the tree of running
// threads, models `delegateCodeMode` as harness-enforced subset attenuation,
// and propagates a cap revoke down the lineage that could only have received
// it by delegation.

import { makeThread } from './thread.js';
import { subsetViolation } from './caps.js';

/**
 * @typedef {import('./caps.js').Cap} Cap
 * @typedef {import('./engine.js').EngineContext} EngineContext
 * @typedef {import('./engine.js').Engine} Engine
 */

/**
 * @param {object} options
 * @param {(ctx: EngineContext) => Engine} options.engineFactory
 * @param {(threadId: string, event: import('./engine.js').ThreadEvent) => void} [options.onEvent]
 */
export const makeRegistry = ({ engineFactory, onEvent = () => {} }) => {
  /** @type {Map<string, ReturnType<typeof makeThread>>} */
  const threads = new Map();
  let counter = 0;
  const nextId = () => {
    counter += 1;
    return `t${counter}`;
  };

  /**
   * @param {object} spec
   * @param {string} [spec.templateName]
   * @param {Cap[]} [spec.caps]
   * @param {string | null} [spec.parentId]
   */
  const create = ({ templateName = 'adhoc', caps = [], parentId = null }) => {
    const id = nextId();
    const thread = makeThread({
      id,
      parentId,
      templateName,
      caps,
      engineFactory,
      onEvent,
      delegate: spec => delegate(id, spec),
    });
    threads.set(id, thread);
    if (parentId) threads.get(parentId)?.addChild(id);
    return thread;
  };

  /**
   * Model `delegateCodeMode`: a child may hold only a subset of its parent's
   * caps, with no read-only → read-write upgrade. Attenuation is by selection,
   * not minting (designs/garden-cockpit.md § "Known gap to flag").
   *
   * @param {string} parentId
   * @param {{ templateName?: string, caps?: Cap[], prompt?: string }} spec
   */
  const delegate = async (parentId, { templateName = 'delegate', caps = [], prompt }) => {
    const parent = threads.get(parentId);
    if (!parent) throw new Error(`unknown parent thread ${parentId}`);
    const violation = subsetViolation(caps, parent.caps());
    if (violation) throw new Error(`delegation rejected: ${violation}`);
    const child = create({ templateName, caps, parentId });
    let outcome;
    if (prompt) outcome = await child.prompt(prompt);
    return { childId: child.id, caps: child.capViews(), outcome };
  };

  /**
   * Revoke a named cap from a thread and from every descendant that still
   * holds it — a delegated cap cannot outlive its revocation up-lineage. The
   * propagation rule is a chosen default for design open-question 4.
   *
   * @param {string} threadId
   * @param {string} capName
   * @returns {string[]} ids of threads a cap was removed from
   */
  const revokeCap = (threadId, capName) => {
    /** @type {string[]} */
    const removed = [];
    const visit = id => {
      const t = threads.get(id);
      if (!t) return;
      if (t.revokeCap(capName)) removed.push(id);
      for (const cid of t.childIds) visit(cid);
    };
    visit(threadId);
    return removed;
  };

  const tree = () => {
    /** @type {Map<string | null, object[]>} */
    const byParent = new Map();
    for (const t of threads.values()) {
      const key = t.parentId;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)?.push(t.toJSON());
    }
    const build = parentId =>
      (byParent.get(parentId) || []).map(node => ({
        ...node,
        children: build(node.id),
      }));
    return build(null);
  };

  return {
    create,
    delegate,
    revokeCap,
    get: id => threads.get(id),
    grantCap: (threadId, cap) => threads.get(threadId)?.grantCap(cap),
    list: () => [...threads.values()].map(t => t.toJSON()),
    tree,
    ids: () => [...threads.keys()],
  };
};
