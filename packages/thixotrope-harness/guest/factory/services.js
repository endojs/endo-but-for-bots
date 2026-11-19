// @ts-check
/**
 * Per-session `SessionServices` builders (M1a W1a.6; hook table,
 * `designs/m1a-interfaces.md` sections 9 and 12; architecture 3.2).
 *
 * `serviceBuilders` is append-only for later milestones: each entry is
 * `(context) -> Promise<Partial<SessionServices>>`, merged in order, with
 * `context = { admin, backend, preset, key, settings, ... }` (the
 * `ServicesContext` typedef). `serviceBinders` and `serviceReleasers`
 * (append-only too) use what was built: after `make`, and when a creation
 * rolls back. The result is attenuated:
 * it never contains an admin facet. M1a builds `{ backend, host }`, where
 * `host` is a `SessionHostFacet` the manager mints unbound
 * (`AgentHostAdmin.forSession()`) and the factory binds after `make`.
 *
 * Guest rules: prelude globals only.
 */
import { shapes } from '../lib/guards/factory.js';
import { presetEndowmentsAt } from './presets.js';
import {
  environmentBinder,
  environmentReleaser,
  environmentServices,
} from './environments.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { HarnessSettings } from './root.js' */
/** @import { Row } from './rows.js' */
/** @import { PostOffice } from './post-office.js' */
/** @import { Subagents } from './subagents.js' */
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
 * @property {HarnessSettings} [settings] the operator
 *   settings (the attached environments admin, `environments.js`)
 * @property {Row} [row] the new session's row (mail, seam F2)
 * @property {PostOffice} [postOffice] the factory's post office (mail)
 * @property {Subagents} [subagents] the factory's subagent tree (mail)
 * @property {Record<string, any>} [resolved] the creation's resolved
 *   options: what a subagent of this session inherits (mail)
 * @property {readonly { label: string, value: any }[]} [delegated] a
 *   subagent's endowments: the attachments its parent listed, possibly
 *   none (R4-70); set only for a subagent
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

/**
 * Mail (designs/m9-interfaces.md F4): the session's `Outbox`, which posts
 * as this session only, and the operator's address (the `user` label). A
 * subagent's endowments are the attachments its parent listed and nothing
 * else (R4-70): the field replaces the preset's, empty when none were
 * listed.
 * @type {ServiceBuilder}
 */
const mailServices = async ({ row, postOffice, delegated }) => {
  if (row === undefined || postOffice === undefined) return {};
  /** @type {Record<string, any>} */
  const services = {
    mail: postOffice.outboxFor(row),
    operatorAddress: postOffice.operatorAddress(),
  };
  if (delegated !== undefined) services.endowments = delegated;
  return services;
};

/**
 * Subagents (F4): the session's `Delegation` while its depth is below
 * `maxDepth`; no field at the limit (R4-69), so the subagent tools are not
 * offered.
 * @type {ServiceBuilder}
 */
const subagentServices = async ({ row, subagents, resolved }) => {
  if (row === undefined || subagents === undefined || resolved === undefined)
    return {};
  const delegation = subagents.delegationFor(
    row,
    /** @type {any} */ (resolved),
  );
  return delegation === undefined ? {} : { subagents: delegation };
};

/** Hook table (append-only). */
export const serviceBuilders = harden([
  backendAndHost,
  execVat,
  presetEndowments,
  environmentServices,
  mailServices,
  subagentServices,
]);

/**
 * What a binder or releaser is given: the creation's services, the made
 * session (binders only) and the operator settings.
 * @typedef {object} ServiceUseContext
 * @property {Record<string, any>} services
 * @property {any} [session]
 * @property {HarnessSettings} [settings]
 */

/**
 * Hook table (append-only): run after `make` answered and was checked,
 * in the same crank; sendOnly only (nothing awaited on the creation path).
 * @type {readonly ((context: ServiceUseContext) => void)[]}
 */
export const serviceBinders = harden([environmentBinder]);

/**
 * Hook table (append-only): run when a creation whose services were built
 * is rolled back; sendOnly only.
 * @type {readonly ((context: ServiceUseContext) => void)[]}
 */
export const serviceReleasers = harden([environmentReleaser]);

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
