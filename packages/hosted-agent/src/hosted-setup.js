// @ts-check
/* global process */

/**
 * Host-setup helpers shared by the CLI adapters' `setup-host.js` and
 * `setup-hosted.js` scripts and by their backends: reading a provisioned
 * formula by its verified entrypoint, validating runtime placement against
 * guest storage roots, persisting the explicit runtime construction policy,
 * refusing runtime-directory leftovers a retired runtime left under a label,
 * and pinning a slice image reference. Each adapter binds its own label,
 * names, and specifiers.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { PINNED_IMAGE_REFERENCE_PATTERN } from '@endo/sandbox/policy.js';
import { assertPrivateDirectory } from '@endo/sandbox/private-directory.js';
import { readRuntimeConfig } from '@endo/sandbox/runtime-config.js';
import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { normalizeRunnerLimits } from './delegated-runner.js';
import { normalizeShareLimits } from './subscription-share.js';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './current-specifier.js';
import { assertAccountAuthority } from './account-authority.js';
import {
  invalidateAccountBindings,
  makeAccountId,
  publishAccountBindings,
} from './account-bindings.js';

/**
 * Read one immutable formula by the ID captured from its current binding.
 * Do not revive it or resolve the mutable pet name again between reads. The
 * formula must be a `make-unconfined` with exactly the expected literal
 * specifier: a generic or unknown entrypoint under the name is refused rather
 * than adopted, since removing a name alone never proves its runtime stopped.
 *
 * @param {any} host The `@agent` host powers.
 * @param {object} options
 * @param {string} options.label The adapter's name for messages.
 * @param {string[]} options.namePath The pet name path of the formula;
 *   messages name its last segment.
 * @param {string} options.expectedSpecifier
 * @param {string} [options.expectedPowersIdentifier] When supplied, require
 *   this exact captured powers reference, not the current value of a pet name.
 * @returns {Promise<{ identifier: string, env: Record<string, string> }>}
 */
export const readProvisionedEnvironment = async (
  host,
  { label, namePath, expectedSpecifier, expectedPowersIdentifier },
) => {
  const name = namePath[namePath.length - 1];
  const identified = await E(host).identify(...namePath);
  if (!identified) throw Fail`Cannot identify ${b(label)} ${q(name)}`;
  // The daemon returns a formula ID; identify's public type erases its brand.
  const identifier = /** @type {string} */ (identified);
  const record = await E(E(host).diagnostics()).getFormula(identifier);
  const specifier = record.properties.specifier;
  (record.type === 'make-unconfined' &&
    specifier?.kind === 'literal' &&
    specifier.value === expectedSpecifier) ||
    Fail`${b(label)} ${b(name)} has an unsupported entrypoint. Retire the old runtime and prove its processes have stopped before replacing its formula; removing its name alone is insufficient.`;
  if (expectedPowersIdentifier !== undefined) {
    const powers = record.properties.powers;
    (powers?.kind === 'reference' &&
      powers.identifier === expectedPowersIdentifier) ||
      Fail`${b(label)} ${b(name)} captures different powers; its storage owner must use the selected state provider`;
  }
  const env = await E(host).getFormulaEnvironment(identifier);
  return harden({ identifier, env: env ?? {} });
};
harden(readProvisionedEnvironment);

/**
 * Canonicalize existing ancestors without creating a future guest storage root.
 * The operator must keep these ancestors outside guest rename authority.
 * @param {string} name
 * @param {string} [label]
 * @returns {Promise<string>}
 */
export const resolveFuturePath = async (name, label = 'Hosted') => {
  await null;
  try {
    return await fs.realpath(name);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
      throw error;
    const existing = await fs.lstat(name).catch(missing => {
      if (/** @type {NodeJS.ErrnoException} */ (missing).code !== 'ENOENT')
        throw missing;
      return undefined;
    });
    !existing || Fail`${b(label)} storage path has an unresolved symlink`;
    const parent = path.dirname(name);
    if (parent === name) throw error;
    return path.join(
      await resolveFuturePath(parent, label),
      path.basename(name),
    );
  }
};
harden(resolveFuturePath);

/**
 * Validate operator placement, including guest roots which do not exist yet.
 * No mkdir/chmod adoption: the runtime parent is provisioned by the deployment.
 * The caller supplies effective persisted roots where a formula already exists.
 * @param {string} directory
 * @param {Record<string, string>} roots
 * @param {string} [label]
 * @returns {Promise<string>} The canonical runtime directory.
 */
export const assertRuntimePlacement = async (
  directory,
  roots,
  label = 'Hosted',
) => {
  const canonical = await assertPrivateDirectory(directory, fs);
  for (const root of Object.values(roots)) {
    path.isAbsolute(root) || Fail`${b(label)} storage roots must be absolute`;
    // eslint-disable-next-line no-await-in-loop
    const guest = await resolveFuturePath(root, label);
    const relative = path.relative(canonical, guest);
    const reverse = path.relative(guest, canonical);
    /** @param {string} value */
    const outside = value =>
      value === '..' || value.startsWith(`..${path.sep}`);
    (outside(relative) && outside(reverse)) ||
      Fail`Sandbox runtime directory must be disjoint from ${b(label)} guest storage roots`;
  }
  return canonical;
};
harden(assertRuntimePlacement);

/**
 * Persist only the explicit runtime construction policy; no ambient credentials.
 * @param {Record<string, string | undefined>} env
 * @param {string} ownerId
 * @param {Record<string, string>} roots
 * @param {string} [label]
 */
