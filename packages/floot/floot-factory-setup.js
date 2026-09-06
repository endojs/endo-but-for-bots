// @ts-check
/* global process */
// endo run --UNCONFINED floot-factory-setup.js --powers @agent \
//   -E ANTHROPIC_API_KEY=sk-...   (optionally -E FLOOT_DIR=floot)
//
// Every FLOOT_* knob is also read as ENDO_FLOOT_*, and the key as
// ENDO_FLOOT_AUTH_TOKEN. A daemon that runs this script from ENDO_EXTRA
// forwards only ENDO_-, LOCKDOWN_-, and XDG_-prefixed variables to its
// subprocess (packages/daemon/index.js `allowEnvPass`), so a hosted deployment
// provisions from a secrets EnvironmentFile under those names.
//
// Provisions the Floot factory under a `floot/` inventory directory as the
// well-known `floot/controller` — a single pinned caplet that owns every chat
// session (each session is its own guest, hidden behind the factory). The LLM
// is configured programmatically (Anthropic API endpoint by default) and handed
// to the factory behind an `llm-provider` capability handle, so no secret lives
// in env. Persistence is daemon-only.
//
// The auth token is held by the daemon's secret manager and handed to the
// factory as a `SecretBlob` capability, so the token can be rotated or revoked
// without re-provisioning anything, every read is audited, and the pet-store
// value the factory reads carries no credential at all.
//
// Re-runnable. A daemon re-runs every ENDO_EXTRA setup on each start, and an
// operator re-runs it to rotate a key or correct the account profile. On a
// re-run the factory host, its profile, the provider value, and the secret are
// reused or replaced in place, and only the factory caplet is re-created: it
// is a pinned unconfined caplet whose module lives in a release checkout, so
// once older releases are pruned its formula would name a module that no
// longer exists. Sessions are untouched — the registry lives in the factory
// profile's pet store and each session's history in its own guest.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { E } from '@endo/eventual-send';
import {
  AUTH_SECRET_PETNAME,
  hasAuthSecret,
  provideAuthSecret,
} from '@endo/fae/src/credentials.js';
import { coerceDeclaredProfile } from '@endo/hosted-agent/account.js';

const flootFactorySpecifier = new URL('agent.js', import.meta.url).href;
const accountOracleSpecifier = new URL('account-oracle.js', import.meta.url)
  .href;

/**
 * Read a setup knob, accepting the `ENDO_`-prefixed spelling that a hosted
 * daemon's environment filter lets through.
 *
 * @param {string} name
 * @returns {string}
 */
const env = name => process.env[name] || process.env[`ENDO_${name}`] || '';

/**
 * Provision the account oracle: a durable formula that answers what plan this
 * deployment is on and how much quota is left, without holding the credential.
 *
 * The declared profile is an ordinary stored value, so an operator corrects the
 * answer by re-running setup with an edited file — no capability changes hands.
 * The oracle formula keeps its identity across that, and across a restart.
 *
 * @param {import('@endo/eventual-send').ERef<object>} agent
 * @param {object} options
 * @param {string} options.dir
 * @param {string} options.provider
 * @param {any} options.factoryHost
 */
