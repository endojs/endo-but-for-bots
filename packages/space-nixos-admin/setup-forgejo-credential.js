// @ts-check
/* global process */
// endo run --UNCONFINED setup-forgejo-credential.js --powers @agent
//
// Mints the Git credential the machine-admin agent pushes to the local Forgejo
// with, and files it in the host's inventory as `forgejo-credential`. Intended
// to be listed in the daemon's ENDO_EXTRA so it re-provisions on every start
// (see the endo-host repo).
//
// This is what closes the self-update loop: a revision the agent authors exists
// only on the forge, and `services.endo.mirrorUrl` fetches it from there, so the
// agent needs push authority to the forge to get a commit the host can pin.
//
// The secret never reaches a session. A guest holding the resulting capability
// sees `audience()` and nothing else; the password stays daemon-side and is fed
// to git through askpass at transport time.
//
// Unlike the nixos-admin controller next door, this re-provisions unconditionally
// rather than skipping when the name is already bound. Credential material is
// daemon-process-local — a restart keeps the formula but leaves the material
// unavailable — so re-minting is precisely the point of running on every start.
// Re-minting rebinds the name to a fresh formula, which is why callers should
// look the credential up when they use it instead of holding a copy.

import { E } from '@endo/far';

const CREDENTIAL_NAME = 'forgejo-credential';

export const main = async agent => {
  const { env } = process;
  const password = env.ENDO_FORGEJO_FLOOT_PW || '';
  if (!password) {
    // No forge configured on this host; machine-admin sessions still work, they
    // just cannot publish a revision.
    console.error(
      'No ENDO_FORGEJO_FLOOT_PW; skipping Forgejo credential provisioning.',
    );
    return;
  }

  // The loopback origin rather than the public hostname: the daemon reaches
  // Forgejo directly, and `services.endo.mirrorUrl` fetches the pinned revision
  // over the same origin, so both halves of the loop agree on the audience.
  const audience = env.ENDO_FORGEJO_URL || 'http://127.0.0.1:3000';
  const username = env.ENDO_FORGEJO_USER || 'floot';

  await E(agent).provideBasicCredential(CREDENTIAL_NAME, {
    audience,
    username,
    password,
  });

  console.error(
    `Forgejo credential provisioned as ${CREDENTIAL_NAME} for ${username} at ${audience}.`,
  );
};
harden(main);
