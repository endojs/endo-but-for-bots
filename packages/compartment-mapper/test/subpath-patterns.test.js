/**
 * Subpath pattern replacement scenarios exercised in this module in two
 * treatments side-by-side: the SES treatment (through the compartment-mapper
 * scaffold and the package's import / archive surfaces) and the Node.js
 * parity treatment (through plain Node.js imports). Where a scenario has a
 * direct Node-side analog the two tests are registered back-to-back; where
 * the scenario only exists on one side (SES-only archive shape checks,
 * Node-only multi-star / globstar exclusions) the test is registered once.
 * Together the SES and Node.js treatments verify that the compartment mapper
 * has parity with Node.js where the fixtures support both.
 */
/** @import {ExecutionContext} from 'ava' */

import 'ses';
import test from 'ava';
import { ZipReader } from '@endo/zip';
import { scaffold, readPowers } from './scaffold.js';
import { importLocation, makeArchive } from '../index.js';
import {
  assertMain,
  assertConditionalBlue,
  assertConditionalDefault,
  assertPrecedence,
  assertImportsEdgeCasesDev,
  assertImportsEdgeCasesDefault,
} from './_subpath-patterns-assertions.js';

const fixture = new URL(
  'fixtures-package-imports-exports/node_modules/app/main.js',
  import.meta.url,
).toString();

const fixtureBase = new URL(
  'fixtures-package-imports-exports/node_modules/app/',
  import.meta.url,
);

const fixtureAssertionCount = 1;

/**
 * @param {ExecutionContext} t
 * @param {{namespace: object}} result
 */
const assertFixture = (t, { namespace }) => {
  assertMain(t, namespace);
};

// Main subpath pattern resolution: SES treatment through the scaffold, then
// the Node.js parity treatment importing the same main.js directly.
scaffold(
  'subpath-patterns (ses)',
  test,
  fixture,
  assertFixture,
  fixtureAssertionCount,
);

test('subpath-patterns (node parity)', async t => {
  const ns = await import(new URL('main.js', fixtureBase).href);
  assertMain(t, ns);
});

// Archive shape: SES-only. The Node.js side has no archive analog.
test('patterns are stripped from archived compartment-map.json', async t => {
  const archive = await makeArchive(readPowers, fixture, {
    modules: {},
    Compartment,
  });
  const reader = new ZipReader(archive);
  const compartmentMapBytes = reader.files.get('compartment-map.json');
  t.truthy(compartmentMapBytes, 'archive contains compartment-map.json');
  const compartmentMap = JSON.parse(
    new TextDecoder().decode(compartmentMapBytes.content),
  );
  for (const [name, descriptor] of Object.entries(
    compartmentMap.compartments,
  )) {
    t.is(
      /** @type {any} */ (descriptor).patterns,
      undefined,
      `compartment ${name} should not have patterns in archive`,
    );
  }
});

// Conditional patterns: SES exercises the explicit blue-moon condition; the
// Node.js parity sibling exercises the default fall-through (Node has no
// API for user-specified conditions in this scaffold).
test('conditional pattern resolves under user-specified condition (ses)', async t => {
  const conditionalFixture = new URL(
    'fixtures-package-imports-exports/node_modules/app/conditional-import.js',
    import.meta.url,
  ).toString();
  const { namespace } = await importLocation(readPowers, conditionalFixture, {
    conditions: new Set(['blue-moon']),
  });
  assertConditionalBlue(t, namespace);
});

test('conditional pattern falls back to default without user condition (ses)', async t => {
  const conditionalFixture = new URL(
    'fixtures-package-imports-exports/node_modules/app/conditional-import.js',
    import.meta.url,
  ).toString();
  const { namespace } = await importLocation(readPowers, conditionalFixture);
  assertConditionalDefault(t, namespace);
});

test('conditional patterns - default condition (node parity)', async t => {
  // Without --conditions=blue-moon, "default" is selected.
  const ns = await import(new URL('conditional-import.js', fixtureBase).href);
  assertConditionalDefault(t, ns);
});

