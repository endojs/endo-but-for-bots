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
import {
  defineProfile as defineProfileIn,
  getProfile as getProfileFrom,
  listProfiles as listProfilesIn,
} from './backend/profiles.js';

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
 * @param {unknown} [options.powers]   live daemon host powers; when present the
 *   cockpit is ONLINE and can build real agentry threads
 * @param {(name: string) => Promise<import('./backend/profiles.js').Profile>} [options.getProfile]
 *   resolve a full provider profile (with apiKey) by name; backend only
 * @param {string} [options.sockPath]   the daemon socket path, for display
 */
export const makeCockpit = ({
  engineFactory = makeMockEngine,
  powers = undefined,
  getProfile = undefined,
  sockPath = undefined,
} = {}) => {
  // When the daemon is online, the cockpit resolves provider profiles against
  // the daemon's petstore (the host powers double as the ProfileHost). The
  // registry's getProfile defaults to this so agentry threads resolve their key
  // unless the caller supplied an explicit getProfile (e.g. a test).
  const profileHost =
    /** @type {import('./backend/profiles.js').ProfileHost} */ (powers);
  const resolveProfile =
    getProfile ||
    (powers !== undefined
      ? name => getProfileFrom(profileHost, name)
      : undefined);

  /** @type {Set<(threadId: string, event: import('./backend/engine.js').ThreadEvent) => void>} */
  const listeners = new Set();
  const emit = (threadId, event) => {
    for (const fn of listeners) fn(threadId, event);
  };
  const registry = makeRegistry({
    engineFactory,
    onEvent: emit,
    powers,
    getProfile: resolveProfile,
  });
  const templates = makeTemplateStore();
  const o11y = makeO11y({ registry });
  const steward = makeSteward({ registry });
  const online = powers !== undefined;

  const profiles = harden({
    online,
    /** @param {import('./backend/profiles.js').Profile} profile */
    define: profile => {
      if (!online) throw new Error('cannot define a profile while OFFLINE');
      return defineProfileIn(profileHost, profile);
    },
    /** masked views only; never returns apiKey */
    list: () => (online ? listProfilesIn(profileHost) : Promise.resolve([])),
  });

  return harden({
    registry,
    templates,
    o11y,
    steward,
    profiles,
    online,
    daemon: harden({ online, sockPath }),
    /** @param {(threadId: string, event: import('./backend/engine.js').ThreadEvent) => void} fn */
    onEvent: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
};
harden(makeCockpit);
