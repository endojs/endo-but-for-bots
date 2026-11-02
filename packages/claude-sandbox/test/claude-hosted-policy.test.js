// @ts-check
import '@endo/init';

import { testHostedProfile } from '@endo/hosted-agent/test/hosted-profile-conformance.js';

import {
  CLAUDE_FIXED_MOUNTS,
  assertHostedAgentPolicyV1,
} from '../src/claude-hosted-policy.js';

testHostedProfile({
  label: 'claude',
  fixedMounts: CLAUDE_FIXED_MOUNTS,
  assertHostedAgentPolicyV1,
});
