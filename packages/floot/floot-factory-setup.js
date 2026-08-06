// @ts-check
/* global process */
// endo run --UNCONFINED floot-factory-setup.js --powers @agent \
//   -E ANTHROPIC_API_KEY=sk-...   (optionally -E FLOOT_DIR=floot)
//
// When run via ENDO_EXTRA on a daemon, only ENDO_-prefixed env vars survive the
// daemon's env filter (packages/daemon/index.js `allowEnvPass`), so this script
// also accepts ENDO_-prefixed equivalents: ENDO_FLOOT_AUTH_TOKEN,
// ENDO_FLOOT_MODEL, ENDO_FLOOT_PROVIDER, ENDO_FLOOT_SYSTEM_PROMPT, ENDO_FLOOT_DIR.
//
// Provisions the Floot factory under a `floot/` inventory directory as the
// well-known `floot/controller` — a single pinned caplet that owns every chat
// session (each session is its own guest, hidden behind the factory). The LLM
// is configured programmatically (Anthropic API endpoint by default) and handed
// to the factory behind an `llm-provider` capability handle, so no secret lives
// in env. Persistence is daemon-only.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { E } from '@endo/eventual-send';

const flootFactorySpecifier = new URL('agent.js', import.meta.url).href;

// Absolute host path to the Endo codebase, mounted read-only into full-control
// sessions. Default: the repo root, two directories up from this script
// (packages/floot/) — derivable because this setup script runs unconfined from
// its real on-disk location. Override with FLOOT_CODE_PATH (e.g. to mount a
// subset, or when the script is run from a copy outside the repo). Resolved to
// '' when the path does not exist on disk, which makes the factory skip the
// mount instead of failing per session.
const resolveCodePath = () => {
  const configured =
    process.env.FLOOT_CODE_PATH ||
    fileURLToPath(new URL('../../', import.meta.url));
  if (!existsSync(configured)) {
    console.warn(
      `Floot: code path "${configured}" does not exist; full-control sessions will have no source mount.`,
    );
    return '';
  }
  return configured;
};

/**
 * Grant the NixOS machine-admin caplet to the factory host so the
 * "machine-admin" session preset can copy it into a session guest.
 *
 * The caplet is provisioned into the ROOT daemon inventory as
 * `controller-for-nixos-admin` by packages/space-nixos-admin/setup.js (listed
 * in ENDO_EXTRA ahead of this script). We hand the factory a locator to it
 * under `nixos-admin`, mirroring how `llm-provider` is granted. Stored on the
 * factory PROFILE (the caplet's own powers) so the factory caplet reads it via
 * `E(host).lookup('nixos-admin')`.
 *
 * Best-effort and idempotent: a no-op when the controller is absent (a
 * non-NixOS host, or the setup has not run yet this boot — this runs on every
 * start, so a later boot fills it in). Never fails factory setup.
 *
 * @param {import('@endo/eventual-send').ERef<any>} agent
 * @param {string[]} factoryProfilePath - pet-name path of the factory profile
 */
