// @ts-nocheck
// Parity coverage for the TypeScript extensions (`.ts`/`.mts`/`.cts`) of the
// auxiliary `package.json` design (Phase 7). Node.js classifies these exactly
// as it classifies their JavaScript counterparts:
//
//   - `.mts` is ALWAYS an ECMAScript module (like `.mjs`).
//   - `.cts` is ALWAYS CommonJS (like `.cjs`).
//   - `.ts`  honors the nearest `package.json` `type` (like `.js`): an
//     ECMAScript module under `type: "module"`, CommonJS under
//     `type: "commonjs"`.
//
// So an auxiliary `{"type":"module"}` / `{"type":"commonjs"}` descriptor flips
// `.ts` within its subtree (to mts / cts) but never touches `.mts` / `.cts`.
// This mirrors `auxiliary-language.test.js`, which covers `.js`.
//
// The compartment mapper ships no TypeScript parser; TypeScript without type
// annotations is syntactically JavaScript, so the fixtures use the ESM parser
// for the module languages (`mts`) and the CommonJS parser for the CommonJS
// languages (`cts`). The languages a `.ts`/`.mts`/`.cts` file resolves to —
// not how the bytes are parsed — is what this exercises, and that resolution
// is what must match Node.js. See
// `../designs/compartment-mapper-auxiliary-package-json.md`.
import 'ses';
import fs from 'fs';
import url from 'url';
import test from 'ava';
import { loadFromMap } from '../src/import-lite.js';
import { defaultParserForLanguage } from '../src/import-parsers.js';
import { mapNodeModules } from '../src/node-modules.js';
import { makeReadPowers } from '../src/node-powers.js';
import parserMjs from '../src/parse-mjs.js';
import parserCjs from '../src/parse-cjs.js';
import { assertTypeScriptClassification } from './_auxiliary-typescript-assertions.js';

const readPowers = makeReadPowers({ fs, url });

const fixture = new URL(
  'fixtures-auxiliary-typescript/node_modules/app/index.js',
  import.meta.url,
).toString();

// Teach the mapper the TypeScript extensions, mirroring Node.js: `.mts`/`.cts`
// are type-independent (added to the shared base), while `.ts` is
// type-dependent (mts under module packages, cts under commonjs packages).
const languageOptions = {
  languageForExtension: { mts: 'mts', cts: 'cts' },
  moduleLanguageForExtension: { ts: 'mts' },
  commonjsLanguageForExtension: { ts: 'cts' },
};

// TypeScript-without-types parses as JavaScript: ESM languages use the mjs
// parser, CommonJS languages use the cjs parser.
const parserForLanguage = {
  ...defaultParserForLanguage,
  mts: parserMjs,
  cts: parserCjs,
};

test('auxiliary package.json flips .ts parsing per subtree, with .mts/.cts type-independent', async t => {
  const compartmentMap = await mapNodeModules(
    readPowers,
    fixture,
    languageOptions,
  );
  const application = await loadFromMap(readPowers, compartmentMap, {
    parserForLanguage,
  });
  const { namespace } = await application.import({});
  // Every subtree must have parsed under the language Node.js would choose; a
  // mismatch (e.g. `.ts` parsed as ESM where CommonJS was meant) throws during
  // evaluation, so a structured result is the load-bearing assertion. The
  // companion `auxiliary-typescript-node-parity.test.js` asserts the same
  // aggregate under plain Node.js via the shared assertions module, so the
  // Compartment Mapper's classification is verified to match Node.js by
  // construction.
  assertTypeScriptClassification(t, namespace.default);
});

test('the entry compartment records ts/mts/cts languageForExtensionByPrefix matching Node.js', async t => {
  const compartmentMap = await mapNodeModules(
    readPowers,
    fixture,
    languageOptions,
  );
  const tsPackageLocation = new URL(
    'fixtures-auxiliary-typescript/node_modules/ts-pkg/',
    import.meta.url,
  ).toString();
  const tsCompartment = compartmentMap.compartments[tsPackageLocation];
  t.truthy(tsCompartment, 'ts-pkg compartment exists');

  // The base (no enclosing auxiliary) classifies ts/mts/cts per ts-pkg's own
  // `type: "module"`: `.ts` and `.mts` are ECMAScript modules, `.cts` is
  // CommonJS.
  t.is(tsCompartment.parsers.ts, 'mts');
  t.is(tsCompartment.parsers.mts, 'mts');
  t.is(tsCompartment.parsers.cts, 'cts');

  const application = await loadFromMap(readPowers, compartmentMap, {
    parserForLanguage,
  });
  await application.import({});

  const byPrefix = tsCompartment.languageForExtensionByPrefix || [];
  const prefixMap = Object.fromEntries(
    byPrefix.map(entry => [entry.prefix, entry.languageForExtension]),
  );

  // Shortest-first ordering invariant, as for the `.js` case.
  const prefixLengths = byPrefix.map(entry => String(entry.prefix).length);
  t.deepEqual(
    prefixLengths,
    [...prefixLengths].sort((a, b) => a - b),
    'prefixes are sorted shortest-first',
  );

  // Inside the commonjs auxiliary, `.ts` is cts; `.mts`/`.cts` are unchanged.
  t.is(prefixMap['cjs-sub/'].ts, 'cts');
  t.is(prefixMap['cjs-sub/'].mts, 'mts', '.mts is never flipped by `type`');
  t.is(prefixMap['cjs-sub/'].cts, 'cts');
  // The deeper module auxiliary flips `.ts` back to mts.
  t.is(prefixMap['cjs-sub/esm-again/'].ts, 'mts');
  t.is(prefixMap['cjs-sub/esm-again/'].mts, 'mts');
});

test('regression: without honoring the auxiliary descriptor, the commonjs .ts subtree misparses', async t => {
  // `cjs-sub/leaf.ts` uses `module.exports`, invalid as an ECMAScript module.
  // Under ts-pkg's `type: "module"` root, `.ts` defaults to mts (ESM); the only
  // thing that makes this import succeed is the `{"type":"commonjs"}` auxiliary
  // flipping `.ts` to cts. This would throw if the override dropped `.ts`.
  const compartmentMap = await mapNodeModules(
    readPowers,
    fixture,
    languageOptions,
  );
  const application = await loadFromMap(readPowers, compartmentMap, {
    parserForLanguage,
  });
  const { namespace } = await application.import({});
  t.is(namespace.default.ctsLeaf, 'cts-leaf');
  t.is(namespace.default.ctsDeep, 'cts-deep');
  // Conversely, `.mts` inside that same commonjs subtree must remain ESM.
  t.is(namespace.default.forcedMts, 'mts-under-cjs');
});
