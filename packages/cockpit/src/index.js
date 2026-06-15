// @ts-check
//
// @endo/cockpit — assemble the harness-host. `makeCockpit` wires the thread
// registry to an engine factory and an event hub; `src/backend/server.js`
// puts an http + websocket front end on it. The default engine is the mock,
// so the cockpit runs end-to-end with no LLM and no monorepo install.

import { makeRegistry } from './backend/registry.js';
import {
  makeMockEngine,
  makeMockGit,
  makeMockWorkspace,
} from './backend/engine.js';
import { makeCap } from './backend/caps.js';
import { makeTemplateStore } from './backend/templates.js';
import { makeO11y } from './backend/o11y.js';
import { makeSteward } from './backend/steward.js';

/**
 * Build a mock-backed capability from a wire spec. The real harness-host
 * resolves live Endo caps via pet-name lookup; the mock builds an in-memory
 * cap whose read-only flavour genuinely lacks the mutating methods.
 *
 * @param {{ name: string, kind: string, mode?: string }} spec
 * @returns {import('./backend/caps.js').Cap}
 */
export const makeMockCap = ({ name, kind, mode }) => {
  let value;
  if (kind === 'git') value = makeMockGit({ mode });
  else if (kind === 'workspace') value = makeMockWorkspace({ mode });
  else value = harden({ describe: async () => `named power ${name}` });
  return makeCap({ name, kind, mode, value });
};
harden(makeMockCap);

/** @param {Array<{ name: string, kind: string, mode?: string }>} specs */
export const buildMockCaps = (specs = []) => specs.map(makeMockCap);
harden(buildMockCaps);

/**
 * @param {object} [options]
 * @param {(ctx: import('./backend/engine.js').EngineContext) => import('./backend/engine.js').Engine} [options.engineFactory]
 */
export const makeCockpit = ({ engineFactory = makeMockEngine } = {}) => {
  /** @type {Set<(threadId: string, event: import('./backend/engine.js').ThreadEvent) => void>} */
  const listeners = new Set();
  const emit = (threadId, event) => {
    for (const fn of listeners) fn(threadId, event);
  };
  const registry = makeRegistry({ engineFactory, onEvent: emit });
  const templates = makeTemplateStore();
  const o11y = makeO11y({ registry });
  const steward = makeSteward({ registry });

  return harden({
    registry,
    templates,
    o11y,
    steward,
    /** @param {(threadId: string, event: import('./backend/engine.js').ThreadEvent) => void} fn */
    onEvent: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
};
harden(makeCockpit);
