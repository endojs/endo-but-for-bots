// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { InterfaceGuard, Pattern } from '@endo/patterns' */
/**
 * @import {
 *   GitToolFacet,
 *   GitToolRewriterCapability,
 *   ToolRecord,
 * } from '../src/types.js'
 */

import test from 'ava';
import { Ajv } from 'ajv';
import {
  M,
  matches,
  getInterfaceGuardPayload,
  getMethodGuardPayload,
} from '@endo/patterns';
import { Far } from '@endo/pass-style';
import {
  GitReaderInterface,
  GitRewriterInterface,
  GitWriterInterface,
} from '@endo/exo-git/src/interfaces.js';

import { makeGitHistoryTool, makeGitTool } from '../src/json-tools/git.js';

/**
 * Conformance checks for hand-authored JSON Schemas and runtime guards.
 */

const ajv = new Ajv({ strict: false });

/** @type {Record<GitToolFacet, InterfaceGuard>} */
const gitInterfaceByFacet = harden({
  reader: /** @type {InterfaceGuard} */ (GitReaderInterface),
  writer: /** @type {InterfaceGuard} */ (GitWriterInterface),
  rewriter: /** @type {InterfaceGuard} */ (GitRewriterInterface),
});

/**
 * Positional guard structure from the supplied facet interface.
 *
 * @param {string} method
 * @param {InterfaceGuard} gitInterface
 */
const guardShapeFor = (method, gitInterface) => {
  const { methodGuards } = getInterfaceGuardPayload(gitInterface);
  const { argGuards, optionalArgGuards } = getMethodGuardPayload(
    methodGuards[method],
  );
  const optional = optionalArgGuards || [];
  return {
    requiredCount: argGuards.length,
    guards: harden([...argGuards, ...optional]),
  };
};

/**
 * Decide whether the runtime guards accept a named-args record, mapping the
 * record's keys onto positional slots by the schema's declared property order.
 *
 * @param {{requiredCount:number, guards:Pattern[]}} shape
 * @param {string[]} paramNames Declared property names, in positional order.
 * @param {Record<string, unknown>} record
 */
const guardAccepts = (shape, paramNames, record) => {
  const { requiredCount, guards } = shape;
  const allowed = new Set(paramNames.slice(0, guards.length));
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return false;
  }
  for (let i = 0; i < guards.length; i += 1) {
    const key = paramNames[i];
    // JSON has no `undefined`, so a known `name: undefined` is treated as absent.
    const present =
      Object.prototype.hasOwnProperty.call(record, key) &&
      record[key] !== undefined;
    if (present) {
      if (!matches(record[key], guards[i])) return false;
    } else if (i < requiredCount) {
      return false;
    }
  }
  return true;
};

/**
 * Candidate args records covering valid and invalid shapes, keyed by abstract
 * positional slots (`slot0`/`slot1`) plus an out-of-band `extra` key. The macro
 * remaps each slot to the tool's real declared property name, so the same
 * coverage exercises every tool's named signature.
 */
const slotRecords = harden([
  {},
  { slot0: 'a-string' },
  { slot0: '' },
  { slot0: 42 },
  { slot0: 42n },
  { slot0: true },
  { slot0: null },
  { slot0: undefined },
  { slot0: {} },
  { slot0: { k: 'v' } },
  { slot0: [] },
  { slot0: ['a'] },
  { slot0: ['a', 'b'], slot1: 'ours' },
  { slot0: ['a'], slot1: 'theirs' },
  { slot0: ['a'], slot1: 'base' },
  { slot0: [42] },
  { slot1: 'only-second' },
  { slot0: 'a', slot1: {} },
  { slot0: 'a', slot1: { opt: 1 } },
  { slot0: 'a', slot1: 'not-a-record' },
  { slot0: 'a', slot1: 5 },
  { slot0: {}, slot1: {} },
  { slot0: 'a', extra: 'x' },
  { extra: 'x' },
  { extra: undefined },
  { slot0: undefined, slot1: undefined },
  // Open-object option records.
  { slot0: { a: 1, b: 2 } },
  { slot0: { nested: { x: 1 } } },
  { slot0: { mode: 'start', upstream: 'main' } },
  { slot0: { mode: 'start', upstream: 'main', autosquash: true } },
  { slot0: { mode: 'continue' } },
  { slot0: { mode: 'abort' } },
  { slot0: { mode: 'skip' } },
  { slot0: { mode: 'continue', autosquash: true } },
  { slot0: { mode: 'abort', upstream: 'main' } },
  { slot0: { mode: 'skip', autosquash: false } },
  { slot0: harden({ author: 'alice', oneline: true, maxCount: 10 }) },
  { slot0: 'a', slot1: { a: 1, b: 2 } },
  { slot0: 'a', slot1: { nested: { x: 1 } } },
  { slot0: 'a', slot1: { amend: true } },
  { slot0: 'a', slot1: { noCommit: true } },
  { slot0: 'a', slot1: harden({ track: true, startPoint: 'main' }) },
]);

