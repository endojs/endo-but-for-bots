// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import {
  RegistryMissingPackageError,
  RegistryOfflineError,
  encodePackageJson,
  makeMemoryRegistryPackageSource,
  makeRegistryResolver,
} from '../src/registry.js';

const packageJson = (name, version, fields = {}) =>
  harden({ name, version, ...fields });

const makeResolver = packages =>
  makeRegistryResolver(makeMemoryRegistryPackageSource(packages));

test('MVS widens a package to the greatest mentioned minor in a major', async t => {
  const resolver = makeResolver({
    a: {
      '1.0.0': packageJson('a', '1.0.0'),
      '1.2.0': packageJson('a', '1.2.0'),
      '1.3.0': packageJson('a', '1.3.0'),
    },
    b: {
      '1.0.0': packageJson('b', '1.0.0', {
        dependencies: { a: '^1.2.0' },
      }),
    },
  });

  const resolution = await resolver.resolve(
    encodePackageJson(
      packageJson('entry', '1.0.0', {
        dependencies: { a: '^1.0.0', b: '^1.0.0' },
      }),
    ),
  );

  t.deepEqual(resolution.keys, ['a@1.3.0', 'b@1.0.0']);
  t.is(resolution.packagesByKey['a@1.3.0'].version, '1.3.0');
  t.regex(resolution.resolutionHash, /^sha256-[0-9a-f]{64}$/);
});

test('MVS keeps incompatible majors under distinct RegistryResolution keys', async t => {
  const resolver = makeResolver({
    a: {
      '1.0.0': packageJson('a', '1.0.0'),
      '1.5.0': packageJson('a', '1.5.0'),
      '2.0.0': packageJson('a', '2.0.0'),
      '2.3.0': packageJson('a', '2.3.0'),
    },
    b: {
      '1.0.0': packageJson('b', '1.0.0', {
        dependencies: { a: '^2.0.0' },
      }),
    },
  });

  const resolution = await resolver.resolve(
    packageJson('entry', '1.0.0', {
      dependencies: { a: '^1.0.0', b: '^1.0.0' },
    }),
  );

  t.deepEqual(resolution.keys, ['a@1.5.0', 'a@2.3.0', 'b@1.0.0']);
});

test('offline mode resolves from the cached package table', async t => {
  const resolver = makeResolver({
    a: {
      '1.0.0': packageJson('a', '1.0.0'),
    },
  });

  const resolution = await resolver.resolve(
    packageJson('entry', '1.0.0', { dependencies: { a: '^1.0.0' } }),
    { offline: true },
  );

  t.deepEqual(resolution.keys, ['a@1.0.0']);
});

test('offline mode reports RegistryOfflineError on a cache miss', async t => {
  const source = makeMemoryRegistryPackageSource(
    {
      a: {
        '1.0.0': packageJson('a', '1.0.0'),
      },
    },
    { offlineNames: ['a'] },
  );
  const resolver = makeRegistryResolver(source);

  await t.throwsAsync(
    () =>
      resolver.resolve(
        packageJson('entry', '1.0.0', { dependencies: { a: '^1.0.0' } }),
        { offline: true },
      ),
    { instanceOf: RegistryOfflineError },
  );
});

test('workspace dependencies resolve to versionless workspace keys', async t => {
  const resolver = makeResolver({});

  const resolution = await resolver.resolve(
    packageJson('lib-a', '1.0.0', {
      dependencies: { 'lib-b': 'workspace:^' },
    }),
    {
      workspaceRoot: {
        packages: {
          'lib-b': packageJson('lib-b', '1.5.0'),
        },
      },
    },
  );

  t.deepEqual(resolution.keys, ['lib-b']);
  t.true(resolution.packagesByKey['lib-b'].workspace);
  t.is(resolution.packagesByKey['lib-b'].version, '1.5.0');
  t.deepEqual(resolution.diagnostics.workspaceVersionMismatches, []);
});

test('workspace version mismatch is diagnostic, not fatal', async t => {
  const resolver = makeResolver({});

  const resolution = await resolver.resolve(
    packageJson('lib-a', '1.0.0', {
      dependencies: { 'lib-b': '^2.0.0' },
    }),
    {
      workspaceRoot: {
        packages: {
          'lib-b': packageJson('lib-b', '1.0.0'),
        },
      },
    },
  );

  t.deepEqual(resolution.keys, ['lib-b']);
  t.like(resolution.diagnostics.workspaceVersionMismatches[0], {
    importer: 'lib-a',
    name: 'lib-b',
    range: '^2.0.0',
  });
});

test('satisfied peerDependencies pass the post-walk check', async t => {
  const resolver = makeResolver({
    'pkg-a': {
      '1.0.0': packageJson('pkg-a', '1.0.0', {
        peerDependencies: { react: '^18.0.0' },
      }),
    },
    react: {
      '18.2.0': packageJson('react', '18.2.0'),
    },
  });

  const resolution = await resolver.resolve(
    packageJson('entry', '1.0.0', {
      dependencies: { 'pkg-a': '^1.0.0', react: '^18.0.0' },
    }),
  );

  t.deepEqual(resolution.keys, ['pkg-a@1.0.0', 'react@18.2.0']);
});

test('unmet peerDependencies reject with RegistryMissingPackageError', async t => {
  const resolver = makeResolver({
    'pkg-a': {
      '1.0.0': packageJson('pkg-a', '1.0.0', {
        peerDependencies: { react: '^18.0.0' },
      }),
    },
    react: {
      '18.2.0': packageJson('react', '18.2.0'),
    },
  });

  await t.throwsAsync(
    () =>
      resolver.resolve(
        packageJson('entry', '1.0.0', {
          dependencies: { 'pkg-a': '^1.0.0' },
        }),
      ),
    {
      instanceOf: RegistryMissingPackageError,
      message: /pkg-a.*react/,
    },
  );
});

test('missing optionalDependencies are carried as diagnostics', async t => {
  const resolver = makeResolver({});

  const resolution = await resolver.resolve(
    packageJson('entry', '1.0.0', {
      optionalDependencies: { fsevents: '^2.0.0' },
    }),
  );

  t.deepEqual(resolution.keys, []);
  t.like(resolution.diagnostics.unmetOptionals[0], {
    importer: 'entry',
    name: 'fsevents',
    range: '^2.0.0',
  });
});
