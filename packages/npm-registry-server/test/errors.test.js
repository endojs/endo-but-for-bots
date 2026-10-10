// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { RegistryHttpError, isRegistryHttpError } from '../src/errors.js';

test('a registry error cannot have its status or reason rewritten', t => {
  const error = RegistryHttpError(403, 'Forbidden');
  t.true(Object.isFrozen(error));
  t.throws(() => {
    /** @type {any} */ (error).statusCode = 200;
  });
  t.throws(() => {
    /** @type {any} */ (error).reason = 'fine';
  });
  t.is(error.statusCode, 403);
  t.is(error.reason, 'Forbidden');
  t.true(isRegistryHttpError(error));
});

test('an error shaped like a registry error is not one', t => {
  const impostor = /** @type {any} */ (Error('Not found'));
  impostor.statusCode = 404;
  impostor.reason = 'Not found';
  t.false(isRegistryHttpError(impostor));
  t.false(
    isRegistryHttpError({ statusCode: 404, reason: 'Not found', message: '' }),
  );
  t.false(isRegistryHttpError(undefined));
});
