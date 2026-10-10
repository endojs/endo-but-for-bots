// @ts-check

// Host-side provisioning for the `machine-admin` session preset: the grants
// floot-factory-setup.js stores on the Floot factory host so the preset can
// copy them into a session guest (the `nixos-admin` and `workflow-factory`
// preset object kinds in agent.js), per
// designs/floot-admin-deploy-workflows.md.
//
// Each grant is best-effort and idempotent across boots. The setups that
// provision what is granted here — @endo/workflow/setup.js,
// @endo/space-nixos-admin/setup.js, and
// @endo/space-nixos-admin/setup-forgejo-credential.js — run against the
// daemon's ROOT host from ENDO_EXTRA ahead of the Floot setup, so the grants
// are re-derived every boot: a host that gains the NixOS controller or the
// workflow service later fills in on its next start, a host that loses one
// has the grant retracted, and a factory that predates this feature is
// brought up to date the same way. Nothing here fails the factory setup.

import { E } from '@endo/eventual-send';

import { endoReleaseChart, nixosConfigChangeChart } from './deploy-charts.js';

// Root-inventory names the companion setups bind.
const WORKFLOW_SERVICE_NAME = 'workflow-service';
const NIXOS_CONTROLLER_NAME = 'controller-for-nixos-admin';
const FORGEJO_CREDENTIAL_NAME = 'forgejo-credential';

// Factory-host names the preset copies from.
const NIXOS_GRANT_NAME = 'nixos-admin';

/**
 * The deploy charts a machine-admin session may propose runs of, and the
 * factory-host name each connection is granted under.
 */
export const DEPLOY_FACTORY_GRANTS = harden([
  { chart: endoReleaseChart, grantName: 'deploy-endo-factory' },
  { chart: nixosConfigChangeChart, grantName: 'change-nixos-factory' },
]);

// The connection caplet is re-created on every boot, exactly as
// floot-factory-setup.js re-creates the factory caplet: its module lives in
// a release checkout that pruning will eventually remove, and nothing durable
// hangs off its formula identity — the service binding and the factory ids
// live in its powers guest, which is kept. Sessions re-copy the grant on
// revival (agent.js provisionPresetObjects), so the fresh identity reaches
// them on the boot that minted it.
const connectionSpecifier = new URL('deploy-connection.js', import.meta.url)
  .href;

/** @param {unknown} err */
const describeError = err => (err instanceof Error ? err.message : String(err));

/**
 * Whether a top-level name is bound to a formula that exists, without
 * incarnating it. The daemon stores an agent's names before it writes the
 * agent's formula, so a death between the two leaves a name that `has`
 * reports and nothing resolves. `identify` plus `getFormula` tell that
 * apart from a transient failure to incarnate, which must not be mistaken
 * for a stray: the agent behind the name may already hold state (a
 * connection's factory ids) that a fresh mint would orphan.
 *
 * @param {any} agent - the root host running setup
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export const isNamePersisted = async (agent, name) => {
  await null;
  try {
    const id = await E(agent).identify(name);
    await E(agent).getFormula(id);
    return true;
  } catch {
    return false;
  }
};
harden(isNamePersisted);

/**
 * Drop a grant from the factory host whose provider is gone, so a required
 * preset object fails loudly at session creation instead of binding a
 * dangling identity, and an optional one is skipped rather than copied dead.
 *
 * @param {any} factoryHost
 * @param {string} grantName
 */
const retractGrant = async (factoryHost, grantName) => {
  if (await E(factoryHost).has(grantName)) {
    await E(factoryHost).remove(grantName);
    console.error(
      `Floot: retracted ${grantName} from the factory host; its provider is gone.`,
    );
  }
};

/**
 * Grant a root-inventory capability to the factory host under `grantName`,
 * refreshed every boot. The grant binds the provider's formula identity (a
 * locator resolves to the same id a copy would). It keeps working across
 * restarts because the credential setup rotates material behind the same
 * formula and the NixOS setup keeps its controller's identity; a re-minted
 * or replaced provider reaches the factory host here on the next boot, and
 * each session on its next revival's re-copy.
 *
 * @param {any} agent - the root host running setup
 * @param {any} factoryHost - the Floot factory's host profile
 * @param {string} sourceName - the root-inventory name
 * @param {string} grantName - the factory-host name
 * @param {string} what - for diagnostics
 * @returns {Promise<boolean>} whether the grant is in place
 */
