// @ts-check
/* global harden, process */
// endo run --UNCONFINED setup.js --powers @agent
//
// Provisions the hosted-Endo management controller and stores it in the
// agent's inventory as `controller-for-endo-mgmt`. Intended to be listed in
// the daemon's ENDO_EXTRA so it auto-provisions on start (see the endo-host
// repo). Idempotent: it no-ops if the controller already exists.

import { E } from '@endo/eventual-send';

const capletSpecifier = new URL('caplet.js', import.meta.url).href;

/**
 * @param {import('@endo/eventual-send').ERef<any>} agent
 */
export const main = async agent => {
  // Re-bind on every start. `capletSpecifier` resolves relative to this file,
  // which the daemon loads through the atomically-swapped release checkout, so
  // re-creating rebinds the controller to the CURRENT release's caplet. Because
  // every deploy restarts the daemon (re-running this), the binding never lags
  // far enough behind for its release to be pruned. Skipping when it already
  // exists would instead pin the controller to the first-built release and
  // break once that release is pruned.
  if (await E(agent).has('controller-for-endo-mgmt')) {
    await E(agent).remove('controller-for-endo-mgmt');
  }

  const { env } = process;
  await E(agent).makeUnconfined('@main', capletSpecifier, {
    resultName: 'controller-for-endo-mgmt',
    env: {
      ENDO_DEPLOY_DIR: env.ENDO_DEPLOY_DIR || '',
      ENDO_MGMT_REPO_URL: env.ENDO_MGMT_REPO_URL || '',
      ENDO_MGMT_DEFAULT_BRANCH: env.ENDO_MGMT_DEFAULT_BRANCH || 'llm',
    },
  });

  console.log('Endo management controller provisioned.');
};
harden(main);