const provideAccountOracle = async (agent, { dir, provider, factoryHost }) => {
  const profilePath = env('FLOOT_ACCOUNT_PROFILE');
  const handleName = `${dir}-account-oracle-handle`;
  const powersName = `profile-for-${handleName}`;
  const oraclePath = [dir, 'account-oracle'];
  const powersPath = [dir, 'account-oracle-powers'];
  const profileNamePath = [dir, 'account-profile'];

  const existing = await E(agent).has(...oraclePath);
  if (!profilePath && !existing) {
    // Nothing declared and no oracle yet: skip it rather than stand up one that
    // can only answer "unavailable".
    console.log(
      'Floot: no FLOOT_ACCOUNT_PROFILE; skipping the account oracle (getAccount() will report it is unavailable).',
    );
    return;
  }

  if (profilePath) {
    if (!existsSync(profilePath)) {
      throw new Error(
        `FLOOT_ACCOUNT_PROFILE "${profilePath}" does not exist on disk.`,
      );
    }
    // Parsed and range-checked here, where a bad file is a setup error the
    // operator sees, rather than inside a caplet where it would surface as a
    // failed answer much later.
    const declared = coerceDeclaredProfile(
      JSON.parse(readFileSync(profilePath, 'utf8')),
    );
    if (await E(agent).has(...profileNamePath)) {
      await E(agent).remove(...profileNamePath);
    }
    await E(agent).storeValue(declared, profileNamePath);
  }

  if (existing) {
    // Keep the oracle's identity: its journal of past observations lives in its
    // own pet store, and a caller may already hold the capability. Re-storing
    // the profile above minted a *new* value formula, so re-point the oracle's
    // namespace at it — otherwise a refresh would read the formula that
    // `remove` just dropped.
    if (profilePath) {
      const oraclePowers = await E(agent).lookup(powersPath);
      await E(oraclePowers).storeLocator(
        'account-profile',
        await E(agent).locate(...profileNamePath),
      );
    }
    await E(factoryHost).storeLocator(
      'account-oracle',
      await E(agent).locate(...oraclePath),
    );
    console.log(
      `Floot account oracle at "${dir}/account-oracle" reused${
        profilePath ? ' with the updated profile' : ''
      }.`,
    );
    return;
  }

  const oracleGuest = await E(agent).provideGuest(handleName, {
    agentName: powersName,
  });
  await E(oracleGuest).storeLocator(
    'account-profile',
    await E(agent).locate(...profileNamePath),
  );
  await E(agent).makeUnconfined('@main', accountOracleSpecifier, {
    powersName,
    resultName: oraclePath,
    env: harden({ ACCOUNT_PROVIDER_ID: provider }),
  });
  await E(agent).move([handleName], [dir, 'account-oracle-handle']);
  await E(agent).move([powersName], powersPath);
  await E(factoryHost).storeLocator(
    'account-oracle',
    await E(agent).locate(...oraclePath),
  );
  console.log(`Floot account oracle created at "${dir}/account-oracle".`);
};

