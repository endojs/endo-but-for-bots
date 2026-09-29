import test from '@endo/ses-ava/prepare-endo.js';

import {
  compareSemver,
  devDateTagForVersion,
  isWritableDevTag,
} from '../src/dev-release.js';
import {
  allowlistCovers,
  canonicalizePackageName,
  encodePackageName,
  tarballFileName,
} from '../src/names.js';

test('development versions derive their date tag', t => {
  t.is(
    devDateTagForVersion('1.7.0-dev.20260928231903.g3aa902d'),
    'dev-2026-09-28',
  );
  for (const bad of [
    '1.7.0',
    '1.7.0-dev.2026092823190.g3aa902d',
    '1.7.0-dev.20260928231903.3aa902d',
    '1.7.0-dev.20260230231903.g3aa902d',
    '01.7.0-dev.20260928231903.g3aa902d',
  ]) {
    t.throws(() => devDateTagForVersion(bad), { message: /Version/ }, bad);
  }
});

test('SemVer precedence orders development builds chronologically', t => {
  const sorted = [
    '1.7.0',
    '1.7.0-dev.20260928231903.g3aa902d',
    '1.6.9',
    '1.7.0-dev.20260928101010.gffffff0',
    '1.7.0-alpha',
    '2.0.0-dev.20260101000000.g0000000',
  ].sort(compareSemver);
  t.deepEqual(sorted, [
    '1.6.9',
    '1.7.0-alpha',
    '1.7.0-dev.20260928101010.gffffff0',
    '1.7.0-dev.20260928231903.g3aa902d',
    '1.7.0',
    '2.0.0-dev.20260101000000.g0000000',
  ]);
});

test('only date channels and reserved dev pointers are writable', t => {
  t.true(isWritableDevTag('dev-2026-09-28', ['dev-latest']));
  t.true(isWritableDevTag('dev-latest', ['dev-latest']));
  t.false(isWritableDevTag('latest', ['dev-latest']));
  t.false(isWritableDevTag('dev-other', ['dev-latest']));
  t.false(isWritableDevTag('next', ['next']));
});

test('package names canonicalize both scoped spellings', t => {
  t.is(canonicalizePackageName('@endo%2fpatterns'), '@endo/patterns');
  t.is(canonicalizePackageName('@endo%2Fpatterns'), '@endo/patterns');
  t.is(canonicalizePackageName('@endo/patterns'), '@endo/patterns');
  t.is(canonicalizePackageName('ses'), 'ses');
  t.throws(() => canonicalizePackageName('Upper'));
  t.throws(() => canonicalizePackageName('..'));
  t.throws(() => canonicalizePackageName('@endo%2f..%2fx'));
  t.is(encodePackageName('@endo/patterns'), '@endo%2fpatterns');
  t.is(tarballFileName('@endo/patterns', '1.0.0'), 'patterns-1.0.0.tgz');
  t.true(allowlistCovers(['@endo/*'], '@endo/patterns'));
  t.false(allowlistCovers(['@endo/*'], '@endolike/patterns'));
  t.false(allowlistCovers(['@endo/*'], 'endo'));
  t.true(allowlistCovers(['ses'], 'ses'));
});
