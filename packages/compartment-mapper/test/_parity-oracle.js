// The node reference oracle for the endor↔node compartment-mapper
// fixture-parity ratchet (designs/endor-run-expanded.md,
// § Fixture-parity ratchet).
//
// This module is the *pure JavaScript* reference: it imports
// `@endo/compartment-mapper` directly, runs `makeArchive` (via
// `mapLocation`) — or `mapNodeModules` for the classification/dynamic
// fixtures — against a fixture's canonical entry point with explicitly
// stated options (never the fixture's own ava harness), and serializes a
// stable, structural projection of the resulting compartment map to
//
//     fixtures-<name>/expected-compartment-map.json
//
// Two consumers share this one oracle so their notion of "the node
// compartment map for a fixture" cannot drift apart:
//
//   1. `rust/endo/tools/gen-parity-golden.mjs` — the CLI that (re)generates
//      and `--check`s the committed goldens.
//   2. `test/fixture-parity.test.js` — the ava test the compartment mapper
//      runs on Node.js to confirm each committed golden still matches what
//      this pure-JavaScript implementation produces (and to assert that the
//      documented endor-baseline divergences still hold).
//
// The rust parity harness
// (rust/endo/tests/compartment_mapper_fixture_parity.rs) independently
// diffs endor's walker output against the same committed golden. Because
// this oracle, the rust harness, and the ava test all apply identical
// projection rules, the committed file *is* the comparison target for all
// three.
//
// This module must NOT call `lockdown()` and must NOT read `process.argv`:
// it is imported both by the standalone generator (which locks down first,
// then dynamically imports this module) and by the ava suite (which runs
// under the package's ses-ava environment). Keeping it side-effect-free at
// import except for constructing read powers lets both hosts drive it.
//
// The structural projection
//
// The golden is deliberately a *projection*, not compartment-mapper's raw
// compartment-map.json. It captures exactly the three things the design
// names as "parity with node" — compartment identity, per-compartment
// module specifiers, and the parser language per module — under two
// documented canonicalisations that absorb representation differences that
// are *not* walker-capability concerns:
//
//   1. Compartments are keyed by their `name`, not the version-suffixed
//      `<name>-v<version>` id. endor defaults an absent package version to
//      `0.0.0` while compartment-mapper leaves it empty (`app-v0.0.0` vs
//      `app-v`); version-string parity is out of the walker's scope, so the
//      id's version tail is dropped from the comparison key.
//
//   2. A module whose specifier ends in a bare `.js` records the language
//      family `"js"` rather than `mjs`/`cjs`. Whether a `.js` file is ESM or
//      CommonJS depends on the enclosing package's `type` field. Collapsing
//      ambiguous `.js` to a single family keeps parser-tag representation
//      separate from graph parity. Unambiguous extensions (`.mjs`, `.cjs`,
//      `.json`) keep their precise language.
//
// Group D's deliberately excluded dev/optional edges and Group B's dynamic
// package edges are not represented completely in an archive map. Those
// goldens therefore carry `projection: "dependency-classification"` and are
// generated directly from `mapNodeModules`, preserving compartment
// identities and cross-compartment dependency links. That is the
// authoritative structural surface for the classifier capability these
// fixtures exercise.
//
// Oracle provenance
//
// Each golden carries an `oracle` field recording where its expected map
// came from:
//
//   - "node"           — generated here from `@endo/compartment-mapper`.
//                        This is genuine node parity.
//   - "endor-baseline" — compartment-mapper's harness-free mapper does NOT
//                        yield a comparable fixture-local map (it throws, or
//                        resolves the entry into an enclosing package outside
//                        the fixture), so the golden pins endor's own
//                        structural output as a regression baseline until a
//                        later increment reconciles the divergence. This
//                        oracle does not author those maps (it cannot run
//                        endor); it only *verifies*, on every run, that the
//                        documented node divergence still holds
//                        (`checkEndorBaselineDivergence`), and leaves the
//                        committed golden untouched.
//
// See FIXTURES below for which fixtures are which and why.

