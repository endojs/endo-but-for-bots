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

test('rebindable bindings are a short list of distinct names, and pass through as declared', t => {
  const base = {
    id: 'test',
    title: 'Test',
    kind: 'hosted',
    continuity: 'transcript',
    toolOwnership: 'endo',
  };
  t.deepEqual(
    assertHostedBackendDescriptor({
      ...base,
      rebindableBindings: ['image', 'provider'],
    }).rebindableBindings,
    ['image', 'provider'],
  );
  t.false('rebindableBindings' in assertHostedBackendDescriptor(base));
  for (const rebindableBindings of [
    'image',
    ['image', 'image'],
    [''],
    ['x'.repeat(65)],
    [42],
    Array.from({ length: 9 }, (_, index) => `binding-${index}`),
  ]) {
    t.throws(
      () => assertHostedBackendDescriptor({ ...base, rebindableBindings }),
      { message: /invalid rebindable bindings/ },
    );
  }
});
