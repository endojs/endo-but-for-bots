// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { parseRootfs, rootfsLabel } from '../src/parse-rootfs.js';

test('rootfs selections and image defaults share normalization', t => {
  for (const value of ['host-bind', 'minimal']) {
    const parsed = parseRootfs(value);
    t.deepEqual(parsed, { kind: value });
    t.is(rootfsLabel(parsed), value);
  }
  for (const value of [
    'localhost/agent:latest',
    'oci:localhost/agent:latest',
  ]) {
    const expected = { kind: 'oci', ref: 'localhost/agent:latest' };
    t.deepEqual(parseRootfs(value), expected);
    for (const blank of [undefined, '']) {
      const parsed = parseRootfs(blank, { defaultImage: value });
      t.deepEqual(parsed, expected);
      t.is(rootfsLabel(parsed), 'oci:localhost/agent:latest');
      t.true(Object.isFrozen(parsed));
    }
  }
});

test('rootfs parser rejects missing images and invalid input', t => {
  t.throws(() => parseRootfs('oci:'), { message: /missing the OCI image/ });
  t.throws(() => parseRootfs(undefined), { message: /must be a string/ });
  for (const defaultImage of ['', 'oci:']) {
    t.throws(() => parseRootfs('', { defaultImage }), {
      message: /missing the OCI image/,
    });
  }
  // @ts-expect-error Exercise the untyped parser boundary.
  t.throws(() => parseRootfs(42), { message: /must be a string/ });
});

test('an image default never selects a host filesystem keyword', t => {
  for (const defaultImage of ['host-bind', 'minimal']) {
    t.deepEqual(parseRootfs('', { defaultImage }), {
      kind: 'oci',
      ref: defaultImage,
    });
  }
});
