// @ts-check

/**
 * Control for {@link file://./pi-confined-compat.test.js}: the pi-mono
 * exports load in the surrounding SES-locked Node realm. The incompatibility
 * this PR pins is specific to confined Compartment loading through
 * `@endo/compartment-mapper`.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { Agent as PiAgent } from '@mariozechner/pi-agent-core';
import { getModel, getProviders } from '@mariozechner/pi-ai';

test('pi-mono loads under SES lockdown outside a confined Compartment', t => {
  t.is(typeof PiAgent, 'function');
  t.is(typeof getModel, 'function');
  t.is(typeof getProviders, 'function');

  const providers = getProviders();
  t.true(Array.isArray(providers));
  t.true(providers.length > 0);

  const agent = new PiAgent({});
  t.is(typeof agent.prompt, 'function');
});