// Policy gating: SES-only.
test('policy allows pattern-matched imports when package is permitted', async t => {
  const policy = {
    entry: { packages: { 'patterns-lib': true } },
    resources: { 'patterns-lib': {} },
  };
  const { namespace } = await importLocation(readPowers, fixture, { policy });
  assertMain(t, namespace);
});

test('policy rejects pattern-matched imports when package is not permitted', async t => {
  const policy = {
    entry: { packages: {} },
    resources: {},
  };
  await t.throwsAsync(() => importLocation(readPowers, fixture, { policy }));
});

// Array imports field: the compartment-mapper throws; Node.js silently
// ignores and resolves through exports.
test('array imports field in package.json causes an exception (ses)', async t => {
  const arrayImportsFixture = new URL(
    'fixtures-package-imports-exports/node_modules/array-imports-app/main.js',
    import.meta.url,
  ).toString();
  await t.throwsAsync(() => importLocation(readPowers, arrayImportsFixture), {
    message: /Cannot interpret package.json imports property, must be object/,
  });
});

test('array imports field is silently ignored by Node.js (node parity)', async t => {
  // Node.js silently ignores an invalid array `imports` field and resolves
  // the package via `exports` instead. The compartment-mapper is stricter
  // and throws (see the SES treatment above). This test documents the
  // Node.js behavior.
  const ns = await import(
    new URL(
      'fixtures-package-imports-exports/node_modules/array-imports-app/main.js',
      import.meta.url,
    ).href
  );
  t.is(ns.value, 'should not reach here');
});

// Imports edge cases: SES exercises the development condition (which yields
// the assertImportsEdgeCasesDev shape); Node.js exercises the default
// condition (assertImportsEdgeCasesDefault).
test('imports edge cases: non-wildcard alias, conditional, null, invalid key, bad value, mismatched wildcard (ses)', async t => {
  const edgeCasesFixture = new URL(
    'fixtures-package-imports-exports/node_modules/imports-edge-cases-app/main.js',
    import.meta.url,
  ).toString();
  const { namespace } = await importLocation(readPowers, edgeCasesFixture, {
    conditions: new Set(['development']),
  });
  assertImportsEdgeCasesDev(t, namespace);
  // The following are exercised by graph construction but do not produce runtime exports:
  // - "invalid-key" (no # prefix): logged and skipped
  // - "#excluded": null (non-wildcard null target): skipped
  // - "#secret/*.js": null (wildcard null target): stored as pattern
  // - "#bad-value": 42 (unsupported value): logged and skipped
  // - "#mismatched/*" / "./mismatched-export/*": mismatched wildcard count
});

test('imports edge cases (node parity)', async t => {
  // Non-wildcard alias (#helper) and conditional import (#cond under default
  // conditions) resolve correctly under Node.js.
  const ns = await import(
    new URL(
      'fixtures-package-imports-exports/node_modules/imports-edge-cases-app/main.js',
      import.meta.url,
    ).href
  );
  assertImportsEdgeCasesDefault(t, ns);
});

// Browser field handling: SES-only (Node's loader does not consult the
// browser field).
test('browser field and commonjs default module', async t => {
  const browserCjsFixture = new URL(
    'fixtures-package-imports-exports/node_modules/browser-cjs-app/main.js',
    import.meta.url,
  ).toString();
  // With the 'browser' condition, the browser field remaps ./src/main.js to
  // ./src/browser-main.js, exercising lines 420-433 in inferExportsAliasesAndPatterns.
  // The package has no exports/module fields and type != 'module', exercising
  // the commonjs default module path (lines 414-415).
  const { namespace } = await importLocation(readPowers, browserCjsFixture, {
    conditions: new Set(['browser']),
  });
  t.is(namespace.env, 'browser');
});

