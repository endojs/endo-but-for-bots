// @ts-check
//
// A thread is a running agent instance — what `make(powers)` returns once a
// template is bound to concrete caps (designs/garden-cockpit.md § Thread). It
// owns its caps, its live scope, its engine, its transcript, and its o11y
// counters. Revoking a cap drops it from the scope the engine reads on the
// next turn.

import { capView } from './caps.js';
import { makeAgentryEngineFromRuntime } from './engine.js';

const TRANSCRIPT_CAP = 500;
const identity = harden(x => x);

/**
 * @typedef {import('./caps.js').Cap} Cap
 * @typedef {import('./engine.js').Engine} Engine
 * @typedef {import('./engine.js').EngineContext} EngineContext
 */

/**
 * @typedef {object} AgentryMeta
 * @property {string} profileName    the provider profile this thread resolves
 * @property {string} model          the model name
 * @property {string} [workspacePetName]
 * @property {string} [gitPetName]
 * @property {'readOnly' | 'readWrite'} [gitMode]
 */

/**
 * The engine is supplied either as a synchronous `engineFactory(ctx)` (the mock
 * path, used by every existing caller and test) or as an already-prepared
 * `agentryRuntime` (the agentry path, where the registry builds the runtime
 * asynchronously before constructing the thread; the thread then wraps it with
 * its own `emit`). Exactly one of the two is required.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {string | null} options.parentId
 * @param {string} options.templateName
 * @param {Cap[]} options.caps
 * @param {(ctx: EngineContext) => Engine} [options.engineFactory]
 * @param {import('@endo/agentry/code-mode-runtime').CodeModeRuntime} [options.agentryRuntime]
 *   a pre-built code-mode runtime (agentry path)
 * @param {(threadId: string, event: import('./engine.js').ThreadEvent) => void} [options.onEvent]
 * @param {EngineContext['delegate']} [options.delegate]
 * @param {AgentryMeta} [options.agentry]   when present, this is a real
 *   (agentry) thread; caps are bound into the agent Compartment at make() time,
 *   so a live cap revoke applies at (re-)creation, not mid-run.
 */
export const makeThread = ({
  id,
  parentId,
  templateName,
  caps,
  engineFactory,
  agentryRuntime,
  onEvent = () => {},
  delegate,
  agentry,
}) => {
  /** @type {Map<string, Cap>} */
  const capMap = new Map(caps.map(c => [c.name, c]));
  /** @type {import('./engine.js').ThreadEvent[]} */
  const transcript = [];
  /** @type {string[]} */
  const childIds = [];
  const o11y = { tokens: 0, turns: 0, cost: 0 };
  let status = 'idle';

  const getScope = () => {
    /** @type {Record<string, unknown>} */
    const scope = { E: identity };
    for (const cap of capMap.values()) {
      scope[cap.name] = cap.value;
    }
    return scope;
  };

  /** @param {import('./engine.js').ThreadEvent} event */
  const emit = event => {
    transcript.push(event);
    if (transcript.length > TRANSCRIPT_CAP) transcript.shift();
    if (event.kind === 'turn-start') status = 'running';
    if (event.kind === 'turn-end') {
      status = event.data === 'error' ? 'error' : 'idle';
      o11y.turns += 1;
    }
    onEvent(id, event);
  };

  // The mock path supplies a synchronous factory; the agentry path supplies an
  // already-prepared runtime that we wrap here with this thread's `emit`.
  const ctx = { getScope, emit, delegate };
  let engine;
  if (agentryRuntime !== undefined) {
    engine = makeAgentryEngineFromRuntime(agentryRuntime, ctx);
  } else if (engineFactory !== undefined) {
    engine = engineFactory(ctx);
  } else {
    throw new Error(
      'makeThread requires either engineFactory or agentryRuntime',
    );
  }

  /** @param {string} text */
  const prompt = async text => {
    const outcome = await engine.prompt(text);
    o11y.tokens += outcome.tokens || 0;
    return outcome;
  };

  return harden({
    id,
    parentId,
    templateName,
    engineKind: engine.kind,
    agentry: agentry ? harden({ ...agentry }) : undefined,
    get childIds() {
      return harden([...childIds]);
    },
    get status() {
      return status;
    },
    caps: () => [...capMap.values()],
    capViews: () => [...capMap.values()].map(capView),
    hasCap: name => capMap.has(name),
    /** @param {Cap} cap */
    grantCap: cap => {
      capMap.set(cap.name, cap);
      emit({ kind: 'tool-result', data: `granted cap ${cap.name}` });
    },
    /**
     * @param {string} name
     * @returns {boolean} whether a cap was removed
     */
    revokeCap: name => {
      const had = capMap.delete(name);
      if (had) emit({ kind: 'tool-result', data: `revoked cap ${name}` });
      return had;
    },
    addChild: childId => childIds.push(childId),
    prompt,
    steer: prompt,
    transcript: () => [...transcript],
    o11y: () => ({ ...o11y }),
    toJSON: () => ({
      id,
      parentId,
      templateName,
      engineKind: engine.kind,
      agentry: agentry ? { ...agentry } : undefined,
      status,
      caps: [...capMap.values()].map(capView),
      childIds: [...childIds],
      o11y: { ...o11y },
      transcriptLength: transcript.length,
    }),
  });
};
harden(makeThread);
