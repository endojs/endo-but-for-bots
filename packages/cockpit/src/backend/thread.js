// @ts-check
//
// A thread is a running agent instance — what `make(powers)` returns once a
// template is bound to concrete caps (designs/garden-cockpit.md § Thread). It
// owns its caps, its live scope, its engine, its transcript, and its o11y
// counters. Revoking a cap drops it from the scope the engine reads on the
// next turn.

import { capView } from './caps.js';

const TRANSCRIPT_CAP = 500;
const identity = harden(x => x);

/**
 * @typedef {import('./caps.js').Cap} Cap
 * @typedef {import('./engine.js').Engine} Engine
 * @typedef {import('./engine.js').EngineContext} EngineContext
 */

/**
 * @param {object} options
 * @param {string} options.id
 * @param {string | null} options.parentId
 * @param {string} options.templateName
 * @param {Cap[]} options.caps
 * @param {(ctx: EngineContext) => Engine} options.engineFactory
 * @param {(threadId: string, event: import('./engine.js').ThreadEvent) => void} [options.onEvent]
 * @param {EngineContext['delegate']} [options.delegate]
 */
export const makeThread = ({
  id,
  parentId,
  templateName,
  caps,
  engineFactory,
  onEvent = () => {},
  delegate,
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

  const engine = engineFactory({ getScope, emit, delegate });

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
      status,
      caps: [...capMap.values()].map(capView),
      childIds: [...childIds],
      o11y: { ...o11y },
      transcriptLength: transcript.length,
    }),
  });
};
harden(makeThread);