const grantLocator = async (
  agent,
  factoryHost,
  sourceName,
  grantName,
  what,
) => {
  await null;
  try {
    if (!(await E(agent).has(sourceName))) {
      console.error(
        `Floot: no ${sourceName} in this inventory; ${what} is not granted to the factory.`,
      );
      await retractGrant(factoryHost, grantName);
      return false;
    }
    const locator = await E(agent).locate(sourceName);
    await E(factoryHost).storeLocator(grantName, locator);
    console.error(`Floot: granted ${grantName} to the factory host.`);
    return true;
  } catch (err) {
    console.error(
      `Floot: could not grant ${grantName} to the factory host: ${describeError(err)}`,
    );
    return false;
  }
};

/**
 * Grant the NixOS machine-admin caplet (`controller-for-nixos-admin`,
 * provisioned by `@endo/space-nixos-admin/setup.js`) to the factory host as
 * `nixos-admin`.
 *
 * @param {any} agent
 * @param {any} factoryHost
 */
export const grantNixosAdmin = (agent, factoryHost) =>
  grantLocator(
    agent,
    factoryHost,
    NIXOS_CONTROLLER_NAME,
    NIXOS_GRANT_NAME,
    'the NixOS machine-admin caplet',
  );
harden(grantNixosAdmin);

/**
 * Grant the Forgejo push credential (`forgejo-credential`, provisioned and
 * rotated on every start by
 * `@endo/space-nixos-admin/setup-forgejo-credential.js`) to the factory host
 * under the same name, so a machine-admin session pushes with a credential
 * that is alive.
 *
 * Credential material is daemon-process-local, so without this grant a
 * session would hold its own credential that nothing re-provisions: every
 * restart would leave it revoked and the next push would fail with "has been
 * revoked". A GitRemote holds the credential CAP rather than its name, so a
 * remote wired to the granted one comes back to life when the seeder rotates
 * it, instead of needing to be rebuilt by hand.
 *
 * @param {any} agent
 * @param {any} factoryHost
 */
export const grantForgejoCredential = (agent, factoryHost) =>
  grantLocator(
    agent,
    factoryHost,
    FORGEJO_CREDENTIAL_NAME,
    FORGEJO_CREDENTIAL_NAME,
    'the Forgejo push credential',
  );
harden(grantForgejoCredential);

/**
 * Whether the newest factory bound to a connection still matches the chart
 * this release ships. A revoked factory, or one the service no longer knows,
 * reads as stale and is re-minted; any other failure propagates, so a
 * transient error (the service still incarnating, a transport hiccup) skips
 * this boot's grant rather than minting a duplicate that would never be
 * revoked.
 *
 * @param {any} service
 * @param {string} fid
 * @param {{ name: string, version: number }} chart
 */
const factoryIsCurrent = async (service, fid, chart) => {
  await null;
  try {
    const record = await E(E(service).factory(fid)).describe();
    return (
      record.chartName === chart.name &&
      record.chartVersion === chart.version &&
      record.revoked !== true
    );
  } catch (err) {
    if (/no workflow factory/.test(describeError(err))) {
      return false;
    }
    throw err;
  }
};

