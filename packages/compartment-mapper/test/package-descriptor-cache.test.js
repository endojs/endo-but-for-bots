// @ts-nocheck
import 'ses';
import fs from 'fs';
import url from 'url';
import test from 'ava';
import { makePackageDescriptorCache } from '../src/package-descriptor-cache.js';
import { makeReadPowers } from '../src/node-powers.js';
import { mapNodeModules } from '../src/node-modules.js';

const readPowers = makeReadPowers({ fs, url });
const { maybeRead } = readPowers;

const fixtureUrl = path =>
  new URL(`fixtures-nested-pkg/node_modules/${path}`, import.meta.url).href;

test('findEnclosingCompartmentRoot walks past auxiliary descriptors to the named ancestor', async t => {
  const cache = makePackageDescriptorCache(maybeRead);
  const entry = fixtureUrl('apackage/afolder/file.js');
  const compartmentRoot = await cache.findEnclosingCompartmentRoot(entry);

  t.is(compartmentRoot.packageLocation, fixtureUrl('apackage/'));
  t.is(compartmentRoot.packageDescriptor.name, 'apackage');
  t.is(compartmentRoot.auxiliaryDescriptors.length, 1);
  t.is(
    compartmentRoot.auxiliaryDescriptors[0].location,
    fixtureUrl('apackage/afolder/'),
  );
  t.is(
    compartmentRoot.auxiliaryDescriptors[0].packageDescriptor.type,
    'module',
  );
  t.is(
    compartmentRoot.auxiliaryDescriptors[0].packageDescriptor.name,
    undefined,
  );
});

test('findEnclosingCompartmentRoot returns named root with no auxiliaries when the entry sits directly in the named package', async t => {
  const cache = makePackageDescriptorCache(maybeRead);
  const entry = fixtureUrl('app/index.js');
  const compartmentRoot = await cache.findEnclosingCompartmentRoot(entry);

  t.is(compartmentRoot.packageLocation, fixtureUrl('app/'));
  t.is(compartmentRoot.packageDescriptor.name, 'app');
  t.is(compartmentRoot.auxiliaryDescriptors.length, 0);
});

test('collectLanguageOverrides returns the layered descriptor list shallowest-first', async t => {
  const cache = makePackageDescriptorCache(maybeRead);
  const entry = fixtureUrl('apackage/afolder/file.js');
  const layered = await cache.collectLanguageOverrides(entry);

  t.is(layered.length, 2);
  // First element is the compartment-defining descriptor.
  t.is(layered[0].name, 'apackage');
  // Second element is the auxiliary that scopes `{"type": "module"}` to
  // `afolder/`.
  t.is(layered[1].name, undefined);
  t.is(layered[1].type, 'module');
});

const escapeRegex = /** @param {string} s */ s =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('mapNodeModules with packageDescriptorCache: entry inside auxiliary subtree resolves to enclosing named compartment', async t => {
  const cache = makePackageDescriptorCache(maybeRead);
  const entry = fixtureUrl('apackage/afolder/file.js');
  const compartmentMap = await mapNodeModules(readPowers, entry, {
    packageDescriptorCache: cache,
  });

  // The entry compartment is rooted at `apackage/`, not at the auxiliary
  // `apackage/afolder/`.
  t.is(compartmentMap.entry.compartment, fixtureUrl('apackage/'));
  t.is(compartmentMap.entry.module, './afolder/file.js');
  const entryCompartment =
    compartmentMap.compartments[compartmentMap.entry.compartment];
  t.truthy(entryCompartment);
  t.is(entryCompartment.name, 'apackage');
});

test('mapNodeModules without packageDescriptorCache: entry inside auxiliary subtree still triggers the PR 70 diagnostic', async t => {
  const entry = fixtureUrl('apackage/afolder/file.js');
  const descriptorLocation = fixtureUrl('apackage/afolder/package.json');
  await t.throwsAsync(mapNodeModules(readPowers, entry), {
    message: new RegExp(
      `package\\.json at "${escapeRegex(
        descriptorLocation,
      )}" must have a "name" field`,
    ),
  });
});

test('PackageDescriptorCache: no named ancestor at all throws the PR 70 diagnostic', async t => {
  // Synthetic filesystem: one auxiliary descriptor at /a/b/ and another
  // auxiliary at /a/, with no named ancestor anywhere. The walk reaches
  // the filesystem boundary and falls through to the PR 70 diagnostic.
  const encoder = new TextEncoder();
  /** @type {Record<string, string>} */
  const files = {
    'file:///a/package.json': '{"type":"module"}',
    'file:///a/b/package.json': '{"type":"commonjs"}',
  };
  /** @param {string} location */
  const syntheticMaybeRead = async location => {
    const body = files[location];
    if (body === undefined) return undefined;
    return encoder.encode(body);
  };
  const cache = makePackageDescriptorCache(syntheticMaybeRead);
  await t.throwsAsync(
    cache.findEnclosingCompartmentRoot('file:///a/b/entry.js'),
    {
      message: /must have a "name" field/,
    },
  );
});

test('PackageDescriptorCache: synthetic mixed named-and-auxiliary walk', async t => {
  // Synthetic filesystem: named root at /pkg/ with an auxiliary subtree
  // at /pkg/sub/ and another auxiliary at /pkg/sub/deeper/. The walk
  // returns /pkg/ as the compartment root with auxiliaries layered
  // shallow-first.
  const encoder = new TextEncoder();
  /** @type {Record<string, string>} */
  const files = {
    'file:///pkg/package.json': '{"name":"pkg"}',
    'file:///pkg/sub/package.json': '{"type":"module"}',
    'file:///pkg/sub/deeper/package.json': '{"type":"commonjs"}',
  };
  /** @param {string} location */
  const syntheticMaybeRead = async location => {
    const body = files[location];
    if (body === undefined) return undefined;
    return encoder.encode(body);
  };
  const cache = makePackageDescriptorCache(syntheticMaybeRead);
  const root = await cache.findEnclosingCompartmentRoot(
    'file:///pkg/sub/deeper/entry.js',
  );
  t.is(root.packageLocation, 'file:///pkg/');
  t.is(root.packageDescriptor.name, 'pkg');
  t.is(root.auxiliaryDescriptors.length, 2);
  // Shallow first: /pkg/sub/ before /pkg/sub/deeper/.
  t.is(root.auxiliaryDescriptors[0].location, 'file:///pkg/sub/');
  t.is(root.auxiliaryDescriptors[0].packageDescriptor.type, 'module');
  t.is(root.auxiliaryDescriptors[1].location, 'file:///pkg/sub/deeper/');
  t.is(root.auxiliaryDescriptors[1].packageDescriptor.type, 'commonjs');

  const layered = await cache.collectLanguageOverrides(
    'file:///pkg/sub/deeper/entry.js',
  );
  t.is(layered.length, 3);
  t.is(layered[0].name, 'pkg');
  t.is(layered[1].type, 'module');
  t.is(layered[2].type, 'commonjs');
});
