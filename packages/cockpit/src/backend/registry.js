// @ts-check
//
// The thread registry: the harness-host's core. It owns the tree of running
// threads, models `delegateCodeMode` as harness-enforced subset attenuation,
// and propagates a cap revoke down the lineage that could only have received
// it by delegation.
//
// Two thread kinds coexist:
//   - MOCK threads (the default; used offline and by every existing test) run
//     the deterministic mock engine over in-memory caps.
//   - AGENTRY threads run the real `@endo/agentry` code-mode runtime against
//     live Endo powers resolved by pet name from the daemon. They are built
//     only when the registry was given daemon `powers` and the create spec
//     names a provider profile.

import { makeThread } from './thread.js';
import { subsetViolation } from './caps.js';
import { mapProfileToAgentryConfig, prepareAgentryRuntime } from './engine.js';

/**
 * @typedef {import('./caps.js').Cap} Cap
 * @typedef {import('./engine.js').EngineContext} EngineContext
 * @typedef {import('./engine.js').Engine} Engine
 * @typedef {import('./thread.js').AgentryMeta} AgentryMeta
 */

/**
 * @param {object} options
 * @param {(ctx: EngineContext) => Engine} options.engineFactory
 *   the default (mock) engine factory
 * @param {(threadId: string, event: import('./engine.js').ThreadEvent) => void} [options.onEvent]
 * @param {unknown} [options.powers]   live daemon host powers; when present,
 *   agentry threads can be created
 * @param {(name: string) => Promise<import('./profiles.js').Profile>} [options.getProfile]
 *   resolve the full provider profile (with apiKey) by name; backend only
 */
export const makeRegistry = ({
  engineFactory,
  onEvent = () => {},
  powers = undefined,
  getProfile = undefined,
}) => {
  /** @type {Map<string, Awaited<ReturnType<typeof makeThread>>>} */
  const threads = new Map();
  let counter = 0;
  const nextId = () => {
    counter += 1;
    return `t${counter}`;
  };

  /**
   * Create a MOCK thread. Synchronous — used by every offline caller and test.
   *
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
      delegate: spec => delegate(id, /** @type {{ caps?: Cap[] }} */ (spec)),
    });
    threads.set(id, thread);
    if (parentId) threads.get(parentId)?.addChild(id);
    return thread;
  };

  /**
   * Create a real AGENTRY thread: resolve the named provider profile, map it to
   * a code-mode config + getApiKey, lazily build the agentry runtime against the
   * live daemon powers, and register the thread. Requires the registry to have
   * been given `powers` + `getProfile` (i.e. an ONLINE daemon).
   *
   * @param {object} spec
   * @param {string} [spec.templateName]
   * @param {Cap[]} [spec.caps]
   * @param {string | null} [spec.parentId]
   * @param {AgentryMeta} spec.agentry
   */
  const createAgentry = async ({
    templateName = 'adhoc',
    caps = [],
    parentId = null,
    agentry,
  }) => {
    if (powers === undefined || getProfile === undefined) {
      throw new Error(
        'agentry threads require an online daemon; the cockpit is OFFLINE',
      );
    }
    if (!agentry || typeof agentry.profileName !== 'string') {
      throw new Error('agentry thread requires a profileName');
    }
    const profile = await getProfile(agentry.profileName);
    const { configModel, configPowers, getApiKey } = mapProfileToAgentryConfig({
      profile,
      model: agentry.model,
      powers: {
        workspacePetName: agentry.workspacePetName,
        gitPetName: agentry.gitPetName,
        gitMode: agentry.gitMode,
      },
    });
    const config = harden({ model: configModel, powers: configPowers });
    // Build the runtime up front (lazy import + define + make). Caps are bound
    // into the agent Compartment here, at make() time — hence the live-revoke
    // limitation documented in engine.js.
    const runtime = await prepareAgentryRuntime({ config, powers, getApiKey });
    const id = nextId();
    const thread = makeThread({
      id,
      parentId,
      templateName,
      caps,
      agentryRuntime: runtime,
      onEvent,
      delegate: spec => delegate(id, /** @type {{ caps?: Cap[] }} */ (spec)),
      agentry,
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
   * @param {{ templateName?: string, caps?: Cap[], prompt?: string, agentry?: AgentryMeta }} spec
   */
  const delegate = async (
    parentId,
    { templateName = 'delegate', caps = [], prompt, agentry },
  ) => {
    const parent = threads.get(parentId);
    if (!parent) throw new Error(`unknown parent thread ${parentId}`);
    const violation = subsetViolation(caps, parent.caps());
    if (violation) throw new Error(`delegation rejected: ${violation}`);
    await null;
    const child = agentry
      ? await createAgentry({ templateName, caps, parentId, agentry })
      : create({ templateName, caps, parentId });
    let outcome;
    if (prompt) outcome = await child.prompt(prompt);
    return { childId: child.id, caps: child.capViews(), outcome };
  };

  /**
   * Revoke a named cap from a thread and from every descendant that still
   * holds it — a delegated cap cannot outlive its revocation up-lineage. The
   * propagation rule is a chosen default for design open-question 4.
   *
   * NOTE: for agentry threads the live cap was bound into the agent Compartment
   * at make() time, so revoke cannot retract it from a turn already running;
   * the revoke applies at (re-)creation. See `engine.js` § makeAgentryEngine.
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

  return harden({
    create,
    createAgentry,
    delegate,
    revokeCap,
    get: id => threads.get(id),
    grantCap: (threadId, cap) => threads.get(threadId)?.grantCap(cap),
    list: () => [...threads.values()].map(t => t.toJSON()),
    tree,
    ids: () => [...threads.keys()],
  });
};
harden(makeRegistry);
