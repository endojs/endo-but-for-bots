// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import { fc } from '@fast-check/ava';

import { buildInstallArgv, buildRunArgv } from '@endo/exo-package-manager';

test('buildInstallArgv always disables npm lifecycle scripts', t => {
  t.deepEqual(buildInstallArgv({ manager: 'npm' }), [
    'npm',
    'ci',
    '--ignore-scripts',
  ]);
  t.deepEqual(
    buildInstallArgv({
      manager: 'npm',
      lockfileMode: 'update',
      offline: true,
      production: true,
    }),
    ['npm', 'install', '--ignore-scripts', '--offline', '--omit=dev'],
  );
});

test('buildInstallArgv pnpm frozen uses --frozen-lockfile', t => {
  t.deepEqual(buildInstallArgv({ manager: 'pnpm' }), [
    'pnpm',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
  ]);
  t.deepEqual(
    buildInstallArgv({
      manager: 'pnpm',
      lockfileMode: 'update',
      offline: true,
      production: true,
    }),
    ['pnpm', 'install', '--ignore-scripts', '--offline', '--prod'],
  );
});

test('buildInstallArgv yarn uses version-appropriate frozen flags', t => {
  t.deepEqual(buildInstallArgv({ manager: 'yarn', yarnMajorVersion: 1 }), [
    'yarn',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
  ]);
  t.deepEqual(buildInstallArgv({ manager: 'yarn', yarnMajorVersion: 4 }), [
    'yarn',
    'install',
    '--immutable',
    '--mode=skip-build',
  ]);
  t.deepEqual(
    buildInstallArgv({
      manager: 'yarn',
      yarnMajorVersion: 2,
      yarnMinorVersion: 4,
    }),
    ['yarn', 'install', '--immutable', '--skip-builds'],
  );
});

test('buildInstallArgv maps workspace selectors per manager', t => {
  t.deepEqual(
    buildInstallArgv({
      manager: 'npm',
      workspaceSelector: '@scope/pkg',
    }),
    ['npm', 'ci', '--ignore-scripts', '--workspace=@scope/pkg'],
  );
  t.deepEqual(
    buildInstallArgv({
      manager: 'pnpm',
      workspaceSelector: 'pkg',
    }),
    [
      'pnpm',
      '--filter=pkg',
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
    ],
  );
  t.deepEqual(
    buildInstallArgv({
      manager: 'yarn',
      yarnMajorVersion: 4,
      workspaceSelector: 'pkg',
    }),
    ['yarn', 'workspace', 'pkg', 'install', '--immutable', '--mode=skip-build'],
  );
});

test('buildInstallArgv fails closed for unsupported or unknown Yarn 2 versions', t => {
  for (const input of [
    { manager: 'yarn' },
    { manager: 'yarn', yarnMajorVersion: 2 },
    { manager: 'yarn', yarnMajorVersion: 2, yarnMinorVersion: 0 },
    { manager: 'yarn', yarnMajorVersion: 2, yarnMinorVersion: 3 },
  ]) {
    t.throws(() => buildInstallArgv(/** @type {any} */ (input)), {
      message: /yarnMajorVersion|Yarn 2 installs require/,
    });
  }
});

test('buildInstallArgv rejects Yarn Berry flags it cannot represent', t => {
  t.throws(
    () =>
      buildInstallArgv({
        manager: 'yarn',
        yarnMajorVersion: 4,
        offline: true,
      }),
    { message: /offline installs are not supported/ },
  );
  t.throws(
    () =>
      buildInstallArgv({
        manager: 'yarn',
        yarnMajorVersion: 4,
        production: true,
      }),
    { message: /production-only installs are not supported/ },
  );
});

test('buildRunArgv plain named scripts omit workspace flags', t => {
  t.deepEqual(
    buildRunArgv({ manager: 'npm', script: 'test', args: ['--watch'] }),
    ['npm', 'run', 'test', '--', '--watch'],
  );
  t.deepEqual(buildRunArgv({ manager: 'pnpm', script: 'lint' }), [
    'pnpm',
    'run',
    'lint',
  ]);
  t.deepEqual(buildRunArgv({ manager: 'yarn', script: 'build' }), [
    'yarn',
    'run',
    'build',
  ]);
});

test('buildRunArgv maps workspace selectors per manager only when set', t => {
  t.deepEqual(
    buildRunArgv({
      manager: 'npm',
      script: 'lint',
      workspaceSelector: '@scope/pkg',
    }),
    ['npm', 'run', 'lint', '--workspace=@scope/pkg'],
  );
  t.deepEqual(
    buildRunArgv({
      manager: 'pnpm',
      script: 'test',
      workspaceSelector: 'pkg',
      args: ['a'],
    }),
    ['pnpm', '--filter=pkg', 'run', 'test', '--', 'a'],
  );
  t.deepEqual(
    buildRunArgv({
      manager: 'yarn',
      script: 'build',
      workspaceSelector: 'pkg',
      args: ['--mode', 'production'],
    }),
    ['yarn', 'workspace', 'pkg', 'run', 'build', '--mode', 'production'],
  );
});

