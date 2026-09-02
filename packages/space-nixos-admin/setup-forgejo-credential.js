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
// Credential material is daemon-process-local: a restart keeps the formula but
// leaves the material unavailable and the record revoked, so re-provisioning on
// every start is the point of this setup. It ROTATES the credential when the
// name is already bound rather than re-minting it. A GitRemote holds the
// credential *cap*, not its name, so re-minting binds the name to a fresh
// formula and strands every remote configured in an earlier process; the
// stranding is invisible until the next push fails with "has been revoked".
// Rotating restores the material in place, which brings those remotes back.

import { E } from '@endo/far';

const CREDENTIAL_NAME = 'forgejo-credential';

/**
 * The controller for an already-bound credential, or undefined when the name is
 * free, holds something that is not a credential, or speaks for a different
 * audience or kind than this host is now configured for. In each of those cases
 * the caller should mint a fresh credential rather than rotate the old one.
 *
 * @param {any} agent
 * @param {string} audience
 */
const existingCredentialController = async (agent, audience) => {
  let controller;
  try {
    const credential = await E(agent).lookup(CREDENTIAL_NAME);
    controller = await E(agent).getGitCredentialController(credential);
  } catch {
    return undefined;
  }
  const info = await E(controller).inspect();
  if (info.audience !== audience || info.kind !== 'basic') {
    return undefined;
  }
  return controller;
};

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

  const controller = await existingCredentialController(agent, audience);
  if (controller !== undefined) {
    await E(controller).rotate({ username, password });
    console.error(
      `Forgejo credential ${CREDENTIAL_NAME} rotated for ${username} at ${audience}.`,
    );
    return;
  }

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
