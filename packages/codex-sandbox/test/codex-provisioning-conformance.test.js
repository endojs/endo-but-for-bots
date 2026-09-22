// @ts-check
import '@endo/init';

import { testProvisioningConformance } from '@endo/hosted-agent/test/provisioning-conformance.js';

import { makeCodexBackendFactory } from '../src/codex-backend-factory.js';
import { makeCodexSessionProvisioner } from '../src/codex-backend-module.js';

const digest = `sha256:${'a'.repeat(64)}`;

testProvisioningConformance({
  label: 'Codex',
  makeProvisioner: powers =>
    makeCodexSessionProvisioner({
      ...powers,
      imageRef: `example@${digest}`,
      accountRef: 'account-a',
    }),
  makeFactory: makeCodexBackendFactory,
  // Codex records the operator's container mounts; none here.
  request: { containerMounts: [] },
  rebound: [
    {
      what: 'image',
      makeProvisioner: powers =>
        makeCodexSessionProvisioner({
          ...powers,
          imageRef: `example@sha256:${'b'.repeat(64)}`,
          accountRef: 'account-a',
        }),
    },
    {
      what: 'account',
      makeProvisioner: powers =>
        makeCodexSessionProvisioner({
          ...powers,
          imageRef: `example@${digest}`,
          accountRef: 'account-b',
        }),
    },
  ],
});
