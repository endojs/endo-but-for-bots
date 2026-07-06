// @ts-nocheck
// Phase 7 of the auxiliary-`package.json` design, transitive-dependency
// coverage (maintainer ask on PR #96, 2026-06-25): an auxiliary `package.json`
// nested in a plain SUBDIRECTORY of a TRANSITIVE dependency — a dep-of-dep, with
// NO intermediate `node_modules` between the dependency's root and the auxiliary
// — flips `.js` parsing for modules reached by relative import within that
// subtree. This proves the lazy per-module override is honored for EVERY package
// in the graph, not just the entry package or a direct dependency.
//
// Topology: app -> dirdep (direct) -> transdep (transitive). `transdep` is
// `type: "module"`, but `transdep/aux/package.json` is `{"type": "commonjs"}`,
// so `transdep/aux/leaf.js` (which uses `module.exports`) loads only when the
// auxiliary override is honored; a deeper `transdep/aux/flip-back/package.json`
// is `{"type": "module"}` and flips `.js` back to ECMAScript.
//
// See `../designs/compartment-mapper-auxiliary-package-json.md`.
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
  'fixtures-auxiliary-transitive/node_modules/app/index.js',
  import.meta.url,
).toString();

test('auxiliary package.json in a transitive dependency subtree flips .js per subdirectory', async t => {
  const application = await loadLocation(read, fixture);
  const { namespace } = await application.import({});
  // The transitive dependency `transdep` aggregates three modules reached by
  // relative import. If any subtree were parsed with the wrong language the
  // import would throw, so a successful structured result is the load-bearing
  // assertion.
  t.deepEqual(namespace.default, {
    // `transdep/aux/leaf.js` uses `module.exports`: honored only because the
    // `aux/` auxiliary `{"type":"commonjs"}` overrides transdep's `type:module`.
    leaf: 'cjs-transitive-leaf',
    // `transdep/aux/deep/buried.js` has no package.json of its own; it inherits
    // the `aux/` commonjs auxiliary.
    deep: 'cjs-transitive-deep',
    // `transdep/aux/flip-back/` is a still-deeper `{"type":"module"}` auxiliary,
    // flipping `.js` back to ECMAScript.
    flipBack: 'esm-transitive-flip-back',
  });
});

test('the transitive dependency compartment records languageForExtensionByPrefix for its auxiliary subtrees', async t => {
  const compartmentMap = await mapNodeModules(readPowers, fixture);
  const transdepLocation = new URL(
    'fixtures-auxiliary-transitive/node_modules/transdep/',
    import.meta.url,
  ).toString();
  const transdepCompartment = compartmentMap.compartments[transdepLocation];
  t.truthy(transdepCompartment, 'transdep (transitive dep) compartment exists');

  // Import through the map so the lazy import-hook walk populates the field on
  // the very descriptor we hold.
  const application = await loadFromMap(readPowers, compartmentMap, {
    parserForLanguage: defaultParserForLanguage,
  });
  await application.import({});

  const byPrefix = transdepCompartment.languageForExtensionByPrefix || [];
  const prefixToJs = Object.fromEntries(
    byPrefix.map(entry => [entry.prefix, entry.languageForExtension.js]),
  );
  // Shortest-prefix-first ordering invariant.
  const prefixLengths = byPrefix.map(entry => String(entry.prefix).length);
  t.deepEqual(
    prefixLengths,
    [...prefixLengths].sort((a, b) => a - b),
    'prefixes are sorted shortest-first',
  );
  // The commonjs auxiliary scopes `.js` to cjs; the deeper module auxiliary
  // flips it back to mjs.
  t.is(prefixToJs['aux/'], 'cjs');
  t.is(prefixToJs['aux/flip-back/'], 'mjs');
});
