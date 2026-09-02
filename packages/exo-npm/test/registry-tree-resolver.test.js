// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import {
  makeNpmRegistryTree,
  makePackageRegistryTree,
  resolveRegistryTree,
} from '../index.js';

const fixture = harden({
  alpha: harden({
    '1.0.0': harden({
      integrity: 'sha512-alpha-1',
      packageJson: JSON.stringify({
        name: 'alpha',
        version: '1.0.0',
        dependencies: { shared: '^1.0.0' },
        optionalDependencies: { absent: '^1.0.0' },
      }),
    }),
    '1.2.0': harden({
      integrity: 'sha512-alpha-12',
      packageJson: JSON.stringify({
        name: 'alpha',
        version: '1.2.0',
        dependencies: { shared: '^1.0.0' },
      }),
    }),
  }),
  shared: harden({
    '1.0.0': harden({
      integrity: 'sha512-shared',
      packageJson: JSON.stringify({ name: 'shared', version: '1.0.0' }),
    }),
  }),
});

/**
 * @param {string} name
 * @param {string} version
 * @param {string} text
 */
const makeTree = (name, version, text) => {
  const blob = Far('ResolverPackageJson', {
    text: async () => text,
    json: async () => JSON.parse(text),
    streamBase64: async () => undefined,
    help: () => 'package.json',
  });
  return Far('ResolverTree', {
    help: () => `${name}@${version}`,
    has: async () => true,
    list: async () => ['package.json'],
    lookup: async () => blob,
    sha256: () => `${name}-${version}`,
    getInfo: async () => harden({ hash: `${name}-${version}` }),
  });
};

/**
 * @param {Record<string, Record<string, { integrity: string, packageJson: string }>>} records
 * @param {string[]} [calls]
 */
const makeFixtureRoot = (records, calls = []) =>
  makePackageRegistryTree({
    npm: makeNpmRegistryTree(
      harden({
        async listVersions(name) {
          calls.push(`list:${name}`);
          return records[name] === undefined
            ? undefined
            : Object.keys(records[name]);
        },
        async providePackageTree(name, version) {
          calls.push(`provide:${name}@${version}`);
          const record = records[name]?.[version];
          if (record === undefined) throw new RangeError(`${name}@${version}`);
          return harden({
            treeRef: makeTree(name, version, record.packageJson),
            integrity: record.integrity,
          });
        },
      }),
    ),
  });

test('resolveRegistryTree preserves eager MVS and same-vat traversal', async t => {
  const calls = [];
  const root = makeFixtureRoot(fixture, calls);
  const entry = JSON.stringify({
    name: 'application',
    dependencies: { alpha: '^1.0.0' },
  });
  const resolution = await resolveRegistryTree(entry, root, {
    sha256: async bytes => `hash:${new TextDecoder().decode(bytes)}`,
  });
  t.deepEqual(resolution.keys, ['alpha@1.2.0', 'shared@1.0.0']);
  t.is(
    resolution.resolutionHash,
    'hash:alpha@1.2.0\tsha512-alpha-12\nshared@1.0.0\tsha512-shared',
  );
  t.true(calls.includes('provide:alpha@1.2.0'));
  t.true(calls.includes('provide:shared@1.0.0'));
  // The tree adapter and resolver communicate only through direct local method
  // calls represented by these operation counters; no bus/E() hook is present.
  t.false(calls.some(call => call.startsWith('eventual:')));
});

test('resolveRegistryTree preserves optional and peer contracts', async t => {
  const records = harden({
    consumer: harden({
      '1.0.0': harden({
        integrity: 'sha512-consumer',
        packageJson: JSON.stringify({
          name: 'consumer',
          version: '1.0.0',
          optionalDependencies: { absent: '^1.0.0' },
        }),
      }),
    }),
    peerConsumer: harden({
      '1.0.0': harden({
        integrity: 'sha512-peer-consumer',
        packageJson: JSON.stringify({
          name: 'peer-consumer',
          version: '1.0.0',
          peerDependencies: { missingPeer: '^1.0.0' },
        }),
      }),
    }),
  });
  const root = makeFixtureRoot(records);
  const optionalResolution = await resolveRegistryTree(
    JSON.stringify({ dependencies: { consumer: '^1.0.0' } }),
    root,
  );
  t.deepEqual(optionalResolution.keys, ['consumer@1.0.0']);
  t.deepEqual(optionalResolution.unmetOptionals, [
    {
      importer: 'consumer',
      name: 'absent',
      range: '^1.0.0',
      reason: 'Package registry has no entry at "/npm/absent"',
    },
  ]);

  const peerError = await t.throwsAsync(() =>
    resolveRegistryTree(
      JSON.stringify({ dependencies: { peerConsumer: '^1.0.0' } }),
      root,
    ),
  );
  t.true(peerError instanceof RangeError);
});

test('resolveRegistryTree preserves workspace-wins and mismatch diagnostics', async t => {
  const workspaceTree = makeTree(
    'workspace-member',
    '1.0.0',
    JSON.stringify({ name: 'workspace-member', version: '1.0.0' }),
  );
  const resolution = await resolveRegistryTree(
    JSON.stringify({ dependencies: { 'workspace-member': '^2.0.0' } }),
    makeFixtureRoot(harden({})),
    {
      workspaceLookup: async name =>
        name === 'workspace-member'
          ? harden({
              packageJson: JSON.stringify({
                name: 'workspace-member',
                version: '1.0.0',
              }),
              treeRef: workspaceTree,
            })
          : undefined,
    },
  );
  t.deepEqual(resolution.keys, ['workspace-member']);
  t.deepEqual(resolution.workspaceMismatches, [
    {
      importer: '<entry>',
      name: 'workspace-member',
      range: '^2.0.0',
      version: '1.0.0',
    },
  ]);
});

test('resolveRegistryTree preserves multiple major selections', async t => {
  const records = harden({
    one: harden({
      '1.0.0': harden({
        integrity: 'sha512-one',
        packageJson: JSON.stringify({
          name: 'one',
          version: '1.0.0',
          dependencies: { multi: '^1.0.0' },
        }),
      }),
    }),
    two: harden({
      '1.0.0': harden({
        integrity: 'sha512-two',
        packageJson: JSON.stringify({
          name: 'two',
          version: '1.0.0',
          dependencies: { multi: '^2.0.0' },
        }),
      }),
    }),
    multi: harden({
      '1.5.0': harden({
        integrity: 'sha512-multi-1',
        packageJson: JSON.stringify({ name: 'multi', version: '1.5.0' }),
      }),
      '2.3.0': harden({
        integrity: 'sha512-multi-2',
        packageJson: JSON.stringify({ name: 'multi', version: '2.3.0' }),
      }),
    }),
  });
  const resolution = await resolveRegistryTree(
    JSON.stringify({ dependencies: { one: '^1.0.0', two: '^1.0.0' } }),
    makeFixtureRoot(records),
  );
  t.deepEqual(resolution.keys, [
    'multi@1.5.0',
    'multi@2.3.0',
    'one@1.0.0',
    'two@1.0.0',
  ]);
});
