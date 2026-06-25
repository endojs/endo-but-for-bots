// @ts-nocheck
// Phase 7 of the auxiliary-`package.json` design: the layered
// language-for-extension overrides collected for the entry compartment are
// honored at parse time, so a `.js` file under a `{"type": "module"}`
// auxiliary actually parses as an ECMAScript module (and the inverse for a
// `{"type": "commonjs"}` auxiliary nested inside it).
//
// See `designs/compartment-mapper-auxiliary-package-json.md`.
import 'ses';
import fs from 'fs';
import url from 'url';
import test from 'ava';
import { makeReadPowers } from '../src/node-powers.js';
import { mapNodeModules } from '../src/node-modules.js';
import { loadLocation } from '../src/import.js';

const readPowers = makeReadPowers({ fs, url });
const { read } = readPowers;

const nestedPkgUrl = path =>
  new URL(`fixtures-nested-pkg/node_modules/${path}`, import.meta.url).href;

const auxiliaryNestedUrl = path =>
  new URL(`fixtures-auxiliary-nested/node_modules/${path}`, import.meta.url)
    .href;

test('entry compartment carries languageForExtensionByPrefix scoping `.js` to mjs under a type:module auxiliary', async t => {
  const entry = nestedPkgUrl('apackage/afolder/file.js');
  const compartmentMap = await mapNodeModules(readPowers, entry);

  const entryCompartment =
    compartmentMap.compartments[compartmentMap.entry.compartment];
  t.is(entryCompartment.name, 'apackage');

  const { languageForExtensionByPrefix } = entryCompartment;
  t.truthy(
    languageForExtensionByPrefix,
    'the entry compartment should carry layered overrides',
  );
  // Shortest prefix first: the compartment root, then the `afolder/`
  // auxiliary.
  t.is(languageForExtensionByPrefix.length, 2);
  t.is(languageForExtensionByPrefix[0].prefix, '');
  // The named `apackage` has no `type`, so `.js` defaults to CommonJS at the
  // compartment root.
  t.is(languageForExtensionByPrefix[0].languageForExtension.js, 'cjs');
  // The `afolder/` auxiliary is `{"type": "module"}`, so `.js` is ECMAScript
  // there.
  t.is(languageForExtensionByPrefix[1].prefix, 'afolder/');
  t.is(languageForExtensionByPrefix[1].languageForExtension.js, 'mjs');
});

test('a `.js` entry under a type:module auxiliary actually imports as an ECMAScript module', async t => {
  // `apackage/afolder/file.js` is `export const isOk = 1;` — invalid as
  // CommonJS. Before Phase 7 the entry compartment parsed `.js` as CommonJS
  // (apackage has no `type`); honoring the `afolder/` auxiliary flips it to
  // mjs so the module loads.
  const entry = nestedPkgUrl('apackage/afolder/file.js');
  const application = await loadLocation(read, entry);
  const { namespace } = await application.import({});
  t.is(namespace.isOk, 1);
});

test('nested auxiliaries layer deepest-first: type:commonjs inside type:module', async t => {
  const entry = auxiliaryNestedUrl('rootpkg/sub1/sub2/x.js');
  const compartmentMap = await mapNodeModules(readPowers, entry);

  const entryCompartment =
    compartmentMap.compartments[compartmentMap.entry.compartment];
  t.is(entryCompartment.name, 'rootpkg');

  const { languageForExtensionByPrefix } = entryCompartment;
  t.truthy(languageForExtensionByPrefix);
  t.is(languageForExtensionByPrefix.length, 3);

  // Compartment root: `rootpkg` has no `type`, so `.js` is CommonJS.
  t.is(languageForExtensionByPrefix[0].prefix, '');
  t.is(languageForExtensionByPrefix[0].languageForExtension.js, 'cjs');

  // `sub1/` is `{"type": "module"}` — `.js` becomes ECMAScript there.
  t.is(languageForExtensionByPrefix[1].prefix, 'sub1/');
  t.is(languageForExtensionByPrefix[1].languageForExtension.js, 'mjs');

  // `sub1/sub2/` is `{"type": "commonjs"}` — the deeper auxiliary wins, so
  // `.js` is CommonJS again within that subtree.
  t.is(languageForExtensionByPrefix[2].prefix, 'sub1/sub2/');
  t.is(languageForExtensionByPrefix[2].languageForExtension.js, 'cjs');
});

test('a compartment without auxiliary descriptors carries no languageForExtensionByPrefix (flat path unchanged)', async t => {
  // The entry sits directly in the named `app` package with no auxiliary
  // `package.json` on the path, so the override list is absent and the
  // compartment uses its flat `parsers` exactly as before.
  const entry = nestedPkgUrl('app/index.js');
  const compartmentMap = await mapNodeModules(readPowers, entry);

  const entryCompartment =
    compartmentMap.compartments[compartmentMap.entry.compartment];
  t.is(entryCompartment.name, 'app');
  t.is(entryCompartment.languageForExtensionByPrefix, undefined);
});