import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';

import { mapLocation } from '../archive.js';
import { mapNodeModules } from '../node-modules.js';
import { captureFromMap } from '../capture-lite.js';
import { defaultParserForLanguage } from '../import-parsers.js';
import { makeArchive, parseArchive } from '../index.js';
import { makeReadPowers } from '../node-powers.js';

const powers = makeReadPowers({ fs, url, crypto });

// A minimal `jsonp` parser, the emulated language registration for
// `fixtures-language-for-extension` (design §2, Group E). It mirrors the
// fixture's own `test/_parse-jsonp.js`: a source that calls
// `exports(<value>)`, recorded under the `jsonp` parser tag. Only the parser
// *tag* matters to the structural golden — the `execute` body is never run
// during mapping — so this stays a faithful but self-contained registration
// rather than importing the ava test helper.
const jsonpParser = Object.freeze({
  parse: (bytes, _specifier, _location, _packageLocation) => ({
    parser: 'jsonp',
    bytes,
    record: Object.freeze({
      imports: Object.freeze([]),
      exports: Object.freeze(['default']),
      execute: Object.freeze(() => {}),
    }),
  }),
  heuristicImports: false,
  synchronous: true,
});

/**
 * The parity fixtures currently exercised by the rust harness. Order and
 * membership must stay in lockstep with the MANIFEST's `Exercise` entries in
 * compartment_mapper_fixture_parity.rs; the rust drift guard fails if a
 * fixture leaves the accounting on either side. The ava parity test iterates
 * this same list, so a golden added without a FIXTURES entry (or vice versa)
 * is caught here too.
 */