export const prepareRuntimeEnv = async (env, ownerId, roots, label) => {
  const config = readRuntimeConfig({ ...env, ENDO_SANDBOX_OWNER_ID: ownerId });
  const directory = await assertRuntimePlacement(
    config.directory,
    roots,
    label,
  );
  return harden({
    ENDO_SANDBOX_RUNTIME_DIR: directory,
    ENDO_SANDBOX_OWNER_ID: config.ownerId,
    ENDO_SANDBOX_GENERATED_MAX_BYTES: String(config.maxBytes),
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: String(config.maxEntries),
  });
};
harden(prepareRuntimeEnv);

/**
 * A runtime claims `<owner>.owner` and `<owner>.files` in its directory at
 * construction and refuses either if present; a retired runtime under the
 * same label leaves both behind across restart or failed cleanup, and a
 * formula the daemon binds before construction would then be retained
 * unusable. Neither is adopted or removed here: the operator establishes that
 * the holder has stopped, then reconciles them, before setup mints anything.
 * @param {string} directory The canonical runtime directory.
 * @param {string} ownerId
 */
export const assertNoRuntimeLeftovers = async (directory, ownerId) => {
  for (const suffix of ['owner', 'files']) {
    const leftover = path.join(directory, `${ownerId}.${suffix}`);
    // eslint-disable-next-line no-await-in-loop
    const info = await fs.lstat(leftover).catch(error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
        return undefined;
      throw error;
    });
    if (info !== undefined) {
      throw Fail`Runtime directory still holds ${q(leftover)}: the native runtime would claim it and be refused at construction. Establish that the runtime that held it has stopped, then reconcile it, before rerunning setup.`;
    }
  }
};
harden(assertNoRuntimeLeftovers);

/**
 * Create a private directory the daemon user owns, or adopt an existing one it
 * already owns, normalizing its mode; refuse a symlink, a non-directory, or a
 * directory owned by someone else.
 * @param {string} label The setting's name for messages.
 * @param {string} directory
 */
