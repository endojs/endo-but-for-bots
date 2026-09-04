// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { decodeUtf8 } from '@endo/utf8/decode.js';

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
    sha256: async bytes => `hash:${decodeUtf8(bytes)}`,
  });
  t.deepEqual(resolution.keys, ['alpha@1.2.0', 'shared@1.0.0']);
  // The preimage is the shared injective `JSON.stringify([[key, integrity]...])`
  // encoding (registry keys/integrity may contain `\t`/`\n`, so the former
  // tab/newline join collided distinct closures onto one cache key).
  t.is(
    resolution.resolutionHash,
    'hash:[["alpha@1.2.0","sha512-alpha-12"],["shared@1.0.0","sha512-shared"]]',
  );
  t.true(calls.includes('provide:alpha@1.2.0'));
  t.true(calls.includes('provide:shared@1.0.0'));
  // The tree adapter and resolver communicate only through direct local method
  // calls — no bus/E() hook is present, so no `eventual:` marker can appear —
  // and every op is a plain `list:`/`provide:` same-vat call, never a
  // per-dependency bus round trip. Each selected version leaf is materialized
  // exactly once (no per-lookup refetch), the concrete zero-round-trip bound.
  t.false(calls.some(call => call.startsWith('eventual:')));
  t.true(
    calls.every(
      call => call.startsWith('list:') || call.startsWith('provide:'),
    ),
  );
  t.is(calls.filter(call => call === 'provide:alpha@1.2.0').length, 1);
  t.is(calls.filter(call => call === 'provide:shared@1.0.0').length, 1);
});

test('resolutionHash is injective across tab/newline-bearing registry keys', async t => {
  // A single package named `a` at a version string that embeds the tab/newline
  // the old preimage delimited on must NOT hash-collide with the two-package
  // closure it textually imitates — a colliding content-addressed cache key
  // would substitute one closure's trees for another's.
  const sha256 = async bytes => `hash:${decodeUtf8(bytes)}`;
  const single = harden({
    a: harden({
      '1.0.0\tI1\nb@1.0.0': harden({
        integrity: 'I2',
        packageJson: JSON.stringify({
          name: 'a',
          version: '1.0.0\tI1\nb@1.0.0',
        }),
      }),
    }),
  });
  const singleRoot = makeFixtureRoot(single);
  const singleResolution = await resolveRegistryTree(
    JSON.stringify({ name: 'app', dependencies: { a: '*' } }),
    singleRoot,
    { sha256 },
  );
  const twoPackages = harden({
    a: harden({
      '1.0.0': harden({
        integrity: 'I1',
        packageJson: JSON.stringify({
          name: 'a',
          version: '1.0.0',
          dependencies: { b: '1.0.0' },
        }),
      }),
    }),
    b: harden({
      '1.0.0': harden({
        integrity: 'I2',
        packageJson: JSON.stringify({ name: 'b', version: '1.0.0' }),
      }),
    }),
  });
  const twoRoot = makeFixtureRoot(twoPackages);
  const twoResolution = await resolveRegistryTree(
    JSON.stringify({ name: 'app', dependencies: { a: '*' } }),
    twoRoot,
    { sha256 },
  );
  t.not(singleResolution.resolutionHash, twoResolution.resolutionHash);
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

test('resolveRegistryTree upgrades an earlier selection within one major', async t => {
  // Two importers require the same package at overlapping ranges in the same
  // major slot: the first pins the low exact version, the second demands a
  // higher one. Eager MVS must upgrade the earlier selection to the greater.
  // A "never upgrade once selected" regression leaves shared@1.0.0.
  const records = harden({
    low: harden({
      '1.0.0': harden({
        integrity: 'sha512-low',
        packageJson: JSON.stringify({
          name: 'low',
          version: '1.0.0',
          dependencies: { shared: '1.0.0' },
        }),
      }),
    }),
    high: harden({
      '1.0.0': harden({
        integrity: 'sha512-high',
        packageJson: JSON.stringify({
          name: 'high',
          version: '1.0.0',
          dependencies: { shared: '^1.2.0' },
        }),
      }),
    }),
    shared: harden({
      '1.0.0': harden({
        integrity: 'sha512-shared-1',
        packageJson: JSON.stringify({ name: 'shared', version: '1.0.0' }),
      }),
      '1.2.0': harden({
        integrity: 'sha512-shared-12',
        packageJson: JSON.stringify({ name: 'shared', version: '1.2.0' }),
      }),
    }),
  });
  const resolution = await resolveRegistryTree(
    JSON.stringify({ dependencies: { low: '^1.0.0', high: '^1.0.0' } }),
    makeFixtureRoot(records),
  );
  t.deepEqual(resolution.keys, ['high@1.0.0', 'low@1.0.0', 'shared@1.2.0']);
});

test('resolveRegistryTree tolerates malformed dependency tables', async t => {
  // Registry-supplied package.json fields are third-party JSON: a null table
  // or a non-string range must be skipped, not crash resolution with a raw
  // TypeError outside the PackageRegistryError family.
  const records = harden({
    malformed: harden({
      '1.0.0': harden({
        integrity: 'sha512-malformed',
        packageJson: JSON.stringify({
          name: 'malformed',
          version: '1.0.0',
          dependencies: null,
          peerDependencies: { misdeclared: 5 },
          optionalDependencies: ['not', 'an', 'object'],
        }),
      }),
    }),
  });
  const resolution = await resolveRegistryTree(
    JSON.stringify({ dependencies: { malformed: '^1.0.0' } }),
    makeFixtureRoot(records),
  );
  t.deepEqual(resolution.keys, ['malformed@1.0.0']);
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