/**
 * Declared property names for a tool, in positional order.
 *
 * @param {ToolRecord} tool
 * @returns {string[]}
 */
const paramNamesOf = tool =>
  Object.keys(
    /** @type {{ properties?: Record<string, unknown> }} */ (tool.parameters)
      .properties || {},
  );

/**
 * Remap an abstract slot record onto a tool's real property names. `slot0` →
 * the first declared property, `slot1` → the second; unknown slots and `extra`
 * are preserved verbatim so the out-of-band-key cases still exercise rejection.
 *
 * @param {Record<string, unknown>} slotRecord
 * @param {string[]} paramNames
 * @returns {Record<string, unknown>}
 */
const toNamedRecord = (slotRecord, paramNames) => {
  /** @type {Record<string, unknown>} */
  const named = {};
  for (const [slot, value] of Object.entries(slotRecord)) {
    const match = /^slot(\d+)$/.exec(slot);
    const key =
      match && paramNames[Number(match[1])] !== undefined
        ? paramNames[Number(match[1])]
        : slot;
    named[key] = value;
  }
  return named;
};

// This test inspects schemas and guards; it never invokes the capability.
const inertGit = /** @type {ERef<GitToolRewriterCapability>} */ (
  /** @type {unknown} */ (Far('InertGit', {}))
);

/** @type {GitToolFacet[]} */
const GIT_TOOL_FACETS = harden(['reader', 'writer', 'rewriter']);

/**
 * For one git tool, assert its hand-authored JSON Schema and its runtime guard
 * — read from the facet interface the tool's catalog was derived from — agree
 * on every candidate args record.
 */
const schemaGuardAgree = test.macro({
  exec(
    t,
    /** @type {ToolRecord} */ tool,
    /** @type {InterfaceGuard} */ gitInterface,
  ) {
    const shape = guardShapeFor(tool.name, gitInterface);
    const paramNames = paramNamesOf(tool);
    const validate = ajv.compile(tool.parameters);
    let checked = 0;
    for (const slotRecord of slotRecords) {
      const record = toNamedRecord(slotRecord, paramNames);
      const guardOk = guardAccepts(shape, paramNames, record);
      const schemaOk = validate({ ...record });
      t.is(
        schemaOk,
        guardOk,
        `${tool.name}: schema=${schemaOk} guard=${guardOk} for ${JSON.stringify(
          record,
          (_k, v) => (typeof v === 'bigint' ? `${v}n` : v),
        )}`,
      );
      checked += 1;
    }
    t.true(checked > 0);
  },
  title(providedTitle, /** @type {ToolRecord} */ tool) {
    return providedTitle || `schema ⟷ guard agree for git.${tool.name}`;
  },
});

for (const facet of GIT_TOOL_FACETS) {
  const gitTools = makeGitTool(inertGit, /** @type {any} */ ({ facet }));
  for (const tool of gitTools) {
    test(
      `schema ⟷ guard agree for git[${facet}].${tool.name}`,
      schemaGuardAgree,
      tool,
      gitInterfaceByFacet[facet],
    );
  }
}

for (const tool of makeGitHistoryTool(inertGit)) {
  test(
    `schema ⟷ guard agree for git[history].${tool.name}`,
    schemaGuardAgree,
    tool,
    /** @type {InterfaceGuard} */ (GitRewriterInterface),
  );
}

