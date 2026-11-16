// @ts-check
/**
 * Per-session `SessionServices` builders (M1a W1a.6; hook table,
 * `designs/m1a-interfaces.md` sections 9 and 12; architecture 3.2).
 *
 * `serviceBuilders` is append-only for later milestones: each entry is
 * `(context) -> Promise<Partial<SessionServices>>`, merged in order, with
 * `context = { admin, backend, preset, key }`. The result is attenuated:
 * it never contains an admin facet. M1a builds `{ backend, host }`, where
 * `host` is a `SessionHostFacet` the manager mints unbound
 * (`AgentHostAdmin.forSession()`) and the factory binds after `make`.
 *
 * Guest rules: prelude globals only.
 */
import { shapes } from '../lib/interfaces.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/**
 * @typedef {object} ServicesContext
 * @property {any} admin the AgentHostAdmin
 * @property {any} backend this session's Backend
 * @property {any} preset this session's Preset
 * @property {string} key the session key
 */

/**
 * @callback ServiceBuilder
 * @param {ServicesContext} context
 * @returns {Promise<Record<string, any>>}
 */

/** @type {ServiceBuilder} */
const backendAndHost = async ({ admin, backend }) => ({
  backend,
  host: await E(admin).forSession(),
});

/** Hook table (append-only). */
export const serviceBuilders = harden([backendAndHost]);

/**
 * Merge every builder's part; the result must be a `shapes.SessionServices`.
 * @param {ServicesContext} context
 * @returns {Promise<{ backend: any, host: any }>}
 */
export const buildSessionServices = async context => {
  /** @type {Record<string, any>} */
  const services = {};
  for (const build of serviceBuilders) {
    // eslint-disable-next-line no-await-in-loop
    Object.assign(services, await build(context));
  }
  const result = harden(services);
  mustMatch(result, shapes.SessionServices);
  return /** @type {{ backend: any, host: any }} */ (result);
};
harden(buildSessionServices);
