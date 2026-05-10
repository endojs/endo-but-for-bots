// @ts-nocheck
// Regression for endojs/endo#2879. Two related properties:
//
// 1. `@endo/env-options`'s `makeEnvironmentCaptor`, when imported and
//    invoked from inside a sub-compartment, observes that compartment's
//    own `globalThis.process.env` rather than the parent realm's.
//
// 2. The exact captor call shape that `@endo/marshal`'s `rankOrder.js`
//    uses at module-load time (option name `ENDO_RANK_STRINGS`,
//    default `utf16-code-unit-order`, alternate values
//    `unicode-code-point-order` and `error-if-order-choice-matters`)
//    is honored per-compartment. Re-importing the full marshal
//    `rankOrder` graph inside a sub-compartment would require staging
//    every transitive dep as a `ModuleSource`; this test instead pins
//    the captor's behavior for the precise call shape marshal uses,
//    so a regression in env-options' per-compartment lookup would
//    surface here before silently shifting marshal's startup-time read.

import test from '@endo/ses-ava/test.js';

import fs from 'node:fs';
import url from 'node:url';
import { ModuleSource } from '@endo/module-source';

const dirname = url.fileURLToPath(new URL('.', import.meta.url));

const readSource = relativePath =>
  fs.readFileSync(`${dirname}${relativePath}`, 'utf8');

const envOptionsSource = readSource('../../env-options/src/env-options.js');

/**
 * Build a sub-compartment that exposes `@endo/env-options` as a parsed
 * module source so a compartment-internal entry can `import` from it.
 *
 * @param {Record<string, string>} env per-compartment environment
 * @param {string} entrySource ESM source text for the entry module
 *   (uses `makeEnvironmentCaptor(globalThis)` to build the captor and
 *   exports its result for the host to inspect)
 */
const makeCompartmentWithEnv = (env, entrySource) => {
  return new Compartment({
    globals: {
      process: { env },
    },
    modules: {
      '@endo/env-options': { source: new ModuleSource(envOptionsSource) },
      './entry.js': { source: new ModuleSource(entrySource) },
    },
    resolveHook: specifier => specifier,
    importHook: () => undefined,
    __noNamespaceBox__: true,
    __options__: true,
  });
};

test('inner import of @endo/env-options observes per-compartment env', async t => {
  const compartment = makeCompartmentWithEnv(
    { FOO: 'inner-bar' },
    `
      import { makeEnvironmentCaptor } from '@endo/env-options';
      const { getEnvironmentOption, getCapturedEnvironmentOptionNames } =
        makeEnvironmentCaptor(globalThis);
      export const foo = getEnvironmentOption('FOO', 'unset');
      export const captured = getCapturedEnvironmentOptionNames();
    `,
  );
  const ns = await compartment.import('./entry.js');
  t.is(ns.foo, 'inner-bar');
  t.deepEqual([...ns.captured], ['FOO']);
});

test('two sibling compartments observe their own env independently', async t => {
  const a = makeCompartmentWithEnv(
    { TARGET: 'A' },
    `
      import { makeEnvironmentCaptor } from '@endo/env-options';
      const { getEnvironmentOption } = makeEnvironmentCaptor(globalThis);
      export const target = getEnvironmentOption('TARGET', 'none');
    `,
  );
  const b = makeCompartmentWithEnv(
    { TARGET: 'B' },
    `
      import { makeEnvironmentCaptor } from '@endo/env-options';
      const { getEnvironmentOption } = makeEnvironmentCaptor(globalThis);
      export const target = getEnvironmentOption('TARGET', 'none');
    `,
  );
  const nsA = await a.import('./entry.js');
  const nsB = await b.import('./entry.js');
  t.is(nsA.target, 'A');
  t.is(nsB.target, 'B');
});

test('inner compartment with no process.env reads the default', async t => {
  // Even when the host realm has the variable set, an inner compartment
  // whose `process.env` is a fresh empty object must not observe it.
  // eslint-disable-next-line no-undef
  const realmProcess = globalThis.process;
  const previous =
    realmProcess && realmProcess.env && realmProcess.env.SHOULD_NOT_LEAK;
  if (realmProcess && realmProcess.env) {
    realmProcess.env.SHOULD_NOT_LEAK = 'leaked';
  }
  t.teardown(() => {
    if (realmProcess && realmProcess.env) {
      if (previous === undefined) {
        delete realmProcess.env.SHOULD_NOT_LEAK;
      } else {
        realmProcess.env.SHOULD_NOT_LEAK = previous;
      }
    }
  });

  const compartment = makeCompartmentWithEnv(
    {},
    `
      import { makeEnvironmentCaptor } from '@endo/env-options';
      const { getEnvironmentOption } = makeEnvironmentCaptor(globalThis);
      export const leak = getEnvironmentOption('SHOULD_NOT_LEAK', 'absent');
    `,
  );
  const ns = await compartment.import('./entry.js');
  t.is(ns.leak, 'absent');
});

test('inner compartment reads ENDO_RANK_STRINGS via the captor', async t => {
  // Pin the per-compartment behavior for the exact call shape marshal
  // uses in `src/rankOrder.js`. If env-options' per-compartment lookup
  // ever stops respecting this shape, marshal's module-load time read
  // would silently shift along with it.
  for (const setting of [
    'unicode-code-point-order',
    'utf16-code-unit-order',
    'error-if-order-choice-matters',
  ]) {
    const compartment = makeCompartmentWithEnv(
      { ENDO_RANK_STRINGS: setting },
      `
        import { makeEnvironmentCaptor } from '@endo/env-options';
        const { getEnvironmentOption } = makeEnvironmentCaptor(globalThis);
        export const got = getEnvironmentOption(
          'ENDO_RANK_STRINGS',
          'utf16-code-unit-order',
          ['unicode-code-point-order', 'error-if-order-choice-matters'],
        );
      `,
    );
    // eslint-disable-next-line no-await-in-loop, @jessie.js/safe-await-separator
    const ns = await compartment.import('./entry.js');
    t.is(
      ns.got,
      setting,
      `inner compartment with ENDO_RANK_STRINGS=${setting} reads it back`,
    );
  }
});
