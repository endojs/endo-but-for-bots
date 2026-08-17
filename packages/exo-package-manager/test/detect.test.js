// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import { fc } from '@fast-check/ava';

import {
  hasFrozenLockfile,
  FROZEN_LOCKFILES,
  MANAGER_MARKERS,
  managersFromMarkers,
  parsePackageManagerField,
  selectManager,
} from '@endo/exo-package-manager';

import {
  getPackageManagerErrorCode,
  getPackageManagerErrorDetails,
} from '../src/errors.js';

const EXPECTED_MANAGER_MARKERS = harden({
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  yarn: ['yarn.lock', '.yarnrc.yml', '.pnp.cjs'],
});

const EXPECTED_FROZEN_LOCKFILES = harden({
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
});

const EXPECTED_ALL_MARKERS = harden(
  Object.values(EXPECTED_MANAGER_MARKERS).flat(),
);

test('parsePackageManagerField accepts Corepack name@version', t => {
  t.deepEqual(parsePackageManagerField('pnpm@9.15.0'), {
    manager: 'pnpm',
    version: '9.15.0',
  });
  t.deepEqual(parsePackageManagerField('yarn@4.6.0'), {
    manager: 'yarn',
    version: '4.6.0',
  });
  t.is(parsePackageManagerField('npm'), undefined);
  t.is(parsePackageManagerField('npm@'), undefined);
  t.is(parsePackageManagerField('yarn@latest'), undefined);
  t.is(parsePackageManagerField('bun@1.0.0'), undefined);
  t.is(parsePackageManagerField(undefined), undefined);
  t.deepEqual(parsePackageManagerField('npm@0.0.0-alpha.1+build.7'), {
    manager: 'npm',
    version: '0.0.0-alpha.1+build.7',
  });
  for (const malformed of [
    'npm@01.2.3',
    'npm@1.2.3-01',
    'npm@1.2.3-.',
    'npm@1.2.3-a..b',
    'npm@1.2.3+build..1',
  ]) {
    t.is(parsePackageManagerField(malformed), undefined);
  }
});

test('managersFromMarkers maps manager-marker families', t => {
  t.deepEqual(MANAGER_MARKERS, EXPECTED_MANAGER_MARKERS);
  t.deepEqual(FROZEN_LOCKFILES, EXPECTED_FROZEN_LOCKFILES);
  t.deepEqual(managersFromMarkers(['package-lock.json']), ['npm']);
  t.deepEqual(managersFromMarkers(['pnpm-lock.yaml']), ['pnpm']);
  t.deepEqual(managersFromMarkers(['yarn.lock', '.yarnrc.yml']), ['yarn']);
  t.deepEqual(
    managersFromMarkers({
      'package-lock.json': true,
      'pnpm-lock.yaml': true,
    }),
    ['npm', 'pnpm'],
  );
  t.true(Object.isFrozen(managersFromMarkers(['package-lock.json'])));
  for (const [manager, markers] of Object.entries(EXPECTED_MANAGER_MARKERS)) {
    for (const marker of markers) {
      t.deepEqual(managersFromMarkers([marker]), [manager]);
    }
  }
  for (const [manager, lockfiles] of Object.entries(
    EXPECTED_FROZEN_LOCKFILES,
  )) {
    for (const lockfile of lockfiles) {
      t.true(hasFrozenLockfile(/** @type {any} */ (manager), [lockfile]));
    }
  }
});

test('selectManager rejects malformed and unsupported packageManager fields', t => {
  for (const packageManagerField of [
    'npm',
    'npm@',
    'yarn@latest',
    'bun@1.0.0',
  ]) {
    const err = t.throws(() =>
      selectManager({ packageManagerField, markers: [] }),
    );
    t.is(getPackageManagerErrorCode(err), 'manager-mismatch');
  }
});

test('selectManager prefers explicit then manifest then lockfile', t => {
  t.like(
    selectManager({
      explicit: 'npm',
      markers: ['package-lock.json'],
    }),
    { manager: 'npm', source: 'explicit' },
  );
  t.like(
    selectManager({
      packageManagerField: 'pnpm@9.0.0',
      markers: ['pnpm-lock.yaml'],
    }),
    { manager: 'pnpm', source: 'manifest', versionRequest: '9.0.0' },
  );
  t.like(selectManager({ markers: ['yarn.lock'] }), {
    manager: 'yarn',
    source: 'marker',
  });
  t.like(selectManager({ defaultManager: 'npm' }), {
    manager: 'npm',
    source: 'default',
  });
});

test('selectManager throws manager-undetected without evidence', t => {
  const err = t.throws(() => selectManager({ markers: [] }));
  t.is(getPackageManagerErrorCode(err), 'manager-undetected');
  t.regex(/** @type {Error} */ (err).message, /manager-undetected/);
});

test('selectManager throws manager-ambiguous for multi-lockfile auto', t => {
  const err = t.throws(() =>
    selectManager({
      markers: ['package-lock.json', 'yarn.lock'],
    }),
  );
  t.is(getPackageManagerErrorCode(err), 'manager-ambiguous');
  t.deepEqual(getPackageManagerErrorDetails(err)?.candidates, ['npm', 'yarn']);
});