test('browser field as string remaps main export', async t => {
  const browserStringFixture = new URL(
    'fixtures-package-imports-exports/node_modules/browser-string-app/main.js',
    import.meta.url,
  ).toString();
  const { namespace } = await importLocation(readPowers, browserStringFixture, {
    conditions: new Set(['browser']),
  });
  t.is(namespace.env, 'browser-string');
});

// Exports edge cases: SES and Node parity assertions are essentially
// identical for this fixture; register them back-to-back.
test('exports edge cases: ./ key skipped, nested subpath with name != "." (ses)', async t => {
  const exportsEdgeCasesFixture = new URL(
    'fixtures-package-imports-exports/node_modules/exports-edge-cases-app/main.js',
    import.meta.url,
  ).toString();
  const { namespace } = await importLocation(
    readPowers,
    exportsEdgeCasesFixture,
  );
  t.is(namespace.main, 'exports-edge-cases-main');
  t.is(namespace.nested, 'nested-esm');
});

test('exports edge cases (node parity)', async t => {
  const ns = await import(
    new URL(
      'fixtures-package-imports-exports/node_modules/exports-edge-cases-app/main.js',
      import.meta.url,
    ).href
  );
  t.is(ns.main, 'exports-edge-cases-main');
  t.is(ns.nested, 'nested-esm');
});

// Non-object exports field: the compartment-mapper produces a specific
// message; Node.js produces a version-dependent code.
test('non-object exports field causes an exception (ses)', async t => {
  const badExportsFixture = new URL(
    'fixtures-package-imports-exports/node_modules/bad-exports-app/main.js',
    import.meta.url,
  ).toString();
  await t.throwsAsync(() => importLocation(readPowers, badExportsFixture), {
    message: /Cannot interpret package.json exports property/,
  });
});

test('non-object exports field is rejected by Node.js (node parity)', async t => {
  // Node.js rejects the invalid numeric exports field. The error code varies
  // by version: ERR_PACKAGE_PATH_NOT_EXPORTED on 18/20, ERR_MODULE_NOT_FOUND
  // on 22+. We just verify it throws.
  await t.throwsAsync(
    () =>
      import(
        new URL(
          'fixtures-package-imports-exports/node_modules/bad-exports-app/main.js',
          import.meta.url,
        ).href
      ),
  );
});

// Non-string non-object browser field: SES-only (Node's loader does not
// consult the browser field).
test('non-string non-object browser field causes an exception', async t => {
  const badBrowserFixture = new URL(
    'fixtures-package-imports-exports/node_modules/bad-browser-app/main.js',
    import.meta.url,
  ).toString();
  await t.throwsAsync(
    () =>
      importLocation(readPowers, badBrowserFixture, {
        conditions: new Set(['browser']),
      }),
    {
      message: /Cannot interpret package.json browser property/,
    },
  );
});

// Null-target patterns: SES rejects with a message; Node.js rejects with
// ERR_PACKAGE_PATH_NOT_EXPORTED.
test('null-target pattern excludes matching specifier (ses)', async t => {
  const nullTargetFixture = new URL(
    'fixtures-package-imports-exports/node_modules/app/null-target-import.js',
    import.meta.url,
  ).toString();
  await t.throwsAsync(() => importLocation(readPowers, nullTargetFixture), {
    message: /excluded by null target pattern/,
  });
});

test('null-target patterns are excluded by Node.js (node parity)', async t => {
  // The file exists on disk but the null-target export prevents resolution.
  await t.throwsAsync(
    () =>
      import(
        new URL(
          'fixtures-package-imports-exports/node_modules/app/null-target-import.js',
          import.meta.url,
        ).href
      ),
    {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    },
  );
});

// Absolute path in subpath pattern: SES rejects with a "Cannot find file"
// message; Node.js rejects with ERR_INVALID_PACKAGE_TARGET.
test('absolute path in subpath pattern replacement is rejected (ses)', async t => {
  const absolutePatternFixture = new URL(
    'fixtures-package-imports-exports/node_modules/absolute-pattern-app/main.js',
    import.meta.url,
  ).toString();
  await t.throwsAsync(
    () => importLocation(readPowers, absolutePatternFixture),
    {
      message: /Cannot find file for internal module/,
    },
  );
});

