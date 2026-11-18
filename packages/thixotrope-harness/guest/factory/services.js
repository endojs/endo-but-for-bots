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
import { presetEndowmentsAt } from './presets.js';

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
 * @property {any} [host] an unbound `SessionHostFacet` minted with a pool
 *   spare (M1b W1b.5)
 * @property {() => any} [makeExecVat] makes this session's `ExecHandle`
 *   (M1b W1b.5; absent without a pool)
 * @property {any} [presetSnapshot] the preset's snapshot the creation's
 *   resolvers read (M5 W5.1, seam H-3)
 */

/**
 * @callback ServiceBuilder
 * @param {ServicesContext} context
 * @returns {Promise<Record<string, any>>}
 */

/**
 * A spare session brings a host facet minted with it (M1b W1b.5: the take
 * saves the `forSession` hop); otherwise one is minted now.
 * @type {ServiceBuilder}
 */
const backendAndHost = async ({ admin, backend, host }) => ({
  backend,
  host: host ?? (await E(admin).forSession()),
});

/**
 * M1b W1b.5: the session's exec-vat lease (`ExecHandle`, made by the
 * factory from its pool; architecture 3.2, m1b-interfaces.md 3.4).
 * @type {ServiceBuilder}
 */
const execVat = async ({ makeExecVat }) =>
  makeExecVat === undefined ? {} : { execVat: makeExecVat() };

/**
 * M5 W5.1 (m5-interfaces.md 2.3 step 3; P-53, R3-17, R3-22, R3-270): the
 * preset's endowment objects, read from its record at the snapshot's
 * revision (`texts.presetChanged` if it was saved since, which fails and
 * rolls back the creation). No field when there are none (`chat-only`).
 * @type {ServiceBuilder}
 */
const presetEndowments = async ({ preset, presetSnapshot }) => {
  const at = presetSnapshot?.revision;
  if (typeof at !== 'number') return {};
  const endowments = presetEndowmentsAt(preset, at);
  if (endowments === undefined || endowments.length === 0) return {};
  return { endowments };
};

/** Hook table (append-only). */
export const serviceBuilders = harden([
  backendAndHost,
  execVat,
  presetEndowments,
]);

/**
 * Merge every builder's part; the result must be a `shapes.SessionServices`.
 * @param {ServicesContext} context
 * @returns {Promise<{ backend: any, host: any, execVat?: any }>}
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
  return /** @type {{ backend: any, host: any, execVat?: any }} */ (result);
};
harden(buildSessionServices);
