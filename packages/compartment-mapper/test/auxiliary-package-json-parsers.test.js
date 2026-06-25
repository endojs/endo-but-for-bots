// @ts-nocheck
// Phase 7 of the auxiliary-`package.json` design, entry-path coverage: a `.js`
// file under a `{"type": "module"}` auxiliary on the entry module's own path
// actually parses as an ECMAScript module (and the inverse for a
// `{"type": "commonjs"}` auxiliary nested inside it).
//
// The unified mechanism is the lazy, per-module walk in the import hook (see
// `auxiliary-language.test.js`); it subsumes the earlier entry-only precompute,
// so the `languageForExtensionByPrefix` override list is populated at parse time
// on the live compartment descriptor rather than baked into the serialized map.
// These tests therefore assert the load-bearing behavior (the module actually
// loads in the language the auxiliary names) and, where they inspect the field,
// build the map and import through it so the import-hook walk has run.
//
// See `designs/compartment-mapper-auxiliary-package-json.md`.
import 'ses';
import fs from 'fs';
import url from 'url';
import test from 'ava';
import { makeReadPowers } from '../src/node-powers.js';
import { mapNodeModules } from '../src/node-modules.js';
import { loadLocation } from '../src/import.js';
import { loadFromMap } from '../src/import-lite.js';
import { defaultParserForLanguage } from '../src/import-parsers.js';

const readPowers = makeReadPowers({ fs, url });
const { read } = readPowers;

const nestedPkgUrl = path =>
  new URL(`fixtures-nested-pkg/node_modules/${path}`, import.meta.url).href;

const auxiliaryNestedUrl = path =>
  new URL(`fixtures-auxiliary-nested/node_modules/${path}`, import.meta.url)
    .href;

// Build the compartment map and import through it, so the lazy import-hook walk
// mutates the very descriptors we hold and we can inspect the
// `languageForExtensionByPrefix` field it populates.
const importThroughMap = async entry => {
  const compartmentMap = await mapNodeModules(readPowers, entry);
  const application = await loadFromMap(readPowers, compartmentMap, {
    parserForLanguage: defaultParserForLanguage,
  });
  const { namespace } = await application.import({});
  return { compartmentMap, namespace };
};

const prefixToJsOf = compartment =>
  Object.fromEntries(
    (compartment.languageForExtensionByPrefix || []).map(entry => [
      entry.prefix,
      entry.languageForExtension.js,
    ]),
  );

test('a `.js` entry under a type:module auxiliary actually imports as an ECMAScript module', async t => {
  // `apackage/afolder/file.js` is `export const isOk = 1;` — invalid as
  // CommonJS. `apackage` has no `type` (so `.js` defaults to CommonJS at its
  // root); honoring the `afolder/` `{"type": "module"}` auxiliary flips it to
  // mjs so the module loads.
  const entry = nestedPkgUrl('apackage/afolder/file.js');
  const application = await loadLocation(read, entry);
  const { namespace } = await application.import({});
  t.is(namespace.isOk, 1);
});

test('entry compartment records languageForExtensionByPrefix scoping `.js` to mjs under a type:module auxiliary', async t => {
  const entry = nestedPkgUrl('apackage/afolder/file.js');
  const { compartmentMap } = await importThroughMap(entry);

  const entryCompartment =
    compartmentMap.compartments[compartmentMap.entry.compartment];
  t.is(entryCompartment.name, 'apackage');

  // The lazy walk records the `afolder/` auxiliary (a `{"type": "module"}`
  // descriptor without a `name`); `.js` is ECMAScript within that subtree.
  const prefixToJs = prefixToJsOf(entryCompartment);
  t.is(prefixToJs['afolder/'], 'mjs');
});

test('nested auxiliaries layer deepest-first: type:commonjs inside type:module', async t => {
  // rootpkg (no `type`) → `sub1/` `{"type": "module"}` → `sub1/sub2/`
  // `{"type": "commonjs"}`. Each leaf is written in exactly one module system,
  // so a successful import is the load-bearing proof of which auxiliary won.

  // `sub1/sub2/x.js` uses `module.exports` (CommonJS): the deeper `sub2/`
  // commonjs auxiliary must win over the enclosing `sub1/` module auxiliary.
  {
    const application = await loadLocation(
      read,
      auxiliaryNestedUrl('rootpkg/sub1/sub2/x.js'),
    );
    const { namespace } = await application.import({});
    t.is(namespace.x, 'x-cjs');
  }
  // `sub1/y.js` uses `export` (ECMAScript): the `sub1/` module auxiliary
  // applies.
  {
    const application = await loadLocation(
      read,
      auxiliaryNestedUrl('rootpkg/sub1/y.js'),
    );
    const { namespace } = await application.import({});
    t.is(namespace.y, 'y-mjs');
  }
  // `z.js` at the compartment root uses `module.exports`: rootpkg has no
  // `type`, so `.js` defaults to CommonJS with no auxiliary in play.
  {
    const application = await loadLocation(
      read,
      auxiliaryNestedUrl('rootpkg/z.js'),
    );
    const { namespace } = await application.import({});
    t.is(namespace.z, 'z-cjs');
  }

  // The field the lazy walk records reflects the deepest-first layering.
  const { compartmentMap } = await importThroughMap(
    auxiliaryNestedUrl('rootpkg/sub1/sub2/x.js'),
  );
  const entryCompartment =
    compartmentMap.compartments[compartmentMap.entry.compartment];
  t.is(entryCompartment.name, 'rootpkg');
  const prefixToJs = prefixToJsOf(entryCompartment);
  t.is(prefixToJs['sub1/'], 'mjs');
  t.is(prefixToJs['sub1/sub2/'], 'cjs');
});

test('a compartment without auxiliary descriptors carries no languageForExtensionByPrefix; an auxiliary dependency subtree does', async t => {
  // `app` has no auxiliary `package.json` on its own path, so the lazy walk
  // never creates the override list for the entry compartment and the flat
  // `parsers` map applies unchanged. Its dependency `apackage`, reached only by
  // package export, does carry the `afolder/` override — the same lazy
  // mechanism, now serving a dependency compartment.
  const entry = nestedPkgUrl('app/index.js');
  const { compartmentMap } = await importThroughMap(entry);

  const entryCompartment =
    compartmentMap.compartments[compartmentMap.entry.compartment];
  t.is(entryCompartment.name, 'app');
  t.is(entryCompartment.languageForExtensionByPrefix, undefined);

  const apackageLocation = nestedPkgUrl('apackage/');
  const apackageCompartment = compartmentMap.compartments[apackageLocation];
  t.truthy(apackageCompartment, 'apackage dependency compartment exists');
  t.is(prefixToJsOf(apackageCompartment)['afolder/'], 'mjs');
});