test('absolute path in subpath pattern is rejected by Node.js (node parity)', async t => {
  // A package whose exports map "./smuggle/*.js" to "/etc/*.js" should not
  // allow importing absolute paths. Node.js rejects this because the
  // resolved target does not start with "./".
  await t.throwsAsync(
    () =>
      import(
        new URL(
          'fixtures-package-imports-exports/node_modules/absolute-pattern-app/main.js',
          import.meta.url,
        ).href
      ),
    {
      code: 'ERR_INVALID_PACKAGE_TARGET',
    },
  );
});

// Module field ESM entry: SES-only (this exercises compartment-mapper's
// module-field handling specifically).
test('module field selects ESM entry point', async t => {
  const moduleFieldFixture = new URL(
    'fixtures-package-imports-exports/node_modules/module-field-app/main.js',
    import.meta.url,
  ).toString();
  // The "module" field (without "exports") yields the ESM entry when the
  // "import" condition is active, which is always the case in the
  // compartment-mapper.
  const { namespace } = await importLocation(readPowers, moduleFieldFixture);
  t.is(namespace.entry, 'esm');
});

// Pattern tie-break precedence: SES exercises through importLocation; Node
// parity exercises through a direct import of the precedence-import.js
// driver.
test('pattern tie-break matches Node precedence rules (ses)', async t => {
  const precedenceFixture = new URL(
    'fixtures-package-imports-exports/node_modules/app/precedence-import.js',
    import.meta.url,
  ).toString();
  const { namespace } = await importLocation(readPowers, precedenceFixture);
  assertPrecedence(t, namespace);
});

test('Node prefers the longer full pattern key on equal prefix length (node parity)', async t => {
  // This exercises Node's pattern key ordering with overlapping keys:
  // "./tie/*" and "./tie/*.js". Node resolves "patterns-lib/tie/bar.js"
  // through "./tie/*.js", not the broader "./tie/*" entry.
  const ns = await import(new URL('precedence-import.js', fixtureBase).href);
  assertPrecedence(t, ns);
});

// Multi-star and globstar exclusions: Node-only. The compartment-mapper has
// no analogous test on the SES side; the parity test pins Node's behavior
// so a future Node change is caught.
test('multi-star patterns are not resolved by Node.js (node parity)', async t => {
  // Node.js restricts subpath patterns to exactly one `*` per side.
  // Entries with multiple `*` are silently ignored (never match).
  // This test will fail if Node.js begins to support multi-star patterns,
  // signaling that we should revisit our implementation.
  const fixtureDir = new URL(
    'fixtures-package-imports-exports/node_modules/',
    import.meta.url,
  );
  // The main export (no wildcards) should still work.
  const main = await import(
    new URL('multi-star-lib/src/main.js', fixtureDir).href
  );
  t.is(main.main, 'main');

  // The multi-star subpath pattern should NOT resolve.
  await t.throwsAsync(
    () => import(new URL('app/multi-star-import.js', fixtureDir).href),
    {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    },
  );
});

test('globstar patterns are not resolved by Node.js (node parity)', async t => {
  // Node.js does not support globstar (**) in subpath patterns.
  // Entries with ** are silently ignored (never match).
  // This test will fail if Node.js begins to support globstar patterns,
  // signaling that we should revisit our implementation.
  const fixtureDir = new URL(
    'fixtures-package-imports-exports/node_modules/',
    import.meta.url,
  );
  // The main export (no wildcards) should still work.
  const main = await import(
    new URL('globstar-lib/src/main.js', fixtureDir).href
  );
  t.is(main.main, 'main');

  // The globstar subpath pattern should NOT resolve.
  await t.throwsAsync(
    () => import(new URL('app/globstar-import.js', fixtureDir).href),
    {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    },
  );
});