test('selectManager throws manager-mismatch for explicit vs lockfile', t => {
  const err = t.throws(() =>
    selectManager({
      explicit: 'npm',
      markers: ['pnpm-lock.yaml'],
    }),
  );
  t.is(getPackageManagerErrorCode(err), 'manager-mismatch');
});

test('selectManager throws manager-mismatch for explicit vs multi-lockfile', t => {
  const err = t.throws(() =>
    selectManager({
      explicit: 'npm',
      markers: ['package-lock.json', 'pnpm-lock.yaml'],
    }),
  );
  t.is(getPackageManagerErrorCode(err), 'manager-mismatch');
});

test('selectManager throws manager-mismatch for manifest vs lockfile', t => {
  const err = t.throws(() =>
    selectManager({
      packageManagerField: 'yarn@1.22.0',
      markers: ['package-lock.json'],
    }),
  );
  t.is(getPackageManagerErrorCode(err), 'manager-mismatch');
});

test('selectManager throws manager-mismatch for explicit vs packageManager', t => {
  const err = t.throws(() =>
    selectManager({
      explicit: 'npm',
      packageManagerField: 'pnpm@9.0.0',
      markers: ['package-lock.json'],
    }),
  );
  t.is(getPackageManagerErrorCode(err), 'manager-mismatch');
});

test('selectManager respects allowedManagers policy', t => {
  const err = t.throws(() =>
    selectManager({
      explicit: 'npm',
      markers: ['package-lock.json'],
      allowedManagers: ['pnpm'],
    }),
  );
  t.is(getPackageManagerErrorCode(err), 'manager-mismatch');
});

test('selectManager matches an independent evidence-matrix oracle', t => {
  const managerArb = fc.constantFrom('npm', 'pnpm', 'yarn');

  /**
   * @param {object} input
   * @param {'auto' | 'npm' | 'pnpm' | 'yarn'} input.explicit
   * @param {string | undefined} input.packageManagerField
   * @param {readonly string[]} input.markers
   * @param {readonly ('npm' | 'pnpm' | 'yarn')[] | undefined} input.allowedManagers
   * @param {'npm' | 'pnpm' | 'yarn' | undefined} input.defaultManager
   */
  const reference = ({
    explicit,
    packageManagerField,
    markers,
    allowedManagers,
    defaultManager,
  }) => {
    const markerManagers = /** @type {('npm' | 'pnpm' | 'yarn')[]} */ (
      Object.entries(EXPECTED_MANAGER_MARKERS)
        .filter(([, names]) => names.some(name => markers.includes(name)))
        .map(([manager]) => manager)
    );
    const manifest =
      packageManagerField === undefined
        ? undefined
        : /** @type {'npm' | 'pnpm' | 'yarn'} */ (
            packageManagerField.slice(0, packageManagerField.indexOf('@'))
          );
    if (markerManagers.length > 1) {
      return {
        error:
          explicit === 'auto' && manifest === undefined
            ? 'manager-ambiguous'
            : 'manager-mismatch',
      };
    }

    let manager;
    let source;
    if (explicit !== 'auto') {
      if (
        (manifest !== undefined && manifest !== explicit) ||
        (markerManagers.length === 1 && markerManagers[0] !== explicit)
      ) {
        return { error: 'manager-mismatch' };
      }
      manager = explicit;
      source = 'explicit';
    } else if (manifest !== undefined) {
      if (markerManagers.length === 1 && markerManagers[0] !== manifest) {
        return { error: 'manager-mismatch' };
      }
      manager = manifest;
      source = 'manifest';
    } else if (markerManagers.length === 1) {
      [manager] = markerManagers;
      source = 'marker';
    } else if (defaultManager !== undefined) {
      manager = defaultManager;
      source = 'default';
    } else {
      return { error: 'manager-undetected' };
    }
    if (allowedManagers !== undefined && !allowedManagers.includes(manager)) {
      return { error: 'manager-mismatch' };
    }
    return { manager, source };
  };

  fc.assert(
    fc.property(
      fc.record({
        explicit: fc.constantFrom('auto', 'npm', 'pnpm', 'yarn'),
        packageManagerField: fc.option(
          managerArb.map(manager => `${manager}@1.2.3`),
          { nil: undefined },
        ),
        markers: fc.array(fc.constantFrom(...EXPECTED_ALL_MARKERS), {
          maxLength: 5,
        }),
        allowedManagers: fc.option(fc.array(managerArb, { maxLength: 3 }), {
          nil: undefined,
        }),
        defaultManager: fc.option(managerArb, { nil: undefined }),
      }),
      input => {
        const expected = reference(input);
        try {
          const actual = selectManager(input);
          return (
            expected.error === undefined &&
            actual.manager === expected.manager &&
            actual.source === expected.source
          );
        } catch (error) {
          return getPackageManagerErrorCode(error) === expected.error;
        }
      },
    ),
  );
  t.pass();
});

test('hasFrozenLockfile distinguishes install lockfiles from workspace markers', t => {
  t.true(hasFrozenLockfile('npm', ['package-lock.json']));
  t.true(hasFrozenLockfile('pnpm', ['pnpm-lock.yaml']));
  t.false(hasFrozenLockfile('pnpm', ['pnpm-workspace.yaml']));
  t.true(hasFrozenLockfile('yarn', ['yarn.lock']));
  t.false(hasFrozenLockfile('yarn', ['.yarnrc.yml']));
});
