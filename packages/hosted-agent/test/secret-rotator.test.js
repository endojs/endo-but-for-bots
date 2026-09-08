// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeSecretRotator } from '../src/secret-rotator.js';

const makeAdmin = () => {
  const calls = [];
  const admin = Far('SecretAdmin', {
    async replaceBase64(base64) {
      calls.push(base64);
      return 'replaced';
    },
    async setDescription() {
      throw Error('should be unreachable');
    },
    async revoke() {
      throw Error('should be unreachable');
    },
    async delete() {
      throw Error('should be unreachable');
    },
    async getSummary() {
      throw Error('should be unreachable');
    },
  });
  return { admin, calls };
};

test('the rotator forwards replacement and answers the manager', async t => {
  await null;
  const { admin, calls } = makeAdmin();
  const rotator = makeSecretRotator(admin);
  t.is(await E(rotator).replaceBase64('cm90YXRlZA=='), 'replaced');
  t.deepEqual(calls, ['cm90YXRlZA==']);
});

test('the rotator carries no other administrative authority', async t => {
  const { admin } = makeAdmin();
  const rotator = makeSecretRotator(admin);
  // The whole point of the attenuation: a broker holding this cannot revoke or
  // destroy the operator's credential, nor rewrite the record's identity.
  // Reached through a key rather than a property because the repo's
  // underscore-dangle and dot-notation rules disagree about the literal form.
  const getMethodNames = '__getMethodNames__';
  const names = await E(/** @type {any} */ (rotator))[getMethodNames]();
  t.deepEqual(
    names.filter(name => !name.startsWith('__')),
    ['replaceBase64'],
  );
  for (const method of [
    'revoke',
    'delete',
    'setDescription',
    'getSummary',
    'readBase64',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(rotator)[method](), {
      message: /no method|not a function/,
    });
  }
});

test('the rotator refuses a non-string replacement rather than forwarding it', async t => {
  const { admin, calls } = makeAdmin();
  const rotator = makeSecretRotator(admin);
  await t.throwsAsync(() => E(rotator).replaceBase64(/** @type {any} */ (42)));
  t.deepEqual(calls, []);
});

test('something that could not be a facet is refused at construction', t => {
  for (const bad of [undefined, null, 42, 'admin', true]) {
    t.throws(() => makeSecretRotator(/** @type {any} */ (bad)), {
      message: /Secret rotator requires an administration facet/,
    });
  }
  // A CapTP presence has no methods to inspect, and the secret manager is
  // exactly the sort of facet that arrives that way, so anything object-shaped
  // is admitted and answers for itself.
  t.notThrows(() =>
    makeSecretRotator(
      Far('SecretAdmin', {
        async replaceBase64() {
          return 'replaced';
        },
      }),
    ),
  );
});
