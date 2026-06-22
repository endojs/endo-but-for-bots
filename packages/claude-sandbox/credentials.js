// @ts-check
// endo run --UNCONFINED credentials.js --powers @agent
//   [<factoryName>]
//
// Provision the Claude Credentials factory caplet under @host. The
// factory presents a "Create Claude Credentials" form on @host's
// inbox; each submission stores a `ClaudeCredentials` cap (Anthropic
// API key wrapper) back in @host's petstore under the chosen name.
// That cap is what the ClaudeSandbox factory's `credentials` form
// field references when minting a session.
//
// The credentials factory normally runs on the *peer* machine (the one that
// owns the Anthropic key), not the sandbox host — keeping the long-lived
// secret on the peer. Its objects live under a directory so they don't
// pollute the host root: `<dir>/controller`, `<dir>/profile`, `<dir>/handle`.
//
// Defaults:
//   <dirName>   claude-credentials
//
// Idempotent: re-running is a no-op once `<dir>/controller` exists.

import { E } from '@endo/eventual-send';

const factoryCapletSpecifier = new URL(
  'src/claude-credentials-factory.js',
  import.meta.url,
).href;

const DEFAULT_FACTORY_NAME = 'claude-credentials';

// Stored as `<dir>/readme` (`endo show <dir>/readme`).
const README = `claude-credentials/ — Claude Credentials factory (PEER side)

This normally runs on the machine that owns the Anthropic account, NOT the
sandbox host. The long-lived API key/token never leaves this peer. What
sharing each object in this directory grants:

  controller   The "Create Claude Credentials" factory exo. It mints a
               ClaudeCredentials cap from a key you submit on its form. The
               sensitive object is the *minted credential*, not this exo.

  profile      The factory's guest AGENT. Holds host-agent = FULL authority
               over THIS (peer) machine. NEVER share.

  handle       The guest's mailbox handle. Low authority; do not share
               casually.

What you DO share off-machine: the minted ClaudeCredentials cap (named when
you submit the form), handed to the sandbox host's createSession. The host
only ever receives a short-lived materialised secret at container-spawn time —
never the long-lived key, which stays on this peer.`;

/**
 * @param {import('@endo/eventual-send').ERef<object>} agent
 * @param {string} [dirName]
 */
export const main = async (agent, dirName = DEFAULT_FACTORY_NAME) => {
  // The directory must exist before any path-form `has`/`move` (a path `has`
  // throws "Unknown pet name" when the directory itself is absent).
  if (!(await E(agent).has(dirName))) {
    await E(agent).makeDirectory([dirName]);
  }

  // Document the directory's objects (backfilled on re-runs).
  if (!(await E(agent).has(dirName, 'readme'))) {
    await E(agent).storeValue(README, [dirName, 'readme']);
  }

  // `<dir>/profile` is the last artifact created, so it is the completion
  // sentinel — every step below is individually guarded so a re-run after a
  // partial failure reconciles rather than leaking the temp top-level names.
  if (
    (await E(agent).has(dirName, 'controller')) &&
    (await E(agent).has(dirName, 'profile'))
  ) {
    console.log(`${dirName}/ already provisioned — skipping`);
    return;
  }

  // provideGuest / powersName take a single name only, so the guest is born
  // top-level and moved into the directory after makeUnconfined.
  const guestTmp = `${dirName}-guest`;
  const agentTmp = `${dirName}-agent`;
  if (
    !(await E(agent).has(guestTmp)) &&
    !(await E(agent).has(dirName, 'handle'))
  ) {
    await E(agent).provideGuest(guestTmp, {
      introducedNames: harden({ '@agent': 'host-agent' }),
      agentName: agentTmp,
    });
  }

  if (!(await E(agent).has(dirName, 'controller'))) {
    await E(agent).makeUnconfined('@main', factoryCapletSpecifier, {
      powersName: agentTmp,
      resultName: [dirName, 'controller'],
    });
  }

  if (await E(agent).has(guestTmp)) {
    await E(agent).move([guestTmp], [dirName, 'handle']);
  }
  if (await E(agent).has(agentTmp)) {
    await E(agent).move([agentTmp], [dirName, 'profile']);
  }

  console.log(`Factory provisioned under ${dirName}/`);
};
harden(main);
