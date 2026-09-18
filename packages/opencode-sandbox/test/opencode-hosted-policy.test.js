// @ts-check
import '@endo/init';

import { testHostedProfile } from '@endo/hosted-agent/test/hosted-profile-conformance.js';

import {
  OPENCODE_FIXED_MOUNTS,
  assertHostedAgentPolicyV1,
} from '../src/opencode-hosted-policy.js';

testHostedProfile({
  label: 'opencode',
  fixedMounts: OPENCODE_FIXED_MOUNTS,
  assertHostedAgentPolicyV1,
});
