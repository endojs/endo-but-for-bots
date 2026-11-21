// @ts-check
/**
 * The factory's entries for session environments: a git workspace and a
 * shell (`designs/m6-interfaces.md` 3.9, 4.1, 4.6; D-M6-12, D-M6-16;
 * R3-12..R3-15, R3-21, R4-9, G-29).
 *
 * The factory keeps no state per environment. The operator attaches the
 * installed `EnvironmentsAdmin` as the `environments` harness setting
 * (`HarnessRoot.configure({ environments })`); each entry here asks that
 * setting when it runs, so a state without environments simply has none:
 *
 * - `environmentProviders` (`preset-templates.js` `objectProviders`): the
 *   `git-workspace` and `development-environment` kinds are available once
 *   the setting is set, else `texts.runnerRequired`;
 * - `environmentServices` (`services.js` `serviceBuilders`): when the
 *   creation's preset snapshot selects either kind, one answered
 *   `provide({ workspace, shell })` (one manager crank on the creation
 *   path), answered as `{ workspace?, shell?, environment }`;
 * - `environmentBinder` (`serviceBinders`, after `make`) and
 *   `environmentReleaser` (`serviceReleasers`, a rolled-back creation):
 *   sendOnly, off the creation path;
 * - `releaseEnvironment` (the factory's delete hook, after the subagents'
 *   own): the delete waits for the manager's `releaseSession`.
 *
 * The admin is a remotable this vat holds; no environments guard is
 * imported here (`texts.runnerRequired` is `guards/factory.js`'s).
 *
 * Guest rules: prelude globals only; no clock.
 */
import { texts } from '../lib/guards/factory.js';
import { environmentKinds, selectsKind } from '../lib/environment-prompt.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { HarnessSettings } from './root.js' */
/** @import { ObjectProvider } from './preset-templates.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * The attached admin, or undefined.
 * @param {HarnessSettings | undefined} settings
 */
const adminOf = settings => settings?.environments();

/**
 * R3-21: a preset that provisions either object needs the runner.
 * @param {{ settings?: HarnessSettings }} context
 */
const runnerAvailable = context =>
  adminOf(context?.settings) === undefined ? texts.runnerRequired : undefined;

/** @type {readonly ObjectProvider[]} */
export const environmentProviders = harden([
  harden({ kind: environmentKinds.workspace, available: runnerAvailable }),
  harden({ kind: environmentKinds.shell, available: runnerAvailable }),
]);

/**
 * Creation (4.1 step 1): the environment the preset snapshot selects. A
 * shell always comes with a workspace (`EnvironmentKit`).
 * @param {{ presetSnapshot?: any, settings?: HarnessSettings }} context
 * @returns {Promise<Record<string, any>>}
 */
export const environmentServices = async ({ presetSnapshot, settings }) => {
  const shell = selectsKind(presetSnapshot, environmentKinds.shell);
  const workspace =
    shell || selectsKind(presetSnapshot, environmentKinds.workspace);
  if (!workspace) return {};
  const admin = adminOf(settings);
  if (admin === undefined) throw Error(texts.runnerRequired);
  const workspaceSeed = presetSnapshot?.workspaceSeed;
  const kit = await E(admin).provide(
    harden({
      workspace,
      shell,
      ...(workspaceSeed === undefined ? {} : { workspaceSeed }),
    }),
  );
  /** @type {Record<string, any>} */
  const services = { environment: kit.control };
  if (kit.workspace !== undefined) services.workspace = kit.workspace;
  if (kit.shell !== undefined) services.shell = kit.shell;
  return harden(services);
};
harden(environmentServices);

/**
 * After `make` (4.1 step 3): the manager learns the record's session, so
 * a delete can release by `Session`. sendOnly.
 * @param {{ services: any, session?: any, settings?: HarnessSettings }} context
 */
export const environmentBinder = ({ services, session, settings }) => {
  const admin = adminOf(settings);
  if (services.environment === undefined || admin === undefined) return;
  E.sendOnly(admin).bindSession(services.environment, session);
};
harden(environmentBinder);

/**
 * A rolled-back creation (4.1 step 3, kill point K1): release the record
 * by its control. sendOnly; the manager's release is idempotent.
 * @param {{ services: any, settings?: HarnessSettings }} context
 */
export const environmentReleaser = ({ services, settings }) => {
  const admin = adminOf(settings);
  if (services.environment === undefined || admin === undefined) return;
  E.sendOnly(admin).release(services.environment);
};
harden(environmentReleaser);

/**
 * Delete step 1 (4.6): release the session's environment, found by its
 * `Session`; nothing when no admin is attached. A rejection leaves the
 * delete record at step 1, resumed at the next start (M2 7.1).
 * @param {{ session: any, settings?: HarnessSettings }} context
 */
export const releaseEnvironment = async ({ session, settings }) => {
  const admin = adminOf(settings);
  if (admin === undefined) return;
  await E(admin).releaseSession(session);
};
harden(releaseEnvironment);
