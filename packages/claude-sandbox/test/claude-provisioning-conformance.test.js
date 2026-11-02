// @ts-check
import '@endo/init';

import { testProvisioningConformance } from '@endo/hosted-agent/test/provisioning-conformance.js';

import { makeClaudeBackendFactory } from '../src/claude-backend-factory.js';
import { makeClaudeSessionProvisioner } from '../src/claude-backend-module.js';

const digest = `sha256:${'a'.repeat(64)}`;

testProvisioningConformance({
  nativeState: true,
  label: 'Claude',
  makeProvisioner: powers =>
    makeClaudeSessionProvisioner({
      ...powers,
      stateRoot: powers.protectedRoots[0],
      // The adapter must protect native state without caller-supplied protection.
      protectedRoots: [],
      rootfs: `oci:localhost/claude@${digest}`,
      accountRef: 'claude-main',
      credentialKind: 'oauthToken',
    }),
  makeFactory: makeClaudeBackendFactory,
  rebound: [
    {
      what: 'image',
      makeProvisioner: powers =>
        makeClaudeSessionProvisioner({
          ...powers,
          stateRoot: powers.protectedRoots[0],
          rootfs: `oci:localhost/claude@sha256:${'b'.repeat(64)}`,
          accountRef: 'claude-main',
          credentialKind: 'oauthToken',
        }),
    },
    {
      // Another account authority, or the same one's credential of another
      // kind, is an `account` change: the module test covers the kind.
      what: 'account',
      makeProvisioner: powers =>
        makeClaudeSessionProvisioner({
          ...powers,
          stateRoot: powers.protectedRoots[0],
          rootfs: `oci:localhost/claude@${digest}`,
          accountRef: 'claude-other',
          credentialKind: 'oauthToken',
        }),
    },
  ],
});