export const FIXTURES = [
  { name: 'cthuloops', entry: 'main.js', oracle: 'node' },
  { name: 'cycle-mjs', entry: 'node_modules/app/index.js', oracle: 'node' },
  { name: 'implicit-reexport', entry: 'index.js', oracle: 'node' },
  {
    name: 'no-name',
    entry: 'node_modules/app/index.js',
    // compartment-mapper rejects a dependency package.json without a
    // "name" field by design — its own test/no-name.test.js asserts
    // the throw. endor extends support via a directory-basename
    // fall-back (no-name-pkg), so there is no node map to diff against.
    oracle: 'endor-baseline',
    divergence:
      'compartment-mapper throws on the nameless no-name-pkg dependency ' +
      '(it asserts this in test/no-name.test.js); endor extends support by ' +
      'falling back to the package directory basename for the compartment id.',
  },
  { name: 'order', entry: 'index.js', oracle: 'node' },
  // Group A — CommonJS require() graph-following (Increment 1). The
  // node oracle runs default options; endor follows require() edges.
  { name: 'cjs-compat', entry: 'node_modules/app/index.js', oracle: 'node' },
  { name: 'cycle-cjs', entry: 'node_modules/app/index.js', oracle: 'node' },
  { name: 'digest', entry: 'node_modules/app2/index.js', oracle: 'node' },
  { name: 'esm-imports-cjs-define', entry: '0.mjs', oracle: 'node' },
  {
    name: 'stack',
    entry: 'index.js',
    // fixtures-stack has no package.json of its own, so
    // compartment-mapper's upward `search` resolves the entry into the
    // enclosing @endo/compartment-mapper package (a version-bearing,
    // release-dependent id), rather than a standalone app graph. endor
    // roots the entry compartment at the entry's own directory
    // (entry-v1.0.0). No stable node map exists to diff against.
    oracle: 'endor-baseline',
    divergence:
      'fixtures-stack has no package.json boundary; compartment-mapper ' +
      'resolves the entry into the enclosing @endo/compartment-mapper ' +
      'package (a release-versioned id), while endor roots it at the entry ' +
      'directory (entry-v1.0.0).',
  },
  { name: 'strict', entry: 'node_modules/app/main.js', oracle: 'node' },
  // Group C — conditional & subpath exports/imports (Increment 2). The
  // parity run supplies the *same* emulated options (conditions and
  // host/exit modules) to this oracle and to endor's walker; see
  // designs/endor-run-expanded.md § Fixture-parity ratchet, Group C.
  {
    name: 'conditional-host-exports',
    entry: 'node_modules/app/index.js',
    oracle: 'node',
    // Emulate the `endo:lib` host condition (the fixture's own harness
    // passes it). It selects lib's `exports["endo:lib"]` (./endo.js);
    // ./endo.js then imports the host specifier `endo:lib`, which — with
    // no import hook supplied to the archive mapper — is dropped by both
    // engines rather than recorded.
    conditions: ['endo:lib'],
  },
  {
    name: 'export-patterns',
    entry: 'node_modules/app/main.js',
    oracle: 'node',
  },
  {
    name: 'package-imports-exports',
    entry: 'node_modules/app/main.js',
    oracle: 'node',
  },
  {
    name: 'nested-pkg',
    entry: 'node_modules/app/index.js',
    oracle: 'node',
  },
  {
    name: '0',
    entry: 'node_modules/app/main.js',
    oracle: 'node',
    // fixtures-0 is the mixed CJS/ESM kitchen-sink. Its harness admits
    // the entry package's devDependencies via the `development`
    // condition and declares `builtin` a host/exit module; both are
    // emulated identically for the walker (WalkOptions in the rust
    // harness) and this oracle.
    conditions: ['development'],
    exitModules: { builtin: true },
  },
  // Group D — dev/prod/peer/optional dependency classification
  // (Increment 3). `dev` is stated explicitly for the non-parity fixture
  // rather than inferred from a harness condition; both engines receive the
  // same false value. Optional peers use compartment-mapper's default
  // `dev: false` and are admitted only when their installation exists.
  {
    name: 'no-trans-dev-deps',
    entry: 'node_modules/app/index.js',
    oracle: 'node',
    projection: 'dependency-classification',
    dev: false,
  },
  {
    name: 'missing-optional-peer-dependencies',
    entry: 'node_modules/app/index.js',
    oracle: 'node',
    projection: 'dependency-classification',
  },
  {
    name: 'optional-peer-dependencies',
    entry: 'node_modules/app/index.js',
    oracle: 'node',
    projection: 'dependency-classification',
  },
  // Group B — statically analyzable dynamic import()/require()
  // (Increment 4).
  {
    name: 'dynamic',
    entry: 'node_modules/app/index.js',
    oracle: 'node',
    projection: 'dependency-classification',
  },
  {
    name: 'dynamic-ancestor',
    entry: 'node_modules/webpackish-app/build.js',
    oracle: 'node',
    dev: true,
  },
  {
    name: 'dynamic-import-esm',
    entry: 'node_modules/app/index.js',
    oracle: 'node',
    projection: 'dependency-classification',
  },
  {
    name: 'optional',
    entry: 'node_modules/optional-esm/index.js',
    oracle: 'node',
    projection: 'dependency-classification',
  },
  // Group G — nested/duplicate/symlink/resolve resolution (Increment 5).
  // These stress the resolver's package-identity handling: multiple
  // node_modules layers, duplicate installed copies of one name/version,
  // realpath'd symlinks, common-dependency injection, and the browser
  // resolve field. The duplicate-copy fixtures exercise the `-n<k>`
  // disambiguation the projection now preserves (see `projectedKey`).
  {
    // Nested duplicate copies (`b/node_modules/dep`, `a/node_modules/dep`)
    // plus an entry-vs-dependency id collision (`a@1.0.0` at the root AND
    // in node_modules). Six compartments over three names, disambiguated
    // `a`/`a-n1`, `dep`/`dep-n1`/`dep-n2`. NON-parity before nested
    // resolution: the single-root-per-compartment walker collapsed them.
    name: 'stability',
    entry: 'a.js',
    oracle: 'node',
  },
  {
    // Two `evan@1.0.0` copies — the top-level `node_modules/evan` and the
    // nested `node_modules/evankin/node_modules/evan` — disambiguated
    // `evan`/`evan-n1`. No single walkable app entry point; the canonical
    // entry is the top-level `evan` package main.
    name: '1',
    entry: 'node_modules/evan/index.js',
    oracle: 'node',
  },
  {
    // Common-dependency injection: `common-dep-required` imports the
    // unlisted `unlisted-common-dep`, resolved to `common-dep-target` via
    // the emulated `commonDependencies` map, supplied identically to the
    // oracle and endor's walker.
    name: 'common-deps',
    entry: 'node_modules/app/index.js',
    oracle: 'node',
    commonDependencies: { 'unlisted-common-dep': 'common-dep-target' },
  },
  {
    // Symlinked package resolution: `app/node_modules/symlink` is a symlink
    // to `deps/node_modules/symlink`, whose own `symlink-peer` dependency
    // resolves only from the realpath'd location, not the symlink site.
    name: 'symlink',
    entry: 'app/index.js',
    oracle: 'node',
  },
  {
    // Browser/resolve field and alias resolution: the entry package's
    // `browser` map remaps both relative (`./xyz.js`→`./browser-xyz.js`,
    // `ijk`→`./browser-ijk.js`) and bare (`abc`→`browser-abc`,
    // `qwe`→`browser-qwe`) specifiers, and a dependency's own `browser`
    // field overrides its main. The `browser` condition is supplied to
    // both engines.
    name: 'resolve',
    entry: 'node_modules/browser/main.js',
    oracle: 'node',
    conditions: ['browser'],
    browser: true,
  },
  // Group E — language-for-extension & non-JS assets (Increment 6). The
  // asset IS the fixture: rather than refactor the harness away, the parser
  // registration it supplies is emulated identically for the node oracle and
  // endor's walker (design §2, Group E).
  {
    // Non-JS asset modules. `.text` and `.bytes` are default languages
    // compartment-mapper already registers; the entry package's `"parsers"`
    // map (`{ "uint32": "bytes" }`) additionally classifies `.uint32` as a
    // bytes module. No emulated option is needed — the fixture's own
    // package.json drives the only non-default mapping.
    name: 'assets',
    entry: 'main.js',
    oracle: 'node',
  },
  {
    // Custom per-extension language config: `module.xsonp` parses as the
    // `jsonp` language via the emulated `languageForExtension: { xsonp:
    // 'jsonp' }` plus a matching `parserForLanguage: { jsonp }`, supplied
    // identically to endor's walker. This is the canonical scaffold from the
    // fixture's `language-for-extension.test.js` (`languageForExtension`).
    name: 'language-for-extension',
    entry: 'node_modules/module-app/module.xsonp',
    oracle: 'node',
    languageForExtension: { xsonp: 'jsonp' },
    parserForLanguage: { jsonp: jsonpParser },
  },
  // Group F — host hooks (Increment 7). Node keeps host module records outside
  // the archive and resolves them while importing; endor materializes
  // equivalent source in the CAS. The `archive-host-hooks` projection omits
  // that representation-only synthetic file, while the oracle checks below
  // prove the same exit request, module-source observations, and runtime value.
  {
    name: 'exit',
    entry: 'import-export.js',
    oracle: 'node',
    projection: 'archive-host-hooks',
    hostHook: 'meaning',
  },
  {
    name: 'module-source-hook',
    entry: 'node_modules/app-implicit/index.js',
    oracle: 'node',
    projection: 'archive-host-hooks',
    hostHook: 'dependency-b',
  },
];

