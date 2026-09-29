import test from '@endo/ses-ava/prepare-endo.js';
import { fc } from '@fast-check/ava';

import {
  compareSemver,
  devDateTagForVersion,
  isWritableDevTag,
  parseSemver,
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
    // The time of day is checked too, not only the date.
    '1.7.0-dev.20260928240000.g3aa902d',
    '1.7.0-dev.20260928236000.g3aa902d',
    '1.7.0-dev.20260928235960.g3aa902d',
    '1.7.0-dev.20260929999999.g0000000',
    // The commit is 7 to 40 hex digits.
    '1.7.0-dev.20260928231903.g3aa902',
    `1.7.0-dev.20260928231903.g${'a'.repeat(41)}`,
  ]) {
    t.throws(() => devDateTagForVersion(bad), { message: /Version/ }, bad);
  }
  for (const good of [
    '1.7.0-dev.20260928000000.g3aa902d',
    '1.7.0-dev.20260928235959.g3aa902d',
    `1.7.0-dev.20260928231903.g${'a'.repeat(40)}`,
  ]) {
    t.is(devDateTagForVersion(good), 'dev-2026-09-28', good);
  }
});

test('version components beyond the safe integers are not SemVer here', t => {
  const limit = String(Number.MAX_SAFE_INTEGER);
  t.truthy(parseSemver(`${limit}.0.0`));
  t.is(parseSemver('9007199254740992.0.0'), undefined);
  t.is(parseSemver('100000000000000000001.0.0'), undefined);
  t.throws(() =>
    compareSemver('100000000000000000001.0.0', '100000000000000000002.0.0'),
  );
  // Numeric prerelease identifiers compare exactly at any magnitude.
  t.true(
    compareSemver(
      '1.0.0-100000000000000000001',
      '1.0.0-100000000000000000002',
    ) < 0,
  );
});

const identifier = fc.oneof(
  fc.nat({ max: 1000 }).map(String),
  fc.constantFrom('alpha', 'beta', 'dev', 'rc', 'x-1', '0a', 'a0'),
);
const semver = fc
  .tuple(
    fc.nat({ max: 3 }),
    fc.nat({ max: 3 }),
    fc.nat({ max: 3 }),
    fc.option(fc.array(identifier, { minLength: 1, maxLength: 4 })),
  )
  .map(
    ([major, minor, patch, prerelease]) =>
      `${major}.${minor}.${patch}${prerelease ? `-${prerelease.join('.')}` : ''}`,
  );

test('compareSemver is a total order', t => {
  fc.assert(
    fc.property(semver, semver, semver, (a, b, c) => {
      const sign = (/** @type {number} */ n) => Math.sign(n) + 0;
      t.is(sign(compareSemver(a, a)), 0);
      t.is(sign(compareSemver(a, b)), sign(-compareSemver(b, a)));
      t.is(compareSemver(a, b) === 0, a === b);
      if (compareSemver(a, b) <= 0 && compareSemver(b, c) <= 0) {
        t.true(compareSemver(a, c) <= 0, `${a} <= ${b} <= ${c}`);
      }
    }),
  );
});

test('package names round-trip through their URL encoding', t => {
  const segment = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,40}$/u);
  const name = fc.oneof(
    segment,
    fc.tuple(segment, segment).map(([scope, leaf]) => `@${scope}/${leaf}`),
  );
  fc.assert(
    fc.property(name, candidate => {
      t.is(canonicalizePackageName(encodePackageName(candidate)), candidate);
    }),
  );
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