/**
 * Provision one deploy-factory grant: install the chart, mint (or keep) a
 * factory binding the endowments, and bind a connection to it under
 * `grantName` on the factory host.
 *
 * The connection (deploy-connection.js) is an unconfined caplet with a
 * dedicated powers guest holding `service` and `factory-ids`. The guest is
 * minted once; the caplet is re-created every boot (see
 * `connectionSpecifier`) and the factory-host locator refreshed with it.
 *
 * Factories snapshot their chart at mint, so a chart VERSION BUMP mints a
 * new factory and appends its id: the connection starts new runs through the
 * newest factory and keeps observing runs of the older ones. The old factory
 * is deliberately left un-revoked — revocation would cancel its live runs,
 * possibly mid-deployment.
 *
 * Every step is written to heal on the next run from a crash at any point:
 * the guest is resolved by its agent name wherever that name is, each move is
 * conditional, and stores overwrite in place rather than remove-then-write.
 *
 * @param {any} agent - the root host running setup
 * @param {object} options
 * @param {string} options.dir - the Floot inventory directory
 * @param {any} options.factoryHost - the Floot factory's host profile
 * @param {any} options.service - the workflow service
 * @param {Record<string, any>} options.endowments - the run endowments
 *   every factory binds (`performer`, `operator`)
 * @param {any} options.chart - the deploy chart
 * @param {string} options.grantName - the factory-host name of the grant
 * @param {string} [options.specifier] - the connection caplet module
 * @returns {Promise<{ chartKey: string, fid: string }>}
 */
export const grantDeployFactory = async (
  agent,
  {
    dir,
    factoryHost,
    service,
    endowments,
    chart,
    grantName,
    specifier = connectionSpecifier,
  },
) => {
  // Keep the installed chart fresh with the release. Install validates
  // (diagnostics gate) and overwrites idempotently; existing runs and
  // factories hold their own snapshots and are unaffected.
  const chartKey = await E(service).install(chart);

  // `provideGuest` takes a single pet name, so the connection's guest and
  // profile are created top-level and moved under the Floot directory
  // afterward, as floot-factory-setup.js does for the factory host. The
  // guest is never taken from `provideGuest`'s return value: against a
  // top-level name that survived a crash between minting and the move, that
  // hands back the mail HANDLE rather than the guest (packages/daemon/
  // AGENTS.md § provideGuest idempotency), so the guest is resolved by its
  // agent name, wherever that name currently is.
  const handleName = `${dir}-${grantName}-handle`;
  const powersName = `profile-for-${handleName}`;
  const connectionPath = [dir, grantName];
  const handlePath = [dir, `${grantName}-handle`];
  const powersPath = [dir, `${grantName}-powers`];
  const revived = await E(agent).has(...powersPath);
  if (!revived) {
    // Adopt a guest an earlier run left top-level, unless its name dangles
    // (see isNamePersisted). A stray handle name with no agent behind it
    // would likewise make `provideGuest` hand back that handle instead of
    // minting. Either way clear the strays and mint afresh: a guest that
    // never finished provisioning holds nothing.
    const adoptable =
      (await E(agent).has(powersName)) &&
      (await isNamePersisted(agent, powersName));
    if (!adoptable) {
      for (const stray of [handleName, powersName]) {
        // eslint-disable-next-line no-await-in-loop
        if (await E(agent).has(stray)) {
          // eslint-disable-next-line no-await-in-loop
          await E(agent).remove(stray);
        }
      }
      await E(agent).provideGuest(handleName, { agentName: powersName });
    }
  }
  const powersRef = revived ? powersPath : powersName;
  const connectionPowers = await E(agent).lookup(powersRef);

  // The service binding heals every boot; the workflow setup keeps the
  // service's formula identity, so this is normally a same-id no-op.
  await E(connectionPowers).storeValue(service, 'service');

  /** @type {string[]} */
  let factoryIds = (await E(connectionPowers).has('factory-ids'))
    ? [...(await E(connectionPowers).lookup('factory-ids'))]
    : [];
  const newest =
    factoryIds.length > 0 ? factoryIds[factoryIds.length - 1] : undefined;
  if (
    newest === undefined ||
    !(await factoryIsCurrent(service, newest, chart))
  ) {
    const { fid } = await E(service).makeFactory(
      harden({ chart: chartKey, endowments }),
    );
    factoryIds = [...factoryIds, fid];
    await E(connectionPowers).storeValue(harden(factoryIds), 'factory-ids');
    console.error(`Floot: minted ${grantName} (${chartKey}) as ${fid}.`);
  }

  // Re-create the connection against this release. The previous caplet, if
  // any, leaves the name here; a session still holding it re-copies the
  // grant on its next revival.
  if (await E(agent).has(...connectionPath)) {
    await E(agent).remove(...connectionPath);
  }
  await E(agent).makeUnconfined('@main', specifier, {
    powersName: powersRef,
    resultName: connectionPath,
  });

  // Tuck the guest and its handle under the Floot directory. Each move is
  // conditional so a crash between them heals on the next run.
  if (await E(agent).has(handleName)) {
    await E(agent).move([handleName], handlePath);
  }
  if (await E(agent).has(powersName)) {
    await E(agent).move([powersName], powersPath);
  }

  await E(factoryHost).storeLocator(
    grantName,
    await E(agent).locate(...connectionPath),
  );
  return harden({ chartKey, fid: factoryIds[factoryIds.length - 1] });
};
harden(grantDeployFactory);