test('canonical rebase guard accepts controls and keeps start fields scoped', t => {
  const [rebaseInputShape] = guardShapeFor(
    'rebase',
    /** @type {InterfaceGuard} */ (GitRewriterInterface),
  ).guards;
  for (const input of [
    { mode: 'start', upstream: 'main' },
    { mode: 'start', upstream: 'main', autosquash: true },
    { mode: 'continue' },
    { mode: 'abort' },
    { mode: 'skip' },
  ]) {
    t.true(matches(harden(input), rebaseInputShape), JSON.stringify(input));
  }
  for (const input of [
    { mode: 'start' },
    { mode: 'continue', upstream: 'main' },
    { mode: 'abort', autosquash: true },
    { mode: 'skip', autosquash: false },
    { mode: 'finish' },
  ]) {
    t.false(matches(harden(input), rebaseInputShape), JSON.stringify(input));
  }
});

test('rebase JSON schema represents start and every control mode', t => {
  const rebase = makeGitTool(inertGit, { facet: 'rewriter' }).find(
    tool => tool.name === 'rebase',
  );
  if (!rebase) {
    t.fail('rewriter catalog must include rebase');
    return;
  }
  const validate = ajv.compile(rebase.parameters);
  for (const input of [
    { mode: 'start', upstream: 'main' },
    { mode: 'start', upstream: 'main', autosquash: false },
    { mode: 'continue' },
    { mode: 'abort' },
    { mode: 'skip' },
  ]) {
    t.true(validate({ input }), JSON.stringify(input));
  }
  for (const input of [
    { mode: 'start' },
    { mode: 'continue', upstream: 'main' },
    { mode: 'abort', autosquash: true },
    { mode: 'skip', autosquash: false },
    { mode: 'finish' },
  ]) {
    t.false(validate({ input }), JSON.stringify(input));
  }
});

// --- bigint synthetic case ----------------------------------------------
//
// The current Git slice has no bigint args, so this covers the bigint
// guard-to-schema mapping directly.

const BIGINT_GUARD = M.bigint();
const BIGINT_SCHEMA = harden({
  type: 'string',
  pattern: '^[+-]?\\d+$',
});
const BIGINT_SCHEMA_WRONG = harden({ type: 'integer' });

test('bigint guard and string-pattern schema agree', t => {
  const validateStr = ajv.compile(BIGINT_SCHEMA);

  /** @type {Array<[unknown, unknown]>} */
  const pairs = harden([
    [5n, '5'],
    [5n, '+5'],
    [-3n, '-3'],
    [0n, '0'],
    [
      123_456_789_012_345_678_901_234_567_890n,
      '123456789012345678901234567890',
    ],
    ['x', 'x'],
    [5.5, '5.5'],
    [{}, '{}'],
    [true, 'true'],
    ['', ''],
  ]);

  for (const [guardValue, wireValue] of pairs) {
    const guardOk = matches(guardValue, BIGINT_GUARD);
    const schemaOk = validateStr(wireValue);
    t.is(
      schemaOk,
      guardOk,
      `bigint: guard(${String(guardValue)})=${guardOk} schema(${JSON.stringify(
        wireValue,
      )})=${schemaOk}`,
    );
  }

  t.true(matches(5n, BIGINT_GUARD));
  t.true(validateStr('5'));
  t.true(validateStr('+5'));
  t.true(validateStr('-3'));
  t.false(validateStr('x'));
  t.false(validateStr('5.5'));
  t.false(validateStr('{}'));
});

test('{type:integer} schema diverges from a bigint guard', t => {
  const validateInt = ajv.compile(BIGINT_SCHEMA_WRONG);

  let divergences = 0;

  {
    const schemaOk = validateInt(5);
    const guardOk = matches(5, BIGINT_GUARD);
    t.true(schemaOk, 'integer-schema accepts the JSON number 5');
    t.false(guardOk, 'bigint-guard rejects the JS number 5');
    if (schemaOk !== guardOk) divergences += 1;
  }

  {
    const schemaOk = validateInt('5');
    const guardOk = matches(5n, BIGINT_GUARD);
    t.false(schemaOk, 'integer-schema rejects the string "5"');
    t.true(guardOk, 'bigint-guard accepts 5n');
    if (schemaOk !== guardOk) divergences += 1;
  }

  t.true(
    divergences >= 1,
    'an {type:integer} schema diverges from a bigint guard',
  );
});