const grantNixosAdmin = async (agent, factoryProfilePath) => {
  try {
    if (!(await E(agent).has('controller-for-nixos-admin'))) {
      return;
    }
    const locator = await E(agent).locate('controller-for-nixos-admin');
    const factoryAgent = await E(agent).lookup(factoryProfilePath);
    await E(factoryAgent).storeLocator('nixos-admin', locator);
    console.log('Granted nixos-admin to the Floot factory.');
  } catch (err) {
    console.warn(
      `Floot: could not grant nixos-admin to the factory: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
};

/**
 * Provision (or revive) the floot-factory: its guest, its provider handle, the
 * pinned factory caplet, and a default session if none exist yet.
 *
 * @param {import('@endo/eventual-send').ERef<object>} agent
 */
export const main = async agent => {
  // Everything lives under a single `floot/` inventory directory rather than
  // polluting the top level. The factory is the well-known `floot/controller`,
  // which the chat space's picker auto-detects.
  const dir = process.env.FLOOT_DIR || process.env.ENDO_FLOOT_DIR || 'floot';
  const controllerPath = [dir, 'controller'];
  // `provideHost` takes a single pet-name (not a path), so the factory host and
  // its profile are created top-level and `move`d under `floot/` afterward.
  const guestName = `${dir}-controller-handle`;
  const agentName = `profile-for-${guestName}`;
  const controllerProfilePath = [dir, 'controller-profile'];
  const pinName = `${dir}-controller`;

  // Config needed by both the re-bind and first-provision paths. The provider
  // secret is NOT needed to re-bind (it lives in floot/llm-provider from the
  // first provision), so restarts don't require ANTHROPIC_API_KEY.
  const systemPrompt =
    process.env.FLOOT_SYSTEM_PROMPT ||
    process.env.ENDO_FLOOT_SYSTEM_PROMPT ||
    '';
  const codePath = resolveCodePath();

  // Re-bind path (ENDO_EXTRA re-runs every setup on each start). The factory is a
  // pinned UNCONFINED caplet whose module lives in the release checkout, and old
  // releases are pruned (newest few kept), so the pinned formula's module path
  // eventually dangles ("Cannot find module .../releases/<old>/packages/floot/
  // agent.js"). The factory itself is stateless across reincarnation — its
  // session registry lives in the factory profile's petstore (floot-sessions)
  // and each session's history in its own guest petstore — so we can safely
  // remove and re-create just the `floot/controller` caplet against the CURRENT
  // release on every start, reusing the existing profile/host/provider. Sessions
  // are untouched. (We must NOT re-run provideHost: step 4 moved guestName away,
  // so a second provideHost would mint a DUPLICATE host and orphan the sessions.)
  // Guard the directory existence first: `has` with a path THROWS ("Unknown pet
  // name") when the `floot/` dir is absent (the first-run case).
  if ((await E(agent).has(dir)) && (await E(agent).has(dir, 'controller'))) {
    await E(agent).remove(dir, 'controller');
    if (await E(agent).has('@pins', pinName)) {
      await E(agent).remove('@pins', pinName);
    }
    await E(agent).makeUnconfined('@main', flootFactorySpecifier, {
      powersName: controllerProfilePath,
      resultName: controllerPath,
      env: harden({
        FLOOT_SYSTEM_PROMPT: systemPrompt,
        FLOOT_CODE_PATH: codePath,
      }),
    });
    await E(agent).copy(controllerPath, ['@pins', pinName]);
    // Re-grant machine-admin every boot: keeps existing factories (created
    // before this feature, or before the controller existed) up to date.
    await grantNixosAdmin(agent, controllerProfilePath);
    console.log(
      `Floot factory re-bound to the current release at "${dir}/controller" (sessions preserved).`,
    );
    return;
  }

  const provider =
    process.env.FLOOT_PROVIDER ||
    process.env.ENDO_FLOOT_PROVIDER ||
    'anthropic';
  const model = process.env.FLOOT_MODEL || process.env.ENDO_FLOOT_MODEL || '';
  const authToken =
    process.env.ANTHROPIC_API_KEY ||
    process.env.FLOOT_AUTH_TOKEN ||
    process.env.ENDO_FLOOT_AUTH_TOKEN ||
    '';

  if (provider === 'anthropic' && !authToken) {
    throw new Error(
      'ANTHROPIC_API_KEY (or FLOOT_AUTH_TOKEN / ENDO_FLOOT_AUTH_TOKEN) is required for the Anthropic provider.',
    );
  }

  // 0. Ensure the floot/ directory exists (idempotent on re-provision).
  if (!(await E(agent).has(dir))) {
    await E(agent).makeDirectory(dir);
  }

  // 1. The factory is its own child host. It needs host authority because only
  // a host can `provideGuest`, and the factory provisions one guest per session.
  // (It must be a host, not a guest: a guest can only reach the host as a
  // mail-only Handle, which after a daemon restart can no longer provideGuest —
  // breaking session revival.) Sessions remain isolated guests owned by this
  // factory host.
  const factoryHost = await E(agent).provideHost(guestName, {
    agentName,
  });

  // 2. Store the provider config (incl. the API key) as a value under
  // `floot/llm-provider` and hand the factory a capability reference to it under
  // `llm-provider` — the fae pattern.
  if (await E(agent).has(dir, 'llm-provider')) {
    await E(agent).remove(dir, 'llm-provider');
  }
  await E(agent).storeValue(harden({ provider, model, authToken }), [
    dir,
    'llm-provider',
  ]);
  const providerLocator = await E(agent).locate(dir, 'llm-provider');
  await E(factoryHost).storeLocator('llm-provider', providerLocator);

  // 3. Launch the factory caplet straight into floot/controller.
  await E(agent).makeUnconfined('@main', flootFactorySpecifier, {
    powersName: agentName,
    resultName: controllerPath,
    env: harden({
      FLOOT_SYSTEM_PROMPT: systemPrompt,
      FLOOT_CODE_PATH: codePath,
    }),
  });

  // 4. Tuck the factory host + its profile under floot/ so the top level stays
  // clean. (The factory already resolved its powers in step 3; renaming the
  // pet-names afterward is cosmetic — formulas reference by identity.)
  await E(agent).move([guestName], [dir, 'controller-handle']);
  await E(agent).move([agentName], [dir, 'controller-profile']);

  // 5. Single pin: the factory revives all its sessions on daemon restart.
  await E(agent).copy(controllerPath, ['@pins', `${dir}-controller`]);
  // 5b. Grant the NixOS machine-admin caplet to the factory (if present) so the
  // "machine-admin" preset can hand it to sessions.
  await grantNixosAdmin(agent, controllerProfilePath);
  console.log(`Floot factory created at "${dir}/controller" and pinned.`);

  // 6. Seed a default session if this is a fresh factory.
  const factory = await E(agent).lookup(controllerPath);
  const sessions = await E(factory).listSessions();
  if (sessions.length === 0) {
    await E(factory).createSession('New chat');
    console.log('Seeded a default session.');
  }
  console.log(
    `Ready (provider: ${provider}${model ? `, model: ${model}` : ''}${
      codePath ? `, code mount: ${codePath}` : ''
    }). Look up "${dir}/controller" and call createSession()/listSessions().`,
  );
};
harden(main);
