// @ts-check
/**
 * Fixture loaded by {@link file://../pi-confined-compat.test.js} inside an
 * Endo Compartment via `@endo/compartment-mapper`'s `importLocation`.
 *
 * Mirrors the imports `src/agent/index.js` makes from pi-mono:
 *
 *   import { Agent as PiAgent } from '@mariozechner/pi-agent-core';
 *   import { getModel, getProviders } from '@mariozechner/pi-ai';
 *
 * Each side-effect is wrapped in try/catch so the importing test can
 * inspect *which* step fails when a future pi release stops tolerating
 * the confined-Compartment environment, rather than seeing a single
 * opaque "import failed" message.
 */

import { Agent as PiAgent } from '@mariozechner/pi-agent-core';
import { getModel, getProviders } from '@mariozechner/pi-ai';

export const types = {
  PiAgent: typeof PiAgent,
  getModel: typeof getModel,
  getProviders: typeof getProviders,
};

export const providersProbe = (() => {
  try {
    const providers = getProviders();
    return { ok: true, value: providers.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
})();

export const getModelProbe = (() => {
  try {
    // Use a deliberately-bogus model id; we only care that the call does
    // not throw under confinement, not that it resolves a real model.
    getModel('openai', 'definitely-not-a-real-model-id');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
})();

export const constructProbe = (() => {
  try {
    // eslint-disable-next-line no-new
    new PiAgent({});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
})();
