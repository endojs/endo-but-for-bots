// @ts-check

import { makeHostedAgentPolicyVerifier } from '@endo/hosted-agent/hosted-agent-policy.js';

/** Codex contributes only its mount table to the shared hosted contract. */
export const CODEX_FIXED_MOUNTS = harden([
  { role: 'workspace', kind: 'session', destination: '/workspace', mode: 'rw' },
  {
    role: 'codex-state',
    kind: 'session',
    destination: '/codex-home',
    mode: 'rw',
  },
  { role: 'tmp', kind: 'tmpfs', destination: '/tmp', mode: 'rw' },
  { role: 'run', kind: 'tmpfs', destination: '/run', mode: 'rw' },
  { role: 'scratch', kind: 'tmpfs', destination: '/scratch', mode: 'rw' },
]);

const codexPolicy = makeHostedAgentPolicyVerifier({
  fixedMounts: CODEX_FIXED_MOUNTS,
});

export const assertContainerMounts = codexPolicy.assertContainerMounts;
export const assertHostedAgentPolicyV1 = codexPolicy.assertHostedAgentPolicyV1;
export const hostedPolicyFromSlice = codexPolicy.hostedPolicyFromSlice;
