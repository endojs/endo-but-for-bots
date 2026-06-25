// @ts-nocheck
// Exercises the lazy, per-module half of the auxiliary `package.json` design
// (Phase 7): a `{"type": "module"}` or `{"type": "commonjs"}` descriptor
// without a `name` flips `.js` parsing within its subtree, for modules reached
// by relative import (not just package exports). See
// `designs/compartment-mapper-auxiliary-package-json.md`.
import 'ses';
import fs from 'fs';
import url from 'url';
import test from 'ava';
import { loadLocation } from '../src/import.js';
import { loadFromMap } from '../src/import-lite.js';
import { defaultParserForLanguage } from '../src/import-parsers.js';
import { mapNodeModules } from '../src/node-modules.js';
import { makeReadPowers } from '../src/node-powers.js';

const readPowers = makeReadPowers({ fs, url });
const { read } = readPowers;

const fixture = new URL(
  'fixtures-auxiliary-language/node_modules/app/index.js',
  import.meta.url,
).toString();

test('auxiliary package.json flips .js parsing per subtree for relatively-imported modules', async t => {
  const application = await loadLocation(read, fixture);
  const { namespace } = await application.import({});
  // The default export of `app` is `aux-pkg`'s aggregated result. If any
  // subtree were parsed with the wrong language the import would throw, so a
  // successful structured result is the load-bearing assertion.
  t.deepEqual(namespace.default, {
    // root .js parsed per aux-pkg's own `type: "module"`.
    rootMod: 'root-esm',
    // redundant `{"type":"module"}` auxiliary keeps .js as ECMAScript.
    esmSub: 'esm-sub',
    // `{"type":"commonjs"}` auxiliary parses .js as CommonJS.
    cjsLeaf: 'cjs-leaf',
    // a deeper directory with no package.json inherits the commonjs auxiliary.
    cjsDeep: 'cjs-deep',
    // a still-deeper `{"type":"module"}` auxiliary flips .js back to ECMAScript.
    esmAgain: 'esm-again',
  });
});

test('the entry compartment records languageForExtensionByPrefix for its auxiliary subtrees', async t => {
  // Build the map ourselves, then import through it so the import hook mutates
  // the very descriptor we hold, letting us inspect the field it populates.
  const compartmentMap = await mapNodeModules(readPowers, fixture);
  const auxPackageLocation = new URL(
    'fixtures-auxiliary-language/node_modules/aux-pkg/',
    import.meta.url,
  ).toString();
  const auxCompartment = compartmentMap.compartments[auxPackageLocation];
  t.truthy(auxCompartment, 'aux-pkg compartment exists');

  const application = await loadFromMap(readPowers, compartmentMap, {
    parserForLanguage: defaultParserForLanguage,
  });
  await application.import({});

  const byPrefix = auxCompartment.languageForExtensionByPrefix || [];
  const prefixToJs = Object.fromEntries(
    byPrefix.map(entry => [entry.prefix, entry.languageForExtension.js]),
  );
  // Shortest-first ordering invariant.
  const prefixLengths = byPrefix.map(entry => String(entry.prefix).length);
  const sortedLengths = [...prefixLengths].sort((a, b) => a - b);
  t.deepEqual(
    prefixLengths,
    sortedLengths,
    'prefixes are sorted shortest-first',
  );
  // The commonjs auxiliary scopes .js to cjs; the deeper module auxiliary
  // flips it back to mjs.
  t.is(prefixToJs['cjs-sub/'], 'cjs');
  t.is(prefixToJs['cjs-sub/esm-again/'], 'mjs');
  // The redundant module auxiliary keeps .js as mjs.
  t.is(prefixToJs['esm-sub/'], 'mjs');
});

test('regression: without honoring the auxiliary descriptor, the commonjs subtree misparses', async t => {
  // The `cjs-sub/leaf.js` module uses `module.exports`, which is invalid as an
  // ECMAScript module. Under aux-pkg's `type: "module"` root, the only thing
  // that makes this import succeed is honoring the `{"type":"commonjs"}`
  // auxiliary. This test would fail (throwing during evaluation) if the
  // override were dropped — proving the new code path is load-bearing.
  const application = await loadLocation(read, fixture);
  const { namespace } = await application.import({});
  t.is(namespace.default.cjsLeaf, 'cjs-leaf');
  t.is(namespace.default.cjsDeep, 'cjs-deep');
});