/**
 * The fixtures test root — the directory this module lives in. Both the
 * fixtures and their committed goldens are resolved relative to it.
 */
export const testRoot = new URL('./', import.meta.url);

/** The absolute `file:` URL of a fixture's canonical entry point. */
const entryLocationOf = fix =>
  new URL(`fixtures-${fix.name}/${fix.entry}`, testRoot).href;

/** Normalise a compartment-mapper / endor parser tag to a base language. */
const baseLanguage = parser => {
  // compartment-mapper emits precompiled parser tags (`pre-mjs-json`,
  // `pre-cjs-json`, `pre-json`); endor emits the bare language.
  const p = String(parser);
  if (p === 'mjs' || p === 'pre-mjs-json') return 'mjs';
  if (p === 'cjs' || p === 'pre-cjs-json') return 'cjs';
  if (p === 'json' || p === 'pre-json') return 'json';
  return p;
};

/** The `.js`-ambiguity canonicalisation (see header, rule 2). */
const canonicalLanguage = (parser, specifier) => {
  const lang = baseLanguage(parser);
  if (specifier.endsWith('.js') && (lang === 'mjs' || lang === 'cjs')) {
    return 'js';
  }
  return lang;
};

/**
 * The projected compartment key: the package `name` plus any duplicate-copy
 * disambiguation suffix (`-n1`, `-n2`, …) carried by the compartment id.
 * The version segment (`-v<version>`) is dropped (rule 1 above), but the
 * `-n<k>` disambiguator that `makeArchiveCompartmentMap` appends to
 * duplicate name/version copies (`fixtures-stability`, `fixtures-1`) is part
 * of the graph identity, so it is preserved. The disambiguator is always the
 * id's trailing `-n<digits>`.
 */
