// @ts-check
import '@endo/init';

import { testProvisioningConformance } from '@endo/hosted-agent/test/provisioning-conformance.js';

import { makeClaudeBackendFactory } from '../src/claude-backend-factory.js';
import { makeClaudeSessionProvisioner } from '../src/claude-backend-module.js';

const digest = `sha256:${'a'.repeat(64)}`;

testProvisioningConformance({
  label: 'Claude',
  makeProvisioner: powers =>
    makeClaudeSessionProvisioner({
      ...powers,
      rootfs: `oci:localhost/claude@${digest}`,
      credentialKind: 'oauthToken',
    }),
  makeFactory: makeClaudeBackendFactory,
  rebound: [
    {
      what: 'image',
      makeProvisioner: powers =>
        makeClaudeSessionProvisioner({
          ...powers,
          rootfs: `oci:localhost/claude@sha256:${'b'.repeat(64)}`,
          credentialKind: 'oauthToken',
        }),
    },
    {
      what: 'credential kind',
      makeProvisioner: powers =>
        makeClaudeSessionProvisioner({
          ...powers,
          rootfs: `oci:localhost/claude@${digest}`,
          credentialKind: 'apiKey',
        }),
    },
  ],
});
