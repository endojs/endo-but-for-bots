// @ts-check

// Establish a SES perimeter (provides the `harden` global).
import '@endo/init/debug.js';

import test from 'ava';

import { make, parsePolicy, parsePositiveInteger } from '../src/index.js';

/**
 * The formula's env, with the mock bridge selected explicitly.
 *
 * @param {string} [policy] - the JSON policy text.
 */
const mockEnv = (policy = '{"allowedActions":["lockNow","getDeviceState"]}') =>
  harden({ policy, bridge: 'mock' });

test('the formula returns a kit whose facets are separable', async t => {
  const kit = await make(undefined, undefined, { env: mockEnv() });

  const client = kit.client();
  const control = kit.control();

  await client.lockNow();
  t.false(control.isRevoked());

  // The point of two methods rather than one record: naming the vendable
  // facet in a pet store must not drag the control facet along with it.
  t.is(/** @type {any} */ (client).revoke, undefined);
  t.is(typeof control.revoke, 'function');
  t.is(typeof kit.help(), 'string');
});

test('the kit control facet governs the kit client facet', async t => {
  const kit = await make(undefined, undefined, { env: mockEnv() });
  const client = kit.client();

  kit.control().revoke();

  await t.throwsAsync(() => client.lockNow(), { message: /revoked/ });
});

test('policy is required and must be a JSON object', t => {
  t.throws(() => parsePolicy(undefined), {
    message: /requires a JSON "policy"/,
  });
  t.throws(() => parsePolicy(''), { message: /requires a JSON "policy"/ });
  t.throws(() => parsePolicy('{not json'), { message: /could not parse/ });
  t.throws(() => parsePolicy('[]'), { message: /must be a JSON object/ });
  t.throws(() => parsePolicy('null'), { message: /must be a JSON object/ });
  t.deepEqual(parsePolicy('{"allowedActions":["lockNow"]}'), {
    allowedActions: ['lockNow'],
  });
});

test('the policy bounds the minted capability', async t => {
  const kit = await make(undefined, undefined, {
    env: mockEnv('{"allowedActions":["getDeviceState"]}'),
  });
  const client = kit.client();

  const state = await client.getDeviceState();
  t.true(state.deviceOwner);
  await t.throwsAsync(() => client.lockNow(), {
    message: /not permitted by policy/,
  });
});

test('an unknown action in the env policy fails at bring-up, not at first use', async t => {
  await t.throwsAsync(
    () =>
      make(undefined, undefined, {
        env: mockEnv('{"allowedActions":["lockNwo"]}'),
      }),
    { message: /unknown admin action/ },
  );
});

test('the mock bridge is never selected implicitly', async t => {
  // Defaulting to a fake device would let a misconfigured deployment report
  // success for administrative actions that never touched hardware.
  await t.throwsAsync(
    () =>
      make(undefined, undefined, {
        env: harden({ policy: '{"allowedActions":["lockNow"]}' }),
      }),
    { message: /could not load the nodejs-mobile bridge module/ },
  );
});

test('an unrecognized bridge name is rejected', async t => {
  await t.throwsAsync(
    () =>
      make(undefined, undefined, {
        env: harden({
          policy: '{"allowedActions":["lockNow"]}',
          bridge: 'carrier-pigeon',
        }),
      }),
    { message: /must be 'nodejs-mobile' or 'mock'/ },
  );
});

test('timeoutMs must be a positive integer when present', t => {
  t.is(parsePositiveInteger(undefined, 'timeoutMs'), undefined);
  t.is(parsePositiveInteger('500', 'timeoutMs'), 500);
  t.throws(() => parsePositiveInteger('0', 'timeoutMs'), {
    message: /positive integer/,
  });
  t.throws(() => parsePositiveInteger('-1', 'timeoutMs'), {
    message: /positive integer/,
  });
  t.throws(() => parsePositiveInteger('soon', 'timeoutMs'), {
    message: /positive integer/,
  });
});