const projectedKey = (name, id) => {
  const unscoped = String(name).split('/').pop();
  const match = /-n(\d+)$/.exec(String(id));
  return match ? `${unscoped}-n${match[1]}` : unscoped;
};

/** Recursively sort object keys for byte-stable JSON output. */
export const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
};

/**
 * Project a compartment-mapper archive compartment-map into the stable
 * structural golden shape (see header). Compartments keyed by name;
 * modules by specifier; file modules → {language}, link modules →
 * {link: <target compartment name>}.
 */
const projectMap = archiveMap => {
  const idToKey = {};
  for (const [id, c] of Object.entries(archiveMap.compartments)) {
    idToKey[id] = projectedKey(c.name, id);
  }
  const keyOf = id => idToKey[id] ?? id;
  const compartments = {};
  for (const [id, c] of Object.entries(archiveMap.compartments)) {
    const modules = {};
    for (const [spec, desc] of Object.entries(c.modules)) {
      if (desc.parser !== undefined) {
        modules[spec] = { language: canonicalLanguage(desc.parser, spec) };
      } else if (desc.compartment !== undefined) {
        // A cross-compartment (or self) link. Record only the target
        // compartment *key* (name + any duplicate-copy disambiguator):
        // endor and compartment-mapper differ on how they spell the
        // target module of a bare-specifier link (endor's unresolved `.`
        // main vs node's resolved `./index.js`), a resolution-
        // representation detail, not a graph-topology one.
        modules[spec] = { link: keyOf(desc.compartment) };
      } else if (desc.exit !== undefined) {
        modules[spec] = { exit: desc.exit };
      } else if (desc.deferredError !== undefined) {
        modules[spec] = { deferredError: true };
      } else {
        modules[spec] = { unknown: true };
      }
    }
    compartments[keyOf(id)] = { modules };
  }
  return {
    entryCompartment: keyOf(archiveMap.entry.compartment),
    entryModule: archiveMap.entry.module,
    compartments,
  };
};

/**
 * Project the pre-link node_modules package graph for fixtures whose point is
 * dependency classification or dynamic package reachability. Intentionally
 * excluded optional/dev edges and runtime-discovered package edges are not a
 * complete surface in an archive map, but
 * `mapNodeModules` is the authoritative classification surface. Preserve the
 * compartment identities and cross-compartment links; omit file modules and
 * deferred source edges, which belong to the archive linker rather than the
 * package classifier.
 */
