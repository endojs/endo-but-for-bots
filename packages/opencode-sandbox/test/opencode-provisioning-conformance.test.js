// @ts-check
import '@endo/init';

import { testProvisioningConformance } from '@endo/hosted-agent/test/provisioning-conformance.js';

import { makeOpencodeBackendFactory } from '../src/opencode-backend-factory.js';
import { makeOpencodeSessionProvisioner } from '../src/opencode-backend-module.js';

const digest = `sha256:${'a'.repeat(64)}`;

testProvisioningConformance({
  label: 'OpenCode',
  makeProvisioner: powers =>
    makeOpencodeSessionProvisioner({
      ...powers,
      rootfs: `oci:localhost/opencode@${digest}`,
      accountRef: 'openrouter-main',
    }),
  makeFactory: makeOpencodeBackendFactory,
  rebound: [
    {
      what: 'image',
      makeProvisioner: powers =>
        makeOpencodeSessionProvisioner({
          ...powers,
          rootfs: `oci:localhost/opencode@sha256:${'b'.repeat(64)}`,
          accountRef: 'openrouter-main',
        }),
    },
    {
      what: 'account',
      makeProvisioner: powers =>
        makeOpencodeSessionProvisioner({
          ...powers,
          rootfs: `oci:localhost/opencode@${digest}`,
          accountRef: 'openrouter-other',
        }),
    },
  ],
});
