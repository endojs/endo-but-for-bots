// @ts-check
/* global process */
// endo run --UNCONFINED setup-hosted.js --powers @agent
//
// Single-machine hosted provisioning for the Codex subscription backend: the
// renewable credential, and the `codex-sandbox/backend` caplet Floot discovers.
// Intended for ENDO_EXTRA alongside setup-host.js, after floot-factory-setup.js.
//
// This replaces an explicit one-shot operator entry point that refused an
// existing backend outright, and which therefore had to be re-run by hand after
// every teardown, host rebuild or state restore. The refusal that mattered is
// kept: an existing credential pinned to a different Secrets record fails
// closed rather than being re-pointed, and an existing backend whose account or
// owner label differs from the requested one is refused before anything is
// minted. What goes away is the refusal to re-run at all.
//
// Reads:
//   ENDO_CODEX_ENABLE=1 — provision at all. Missing configuration enables
//     nothing, exactly as ENDO_CODEX_HOST_CONFIG's absence did.
//   ENDO_CODEX_CREDS_NAME (default codex-subscription-auth) — the Secrets
//     record holding the normalized BrokerOAuthStateV1 document. It is never
//     created here: a subscription credential is imported by an operator.
//   ENDO_CODEX_ACCOUNT_REF — the pinned ChatGPT account. Defaults to the
//     account the stored credential already names; a value that disagrees with
//     it is refused.
//   ENDO_CODEX_HOST_DIR — the private host root holding the durable volume
//     registry and the broker listener's process lock
//   ENDO_CODEX_SANDBOX_IMAGE — Codex CLI slice rootfs (`oci:<image>`); pinned
//     to its digest through Podman when the backend is minted
//   ENDO_CODEX_BROKER_LISTENER_IMAGE — digest-pinned listener image
//   ENDO_CODEX_VOLUME_ROOT, ENDO_CODEX_FILESYSTEM, ENDO_CODEX_QUOTA_COMMAND,
//     ENDO_CODEX_SUDO_PATH, ENDO_CODEX_FLOCK_PATH — the XFS project-quota
//     bridge, as setup-host.js takes them
//   ENDO_CODEX_PROJECT_IDS — JSON {"first":n,"last":n}. A LIFETIME budget: two
//     ids are spent per session and never recycled, the registry latches an
//     exhausted flag, and it refuses a changed range outright. Widening an
//     exhausted registry does nothing; migrating means a fresh
//     ENDO_CODEX_HOST_DIR with a disjoint range.
//   ENDO_CODEX_MAX_SESSIONS — concurrent sessions (listener slots), not a
//     lifetime budget
//   ENDO_CODEX_WORKSPACE_BYTES, ENDO_CODEX_STATE_BYTES — MiB-aligned per-session
//     volume quotas, as decimal strings
//   ENDO_CODEX_MODELS — JSON array of Floot model descriptors
//   ENDO_CODEX_PUBLIC_INTERNET=1 — public egress. Off by default: absent means
//     broker-only.
//   ENDO_CODEX_DIAGNOSTICS=1 — log host-side broker upstream failures and
//     admission events. Off by default; the slice only ever sees a bare 502.
//   ENDO_CODEX_BACKEND_NAME (default codex-backend) — the name Floot's factory
//     discovers the backend under, in its controller profile
//   ENDO_CODEX_SANDBOX_OWNER_ID — must match setup-host.js's; defaults to the
//     same derivation
//
// Idempotent: the credential and the host-side formulas are reused; the backend
// caplet — the one formula whose module path is tied to a release checkout — is
// re-created on every run and re-bound into the Floot profile.