const projectDependencyClassification = packageMap => {
  const idToKey = {};
  for (const [id, compartment] of Object.entries(packageMap.compartments)) {
    idToKey[id] = projectedKey(compartment.name, id);
  }
  const keyOf = id => idToKey[id] ?? id;
  const compartments = {};
  for (const [id, compartment] of Object.entries(packageMap.compartments)) {
    const modules = {};
    for (const [specifier, descriptor] of Object.entries(
      compartment.modules || {},
    )) {
      if (
        descriptor.compartment !== undefined &&
        descriptor.compartment !== id
      ) {
        modules[specifier] = { link: keyOf(descriptor.compartment) };
      }
    }
    compartments[keyOf(id)] = { modules };
  }
  return {
    entryCompartment: keyOf(packageMap.entry.compartment),
    entryModule: packageMap.entry.module,
    compartments,
  };
};

/**
 * The archive-shaped (renamed, parser-assigned) compartment map.
 * `options` carries the emulated harness inputs — the `conditions` set
 * and any host/exit `modules` — supplied identically to endor's walker.
 */
const archiveMapOf = async (entryLocation, options = {}) => {
  const mapOptions = {};
  if (options.conditions) {
    mapOptions.conditions = new Set(options.conditions);
  }
  if (options.exitModules) {
    mapOptions.modules = options.exitModules;
  }
  if (options.dev !== undefined) {
    mapOptions.dev = options.dev;
  }
  if (options.commonDependencies) {
    mapOptions.commonDependencies = options.commonDependencies;
  }
  if (options.languageForExtension) {
    mapOptions.languageForExtension = options.languageForExtension;
  }
  if (options.parserForLanguage) {
    mapOptions.parserForLanguage = options.parserForLanguage;
  }
  if (options.hostHook) {
    mapOptions.importHook = makeNodeExitHook(options.hostHook).hook;
    mapOptions.moduleSourceHook = () => {};
  }
  const bytes = await mapLocation(powers, entryLocation, mapOptions);
  return JSON.parse(new TextDecoder().decode(bytes));
};

const makeNodeExitHook = hostHook => {
  const requests = [];
  const hook = async specifier => {
    requests.push(specifier);
    if (hostHook === 'meaning' && specifier === 'h2g2:meaning') {
      return {
        imports: [],
        exports: ['meaning'],
        execute(moduleExports) {
          moduleExports.meaning = 42;
        },
      };
    }
    if (hostHook === 'dependency-b' && specifier === 'dependency-b') {
      return {
        imports: [],
        exports: ['default', 'value'],
        execute(moduleExports) {
          moduleExports.default = 'dependency-b';
          moduleExports.value = 'dependency-b';
        },
      };
    }
    return undefined;
  };
  return { hook, requests };
};

const assertJsonEqual = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

const validateHostHooks = async (fixture, entryLocation) => {
  if (fixture.hostHook === 'meaning') {
    const archive = await makeArchive(powers, entryLocation);
    const application = await parseArchive(archive);
    const { hook, requests } = makeNodeExitHook(fixture.hostHook);
    const { namespace } = await application.import({ importHook: hook });
    if (namespace.meaning !== 42) {
      throw new Error(
        `exit host hook returned ${String(namespace.meaning)}, expected 42`,
      );
    }
    assertJsonEqual('exit host-hook requests', requests, ['h2g2:meaning']);
    return {
      exitModuleImports: requests,
      moduleSources: [],
    };
  }

  const packageMap = await mapNodeModules(powers, entryLocation);
  const { hook, requests } = makeNodeExitHook(fixture.hostHook);
  const moduleSources = [];
  const packageLocation = new URL('./', entryLocation).href;
  await captureFromMap(powers, packageMap, {
    importHook: hook,
    parserForLanguage: defaultParserForLanguage,
    moduleSourceHook: ({ moduleSource }) => {
      if ('exit' in moduleSource) {
        moduleSources.push({
          origin: 'synthetic',
          specifier: moduleSource.exit,
        });
        return;
      }
      const sourceLocation = String(moduleSource.location);
      const specifier = sourceLocation.startsWith(packageLocation)
        ? `./${sourceLocation.slice(packageLocation.length)}`
        : sourceLocation;
      moduleSources.push({ origin: 'file', specifier });
    },
  });
  const expectedModuleSources = [
    { origin: 'file', specifier: './index.js' },
    { origin: 'synthetic', specifier: 'dependency-b' },
  ];
  assertJsonEqual('module-source host-hook requests', requests, [
    'dependency-b',
  ]);
  assertJsonEqual(
    'module-source hook observations',
    moduleSources,
    expectedModuleSources,
  );
  return {
    exitModuleImports: requests,
    moduleSources,
  };
};