export const providePrivateDirectory = async (label, directory) => {
  const info = await fs.lstat(directory).catch(() => undefined);
  !info?.isSymbolicLink() ||
    Fail`${b(label)} must not be a symlink: ${q(directory)}`;
  if (info && !info.isDirectory()) {
    throw Fail`${b(label)} must be a directory: ${q(directory)}`;
  }
  if (info) {
    (await fs.stat(directory)).uid === process.getuid?.() ||
      Fail`${b(label)} must be owned by the daemon user: ${q(directory)}`;
    await fs.chmod(directory, 0o700);
  } else {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
};
harden(providePrivateDirectory);

/**
 * Mint an unconfined formula whose sole powers is an existing capability
 * named by path. `powersName` takes one pet name, so alias the capability
 * under a temporary root name for the mint; the formula retains the
 * capability's identity, not the alias. The temporary name should carry a
 * dot so it cannot shadow a managed-credential name.
 * @param {any} hostAgent
 * @param {object} options
 * @param {string[]} options.powersPath
 * @param {string} options.temporary
 * @param {string} options.specifier
 * @param {string[]} options.resultName
 * @param {Record<string, string>} options.env
 */
export const mintWithPowersPath = async (
  hostAgent,
  { powersPath, temporary, specifier, resultName, env },
) => {
  if (await E(hostAgent).has(temporary)) await E(hostAgent).remove(temporary);
  try {
    await E(hostAgent).copy(powersPath, [temporary]);
    await E(hostAgent).makeUnconfined('@main', specifier, {
      powersName: temporary,
      resultName,
      env: harden(env),
    });
  } finally {
    await E(hostAgent).remove(temporary);
  }
};
harden(mintWithPowersPath);

/**
 * Provide the account oracle of one subscription: a retained formula with a
 * namespace of its own (`account-oracle-module.js`), fed by the broker service
 * whose transport reads the account's rate-limit headers.
 *
 * The oracle's namespace holds the broker's read-only account source, as a
 * formula of its own (`account-source-module.js`), and never the broker
 * service, which can mint session scopes. That source is minted again over
 * the broker that exists now on every run, and the oracle's `account-source`
 * name re-pointed at it; the oracle itself keeps its identity, and so its
 * journal of readings and any reference a view already holds, across a broker
 * that a deploy re-minted.
 *
 * The names it needs while it is being made are tucked under `dir`
 * afterwards, and a run that died half way is finished or cleared by the
 * next.
 *
 * @param {any} hostAgent The `@agent` host powers.
 * @param {object} options
 * @param {string} options.label The adapter's name for messages.
 * @param {string} options.dir The adapter's directory pet name.
 * @param {string[]} options.brokerPath Pet name path of the broker service.
 * @param {string} options.providerId What the oracle calls its provider.
 * @param {string} options.specifier The oracle module's import specifier.
 * @param {string} options.sourceSpecifier The source module's specifier.
 * @param {string} [options.subscriptionId] For a broker over several
 *   subscriptions: which one this oracle describes. Each has an oracle, a
 *   journal and a source of its own.
 * @returns {Promise<string[]>} The oracle's pet name path.
 */
export const provideAccountOracle = async (
  hostAgent,
  {
    label,
    dir,
    brokerPath,
    providerId,
    specifier,
    sourceSpecifier,
    subscriptionId,
  },
) => {
  const suffix = subscriptionId === undefined ? '' : `-${subscriptionId}`;
  const oraclePath = [dir, `account-oracle${suffix}`];
  const sourcePath = [dir, `account-source${suffix}`];
  const powersPath = [dir, `account-oracle${suffix}-powers`];
  const handlePath = [dir, `account-oracle${suffix}-handle`];
  const handleName = `${dir}.account-oracle${suffix}-handle`;
  const powersName = `${dir}.account-oracle${suffix}-powers`;
  (await E(hostAgent).has(...brokerPath)) ||
    Fail`${b(label)} account oracle needs the broker service ${q(brokerPath.join('/'))}`;

  if (await E(hostAgent).has(...sourcePath)) {
    await E(hostAgent).remove(...sourcePath);
  }
  await mintWithPowersPath(hostAgent, {
    powersPath: brokerPath,
    temporary: `${dir}.account-source${suffix}-powers`,
    specifier: sourceSpecifier,
    resultName: sourcePath,
    env:
      subscriptionId === undefined
        ? {}
        : { ACCOUNT_SUBSCRIPTION_ID: subscriptionId },
  });
  const sourceLocator = await E(hostAgent).locate(...sourcePath);

  if (!(await E(hostAgent).has(...oraclePath))) {
    // A run that died before the launch left these top-level; start clean.
    for (const stray of [handleName, powersName]) {
      // eslint-disable-next-line no-await-in-loop
      if (await E(hostAgent).has(stray)) await E(hostAgent).remove(stray);
    }
    await E(hostAgent).provideGuest(handleName, { agentName: powersName });
    const guest = await E(hostAgent).lookup(powersName);
    await E(guest).storeLocator('account-source', sourceLocator);
    await E(hostAgent).makeUnconfined('@main', specifier, {
      powersName,
      resultName: oraclePath,
      env: harden({ ACCOUNT_PROVIDER_ID: providerId }),
    });
  }
  // Finish the moves, only into a destination that is still free.
  for (const [from, to] of [
    [handleName, handlePath],
    [powersName, powersPath],
  ]) {
    if (
      // eslint-disable-next-line no-await-in-loop
      (await E(hostAgent).has(/** @type {string} */ (from))) &&
      // eslint-disable-next-line no-await-in-loop
      !(await E(hostAgent).has(.../** @type {string[]} */ (to)))
    ) {
      // eslint-disable-next-line no-await-in-loop
      await E(hostAgent).move([from], to);
    }
  }
  // Re-point at the source minted above. The oracle resolves the name on
  // every call, so this is all a re-minted broker takes.
  const powers = await E(hostAgent).lookup(powersPath);
  await E(powers).storeLocator('account-source', sourceLocator);
  return oraclePath;
};
harden(provideAccountOracle);

/**
 * Provide the subscription admin of one subscription: a retained formula with
 * a namespace of its own (`subscription-admin-module.js`), through which an
 * operator redeems a banked rate-limit reset.
 *
 * It follows the account oracle's shape, and for the same reasons. Its
 * namespace holds the broker's reset redeemer as a formula of its own
 * (`reset-redeemer-module.js`), minted again on every run, and the account
 * source the oracle already has; never the broker service. The admin keeps
 * its identity across a re-minted broker, and with it the stored intent of a
 * redeem whose answer was lost.
 *
 * Call it after `provideAccountOracle`, which mints the source.
 *
 * @param {any} hostAgent The `@agent` host powers.
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.dir
 * @param {string[]} options.brokerPath
 * @param {string} options.specifier The admin module's import specifier.
 * @param {string} options.redeemerSpecifier The redeemer module's specifier.
 * @param {string} [options.subscriptionId]
 * @returns {Promise<string[] | undefined>} The admin's pet name path, or
 *   undefined when this broker has no reset redeemer.
 */
export const provideSubscriptionAdmin = async (
  hostAgent,
  { label, dir, brokerPath, specifier, redeemerSpecifier, subscriptionId },
) => {
  const suffix = subscriptionId === undefined ? '' : `-${subscriptionId}`;
  const adminPath = [dir, `subscription-admin${suffix}`];
  const redeemerPath = [dir, `reset-redeemer${suffix}`];
  const sourcePath = [dir, `account-source${suffix}`];
  const powersPath = [dir, `subscription-admin${suffix}-powers`];
  const handlePath = [dir, `subscription-admin${suffix}-handle`];
  const handleName = `${dir}.subscription-admin${suffix}-handle`;
  const powersName = `${dir}.subscription-admin${suffix}-powers`;
  (await E(hostAgent).has(...brokerPath)) ||
    Fail`${b(label)} subscription admin needs the broker service ${q(brokerPath.join('/'))}`;
  (await E(hostAgent).has(...sourcePath)) ||
    Fail`${b(label)} subscription admin needs the account source ${q(sourcePath.join('/'))}`;

  if (await E(hostAgent).has(...redeemerPath)) {
    await E(hostAgent).remove(...redeemerPath);
  }
  // A provider with nothing to redeem answers undefined; a broker whose
  // running worker is from before it had a redeemer cannot answer at all, and
  // then the mint itself fails, after it has written the name. Neither leaves
  // a name behind.
  let redeemer;
  try {
    await mintWithPowersPath(hostAgent, {
      powersPath: brokerPath,
      temporary: `${dir}.reset-redeemer${suffix}-powers`,
      specifier: redeemerSpecifier,
      resultName: redeemerPath,
      env:
        subscriptionId === undefined
          ? {}
          : { ACCOUNT_SUBSCRIPTION_ID: subscriptionId },
    });
    redeemer = await E(hostAgent).lookup(redeemerPath);
  } catch (error) {
    if (await E(hostAgent).has(...redeemerPath)) {
      await E(hostAgent).remove(...redeemerPath);
    }
    throw error;
  }
  if (redeemer === undefined) {
    await E(hostAgent).remove(...redeemerPath);
    return undefined;
  }
  const redeemerLocator = await E(hostAgent).locate(...redeemerPath);
  const sourceLocator = await E(hostAgent).locate(...sourcePath);

  if (!(await E(hostAgent).has(...adminPath))) {
    for (const stray of [handleName, powersName]) {
      // eslint-disable-next-line no-await-in-loop
      if (await E(hostAgent).has(stray)) await E(hostAgent).remove(stray);
    }
    await E(hostAgent).provideGuest(handleName, { agentName: powersName });
    const guest = await E(hostAgent).lookup(powersName);
    await E(guest).storeLocator('reset-redeemer', redeemerLocator);
    await E(guest).storeLocator('account-source', sourceLocator);
    await E(hostAgent).makeUnconfined('@main', specifier, {
      powersName,
      resultName: adminPath,
      env: harden({}),
    });
  }
  for (const [from, to] of [
    [handleName, handlePath],
    [powersName, powersPath],
  ]) {
    if (
      // eslint-disable-next-line no-await-in-loop
      (await E(hostAgent).has(/** @type {string} */ (from))) &&
      // eslint-disable-next-line no-await-in-loop
      !(await E(hostAgent).has(.../** @type {string[]} */ (to)))
    ) {
      // eslint-disable-next-line no-await-in-loop
      await E(hostAgent).move([from], to);
    }
  }
  // Re-point at what was minted over the broker that exists now. The intent
  // journal in this namespace is not touched.
  const powers = await E(hostAgent).lookup(powersPath);
  await E(powers).storeLocator('reset-redeemer', redeemerLocator);
  await E(powers).storeLocator('account-source', sourceLocator);
  return adminPath;
};
harden(provideSubscriptionAdmin);

const moduleSpecifier = (/** @type {string} */ relative) =>
  assertCurrentSpecifier(
    toCurrentSpecifier(new URL(relative, import.meta.url).href),
  );

const SHARE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * Mint the adapter's broker as a `Subscription` (`subscription-module.js`)
 * over the broker that exists now, as `<dir>/subscription`, and re-point
 * every share already made at it. Called on every setup run, since a deploy
 * re-mints the broker; a share keeps its identity, its limits, its meter and
 * its revocation.
 *
 * `<dir>/subscription` is the operator's subscription whole: it is given to
 * shares' namespaces and to nothing else.
 *
 * @param {any} hostAgent The `@agent` host powers.
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.dir
 * @param {string[]} options.brokerPath
 * @param {string} options.specifier The subscription module's specifier.
 * @returns {Promise<string>} The subscription's locator.
 */
export const provideBrokerSubscription = async (
  hostAgent,
  { label, dir, brokerPath, specifier },
) => {
  const subscriptionPath = [dir, 'subscription'];
  (await E(hostAgent).has(...brokerPath)) ||
    Fail`${b(label)} subscription needs the broker service ${q(brokerPath.join('/'))}`;
  if (await E(hostAgent).has(...subscriptionPath)) {
    await E(hostAgent).remove(...subscriptionPath);
  }
  try {
    await mintWithPowersPath(hostAgent, {
      powersPath: brokerPath,
      temporary: `${dir}.subscription-powers`,
      specifier,
      resultName: subscriptionPath,
      env: {},
    });
    (await E(hostAgent).lookup(subscriptionPath)) !== undefined ||
      Fail`${b(label)} broker offers no subscription`;
  } catch (error) {
    // A broker whose worker predates `subscription()`: no name is left.
    if (await E(hostAgent).has(...subscriptionPath)) {
      await E(hostAgent).remove(...subscriptionPath);
    }
    throw error;
  }
  const locator = await E(hostAgent).locate(...subscriptionPath);
  const names = await E(hostAgent).list(dir);
  for (const name of Array.isArray(names) ? names : []) {
    // Only shares made over this adapter's own broker follow it. A share
    // narrowed from somebody else's says so, and is left alone.
    const match = /^share-([A-Za-z0-9][A-Za-z0-9_-]{0,31})-powers$/.exec(name);
    if (match) {
      // eslint-disable-next-line no-await-in-loop
      const powers = await E(hostAgent).lookup([dir, name]);
      // eslint-disable-next-line no-await-in-loop
      if (!(await E(powers).has('share-of-another'))) {
        // eslint-disable-next-line no-await-in-loop
        await E(powers).storeLocator('subscription', locator);
      }
    }
  }
  return locator;
};
harden(provideBrokerSubscription);

/**
 * Provide a delegated runner: an adapter's hosted backend within limits the
 * operator chose, to hand to somebody else (`delegated-runner.js`).
 *
 * Like a share, it is a namespace (`<dir>/runner-<id>-powers`), the
 * operator's kit over it (`<dir>/runner-<id>-kit`: `revoke()`,
 * `getStatus()`) and the name to hand out (`<dir>/runner-<id>`). Called
 * again it rewrites the limits and re-points the backend, and nothing else:
 * the sessions it counts and its revocation stay.
 *
 * The subscription its sessions spend is a member of the broker's pool that
 * the operator names, which should be a share and set aside (`pinnedOnly`):
 * that is what meters a holder, and what keeps the operator's own sessions
 * off it.
 *
 * @param {any} hostAgent The `@agent` host powers.
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.dir The adapter's directory pet name.
 * @param {string} options.runnerId Letters, digits and `_`: no `-`, which
 *   separates a runner's name from a session's in what the backend sees.
 * @param {any} [options.limits] `RunnerLimits`. Required for a new runner.
 * @param {string[]} [options.poolPowersPath] The broker's namespace, where
 *   the declared set is: `<dir>/broker-powers` by default.
 * @param {boolean} [options.unmetered] The operator's explicit word that the
 *   subscription named need not be a lane set aside: the holder then spends
 *   an account of the operator's with no meter but the provider's.
 * @returns {Promise<{ runnerPath: string[], kitPath: string[], created: boolean }>}
 */
export const provideDelegatedRunner = async (
  hostAgent,
  {
    label,
    dir,
    runnerId,
    limits,
    poolPowersPath = [dir, 'broker-powers'],
    unmetered = false,
  },
) => {
  /^[A-Za-z0-9][A-Za-z0-9_]{0,31}$/.test(runnerId) ||
    Fail`Invalid runner id ${q(runnerId)}`;
  !/^(powers|handle|kit)$/.test(runnerId) ||
    Fail`Runner id ${q(runnerId)} is a name this uses`;
  // Always the adapter's own backend, which setup re-points runners at on
  // every run (`republishDelegatedRunners`).
  const backendPath = [dir, 'backend'];
  const runnerPath = [dir, `runner-${runnerId}`];
  const kitPath = [dir, `runner-${runnerId}-kit`];
  const powersPath = [dir, `runner-${runnerId}-powers`];
  const handlePath = [dir, `runner-${runnerId}-handle`];
  const handleName = `${dir}.runner-${runnerId}-handle`;
  const powersName = `${dir}.runner-${runnerId}-powers`;
  (await E(hostAgent).has(...backendPath)) ||
    Fail`${b(label)} runner needs the backend ${q(backendPath.join('/'))}`;
  const backendLocator = await E(hostAgent).locate(...backendPath);
  const stored =
    limits === undefined ? undefined : normalizeRunnerLimits(limits);
  if (stored !== undefined && !unmetered) {
    // What meters a holder is the share its sessions are pinned to, and what
    // keeps the operator's own sessions off that share is `pinnedOnly`. A
    // runner over anything else lends an account whole.
    /** @type {any} */
    let declared;
    if (await E(hostAgent).has(...poolPowersPath)) {
      const poolPowers = await E(hostAgent).lookup(poolPowersPath);
      if (await E(poolPowers).has('subscriptions')) {
        declared = await E(poolPowers).lookup('subscriptions');
      }
    }
    const lane = (declared?.members ?? []).find(
      (/** @type {any} */ member) => member?.id === stored.subscription,
    );
    (lane !== undefined &&
      lane.subscriptionName !== undefined &&
      lane.pinnedOnly === true) ||
      Fail`Runner ${q(runnerId)} must spend a lane set aside: a member of the broker's pool that is a share and pinnedOnly (${q(stored.subscription)} is not)`;
  }

  const created = !(await E(hostAgent).has(...kitPath));
  if (created && (await E(hostAgent).has(...runnerPath))) {
    // As for a share: the name handed out keeps its kit running.
    throw Fail`Runner ${q(runnerId)} is still handed out as ${q(runnerPath.join('/'))}, which keeps its kit running; remove that name first, and hand the runner out again`;
  }
  if (created && (await E(hostAgent).has(...powersPath))) {
    // The namespace (the limits, the sessions it counts, its revocation)
    // outlived its kit: the kit is made over it again, not beside it.
    await mintWithPowersPath(hostAgent, {
      powersPath,
      temporary: `${dir}.runner-${runnerId}-powers`,
      specifier: moduleSpecifier('./delegated-runner-module.js'),
      resultName: kitPath,
      env: { RUNNER_ID: runnerId },
    });
  } else if (created) {
    stored !== undefined || Fail`A new runner needs limits`;
    for (const stray of [handleName, powersName]) {
      // eslint-disable-next-line no-await-in-loop
      if (await E(hostAgent).has(stray)) await E(hostAgent).remove(stray);
    }
    await E(hostAgent).provideGuest(handleName, { agentName: powersName });
    const guest = await E(hostAgent).lookup(powersName);
    await E(guest).storeLocator('backend', backendLocator);
    await E(guest).storeValue(stored, 'runner-limits');
    await E(hostAgent).makeUnconfined(
      '@main',
      moduleSpecifier('./delegated-runner-module.js'),
      {
        powersName,
        resultName: kitPath,
        env: harden({ RUNNER_ID: runnerId }),
      },
    );
  }
  for (const [from, to] of [
    [handleName, handlePath],
    [powersName, powersPath],
  ]) {
    if (
      // eslint-disable-next-line no-await-in-loop
      (await E(hostAgent).has(/** @type {string} */ (from))) &&
      // eslint-disable-next-line no-await-in-loop
      !(await E(hostAgent).has(.../** @type {string[]} */ (to)))
    ) {
      // eslint-disable-next-line no-await-in-loop
      await E(hostAgent).move([from], to);
    }
  }
  const powers = await E(hostAgent).lookup(powersPath);
  // The backend that exists now: an adapter mints it again on every run.
  await E(powers).storeLocator('backend', backendLocator);
  if (stored !== undefined) await E(powers).storeValue(stored, 'runner-limits');
  if (!(await E(hostAgent).has(...runnerPath))) {
    await mintWithPowersPath(hostAgent, {
      powersPath: kitPath,
      temporary: `${dir}.runner-${runnerId}-kit-powers`,
      specifier: moduleSpecifier('./delegated-runner-facet-module.js'),
      resultName: runnerPath,
      env: {},
    });
  }
  return harden({ runnerPath, kitPath, created });
};
harden(provideDelegatedRunner);

/**
 * Re-point every delegated runner of an adapter at the backend that exists
 * now. Called at the end of the adapter's setup, after it has bound its
 * backend: a runner keeps its identity, its limits, its sessions and its
 * revocation across a backend that a deploy re-minted.
 *
 * @param {any} hostAgent The `@agent` host powers.
 * @param {{ label: string, dir: string }} options
 */
export const republishDelegatedRunners = async (hostAgent, { label, dir }) => {
  await null;
  const backendPath = [dir, 'backend'];
  try {
    if (!(await E(hostAgent).has(...backendPath))) return;
    const locator = await E(hostAgent).locate(...backendPath);
    const names = await E(hostAgent).list(dir);
    for (const name of Array.isArray(names) ? names : []) {
      if (/^runner-[A-Za-z0-9][A-Za-z0-9_]{0,31}-powers$/.test(name)) {
        // eslint-disable-next-line no-await-in-loop
        const powers = await E(hostAgent).lookup([dir, name]);
        // eslint-disable-next-line no-await-in-loop
        await E(powers).storeLocator('backend', locator);
      }
    }
  } catch (error) {
    console.error(
      `${label} delegated runners were not re-pointed at the new backend; sessions are unaffected:`,
      error instanceof Error ? error.message : String(error),
    );
  }
};
harden(republishDelegatedRunners);

/**
 * Provide an adapter's broker as a `Subscription` over its
 * `<dir>/broker-service`, and bring the shares made over it along. Like the
 * account oracle, it is not what sessions run on: a failure is reported and
 * setup goes on.
 *
 * @param {any} hostAgent The `@agent` host powers.
 * @param {{ label: string, dir: string }} options
 */
export const publishBrokerSubscription = async (hostAgent, { label, dir }) => {
  await null;
  try {
    await provideBrokerSubscription(hostAgent, {
      label,
      dir,
      brokerPath: [dir, 'broker-service'],
      specifier: moduleSpecifier('./subscription-module.js'),
    });
  } catch (error) {
    console.error(
      `${label} subscription was not provided, so its shares do not serve; sessions are unaffected:`,
      error instanceof Error ? error.message : String(error),
    );
  }
};
harden(publishBrokerSubscription);

/**
 * Provide a share of a subscription: `attenuate(limits)`, as the operator's
 * provisioning step it has to be, since only a host can mint a formula and a
 * share is handed out by name.
 *
 * It makes, once, a namespace (`<dir>/share-<id>-powers`), the share's kit
 * over it (`<dir>/share-<id>-kit`, the grantor's: `revoke()`, `getStatus()`)
 * and the share itself (`<dir>/share-<id>`), which is the name to hand to a
 * peer. Called again for a share that exists, it rewrites the limits, which
 * the share reads for every request, and nothing else: the meter, the
 * revocation and the identity a holder already stored all stay.
 *
 * @param {any} hostAgent The `@agent` host powers.
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.dir The adapter's directory pet name.
 * @param {string} options.shareId
 * @param {any} [options.limits] `ShareLimits` without `createdAt`, which is
 *   set when the share is made and kept after. Required for a new share.
 * @param {string[]} [options.subscriptionPath] What the share is made over:
 *   `<dir>/subscription` by default, or a share somebody else handed over.
 * @param {() => string} [options.now] ISO 8601 clock.
 * @returns {Promise<{ sharePath: string[], kitPath: string[], created: boolean }>}
 */
export const provideSubscriptionShare = async (
  hostAgent,
  {
    label,
    dir,
    shareId,
    limits,
    subscriptionPath,
    now = () => new Date().toISOString(),
  },
) => {
  SHARE_ID_PATTERN.test(shareId) || Fail`Invalid share id ${q(shareId)}`;
  // `-powers` and `-handle` are this function's own suffixes.
  !/(^|-)(powers|handle|kit)$/.test(shareId) ||
    Fail`Share id ${q(shareId)} must not be or end in -powers, -handle or -kit`;
  const sharePath = [dir, `share-${shareId}`];
  const kitPath = [dir, `share-${shareId}-kit`];
  const powersPath = [dir, `share-${shareId}-powers`];
  const handlePath = [dir, `share-${shareId}-handle`];
  const handleName = `${dir}.share-${shareId}-handle`;
  const powersName = `${dir}.share-${shareId}-powers`;
  const beneathPath = subscriptionPath ?? [dir, 'subscription'];
  (await E(hostAgent).has(...beneathPath)) ||
    Fail`${b(label)} share needs the subscription ${q(beneathPath.join('/'))}`;
  const beneathLocator = await E(hostAgent).locate(...beneathPath);

  const created = !(await E(hostAgent).has(...kitPath));
  if (created && (await E(hostAgent).has(...sharePath))) {
    // The name that was handed out keeps the kit it was made over alive,
    // whatever became of the kit's own name. A second kit over the same
    // namespace would be a second meter and a second writer of one record,
    // and its `revoke()` would not reach the endpoints holders are using.
    throw Fail`Share ${q(shareId)} is still handed out as ${q(sharePath.join('/'))}, which keeps its kit running; remove that name first, and hand the share out again`;
  }
  if (created && (await E(hostAgent).has(...powersPath))) {
    // The namespace is there and neither the kit nor the share is: somebody
    // removed them. The namespace is the share (its limits, its meter, its
    // revocation), so the kit is made over it again rather than beside it
    // over a new, empty one. (A run that died before the kit was made left
    // its names at the top level instead, and starts clean below.)
    await mintWithPowersPath(hostAgent, {
      powersPath,
      temporary: `${dir}.share-${shareId}-powers`,
      specifier: moduleSpecifier('./subscription-share-module.js'),
      resultName: kitPath,
      env: { SHARE_ID: shareId },
    });
  } else if (created) {
    limits !== undefined || Fail`A new share needs limits`;
    const stored = normalizeShareLimits({ ...limits, createdAt: now() });
    for (const stray of [handleName, powersName]) {
      // eslint-disable-next-line no-await-in-loop
      if (await E(hostAgent).has(stray)) await E(hostAgent).remove(stray);
    }
    await E(hostAgent).provideGuest(handleName, { agentName: powersName });
    const guest = await E(hostAgent).lookup(powersName);
    await E(guest).storeLocator('subscription', beneathLocator);
    await E(guest).storeValue(stored, 'share-limits');
    if (subscriptionPath !== undefined) {
      // Made over something other than this adapter's broker: setup must not
      // re-point it at the broker on its next run.
      await E(guest).storeValue(true, 'share-of-another');
    }
    await E(hostAgent).makeUnconfined(
      '@main',
      moduleSpecifier('./subscription-share-module.js'),
      {
        powersName,
        resultName: kitPath,
        env: harden({ SHARE_ID: shareId }),
      },
    );
  }
  for (const [from, to] of [
    [handleName, handlePath],
    [powersName, powersPath],
  ]) {
    if (
      // eslint-disable-next-line no-await-in-loop
      (await E(hostAgent).has(/** @type {string} */ (from))) &&
      // eslint-disable-next-line no-await-in-loop
      !(await E(hostAgent).has(.../** @type {string[]} */ (to)))
    ) {
      // eslint-disable-next-line no-await-in-loop
      await E(hostAgent).move([from], to);
    }
  }
  const powers = await E(hostAgent).lookup(powersPath);
  if (
    subscriptionPath === undefined &&
    !(await E(powers).has('share-of-another'))
  ) {
    // Over this adapter's own broker: the one that exists now.
    await E(powers).storeLocator('subscription', beneathLocator);
  }
  if (limits !== undefined && (await E(powers).has('share-limits'))) {
    // The grantor changes its mind: a write of a value. The anchor of the
    // budget's periods is the share's creation and does not move.
    const before = await E(powers).lookup('share-limits');
    await E(powers).storeValue(
      normalizeShareLimits({ ...limits, createdAt: before.createdAt }),
      'share-limits',
    );
  }
  if (!(await E(hostAgent).has(...sharePath))) {
    // What is handed out: the kit's `share()` and nothing more of it.
    await mintWithPowersPath(hostAgent, {
      powersPath: kitPath,
      temporary: `${dir}.share-${shareId}-kit-powers`,
      specifier: moduleSpecifier('./subscription-share-facet-module.js'),
      resultName: sharePath,
      env: {},
    });
  }
  return harden({ sharePath, kitPath, created });
};
harden(provideSubscriptionShare);

/**
 * Provide existing account owners over the broker, then atomically publish a
 * complete discovery source. Preparation failure leaves the source unavailable.
 *
 * Status is an observation: a deployment whose oracle could not be provided
 * still runs sessions. The failure is reported and setup goes on.
 *
 * @param {any} hostAgent The `@agent` host powers.
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.dir
 * @param {string} options.providerId
 * @param {string} options.flootDir
 * @param {string} options.backendId The hosted backend's descriptor id.
 * @param {string} options.accountAuthority The operator's explicit account identity.
 * @param {string[]} [options.subscriptionIds] For a broker over several
 *   subscriptions: one oracle each, explicitly associated with its member ID.
 * @param {boolean} [options.resetCredits] The provider banks rate-limit
 *   resets (Codex): also provide each subscription's admin, through which an
 *   operator redeems one. Only the trusted Floot profile receives these caps.
 */
export const publishAccountOracle = async (
  hostAgent,
  {
    label,
    dir,
    providerId,
    flootDir,
    backendId,
    accountAuthority,
    subscriptionIds,
    resetCredits,
  },
) => {
  await null;
  try {
    const profile = (await E(hostAgent).has(flootDir, 'controller-profile'))
      ? await E(hostAgent).lookup([flootDir, 'controller-profile'])
      : undefined;
    if (profile) await invalidateAccountBindings(profile, { source: dir });
    makeAccountId({ providerId, accountAuthority });
    /** @type {import('./account-bindings.js').AccountBinding[]} */
    const accounts = [];
    // Setup is sequential: keep the existing owners and publication ordering.
    /* eslint-disable no-await-in-loop */
    for (const subscriptionId of subscriptionIds ?? [undefined]) {
      const oraclePath = await provideAccountOracle(hostAgent, {
        label,
        dir,
        brokerPath: [dir, 'broker-service'],
        providerId,
        specifier: moduleSpecifier('./account-oracle-module.js'),
        sourceSpecifier: moduleSpecifier('./account-source-module.js'),
        ...(subscriptionId === undefined ? {} : { subscriptionId }),
      });
      const adminPath =
        resetCredits === true
          ? await provideSubscriptionAdmin(hostAgent, {
              label,
              dir,
              brokerPath: [dir, 'broker-service'],
              specifier: moduleSpecifier('./subscription-admin-module.js'),
              redeemerSpecifier: moduleSpecifier('./reset-redeemer-module.js'),
              ...(subscriptionId === undefined ? {} : { subscriptionId }),
            })
          : undefined;
      accounts.push({
        accountId: makeAccountId({
          providerId,
          accountAuthority,
          subscriptionId,
        }),
        providerId,
        title: label,
        ...(subscriptionId === undefined ? {} : { label: subscriptionId }),
        oracle: await E(hostAgent).lookup(oraclePath),
        ...(adminPath === undefined
          ? {}
          : {
              adminId: await E(hostAgent).identify(...adminPath),
              admin: await E(hostAgent).lookup(adminPath),
            }),
        uses: [
          {
            backendId,
            ...(subscriptionId === undefined ? {} : { subscriptionId }),
          },
        ],
      });
    }
    /* eslint-enable no-await-in-loop */
    if (profile) {
      await publishAccountBindings(profile, { source: dir, accounts });
    }
  } catch (error) {
    console.error(
      `${label} account discovery was not published; sessions are unaffected:`,
      error instanceof Error ? error.message : String(error),
    );
  }
};
harden(publishAccountOracle);

/**
 * The account authority a hosted backend's broker serves, from the host
 * configuration (`ENDO_<BACKEND>_ACCOUNT_AUTHORITY`): required, since the
 * literal a catalog lists for one credential identifies nothing.
 * @param {Record<string, string | undefined>} env
 * @param {string} name The variable's name.
 * @param {string} label
 */
export const readAccountAuthority = (env, name, label) => {
  const value = env[name] || '';
  value !== '' ||
    Fail`${b(name)} is required: the account authority this ${b(label)} broker serves, a pool or a single account, by the id the operator declared`;
  return assertAccountAuthority(value, label);
};
harden(readAccountAuthority);

/**
 * The spelling checks of a configured slice image that need no Podman — the
 * digest a broker or controller refuses at construction, and an option-like
 * name Podman would misparse — so setup refuses them before any mint.
 * @param {string} rootfs Config rootfs (`oci:<image>` or already pinned).
 * @param {string} [label]
 * @returns {{ image: string, imageDigest?: string }}
 */
export const readSliceImageReference = (rootfs, label = 'Hosted') => {
  const image = rootfs.startsWith('oci:') ? rootfs.slice(4) : rootfs;
  // A leading dash would be parsed as a podman option rather than an image.
  !image.startsWith('-') || Fail`Invalid ${b(label)} sandbox image ${q(image)}`;
  if (image.includes('@sha256:')) {
    const imageDigest = image.slice(image.indexOf('@') + 1);
    /^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
      Fail`${b(label)} sandbox image digest is invalid, got ${q(imageDigest)}`;
    return harden({ image, imageDigest });
  }
  return harden({ image });
};
harden(readSliceImageReference);

const execFile = promisify(execFileCallback);

/**
 * Resolve a local OCI image reference to its immutable digest form, so the
 * host pins what Podman actually resolved rather than trusting a mutable tag.
 *
 * @param {string} rootfs Config rootfs (`oci:<image>` or already pinned).
 * @param {(file: string, args: string[]) => Promise<{ stdout: string }>} [exec]
 * @param {string} [label]
 * @returns {Promise<{ imageRef: string, imageDigest: string }>}
 */
export const resolvePinnedImageRef = async (
  rootfs,
  exec = execFile,
  label = 'Hosted',
) => {
  const { image, imageDigest: pinned } = readSliceImageReference(rootfs, label);
  if (pinned !== undefined) {
    // An operator's own pin gets the same runtime rule as a resolved one, here
    // rather than at every session creation.
    PINNED_IMAGE_REFERENCE_PATTERN.test(image) ||
      Fail`Pinned ${b(label)} sandbox image ${q(image)} is not a pinned reference the native runtime will accept; drop the tag it was reached by and keep the digest`;
    return harden({ imageRef: image, imageDigest: pinned });
  }
  const { stdout } = await exec('podman', [
    'image',
    'inspect',
    '--format',
    '{{.Digest}}',
    image,
  ]);
  const imageDigest = stdout.trim();
  /^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
    Fail`Cannot resolve a digest for ${b(label)} sandbox image ${q(image)}; build it before hosted setup`;
  // Drop the tag the image was FOUND under before pinning it. `name:tag@digest`
  // is valid reference syntax and Podman accepts it, but the native runtime's
  // PINNED_IMAGE_REFERENCE_PATTERN admits a registry port and no tag, so
  // appending the digest to the tagged name produced a reference that this
  // resolver called pinned and that every buildSlice then refused with "Native
  // profile requires a pinned OCI image". The digest is the pin; the tag it was
  // reached by is exactly the mutable part being resolved away.
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  const repository = lastColon > lastSlash ? image.slice(0, lastColon) : image;
  const imageRef = `${repository}@${imageDigest}`;
  // Check the rule the runtime will apply, here, where the operator can still
  // read the message — rather than shipping a value that only fails per
  // session, deep inside a slice build.
  PINNED_IMAGE_REFERENCE_PATTERN.test(imageRef) ||
    Fail`Resolved ${b(label)} sandbox image ${q(imageRef)} is not a pinned reference the native runtime will accept`;
  return harden({ imageRef, imageDigest });
};
harden(resolvePinnedImageRef);

/**
 * A retained broker keeps the slice and listener images it was minted with:
 * sessions record the broker's pins, and the controller attests a slice
 * against them. Setup therefore cannot re-pin a live broker in place, and
 * silently retaining it discards the operator's change — the unit environment
 * carries the new digest while every slice keeps launching the old image, and
 * nothing short of inspecting a running container says so. Refuse instead,
 * naming both digests and the retirement recipe, before any mint.
 *
 * Only the images are compared here. The rest of the persisted profile is
 * still retained as-is; a broker bearing live grants is deliberately not
 * rebuilt for a diagnostics toggle.
 *
 * @param {object} args
 * @param {string} args.label Adapter label for messages, e.g. `Claude`.
 * @param {string} args.serviceName Pet-name path of the broker, for the recipe.
 * @param {{ imageDigest: string, listenerImageRef: string }} args.retained
 *   The broker's persisted configuration.
 * @param {string} args.rootfs The configured slice image (`oci:<image>`).
 * @param {string} args.listenerImageRef The configured listener image, or ''
 *   when the environment names none (a retained broker needs none).
 * @param {(file: string, args: string[]) => Promise<{ stdout: string }>} [args.exec]
 */
export const assertRetainedBrokerImages = async ({
  label,
  serviceName,
  retained,
  rootfs,
  listenerImageRef,
  exec = undefined,
}) => {
  await null;
  // Resolving an unpinned tag asks Podman, which is read-only; a pinned
  // reference needs no Podman at all.
  const { imageDigest } = await resolvePinnedImageRef(rootfs, exec, label);
  imageDigest === retained.imageDigest ||
    Fail`The retained ${q(serviceName)} pins ${b(label)} sandbox image ${q(retained.imageDigest)} but the configuration now names ${q(imageDigest)}; a live broker cannot be re-pinned in place: remove ${q(serviceName)} when no session depends on it, then rerun setup to mint it with the current pins`;
  if (listenerImageRef !== '') {
    listenerImageRef === retained.listenerImageRef ||
      Fail`The retained ${q(serviceName)} runs listener image ${q(retained.listenerImageRef)} but the configuration now names ${q(listenerImageRef)}; a live broker cannot be re-pinned in place: remove ${q(serviceName)} when no session depends on it, then rerun setup to mint it with the current pins`;
  }
};
harden(assertRetainedBrokerImages);