import { Fail, b, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { providePrivateDirectory } from '@endo/hosted-agent/hosted-setup.js';
import { provideManagedRenewableCredentials } from '@endo/hosted-agent/managed-renewable-credentials.js';

import { readCodexHostConfig } from './src/codex-host-config.js';
import {
  SANDBOX_DIR,
  backendSpecifier,
  readBackend,
  readNativeSandbox,
  readStateProvider,
  resolvePinnedImageRef,
} from './src/hosted-runtime-setup.js';
import { deriveCodexOwnerId } from './setup-host.js';
import { assertSubscriptionAccount } from './src/subscription-setup.js';

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 */
const required = (env, name) => {
  const value = env[name];
  (typeof value === 'string' && value.length > 0) ||
    Fail`${b(name)} is required`;
  return /** @type {string} */ (value);
};

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 */
const requiredJson = (env, name) => {
  try {
    return JSON.parse(required(env, name));
  } catch (error) {
    throw Fail`${b(name)} must be JSON: ${q(/** @type {Error} */ (error).message)}`;
  }
};

/**
 * @param {any} hostAgent
 * @param {{ exec?: Parameters<typeof resolvePinnedImageRef>[1] }} [powers]
 */
export const main = async (hostAgent, { exec = undefined } = {}) => {
  await null;
  const { env } = process;
  if (env.ENDO_CODEX_ENABLE !== '1') return;

  const credsName = env.ENDO_CODEX_CREDS_NAME || 'codex-subscription-auth';
  const backendName = env.ENDO_CODEX_BACKEND_NAME || 'codex-backend';
  if (backendName !== 'codex-backend') {
    console.warn(
      `Codex backend name is "${backendName}"; Floot's factory only discovers "codex-backend" unless its own configuration is changed to match.`,
    );
  }

  // The host-side formulas are what sessions are built from; a backend minted
  // without them would fail on first provision.
  const present = await Promise.all(
    ['native-sandbox', 'state-provider'].map(name =>
      E(hostAgent)
        .has(SANDBOX_DIR, name)
        .then(has => /** @type {[string, boolean]} */ ([name, has])),
    ),
  );
  for (const [name, has] of present) {
    has ||
      Fail`${q(`${SANDBOX_DIR}/${name}`)} is missing — run setup-host.js first.`;
  }
  const runtime = await readNativeSandbox(hostAgent);
  await readStateProvider(hostAgent);
  const ownerId =
    env.ENDO_CODEX_SANDBOX_OWNER_ID || (await deriveCodexOwnerId(hostAgent));
  // One identity across the Podman label, the volume registry and the listener
  // lock. A registry that has recorded another owner refuses outright, so a
  // disagreement here is a migration, not a restart — say so before minting.
  runtime.config.ownerId === ownerId ||
    Fail`${b(SANDBOX_DIR)}/native-sandbox runs as ${q(runtime.config.ownerId)} but this setup would configure the backend as ${q(ownerId)}. The volume registry records one owner and refuses a change; retire the runtime and its registry together.`;

  const hostDir = required(env, 'ENDO_CODEX_HOST_DIR');
  const rootfs = required(env, 'ENDO_CODEX_SANDBOX_IMAGE');

  // Everything the configuration reader would refuse is refused here, before
  // any mint or directory creation. Only asking Podman for an unpinned slice
  // image's digest waits for the mint, and the reader runs again on the result.
  const partial = harden({
    directory: hostDir,
    filesystem: required(env, 'ENDO_CODEX_FILESYSTEM'),
    listenerImageRef: required(env, 'ENDO_CODEX_BROKER_LISTENER_IMAGE'),
    maxSessions: Number(required(env, 'ENDO_CODEX_MAX_SESSIONS')),
    models: requiredJson(env, 'ENDO_CODEX_MODELS'),
    ownerId,
    projectIds: requiredJson(env, 'ENDO_CODEX_PROJECT_IDS'),
    quotaCommand: required(env, 'ENDO_CODEX_QUOTA_COMMAND'),
    stateBytes: required(env, 'ENDO_CODEX_STATE_BYTES'),
    volumeRoot: required(env, 'ENDO_CODEX_VOLUME_ROOT'),
    workspaceBytes: required(env, 'ENDO_CODEX_WORKSPACE_BYTES'),
    ...(env.ENDO_CODEX_SUDO_PATH ? { sudoPath: env.ENDO_CODEX_SUDO_PATH } : {}),
    ...(env.ENDO_CODEX_FLOCK_PATH
      ? { flockPath: env.ENDO_CODEX_FLOCK_PATH }
      : {}),
    ...(env.ENDO_CODEX_PUBLIC_INTERNET === '1' ? { publicInternet: true } : {}),
    ...(env.ENDO_CODEX_DIAGNOSTICS === '1' ? { diagnostics: true } : {}),
    secretPath: ['secrets', credsName],
  });

  // Refuse every other setting before the first mint. The two filled in here
  // are not known yet — the account may default to the one the stored
  // credential names, and the image's digest may have to be resolved through
  // Podman — and both are checked on the real configuration below.
  readCodexHostConfig({
    ...partial,
    accountRef: 'unresolved',
    imageRef: `localhost/unresolved@sha256:${'0'.repeat(64)}`,
  });

  // The credential. Minted once with `@agent` and adopted afterwards; it is the
  // one formula in this adapter that still needs it, because the daemon vends a
  // SecretAdmin only from `@secrets/catalog` and makes no delegable form of it.
  await provideManagedRenewableCredentials(hostAgent, {
    namePath: [SANDBOX_DIR, 'credential'],
    secretPath: [...partial.secretPath],
    label: 'Codex',
  });
  const credential = await E(hostAgent).lookup([SANDBOX_DIR, 'credential']);

  // The account is pinned in formula configuration. Read the credential's own
  // account only to default it; an explicit value that disagrees is refused,
  // and a credential that is not a normalized state record is refused before a
  // backend is published against it.
  let stored;
  try {
    stored = JSON.parse(
      globalThis.atob((await E(credential).readBase64WithGeneration()).base64),
    );
  } catch {
    throw Fail`Invalid Codex subscription credential`;
  }
  stored?.version === 'BrokerOAuthStateV1' ||
    Fail`Import and normalize the Codex subscription credential before setup; ${q(credsName)} is not a BrokerOAuthStateV1 record.`;
  const accountRef = assertSubscriptionAccount(
    env.ENDO_CODEX_ACCOUNT_REF || stored.accountId,
    stored,
  );

  // A previously minted backend pins an account; changing it is a deliberate
  // replacement, not a reconfiguration a restart may perform.
  const backendPath = [SANDBOX_DIR, 'backend'];
  const existingBackend = (await E(hostAgent).has(...backendPath))
    ? await readBackend(hostAgent)
    : undefined;
  if (existingBackend) {
    existingBackend.config.accountRef === accountRef ||
      Fail`Codex backend is pinned to account ${q(existingBackend.config.accountRef)}, not ${q(accountRef)}. Replacing the pinned account is a migration: retire the backend deliberately.`;
    existingBackend.config.ownerId === ownerId ||
      Fail`Codex backend runs as ${q(existingBackend.config.ownerId)}, not ${q(ownerId)}.`;
  }

  const { imageRef } = await resolvePinnedImageRef(rootfs, exec);
  const config = readCodexHostConfig({ ...partial, accountRef, imageRef });
  // The durable volume registry and the listener's process lock live here, and
  // both would otherwise mkdir it blind.
  await providePrivateDirectory('ENDO_CODEX_HOST_DIR', config.directory);

  const [sandbox, stateProvider] = await Promise.all([
    E(hostAgent).lookup([SANDBOX_DIR, 'native-sandbox']),
    E(hostAgent).lookup([SANDBOX_DIR, 'state-provider']),
  ]);
  const powersName = 'codex.backend-powers';
  const backendNextPath = [SANDBOX_DIR, 'backend-next'];
  const configText = JSON.stringify({
    accountRef: config.accountRef,
    directory: config.directory,
    filesystem: config.filesystem,
    flockPath: config.flockPath,
    imageRef: config.imageRef,
    listenerImageRef: config.listenerImageRef,
    maxSessions: config.maxSessions,
    models: config.models,
    ownerId: config.ownerId,
    projectIds: config.projectIds,
    quotaCommand: config.quotaCommand,
    secretPath: config.secretPath,
    stateBytes: `${config.volumeLimits.stateBytes}`,
    sudoPath: config.sudoPath,
    volumeRoot: config.volumeRoot,
    workspaceBytes: `${config.volumeLimits.workspaceBytes}`,
    ...(config.diagnostics ? { diagnostics: true } : {}),
    ...(config.publicInternet ? { publicInternet: true } : {}),
  });

  // Unlike Claude's and OpenCode's, this caplet is not a disposable
  // release-pinned shell: it constructs the provider listener runtime, which
  // takes an exclusive lock under `<hostDir>/listener` keyed by the owner
  // label. Minting a replacement while the live one still holds that lock
  // fails with `Provider runtime owner is already active` — which is what a
  // second daemon start did, leaving `backend-next` bound and setup aborted
  // before the Floot binding. Its module specifier already resolves through
  // `<stateDir>/current`, so a retained backend runs the deployed code on its
  // next revival; only its recorded configuration is frozen. Splitting the
  // listener into a retained `broker-service`, as the other two adapters have,
  // is what would make this caplet re-mintable.
  // A failed mint leaves this bound — the construction that refused is what
  // aborted the run — and nothing else ever reads it, so clear it on every
  // run rather than only on the path that creates it.
  if (await E(hostAgent).has(...backendNextPath)) {
    await E(hostAgent).remove(...backendNextPath);
  }
  if (existingBackend && existingBackend.text === configText) {
    console.log(
      'Retaining the Codex hosted backend with its persisted configuration.',
    );
  } else {
    if (existingBackend) {
      throw Fail`Codex backend configuration changed. This caplet holds the provider listener's exclusive lock, so a replacement cannot be minted beside it: retire ${q(backendPath.join('/'))} deliberately, then rerun setup.`;
    }
    if (await E(hostAgent).has(powersName)) {
      await E(hostAgent).remove(powersName);
    }
    // The backend's powers: a stored record of exactly the three capabilities
    // it needs. `powersName` takes one name, and a marshalled record is how
    // several capabilities become one — the minted formula retains the record
    // as its powers dependency, so the temporary name is not what keeps it
    // alive.
    await E(hostAgent).storeValue(
      harden({ credential, sandbox, stateProvider }),
      powersName,
    );
    try {
      // Mint under a temporary name *before* touching the live one: if the
      // mint fails, Floot's existing binding keeps working.
      await E(hostAgent).makeUnconfined('@main', backendSpecifier, {
        powersName,
        resultName: backendNextPath,
        env: harden({ CODEX_HOST_CONFIG: configText }),
      });
    } finally {
      await E(hostAgent).remove(powersName);
    }
    if (await E(hostAgent).has(...backendPath)) {
      await E(hostAgent).remove(...backendPath);
    }
    await E(hostAgent).copy(backendNextPath, backendPath);
    await E(hostAgent).remove(...backendNextPath);
    console.log(
      `Minted the Codex hosted backend at "${backendPath.join('/')}".`,
    );
  }

  const flootDir = env.ENDO_FLOOT_DIR || env.FLOOT_DIR || 'floot';
  if (await E(hostAgent).has(flootDir, 'controller-profile')) {
    // copy overwrites an existing binding, so no remove is needed — and
    // removing first would open a window in which Floot cannot discover the
    // backend if the copy fails.
    await E(hostAgent).copy(backendPath, [
      flootDir,
      'controller-profile',
      backendName,
    ]);
    console.log(
      `Bound "${backendName}" into "${flootDir}/controller-profile".`,
    );
  } else {
    console.warn(
      `Floot controller profile "${flootDir}/controller-profile" is absent; skipping the "${backendName}" binding.`,
    );
  }

  console.log(
    'Hosted Codex subscription backend ready. Session state is owned by the daemon under codex-sandbox/state-provider.',
  );
};
harden(main);
