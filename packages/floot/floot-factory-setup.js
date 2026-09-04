// @ts-check
/* global process */
// endo run --UNCONFINED floot-factory-setup.js --powers @agent \
//   -E ANTHROPIC_API_KEY=sk-...   (optionally -E FLOOT_DIR=floot)
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

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { E } from '@endo/eventual-send';
import {
  AUTH_SECRET_PETNAME,
  provideAuthSecret,
} from '@endo/fae/src/credentials.js';

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
 * Provision (or revive) the floot-factory: its guest, its provider handle, the
 * pinned factory caplet, and a default session if none exist yet.
 *
 * @param {import('@endo/eventual-send').ERef<object>} agent
 */
export const main = async agent => {
  // Everything lives under a single `floot/` inventory directory rather than
  // polluting the top level. The factory is the well-known `floot/controller`,
  // which the chat space's picker auto-detects.
  const dir = process.env.FLOOT_DIR || 'floot';
  const controllerPath = [dir, 'controller'];
  // `provideHost` takes a single pet-name (not a path), so the factory host and
  // its profile are created top-level and `move`d under `floot/` afterward.
  const guestName = `${dir}-controller-handle`;
  const agentName = `profile-for-${guestName}`;

  const provider = process.env.FLOOT_PROVIDER || 'anthropic';
  const model = process.env.FLOOT_MODEL || '';
  const authToken =
    process.env.ANTHROPIC_API_KEY || process.env.FLOOT_AUTH_TOKEN || '';
  const systemPrompt = process.env.FLOOT_SYSTEM_PROMPT || '';
  const codePath = resolveCodePath();

  // 0. Ensure the floot/ directory exists (idempotent on re-provision).
  if (!(await E(agent).has(dir))) {
    await E(agent).makeDirectory(dir);
  }

  // A re-provision without the key in env keeps the secret already in the
  // manager: the credential lives in the daemon now, not in this shell.
  const secretName = `${dir}-auth`;
  const hasExistingSecret = await E(agent).has('secrets', secretName);
  if (provider === 'anthropic' && !authToken && !hasExistingSecret) {
    throw new Error(
      'ANTHROPIC_API_KEY (or FLOOT_AUTH_TOKEN) is required for the Anthropic provider.',
    );
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

  // 4. Launch the factory caplet straight into floot/controller.
  await E(agent).makeUnconfined('@main', flootFactorySpecifier, {
    powersName: agentName,
    resultName: controllerPath,
    env: harden({
      FLOOT_SYSTEM_PROMPT: systemPrompt,
      FLOOT_CODE_PATH: codePath,
    }),
  });

  // 5. Tuck the factory host + its profile under floot/ so the top level stays
  // clean. (The factory already resolved its powers in step 4; renaming the
  // pet-names afterward is cosmetic — formulas reference by identity.)
  await E(agent).move([guestName], [dir, 'controller-handle']);
  await E(agent).move([agentName], [dir, 'controller-profile']);

  // 6. Single pin: the factory revives all its sessions on daemon restart.
  await E(agent).copy(controllerPath, ['@pins', `${dir}-controller`]);
  console.log(`Floot factory created at "${dir}/controller" and pinned.`);

  // 7. Seed a default session if this is a fresh factory.
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