test('fixed argv builders reject invalid discriminants and option-like scripts', t => {
  t.throws(() => buildInstallArgv(/** @type {any} */ ({ manager: 'bun' })), {
    message: /manager.*must be one of/,
  });
  t.throws(
    () =>
      buildInstallArgv(
        /** @type {any} */ ({ manager: 'npm', lockfileMode: 'maybe' }),
      ),
    { message: /lockfileMode.*must be one of/ },
  );
  t.throws(() => buildRunArgv({ manager: 'npm', script: '--version' }), {
    message: /must not begin with "-"/,
  });
  t.throws(
    () =>
      buildRunArgv({
        manager: 'npm',
        script: 'test',
        args: /** @type {string[]} */ (Array(1)),
      }),
    { message: /dense array of strings/ },
  );
});

/**
 * Independent table-driven oracle for supported install records.
 *
 * @param {Parameters<typeof buildInstallArgv>[0]} input
 * @returns {readonly string[]}
 */
const referenceInstallArgv = input => {
  const {
    manager,
    lockfileMode = 'frozen',
    offline = false,
    production = false,
    yarnMajorVersion,
    yarnMinorVersion,
  } = input;
  if (manager === 'npm') {
    return [
      'npm',
      lockfileMode === 'frozen' ? 'ci' : 'install',
      '--ignore-scripts',
      ...(offline ? ['--offline'] : []),
      ...(production ? ['--omit=dev'] : []),
    ];
  }
  if (manager === 'pnpm') {
    return [
      'pnpm',
      'install',
      ...(lockfileMode === 'frozen' ? ['--frozen-lockfile'] : []),
      '--ignore-scripts',
      ...(offline ? ['--offline'] : []),
      ...(production ? ['--prod'] : []),
    ];
  }
  if (yarnMajorVersion === undefined || yarnMajorVersion < 1) {
    throw Error('unknown Yarn version');
  }
  if (
    yarnMajorVersion === 2 &&
    (yarnMinorVersion === undefined || yarnMinorVersion < 4)
  ) {
    throw Error('unsupported Yarn 2 version');
  }
  if (yarnMajorVersion > 1 && (offline || production)) {
    throw Error('unsupported Yarn Berry install option');
  }
  return [
    'yarn',
    'install',
    ...(lockfileMode === 'frozen'
      ? [yarnMajorVersion <= 1 ? '--frozen-lockfile' : '--immutable']
      : []),
    yarnMajorVersion <= 1
      ? '--ignore-scripts'
      : yarnMajorVersion === 2
        ? '--skip-builds'
        : '--mode=skip-build',
    ...(offline ? ['--offline'] : []),
    ...(production ? ['--production'] : []),
  ];
};

test('buildInstallArgv matches the independent option matrix', async t => {
  await fc.assert(
    fc.property(
      fc.record({
        manager: fc.constantFrom('npm', 'pnpm', 'yarn'),
        lockfileMode: fc.constantFrom('frozen', 'update'),
        offline: fc.boolean(),
        production: fc.boolean(),
        yarnMajorVersion: fc.integer({ min: 1, max: 8 }),
        yarnMinorVersion: fc.integer({ min: 0, max: 10 }),
      }),
      input => {
        try {
          t.deepEqual(buildInstallArgv(input), referenceInstallArgv(input));
        } catch (error) {
          t.throws(() => referenceInstallArgv(input));
          t.regex(
            /** @type {Error} */ (error).message,
            /Yarn 2 or later|Yarn 2 installs require/,
          );
        }
      },
    ),
  );
});

test('buildRunArgv preserves arbitrary argument elements', async t => {
  const safeScript = fc
    .string({ minLength: 1 })
    .filter(script => !script.startsWith('-'));
  await fc.assert(
    fc.property(
      fc.constantFrom('npm', 'pnpm', 'yarn'),
      safeScript,
      fc.array(fc.string()),
      (manager, script, args) => {
        const argv = buildRunArgv({ manager, script, args });
        if (args.length === 0) {
          t.false(argv.includes('--'));
        } else if (manager === 'yarn') {
          t.deepEqual(argv.slice(-args.length), args);
        } else {
          t.deepEqual(argv.slice(-(args.length + 1)), ['--', ...args]);
        }
      },
    ),
  );
});
