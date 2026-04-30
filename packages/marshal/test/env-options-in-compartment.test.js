// @ts-check
// Verifies that `ENDO_RANK_STRINGS`, when set on a sub-compartment's
// own `process.env`, configures string-ranking decisions made by code
// running inside that sub-compartment, independent of the parent's
// (process-level) setting.
//
// The parent of this test is loaded with the default
// `utf16-code-unit-order` regime (no `tools/prepare-*.js` import).
// Inside the sub-compartment we set `ENDO_RANK_STRINGS =
// 'unicode-code-point-order'` on its own `process.env` and then
// observe that string ranking inside the sub-compartment follows
// code-point order while ranking in the parent follows code-unit
// order.
//
// See https://github.com/endojs/endo/issues/2879

import '@endo/init/debug.js';

import { readFile } from 'node:fs/promises';

import test from '@endo/ses-ava/test.js';
import { ModuleSource } from '@endo/module-source';
import harden from '@endo/harden';

import { compareRank as parentCompareRank } from '../src/rankOrder.js';
import { multiplanarStrings, sorted } from '../tools/marshal-test-data.js';

/** @import { RankCompare, RankComparison } from '../src/types.js' */

/**
 * @typedef {object} CompareStringsNamespace
 * @property {RankCompare} compareStrings
 * @property {string} capturedSetting
 */

const envOptionsSourceUrl = new URL(
  './src/env-options.js',
  // eslint-disable-next-line @endo/no-polymorphic-call
  import.meta.resolve('@endo/env-options/package.json'),
);

// A small virtual module that mirrors the ENDO_RANK_STRINGS branch in
// `packages/marshal/src/rankOrder.js` for plain strings.  It captures
// the option once at module evaluation, exactly like rankOrder.js does.
const compareStringsModuleSource = {
  imports: harden(['@endo/env-options']),
  exports: harden(['compareStrings', 'capturedSetting']),
  /**
   * @param {Record<string, unknown>} env
   * @param {Compartment} _c
   * @param {Record<string, string>} resolutions
   */
  execute(env, _c, resolutions) {
    // eslint-disable-next-line no-use-before-define
    const envOptionsNs = _c.importNow(resolutions['@endo/env-options']);
    const { getEnvironmentOption } =
      /** @type {{ getEnvironmentOption: (n: string, d: string, o?: string[]) => string }} */ (
        envOptionsNs
      );
    const ENDO_RANK_STRINGS = getEnvironmentOption(
      'ENDO_RANK_STRINGS',
      'utf16-code-unit-order',
      ['unicode-code-point-order', 'error-if-order-choice-matters'],
    );
    env.capturedSetting = ENDO_RANK_STRINGS;

    /** @type {(left: string, right: string) => RankComparison} */
    const trivial = (left, right) =>
      // eslint-disable-next-line no-nested-ternary
      left < right ? -1 : left > right ? 1 : 0;
    /** @type {(left: string, right: string) => RankComparison} */
    const codePoint = (left, right) => {
      // Convert to code-point sequences for ordering.
      const leftCps = [...left];
      const rightCps = [...right];
      const n = Math.min(leftCps.length, rightCps.length);
      for (let i = 0; i < n; i += 1) {
        const a = /** @type {number} */ (leftCps[i].codePointAt(0));
        const b = /** @type {number} */ (rightCps[i].codePointAt(0));
        if (a !== b) return a < b ? -1 : 1;
      }
      // eslint-disable-next-line no-nested-ternary
      return leftCps.length < rightCps.length
        ? -1
        : leftCps.length > rightCps.length
          ? 1
          : 0;
    };
    env.compareStrings = (left, right) => {
      switch (ENDO_RANK_STRINGS) {
        case 'utf16-code-unit-order':
          return trivial(left, right);
        case 'unicode-code-point-order':
          return codePoint(left, right);
        default:
          throw Error(`Unexpected ENDO_RANK_STRINGS ${ENDO_RANK_STRINGS}`);
      }
    };
  },
};

/**
 * @param {string} setting
 * @returns {Promise<Compartment>}
 */
const makeCompartmentWithEnvOptions = async setting => {
  const envOptionsSource = await readFile(envOptionsSourceUrl, 'utf8');
  // The compartment defines `compareStrings` and `capturedSetting`
  // exports against its own process.env via @endo/env-options.
  return new Compartment({
    globals: {
      process: { env: { ENDO_RANK_STRINGS: setting } },
    },
    modules: {
      '@endo/env-options': {
        source: new ModuleSource(envOptionsSource),
      },
      'compare-strings': {
        source: compareStringsModuleSource,
      },
    },
    resolveHook: specifier => specifier,
    __noNamespaceBox__: true,
    __options__: true,
  });
};

const { bmpHigh, surrogatePair } = multiplanarStrings;

test('per-compartment ENDO_RANK_STRINGS controls string ranking inside the compartment', async t => {
  // Parent has the default setting.  These two strings disagree
  // between code-unit and code-point order (the canonical example from
  // the ICU paper), so they reveal which order is in effect.
  // utf16-code-unit-order: surrogatePair < bmpHigh
  // unicode-code-point-order: bmpHigh < surrogatePair
  t.is(parentCompareRank(surrogatePair, bmpHigh), -1);
  t.is(parentCompareRank(bmpHigh, surrogatePair), 1);

  const compartment = await makeCompartmentWithEnvOptions(
    'unicode-code-point-order',
  );
  const { compareStrings, capturedSetting } =
    /** @type {CompareStringsNamespace} */ (
      /** @type {unknown} */ (await compartment.import('compare-strings'))
    );

  // The sub-compartment captured its own setting, not the parent's.
  t.is(capturedSetting, 'unicode-code-point-order');

  // Inside the sub-compartment, code-point order swaps the result.
  t.is(compareStrings(surrogatePair, bmpHigh), 1);
  t.is(compareStrings(bmpHigh, surrogatePair), -1);

  // And the resulting sort differs from the parent's.
  const strs = harden([bmpHigh, surrogatePair]);
  t.deepEqual(sorted(strs, parentCompareRank), [surrogatePair, bmpHigh]);
  t.deepEqual(sorted(strs, compareStrings), [bmpHigh, surrogatePair]);
});

test('two sibling sub-compartments capture different ENDO_RANK_STRINGS', async t => {
  const utf16 = await makeCompartmentWithEnvOptions('utf16-code-unit-order');
  const codePoint = await makeCompartmentWithEnvOptions(
    'unicode-code-point-order',
  );
  const utf16Ns = /** @type {CompareStringsNamespace} */ (
    /** @type {unknown} */ (await utf16.import('compare-strings'))
  );
  const codePointNs = /** @type {CompareStringsNamespace} */ (
    /** @type {unknown} */ (await codePoint.import('compare-strings'))
  );

  t.is(utf16Ns.capturedSetting, 'utf16-code-unit-order');
  t.is(codePointNs.capturedSetting, 'unicode-code-point-order');

  // Same inputs, opposite results.
  t.is(utf16Ns.compareStrings(surrogatePair, bmpHigh), -1);
  t.is(codePointNs.compareStrings(surrogatePair, bmpHigh), 1);
});