// Absolute host path to the Endo codebase, mounted read-only into full-control
// sessions. Default: the repo root, two directories up from this script
// (packages/floot/) — derivable because this setup script runs unconfined from
// its real on-disk location. Override with FLOOT_CODE_PATH (e.g. to mount a
// subset, or when the script is run from a copy outside the repo). Resolved to
// '' when the path does not exist on disk, which makes the factory skip the
// mount instead of failing per session.
const resolveCodePath = () => {
  const configured =
    env('FLOOT_CODE_PATH') || fileURLToPath(new URL('../../', import.meta.url));
  if (!existsSync(configured)) {
    console.warn(
      `Floot: code path "${configured}" does not exist; full-control sessions will have no source mount.`,
    );
    return '';
  }
  return configured;
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
  const dir = env('FLOOT_DIR') || 'floot';
  const controllerPath = [dir, 'controller'];
  const controllerHandlePath = [dir, 'controller-handle'];
  const controllerProfilePath = [dir, 'controller-profile'];
  const pinPath = ['@pins', `${dir}-controller`];
  // `provideHost` takes a single pet-name (not a path), so the factory host and
  // its profile are created top-level and `move`d under `floot/` afterward.
  const guestName = `${dir}-controller-handle`;
  const agentName = `profile-for-${guestName}`;

  const provider = env('FLOOT_PROVIDER') || 'anthropic';
  const model = env('FLOOT_MODEL');
  const authToken = process.env.ANTHROPIC_API_KEY || env('FLOOT_AUTH_TOKEN');
  const systemPrompt = env('FLOOT_SYSTEM_PROMPT');
  const codePath = resolveCodePath();
  // The factory reads its per-deployment knobs from the caplet env. Optional
  // ones are forwarded only when set, so the factory's defaults apply
  // otherwise and a bad value is rejected where the factory parses it.
  const factoryEnv = harden({
    FLOOT_SYSTEM_PROMPT: systemPrompt,
    FLOOT_CODE_PATH: codePath,
    ...(env('FLOOT_MAX_TOOL_ROUNDS')
      ? { FLOOT_MAX_TOOL_ROUNDS: env('FLOOT_MAX_TOOL_ROUNDS') }
      : {}),
    ...(env('FLOOT_MAX_SUBAGENT_DEPTH')
      ? { FLOOT_MAX_SUBAGENT_DEPTH: env('FLOOT_MAX_SUBAGENT_DEPTH') }
      : {}),
  });

  // 0. Ensure the floot/ directory exists (idempotent on re-provision).
  if (!(await E(agent).has(dir))) {
    await E(agent).makeDirectory(dir);
  }

  // A re-provision without the key in env keeps the secret already in the
  // manager: the credential lives in the daemon now, not in this shell.
  const secretName = `${dir}-auth`;
  const hasExistingSecret = await hasAuthSecret({
    hostAgent: agent,
    name: secretName,
  });
  if (provider === 'anthropic' && !authToken && !hasExistingSecret) {
    throw new Error(
      'ANTHROPIC_API_KEY (or FLOOT_AUTH_TOKEN / ENDO_FLOOT_AUTH_TOKEN) is required for the Anthropic provider.',
    );
  }

  // 1. The factory is its own child host. It needs host authority because only
  // a host can `provideGuest`, and the factory provisions one guest per session.
  // (It must be a host, not a guest: a guest can only reach the host as a
  // mail-only Handle, which after a daemon restart can no longer provideGuest —
  // breaking session revival.) Sessions remain isolated guests owned by this
  // factory host.
  //
  // On a re-run the host already exists, at the path step 6 moved it to.
  // `provideHost(guestName)` looks for the top-level name and, not finding it,
  // would mint a second host that owns none of the sessions. The pet name
  // `provideHost` is given binds the host's mail handle and `agentName` binds
  // the host itself, so the profile path is the one to look up.
  const revived = await E(agent).has(...controllerProfilePath);
  const factoryHost = revived
    ? await E(agent).lookup(...controllerProfilePath)
    : await E(agent).provideHost(guestName, { agentName });

  // 2. Put the auth token in the daemon's secret manager and hand the factory
  // the `SecretBlob`. `@secrets` is carried only by the root host, so a setup
  // run from a child host falls back to the pre-secret-manager arrangement: a
  // plaintext token inside the config value, which cannot be rotated, revoked,
  // or audited.
  /** @type {string | undefined} */
  let authSecretLocator;
  if (authToken || hasExistingSecret) {
    try {
      ({ locator: authSecretLocator } = authToken
        ? await provideAuthSecret({
            hostAgent: agent,
            name: secretName,
            description: `Floot ${provider} provider auth token`,
            token: authToken,
          })
        : { locator: await E(agent).locate('secrets', secretName) });
    } catch (error) {
      if (!authToken) throw error;
      console.warn(
        `Floot: could not use the secret manager (${
          error instanceof Error ? error.message : String(error)
        }); falling back to a plaintext token in ${dir}/llm-provider.`,
      );
    }
  }

  // 3. Store the provider config as a value under `floot/llm-provider` and hand
  // the factory a capability reference to it under `llm-provider` — the fae
  // pattern. The value carries a credential only on the fallback path.
  if (await E(agent).has(dir, 'llm-provider')) {
    await E(agent).remove(dir, 'llm-provider');
  }
  await E(agent).storeValue(
    harden({
      provider,
      model,
      ...(authSecretLocator ? {} : { authToken }),
    }),
    [dir, 'llm-provider'],
  );
  const providerLocator = await E(agent).locate(dir, 'llm-provider');
  await E(factoryHost).storeLocator('llm-provider', providerLocator);
  if (authSecretLocator) {
    await E(factoryHost).storeLocator(AUTH_SECRET_PETNAME, authSecretLocator);
  } else if (await E(factoryHost).has(AUTH_SECRET_PETNAME)) {
    // Do not leave a stale blob reachable beside a fallback plaintext token:
    // the factory prefers the capability, so a stale one would win silently.
    await E(factoryHost).remove(AUTH_SECRET_PETNAME);
  }

  // 4. The account oracle, if this deployment declared a profile. Provisioned
  // before the factory so the very first session already has `accountStatus`.
  await provideAccountOracle(agent, { dir, provider, factoryHost });

  // 5. Launch the factory caplet straight into floot/controller. On a re-run,
  // replace the caplet — the one formula whose module path is tied to a
  // release checkout — and keep everything it was bound to.
  if (await E(agent).has(...controllerPath)) {
    await E(agent).remove(...controllerPath);
  }
  if (await E(agent).has(...pinPath)) {
    await E(agent).remove(...pinPath);
  }
  await E(agent).makeUnconfined('@main', flootFactorySpecifier, {
    powersName: revived ? controllerProfilePath : agentName,
    resultName: controllerPath,
    env: factoryEnv,
  });

  // 6. Tuck the factory host + its profile under floot/ so the top level stays
  // clean. (The factory already resolved its powers in step 5; renaming the
  // pet-names afterward is cosmetic — formulas reference by identity.) A re-run
  // found them there already.
  if (!revived) {
    await E(agent).move([guestName], controllerHandlePath);
    await E(agent).move([agentName], controllerProfilePath);
  }

  // 7. Single pin: the factory revives all its sessions on daemon restart.
  await E(agent).copy(controllerPath, pinPath);
  console.log(
    revived
      ? `Floot factory re-bound to the current release at "${dir}/controller" and pinned (sessions preserved).`
      : `Floot factory created at "${dir}/controller" and pinned.`,
  );

  // 8. Seed a default session if this is a fresh factory.
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