const dependencyClassificationMapOf = async (entryLocation, options = {}) => {
  const mapOptions = {};
  if (options.conditions) {
    mapOptions.conditions = new Set(options.conditions);
  }
  if (options.dev !== undefined) {
    mapOptions.dev = options.dev;
  }
  return mapNodeModules(powers, entryLocation, mapOptions);
};

/**
 * Build the full golden object for a `oracle: 'node'` fixture by running the
 * pure-JavaScript `@endo/compartment-mapper` implementation live and
 * projecting its output. This is the value the generator serializes to the
 * committed golden and the value the ava parity test compares the committed
 * golden against.
 */
export const buildNodeGolden = async fix => {
  if (fix.oracle !== 'node') {
    throw new Error(
      `buildNodeGolden is only for oracle:'node' fixtures; ${fix.name} is ${fix.oracle}`,
    );
  }
  const entryLocation = entryLocationOf(fix);
  const emulatedHooks = fix.hostHook
    ? await validateHostHooks(fix, entryLocation)
    : undefined;
  const projection =
    fix.projection === 'dependency-classification'
      ? projectDependencyClassification(
          await dependencyClassificationMapOf(entryLocation, fix),
        )
      : projectMap(await archiveMapOf(entryLocation, fix));
  return {
    fixture: `fixtures-${fix.name}`,
    entry: fix.entry,
    oracle: 'node',
    ...(fix.projection ? { projection: fix.projection } : {}),
    ...(fix.conditions ? { conditions: [...fix.conditions].sort() } : {}),
    ...(fix.exitModules
      ? { exitModules: Object.keys(fix.exitModules).sort() }
      : {}),
    ...(fix.dev !== undefined ? { dev: fix.dev } : {}),
    ...(fix.languageForExtension
      ? { languageForExtension: stable(fix.languageForExtension) }
      : {}),
    ...(emulatedHooks ? { emulatedHooks } : {}),
    ...projection,
  };
};

/**
 * For an `oracle: 'endor-baseline'` fixture, verify the documented node
 * divergence still holds: compartment-mapper either throws, or resolves the
 * entry into a package other than the fixture itself. Returns `{ held,
 * observed }`; a `held: false` means compartment-mapper now yields a
 * fixture-local map and the fixture should be promoted to the node oracle.
 */
export const checkEndorBaselineDivergence = async fix => {
  const entryLocation = entryLocationOf(fix);
  try {
    const archiveMap = await archiveMapOf(entryLocation);
    const entryName =
      archiveMap.compartments[archiveMap.entry.compartment]?.name;
    // Divergence holds if the entry resolved into a package other than
    // the fixture itself (e.g. the enclosing @endo/compartment-mapper).
    const held =
      entryName !== `fixtures-${fix.name}` && !entryName?.startsWith(fix.name);
    return {
      held,
      observed: `resolved entry compartment "${entryName}" (outside the fixture)`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      held: true,
      observed: `mapper threw: ${message.split('\n')[0]}`,
    };
  }
};

/** The absolute filesystem path of a fixture's committed golden. */
export const goldenPath = name =>
  url.fileURLToPath(
    new URL(`fixtures-${name}/expected-compartment-map.json`, testRoot),
  );

/** Serialize a golden object exactly as the committed file stores it. */
export const serialize = obj => `${JSON.stringify(stable(obj), null, 2)}\n`;
