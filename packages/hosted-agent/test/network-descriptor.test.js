// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { assertHostedBackendDescriptor } from '../src/hosted-backend.js';

const descriptor = harden({
  id: 'test',
  title: 'Test',
  kind: 'hosted',
  continuity: 'opaque-reconciled',
  toolOwnership: 'endo',
});

test('network enforcement support is explicit and closed to known policies', t => {
  t.false(
    Object.hasOwn(
      assertHostedBackendDescriptor(descriptor),
      'supportedNetworkPolicies',
    ),
  );
  t.deepEqual(
    assertHostedBackendDescriptor({
      ...descriptor,
      supportedNetworkPolicies: ['off', 'public-internet'],
    }).supportedNetworkPolicies,
    ['off', 'public-internet'],
  );
  for (const supportedNetworkPolicies of [
    ['private'],
    ['off', 'off'],
    'off',
    null,
  ]) {
    t.throws(() =>
      assertHostedBackendDescriptor({
        ...descriptor,
        supportedNetworkPolicies,
      }),
    );
  }
  t.throws(() =>
    assertHostedBackendDescriptor({ ...descriptor, network: 'host' }),
  );
});
