// @ts-check
import '@endo/init';

import { testProvisioningConformance } from '@endo/hosted-agent/test/provisioning-conformance.js';

import { makeCodexBackendFactory } from '../src/codex-backend-factory.js';
import { makeCodexSessionProvisioner } from '../src/codex-backend-module.js';

const digest = `sha256:${'a'.repeat(64)}`;

testProvisioningConformance({
  nativeState: true,
  label: 'Codex',
  makeProvisioner: powers =>
    makeCodexSessionProvisioner({
      ...powers,
      stateRoot: powers.protectedRoots[0],
      // The adapter must protect native state without caller-supplied protection.
      protectedRoots: [],
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
          stateRoot: powers.protectedRoots[0],
          imageRef: `example@sha256:${'b'.repeat(64)}`,
          accountRef: 'account-a',
        }),
    },
    {
      what: 'account',
      makeProvisioner: powers =>
        makeCodexSessionProvisioner({
          ...powers,
          stateRoot: powers.protectedRoots[0],
          imageRef: `example@${digest}`,
          accountRef: 'account-b',
        }),
    },
  ],
});
