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
  if (await E(agent).has('controller-for-endo-mgmt')) {
    console.log('Endo management already provisioned — skipping setup.');
    return;
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