/**
 * Grant every deploy-workflow connection to the factory host, so the
 * machine-admin preset can copy them into session guests.
 *
 * Requires the pinned workflow service and the NixOS controller, both
 * provisioned into the ROOT inventory by their own ENDO_EXTRA setups ahead
 * of this one; when either is absent the grants are retracted and this is
 * otherwise a quiet no-op. Each factory binds the `performer` (the
 * controller) and `operator` (the root host's own `@self` handle, so
 * approval forms land in the owner's inbox) endowments. One grant's failure
 * does not skip the other.
 *
 * @param {any} agent - the root host running setup
 * @param {object} options
 * @param {string} options.dir - the Floot inventory directory
 * @param {any} options.factoryHost - the Floot factory's host profile
 * @returns {Promise<boolean>} whether every grant is in place
 */
export const grantDeployFactories = async (agent, { dir, factoryHost }) => {
  await null;
  let service;
  let endowments;
  try {
    for (const name of [WORKFLOW_SERVICE_NAME, NIXOS_CONTROLLER_NAME]) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await E(agent).has(name))) {
        console.error(
          `Floot: no ${name} in this inventory; deploy-workflow factories are not granted to the factory.`,
        );
        for (const { grantName } of DEPLOY_FACTORY_GRANTS) {
          // eslint-disable-next-line no-await-in-loop
          await retractGrant(factoryHost, grantName);
        }
        return false;
      }
    }
    service = await E(agent).lookup(WORKFLOW_SERVICE_NAME);
    endowments = harden({
      performer: await E(agent).lookup(NIXOS_CONTROLLER_NAME),
      operator: await E(agent).lookup('@self'),
    });
  } catch (err) {
    console.error(
      `Floot: could not reach the deploy-workflow providers: ${describeError(err)}`,
    );
    return false;
  }
  let granted = true;
  for (const { chart, grantName } of DEPLOY_FACTORY_GRANTS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await grantDeployFactory(agent, {
        dir,
        factoryHost,
        service,
        endowments,
        chart,
        grantName,
      });
    } catch (err) {
      granted = false;
      console.error(
        `Floot: could not grant ${grantName} to the factory host: ${describeError(err)}. The previous grant, if any, stands; if this repeats every boot, the newest entry of factory-ids on ${dir}/${grantName}-powers may name an unreadable factory — drop it to mint afresh.`,
      );
    }
  }
  if (granted) {
    console.error(
      'Floot: granted the deploy-workflow factories to the factory host.',
    );
  }
  return granted;
};
harden(grantDeployFactories);

/**
 * Everything the `machine-admin` preset draws on, in one call for
 * floot-factory-setup.js: the NixOS caplet, the Forgejo push credential, and
 * the deploy-workflow connections.
 *
 * @param {any} agent - the root host running setup
 * @param {object} options
 * @param {string} options.dir - the Floot inventory directory
 * @param {any} options.factoryHost - the Floot factory's host profile
 */
export const provisionMachineAdmin = async (agent, { dir, factoryHost }) => {
  await grantNixosAdmin(agent, factoryHost);
  await grantForgejoCredential(agent, factoryHost);
  await grantDeployFactories(agent, { dir, factoryHost });
};
harden(provisionMachineAdmin);
